import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PHASE_A_BINARY_SHA256 } from "@agent-farm/codex-bridge";

import { createProductionComposition } from "./composition.js";
import { JwtAuthService, type JwtAuthOptions } from "./auth.js";
import { BrowserAuthBff } from "./browser-auth.js";
import {
  DEFAULT_ORCHESTRATION_BUDGET,
  type OrchestrationBudget,
} from "./contracts.js";
import { createSupportedCodexRuntimeAnchors } from "./runtime-service.js";
import { createRemoteTokenStatusVerifier } from "./token-status.js";

/** A self-contained deployment must not load scripts, styles, or connections from another origin. */
export const SELF_ONLY_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

/**
 * Real 0.145.0 thread/read and thread/list responses can exceed the client's
 * conservative 1 MiB default. Keep Codex's bridge at its absolute 8 MiB cap,
 * while requesting small list pages so the retained privacy gate remains
 * bounded. Official thread/read is unpaginated and relies on the line cap.
 */
export const CODEX_RUNTIME_MAX_LINE_BYTES = 8 * 1_048_576;
export const CODEX_RECONCILER_PAGE_SIZE = 20;

export type EnvironmentInput = Readonly<Record<string, string | undefined>>;

export interface ServerEnvironment {
  readonly devMode: boolean;
  /** Loopback-only install-and-run mode with local browser sessions; no OAuth. */
  readonly localMode: boolean;
  /** User-configurable sub-agent orchestration budget for local installs. */
  readonly orchestrationBudget: Readonly<OrchestrationBudget>;
  readonly port: number;
  readonly host: string;
  readonly databaseFilename: string;
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly staticRoot: string;
  readonly jwksUri?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly resource?: string;
  readonly authorizationServer?: string;
  readonly browserAuthorizationEndpoint?: string;
  readonly browserTokenEndpoint?: string;
  readonly browserClientId?: string;
  readonly browserRedirectUri?: string;
  readonly browserRevocationEndpoint?: string;
  /** Explicitly pinned, read-only Codex app-server runtime configuration. */
  readonly codexExecutable: string;
  readonly codexBinarySha256: string;
  readonly codexInstallationId: string;
  /** Trusted local-launch task identity; never serialized to the browser. */
  readonly expectedLocalSourceRootId?: string;
  /** Trusted local rollout directory used only for bounded identity evidence. */
  readonly codexSessionsRoot: string;
  /** Secret key used to hash the refresh-stable MCP grant tuple at rest. */
  readonly mcpGrantDigestKey: string;
  readonly tokenStatusUrl?: string;
  readonly tokenStatusSecret?: string;
  readonly tokenStatusTimeoutMs?: number;
  readonly tokenStatusMaxResponseBytes?: number;
}

export type { OrchestrationBudget } from "./contracts.js";
export { DEFAULT_ORCHESTRATION_BUDGET } from "./contracts.js";

export class EnvironmentConfigError extends Error {
  readonly missing: readonly string[];
  readonly invalid: readonly string[];

  constructor(missing: readonly string[], invalid: readonly string[]) {
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      invalid.length > 0 ? `invalid ${invalid.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    super(`Agent Farm ${details || "environment configuration is invalid"}`);
    this.name = "EnvironmentConfigError";
    this.missing = missing;
    this.invalid = invalid;
  }
}

const DEFAULT_DEV_DATABASE = ".agent-farm/dev.sqlite";
const DEFAULT_LOCAL_DATABASE = ".agent-farm/local.sqlite";
const DEFAULT_WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const DEFAULT_DEV_CODEX_EXECUTABLE = resolve(homedir(), ".local/bin/codex");
const DEFAULT_DEV_CODEX_SESSIONS_ROOT = resolve(homedir(), ".codex/sessions");
const DEFAULT_DEV_CODEX_INSTALLATION_ID = "codex-local-dev";
const DEFAULT_DEV_MCP_GRANT_DIGEST_KEY = "agent-farm-dev-mcp-grant-digest-key-v1-32bytes!";
const CODEX_ID = /^[A-Za-z0-9._:-]{1,256}$/u;

/**
 * Parse an environment object without reading or mutating process.env.  This
 * makes startup policy unit-testable and keeps production's deny-by-default
 * boundary explicit.
 */
export function parseServerEnvironment(env: EnvironmentInput = process.env): ServerEnvironment {
  const devMode = env.AGENT_FARM_DEV_MODE === "1";
  const localMode = env.AGENT_FARM_LOCAL_MODE === "1";
  const relaxed = devMode || localMode;
  const missing: string[] = [];
  const invalid: string[] = [];
  const host = nonEmpty(env.HOST) ?? "127.0.0.1";
  const port = parsePort(env.PORT, invalid);
  // Development permits plain HTTP only for a genuinely local listener.
  // Binding every interface would turn the dev exception into a network
  // deployment path without TLS, even if the displayed origin were loopback.
  if (relaxed && !isLoopbackHost(host)) {
    invalid.push("HOST");
    if (localMode) invalid.push("AGENT_FARM_LOCAL_MODE");
  }

  const configuredDatabase = nonEmpty(env.AGENT_FARM_DATABASE);
  const localDatabaseFilename = resolve(process.cwd(), DEFAULT_LOCAL_DATABASE);
  const databaseFilename = configuredDatabase ?? (
    relaxed ? resolve(process.cwd(), localMode ? DEFAULT_LOCAL_DATABASE : DEFAULT_DEV_DATABASE) : ""
  );
  if (!configuredDatabase && !relaxed) missing.push("AGENT_FARM_DATABASE");
  if (databaseFilename === ":memory:" || databaseFilename.length === 0) {
    invalid.push("AGENT_FARM_DATABASE");
  }
  // Local mode is the documented single-user launcher contract: it owns one
  // fixed durable file below .agent-farm and must not be redirected to an
  // arbitrary operator-selected database path. Accept equivalent relative or
  // absolute spellings of that one path, but reject every other override.
  if (localMode && configuredDatabase !== undefined && resolve(configuredDatabase) !== localDatabaseFilename) {
    invalid.push("AGENT_FARM_DATABASE", "AGENT_FARM_LOCAL_MODE");
  }

  const jwksUri = parseHttpsSetting("AGENT_FARM_JWKS_URI", env.AGENT_FARM_JWKS_URI, missing, invalid, !relaxed);
  const issuer = parseTextSetting("AGENT_FARM_ISSUER", env.AGENT_FARM_ISSUER, missing, !relaxed);
  const audience = parseTextSetting("AGENT_FARM_AUDIENCE", env.AGENT_FARM_AUDIENCE, missing, !relaxed);
  const resource = parseHttpsSetting(
    "AGENT_FARM_RESOURCE",
    nonEmpty(env.AGENT_FARM_RESOURCE) ?? nonEmpty(env.AGENT_FARM_RFC8707_RESOURCE),
    missing,
    invalid,
    !relaxed,
  );
  const authorizationServer = parseHttpsSetting(
    "AGENT_FARM_AUTHORIZATION_SERVER",
    env.AGENT_FARM_AUTHORIZATION_SERVER,
    missing,
    invalid,
    !relaxed,
  );
  const browserAuthorizationEndpoint = parseHttpsSetting(
    "AGENT_FARM_BROWSER_AUTHORIZATION_ENDPOINT",
    env.AGENT_FARM_BROWSER_AUTHORIZATION_ENDPOINT,
    missing,
    invalid,
    !relaxed,
  );
  const browserTokenEndpoint = parseHttpsSetting(
    "AGENT_FARM_BROWSER_TOKEN_ENDPOINT",
    env.AGENT_FARM_BROWSER_TOKEN_ENDPOINT,
    missing,
    invalid,
    !relaxed,
  );
  const browserClientId = parseTextSetting(
    "AGENT_FARM_BROWSER_CLIENT_ID",
    env.AGENT_FARM_BROWSER_CLIENT_ID,
    missing,
    !relaxed,
  );
  const browserRedirectUri = parseHttpsSetting(
    "AGENT_FARM_BROWSER_REDIRECT_URI",
    env.AGENT_FARM_BROWSER_REDIRECT_URI,
    missing,
    invalid,
    !relaxed,
  );
  const browserRevocationEndpoint = parseHttpsSetting(
    "AGENT_FARM_BROWSER_REVOCATION_ENDPOINT",
    env.AGENT_FARM_BROWSER_REVOCATION_ENDPOINT,
    missing,
    invalid,
    false,
  );
  const browserAuthParts = [
    browserAuthorizationEndpoint,
    browserTokenEndpoint,
    browserClientId,
    browserRedirectUri,
  ];
  if (browserAuthParts.some((value) => value !== undefined) && browserAuthParts.some((value) => value === undefined)) {
    invalid.push("AGENT_FARM_BROWSER_AUTH_CONFIGURATION");
  }
  if (browserRedirectUri !== undefined && resource !== undefined) {
    try {
      const redirect = new URL(browserRedirectUri);
      const protectedResource = new URL(resource);
      if (redirect.origin !== protectedResource.origin || redirect.pathname !== "/auth/callback" || redirect.search || redirect.hash) {
        invalid.push("AGENT_FARM_BROWSER_REDIRECT_URI");
      }
    } catch {
      invalid.push("AGENT_FARM_BROWSER_REDIRECT_URI");
    }
  }

  // The runtime is always explicit in production. Development gets only the
  // already-retained Phase-A local binary/hash defaults; a caller may still
  // override all three values to exercise another explicitly tested setup.
  const codexRuntimeParts = [
    env.AGENT_FARM_CODEX_EXECUTABLE,
    env.AGENT_FARM_CODEX_BINARY_SHA256,
    env.AGENT_FARM_CODEX_INSTALLATION_ID,
  ];
  if (relaxed && codexRuntimeParts.some((value) => nonEmpty(value) !== undefined) && codexRuntimeParts.some((value) => nonEmpty(value) === undefined)) {
    invalid.push("AGENT_FARM_CODEX_CONFIGURATION");
  }
  const codexExecutable = parseExecutableSetting(
    "AGENT_FARM_CODEX_EXECUTABLE",
    env.AGENT_FARM_CODEX_EXECUTABLE,
    missing,
    invalid,
    !relaxed,
    DEFAULT_DEV_CODEX_EXECUTABLE,
  );
  const codexBinarySha256 = parseBinaryShaSetting(
    "AGENT_FARM_CODEX_BINARY_SHA256",
    env.AGENT_FARM_CODEX_BINARY_SHA256,
    missing,
    invalid,
    !relaxed,
    PHASE_A_BINARY_SHA256,
  );
  const codexInstallationId = parseInstallationSetting(
    "AGENT_FARM_CODEX_INSTALLATION_ID",
    env.AGENT_FARM_CODEX_INSTALLATION_ID,
    missing,
    invalid,
    !relaxed,
    DEFAULT_DEV_CODEX_INSTALLATION_ID,
  );
  const expectedLocalSourceRootId = nonEmpty(env.AGENT_FARM_EXPECTED_SOURCE_ROOT_ID);
  if (expectedLocalSourceRootId !== undefined && (!localMode || !CODEX_ID.test(expectedLocalSourceRootId))) {
    invalid.push("AGENT_FARM_EXPECTED_SOURCE_ROOT_ID");
  }
  const codexSessionsRoot = parseAbsolutePathSetting(
    "AGENT_FARM_CODEX_SESSIONS_ROOT",
    env.AGENT_FARM_CODEX_SESSIONS_ROOT,
    missing,
    invalid,
    !relaxed,
    DEFAULT_DEV_CODEX_SESSIONS_ROOT,
  );
  const mcpGrantDigestKey = parseMcpGrantDigestKey(
    env.AGENT_FARM_MCP_GRANT_DIGEST_KEY,
    missing,
    invalid,
    !relaxed,
  );

  const tokenStatusUrl = parseHttpsSetting(
    "AGENT_FARM_TOKEN_STATUS_URL",
    nonEmpty(env.AGENT_FARM_TOKEN_STATUS_URL) ?? nonEmpty(env.AGENT_FARM_TOKEN_STATUS_ENDPOINT),
    missing,
    invalid,
    !relaxed,
  );
  const tokenStatusSecret = parseTextSetting(
    "AGENT_FARM_TOKEN_STATUS_SECRET",
    nonEmpty(env.AGENT_FARM_TOKEN_STATUS_SECRET) ?? nonEmpty(env.AGENT_FARM_TOKEN_STATUS_BEARER),
    missing,
    !relaxed,
  );
  if ((tokenStatusUrl === undefined) !== (tokenStatusSecret === undefined)) {
    invalid.push("AGENT_FARM_TOKEN_STATUS_URL/AGENT_FARM_TOKEN_STATUS_SECRET");
  }
  // Local mode owns its loopback trust boundary and never composes OAuth or a
  // remote token-status verifier. Reject every related setting, including
  // optional aliases and tuning knobs, rather than silently ignoring one.
  if (localMode && [
    env.AGENT_FARM_JWKS_URI,
    env.AGENT_FARM_ISSUER,
    env.AGENT_FARM_AUDIENCE,
    env.AGENT_FARM_RESOURCE,
    env.AGENT_FARM_RFC8707_RESOURCE,
    env.AGENT_FARM_AUTHORIZATION_SERVER,
    env.AGENT_FARM_BROWSER_AUTHORIZATION_ENDPOINT,
    env.AGENT_FARM_BROWSER_TOKEN_ENDPOINT,
    env.AGENT_FARM_BROWSER_CLIENT_ID,
    env.AGENT_FARM_BROWSER_REDIRECT_URI,
    env.AGENT_FARM_BROWSER_REVOCATION_ENDPOINT,
    env.AGENT_FARM_TOKEN_STATUS_URL,
    env.AGENT_FARM_TOKEN_STATUS_ENDPOINT,
    env.AGENT_FARM_TOKEN_STATUS_SECRET,
    env.AGENT_FARM_TOKEN_STATUS_BEARER,
    env.AGENT_FARM_TOKEN_STATUS_TIMEOUT_MS,
    env.AGENT_FARM_TOKEN_STATUS_MAX_RESPONSE_BYTES,
  ].some((value) => nonEmpty(value) !== undefined)) {
    invalid.push("AGENT_FARM_LOCAL_MODE");
  }

  const configuredOrigins = parseCsv(env.AGENT_FARM_ALLOWED_ORIGINS);
  if (configuredOrigins.includes("*")) invalid.push("AGENT_FARM_ALLOWED_ORIGINS");
  const allowedOrigins = configuredOrigins.length > 0
    ? configuredOrigins.filter((origin) => isWebOrigin(origin, invalid, relaxed))
    : relaxed
      ? [inferredOrigin(host, port)]
      : [];
  if (localMode && allowedOrigins.some((origin) => !isLoopbackOrigin(origin))) invalid.push("AGENT_FARM_LOCAL_MODE");
  if (!relaxed && configuredOrigins.length === 0) missing.push("AGENT_FARM_ALLOWED_ORIGINS");

  const configuredHosts = parseCsv(env.AGENT_FARM_ALLOWED_HOSTS);
  if (configuredHosts.includes("*")) invalid.push("AGENT_FARM_ALLOWED_HOSTS");
  // HTTP Host headers must bracket IPv6 addresses; synthesize the header-safe
  // form so a local-mode default of HOST=::1 accepts "[::1]:8787" requests.
  const allowedHosts = configuredHosts.length > 0
    ? configuredHosts.filter((value) => isHost(value))
    : relaxed
      ? [`${loopbackHostHeader(host)}:${port}`]
      : [];
  if (localMode && allowedHosts.some((value) => !isLoopbackHostSpec(value) || !hasExplicitHostPort(value))) invalid.push("AGENT_FARM_LOCAL_MODE");
  if (!relaxed && configuredHosts.length === 0) missing.push("AGENT_FARM_ALLOWED_HOSTS");
  if (configuredHosts.some((value) => !isHost(value))) invalid.push("AGENT_FARM_ALLOWED_HOSTS");

  const orchestrationBudget = parseOrchestrationBudget(env, invalid);

  const tokenStatusTimeoutMs = parseOptionalBound(
    "AGENT_FARM_TOKEN_STATUS_TIMEOUT_MS",
    env.AGENT_FARM_TOKEN_STATUS_TIMEOUT_MS,
    50,
    30_000,
    invalid,
  );
  const tokenStatusMaxResponseBytes = parseOptionalBound(
    "AGENT_FARM_TOKEN_STATUS_MAX_RESPONSE_BYTES",
    env.AGENT_FARM_TOKEN_STATUS_MAX_RESPONSE_BYTES,
    256,
    1 * 1024 * 1024,
    invalid,
  );

  if (missing.length > 0 || invalid.length > 0) {
    throw new EnvironmentConfigError([...new Set(missing)], [...new Set(invalid)]);
  }

  return {
    devMode,
    localMode,
    orchestrationBudget,
    port,
    host,
    databaseFilename: resolve(databaseFilename),
    allowedOrigins,
    allowedHosts,
    staticRoot: resolve(nonEmpty(env.AGENT_FARM_WEB_DIST) ?? DEFAULT_WEB_DIST),
    ...(jwksUri === undefined ? {} : { jwksUri }),
    ...(issuer === undefined ? {} : { issuer }),
    ...(audience === undefined ? {} : { audience }),
    ...(resource === undefined ? {} : { resource }),
    ...(authorizationServer === undefined ? {} : { authorizationServer }),
    ...(browserAuthorizationEndpoint === undefined ? {} : { browserAuthorizationEndpoint }),
    ...(browserTokenEndpoint === undefined ? {} : { browserTokenEndpoint }),
    ...(browserClientId === undefined ? {} : { browserClientId }),
    ...(browserRedirectUri === undefined ? {} : { browserRedirectUri }),
    ...(browserRevocationEndpoint === undefined ? {} : { browserRevocationEndpoint }),
    codexExecutable: codexExecutable!,
    codexBinarySha256: codexBinarySha256!,
    codexInstallationId: codexInstallationId!,
    ...(expectedLocalSourceRootId === undefined ? {} : { expectedLocalSourceRootId }),
    codexSessionsRoot: codexSessionsRoot!,
    mcpGrantDigestKey: mcpGrantDigestKey!,
    ...(tokenStatusUrl === undefined ? {} : { tokenStatusUrl }),
    ...(tokenStatusSecret === undefined ? {} : { tokenStatusSecret }),
    ...(tokenStatusTimeoutMs === undefined ? {} : { tokenStatusTimeoutMs }),
    ...(tokenStatusMaxResponseBytes === undefined ? {} : { tokenStatusMaxResponseBytes }),
  };
}

/** Descriptive aliases for callers that already use config/read terminology. */
export const parseEnvironment = parseServerEnvironment;
export const readServerConfig = parseServerEnvironment;

/**
 * Re-check the security policy at the start boundary as well as during env
 * parsing. Callers may inject a pre-built ServerEnvironment in tests or from
 * an embedding process, so startup must not trust that object blindly.
 */
export function assertServerEnvironmentInvariants(config: ServerEnvironment): void {
  const invalid: string[] = [];
  if (!isBudgetWithinBounds(config.orchestrationBudget)) invalid.push("AGENT_FARM_BUDGET");
  if (config.expectedLocalSourceRootId !== undefined && (!config.localMode || !CODEX_ID.test(config.expectedLocalSourceRootId))) {
    invalid.push("AGENT_FARM_EXPECTED_SOURCE_ROOT_ID");
  }

  if (config.localMode) {
    let localPolicyInvalid = false;
    const expectedLocalDatabase = resolve(process.cwd(), DEFAULT_LOCAL_DATABASE);
    if (
      typeof config.databaseFilename !== "string" ||
      resolve(config.databaseFilename) !== expectedLocalDatabase
    ) {
      invalid.push("AGENT_FARM_DATABASE");
      localPolicyInvalid = true;
    }
    if (typeof config.host !== "string" || !isLoopbackHost(config.host)) {
      invalid.push("HOST");
      localPolicyInvalid = true;
    }
    if (!Array.isArray(config.allowedHosts) || config.allowedHosts.some((value) => typeof value !== "string" || !isLoopbackHostSpec(value) || !hasExplicitHostPort(value))) {
      invalid.push("AGENT_FARM_ALLOWED_HOSTS");
      localPolicyInvalid = true;
    }
    if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.some((value) => typeof value !== "string" || !isLoopbackOrigin(value))) {
      invalid.push("AGENT_FARM_ALLOWED_ORIGINS");
      localPolicyInvalid = true;
    }
    const forbiddenLocalFields: readonly [keyof ServerEnvironment, string][] = [
      ["jwksUri", "AGENT_FARM_JWKS_URI"],
      ["issuer", "AGENT_FARM_ISSUER"],
      ["audience", "AGENT_FARM_AUDIENCE"],
      ["resource", "AGENT_FARM_RESOURCE"],
      ["authorizationServer", "AGENT_FARM_AUTHORIZATION_SERVER"],
      ["browserAuthorizationEndpoint", "AGENT_FARM_BROWSER_AUTHORIZATION_ENDPOINT"],
      ["browserTokenEndpoint", "AGENT_FARM_BROWSER_TOKEN_ENDPOINT"],
      ["browserClientId", "AGENT_FARM_BROWSER_CLIENT_ID"],
      ["browserRedirectUri", "AGENT_FARM_BROWSER_REDIRECT_URI"],
      ["browserRevocationEndpoint", "AGENT_FARM_BROWSER_REVOCATION_ENDPOINT"],
      ["tokenStatusUrl", "AGENT_FARM_TOKEN_STATUS_URL"],
      ["tokenStatusSecret", "AGENT_FARM_TOKEN_STATUS_SECRET"],
      ["tokenStatusTimeoutMs", "AGENT_FARM_TOKEN_STATUS_TIMEOUT_MS"],
      ["tokenStatusMaxResponseBytes", "AGENT_FARM_TOKEN_STATUS_MAX_RESPONSE_BYTES"],
    ];
    for (const [key, name] of forbiddenLocalFields) {
      if (config[key] !== undefined) {
        invalid.push(name);
        localPolicyInvalid = true;
      }
    }
    if (localPolicyInvalid) invalid.push("AGENT_FARM_LOCAL_MODE");
  }

  if (invalid.length > 0) throw new EnvironmentConfigError([], [...new Set(invalid)]);
}

/** Start the composition with production auth and durable storage policy. */
export async function startServer(environment?: ServerEnvironment): Promise<void> {
  let composition: ReturnType<typeof createProductionComposition> | undefined;
  const shutdown = async (): Promise<void> => {
    const active = composition;
    composition = undefined;
    await active?.close();
  };
  const config = environment ?? parseServerEnvironment();
  assertServerEnvironmentInvariants(config);
  const statusVerifier = config.tokenStatusUrl === undefined || config.tokenStatusSecret === undefined
    ? undefined
    : createRemoteTokenStatusVerifier({
        endpoint: config.tokenStatusUrl,
        bearerSecret: config.tokenStatusSecret,
        ...(config.tokenStatusTimeoutMs === undefined ? {} : { timeoutMs: config.tokenStatusTimeoutMs }),
        ...(config.tokenStatusMaxResponseBytes === undefined ? {} : { maxResponseBytes: config.tokenStatusMaxResponseBytes }),
      });
  const auth: JwtAuthOptions = {
    requireJti: true,
    ...(config.jwksUri === undefined ? {} : { jwksUri: config.jwksUri }),
    ...(config.issuer === undefined ? {} : { issuer: config.issuer }),
    ...(config.audience === undefined ? {} : { audience: config.audience }),
    ...(config.resource === undefined ? {} : { resource: config.resource }),
    ...(statusVerifier === undefined ? {} : { tokenStatusVerifier: statusVerifier }),
  };
  const authService = new JwtAuthService(auth);
  const runtimeAnchors = createSupportedCodexRuntimeAnchors();
  const browserAuth = !config.localMode && config.browserAuthorizationEndpoint !== undefined &&
      config.browserTokenEndpoint !== undefined &&
      config.browserClientId !== undefined &&
      config.browserRedirectUri !== undefined &&
      config.resource !== undefined
    ? new BrowserAuthBff({
        authorizationEndpoint: config.browserAuthorizationEndpoint,
        tokenEndpoint: config.browserTokenEndpoint,
        clientId: config.browserClientId,
        redirectUri: config.browserRedirectUri,
        resource: config.resource,
        ...(config.audience === undefined ? {} : { audience: config.audience }),
        ...(config.issuer === undefined ? {} : { issuer: config.issuer }),
        scopes: [
          "agent-session:create",
          "agent-session:read",
          "agent-session:read-details",
          "agent-session:render",
          "bridge:pair",
        ],
        requiredScopes: [
          "agent-session:create",
          "agent-session:read",
          "agent-session:read-details",
          "agent-session:render",
        ],
        authService,
        ...(config.browserRevocationEndpoint === undefined ? {} : { revocationEndpoint: config.browserRevocationEndpoint }),
      })
    : undefined;
  const signalHandlers = {
    SIGINT: () => { void shutdown(); },
    SIGTERM: () => { void shutdown(); },
  } as const;

  try {
    if (config.devMode || config.localMode) {
      // The default local SQLite file lives below a small private directory;
      // create that directory only in explicit dev/local mode. Production paths
      // remain operator-provisioned and are never silently created here.
      mkdirSync(dirname(config.databaseFilename), { recursive: true });
    }
    composition = createProductionComposition({
      databaseFilename: config.databaseFilename,
      storeOptions: { mcpGrantDigestKey: config.mcpGrantDigestKey },
      codexRuntime: {
        executable: config.codexExecutable,
        args: ["app-server", "--stdio"],
        binaryPath: config.codexExecutable,
        binarySha256: config.codexBinarySha256,
        installationId: config.codexInstallationId,
        ...runtimeAnchors,
        maxLineBytes: CODEX_RUNTIME_MAX_LINE_BYTES,
        rolloutIdentity: {
          sessionsRoot: config.codexSessionsRoot,
          sessionIndexPath: join(dirname(config.codexSessionsRoot), "session_index.jsonl"),
        },
        reconcilerLimits: {
          listPageSize: CODEX_RECONCILER_PAGE_SIZE,
        },
      },
      ...(config.resource === undefined ? {} : { expectedResource: config.resource }),
      server: {
        auth,
        authService,
        ...(browserAuth === undefined ? {} : { browserAuth }),
        localMode: config.localMode,
        localDataDirectory: join(dirname(config.databaseFilename), "local-auth"),
        orchestrationBudget: config.orchestrationBudget,
        localInstallationId: config.codexInstallationId,
        ...(config.expectedLocalSourceRootId === undefined ? {} : { expectedLocalSourceRootId: config.expectedLocalSourceRootId }),
        allowedOrigins: config.allowedOrigins,
        allowedHosts: config.allowedHosts,
        staticRoot: config.staticRoot,
        csp: SELF_ONLY_CSP,
        oauth: {
          ...(config.resource === undefined ? {} : { resource: config.resource }),
          ...(config.authorizationServer === undefined ? {} : { authorizationServer: config.authorizationServer }),
        },
      },
    });
    process.once("SIGINT", signalHandlers.SIGINT);
    process.once("SIGTERM", signalHandlers.SIGTERM);
    await composition.app.listen({ port: config.port, host: config.host });
  } catch (error: unknown) {
    // Keep diagnostics generic. Config errors contain only variable names;
    // verifier errors never include the endpoint body or service secret.
    const detail = error instanceof Error && error.message.length > 0 ? `: ${error.message}` : "";
    process.stderr.write(`Agent Farm server failed to start${detail}\n`);
    process.removeListener("SIGINT", signalHandlers.SIGINT);
    process.removeListener("SIGTERM", signalHandlers.SIGTERM);
    await shutdown();
    throw error;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePort(value: string | undefined, invalid: string[]): number {
  if (value === undefined || value.trim() === "") return 8787;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    invalid.push("PORT");
    return 8787;
  }
  return parsed;
}

/** Parse the optional port suffix of an HTTP Host header without coercion. */
function parseHostPort(value: string): number | undefined {
  if (!/^\d{1,5}$/u.test(value)) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function parseTextSetting(
  name: string,
  value: string | undefined,
  missing: string[],
  required: boolean,
): string | undefined {
  const result = nonEmpty(value);
  if (result === undefined && required) missing.push(name);
  return result;
}

function parseExecutableSetting(
  name: string,
  value: string | undefined,
  missing: string[],
  invalid: string[],
  required: boolean,
  devDefault: string,
): string | undefined {
  const result = nonEmpty(value) ?? (required ? undefined : devDefault);
  if (result === undefined) {
    missing.push(name);
    return undefined;
  }
  // Do not resolve or normalize an operator-supplied path: the exact path is
  // part of the binary identity that the runtime hashes before connecting.
  if (!isAbsolute(result) || result.includes("\u0000") || result.length > 4_096) invalid.push(name);
  return result;
}

function parseBinaryShaSetting(
  name: string,
  value: string | undefined,
  missing: string[],
  invalid: string[],
  required: boolean,
  devDefault: string,
): string | undefined {
  const result = nonEmpty(value) ?? (required ? undefined : devDefault);
  if (result === undefined) {
    missing.push(name);
    return undefined;
  }
  if (!/^[a-f0-9]{64}$/iu.test(result) || result.toLowerCase() !== PHASE_A_BINARY_SHA256) {
    invalid.push(name);
    return result.toLowerCase();
  }
  return result.toLowerCase();
}

function parseInstallationSetting(
  name: string,
  value: string | undefined,
  missing: string[],
  invalid: string[],
  required: boolean,
  devDefault: string,
): string | undefined {
  const result = nonEmpty(value) ?? (required ? undefined : devDefault);
  if (result === undefined) {
    missing.push(name);
    return undefined;
  }
  if (!CODEX_ID.test(result) || result.includes("\u0000")) invalid.push(name);
  return result;
}

function parseAbsolutePathSetting(
  name: string,
  value: string | undefined,
  missing: string[],
  invalid: string[],
  required: boolean,
  devDefault: string,
): string | undefined {
  const result = nonEmpty(value) ?? (required ? undefined : devDefault);
  if (result === undefined) {
    missing.push(name);
    return undefined;
  }
  if (!isAbsolute(result) || result.includes("\u0000") || result.length > 4_096) invalid.push(name);
  return result;
}

function parseMcpGrantDigestKey(
  value: string | undefined,
  missing: string[],
  invalid: string[],
  required: boolean,
): string | undefined {
  const name = "AGENT_FARM_MCP_GRANT_DIGEST_KEY";
  const result = nonEmpty(value) ?? (required ? undefined : DEFAULT_DEV_MCP_GRANT_DIGEST_KEY);
  if (result === undefined) {
    missing.push(name);
    return undefined;
  }
  // Keep this key bounded and printable so it can be provisioned safely as an
  // environment secret without silently accepting control characters.
  if (result.length < 32 || result.length > 256 || !/^[\x21-\x7e]+$/u.test(result)) invalid.push(name);
  return result;
}

function parseHttpsSetting(
  name: string,
  value: string | undefined,
  missing: string[],
  invalid: string[],
  required: boolean,
): string | undefined {
  const result = nonEmpty(value);
  if (result === undefined) {
    if (required) missing.push(name);
    return undefined;
  }
  try {
    const parsed = new URL(result);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) invalid.push(name);
  } catch {
    invalid.push(name);
  }
  return result;
}

function parseCsv(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function isWebOrigin(value: string, invalid: string[], allowHttp: boolean): boolean {
  try {
    const parsed = new URL(value);
    const httpAllowed = allowHttp && parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
    if ((parsed.protocol !== "https:" && !httpAllowed) || parsed.origin !== value || parsed.username || parsed.password) {
      invalid.push("AGENT_FARM_ALLOWED_ORIGINS");
      return false;
    }
    return true;
  } catch {
    invalid.push("AGENT_FARM_ALLOWED_ORIGINS");
    return false;
  }
}

function isLoopbackHost(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

/** Host-header form for a loopback listener address (brackets IPv6). */
function loopbackHostHeader(value: string): string {
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

/** Host header forms are allowed to carry a port; the hostname must be loopback. */
function isLoopbackHostSpec(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) return false;
    const hostname = text.slice(0, close + 1);
    const suffix = text.slice(close + 1);
    if (suffix.length > 0 && (!suffix.startsWith(":") || parseHostPort(suffix.slice(1)) === undefined)) return false;
    return isLoopbackHost(hostname);
  }
  // A bare IPv6 loopback address contains colons and is not a host:port form;
  // accept it directly rather than splitting on the first colon.
  if (text.includes(":") && [...text].filter((character) => character === ":").length > 1) {
    return isLoopbackHost(text);
  }
  const separator = text.indexOf(":");
  if (separator < 0) return isLoopbackHost(text);
  return isLoopbackHost(text.slice(0, separator)) && parseHostPort(text.slice(separator + 1)) !== undefined;
}

function hasExplicitHostPort(value: string): boolean {
  const text = value.trim();
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    return close >= 0 && text.slice(close + 1).startsWith(":") && parseHostPort(text.slice(close + 2)) !== undefined;
  }
  const separator = text.lastIndexOf(":");
  return separator > 0 && parseHostPort(text.slice(separator + 1)) !== undefined && !text.slice(0, separator).includes(":");
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function parseOrchestrationBudget(
  env: EnvironmentInput,
  invalid: string[],
): Readonly<OrchestrationBudget> {
  const rawSolHigh = nonEmpty(env.AGENT_FARM_BUDGET_SOL_HIGH);
  const rawLunaMax = nonEmpty(env.AGENT_FARM_BUDGET_LUNA_MAX);
  const rawSolMax = nonEmpty(env.AGENT_FARM_BUDGET_SOL_MAX);
  const provided = [rawSolHigh, rawLunaMax, rawSolMax].filter((value): value is string => value !== undefined);
  if (provided.length === 0) return DEFAULT_ORCHESTRATION_BUDGET;
  if (provided.length !== 3) {
    invalid.push("AGENT_FARM_BUDGET");
    return DEFAULT_ORCHESTRATION_BUDGET;
  }
  const solHigh = boundedInteger(rawSolHigh!, 0, 10);
  const lunaMax = boundedInteger(rawLunaMax!, 0, 10);
  const solMax = boundedInteger(rawSolMax!, 2, 3);
  if (solHigh === undefined || lunaMax === undefined || solMax === undefined || solHigh + lunaMax + solMax > 25) {
    invalid.push("AGENT_FARM_BUDGET");
    return DEFAULT_ORCHESTRATION_BUDGET;
  }
  return { solHigh, lunaMax, solMax };
}

function isBudgetWithinBounds(budget: OrchestrationBudget): boolean {
  return typeof budget?.solHigh === "number" && Number.isSafeInteger(budget.solHigh) && budget.solHigh >= 0 && budget.solHigh <= 10 &&
    typeof budget?.lunaMax === "number" && Number.isSafeInteger(budget.lunaMax) && budget.lunaMax >= 0 && budget.lunaMax <= 10 &&
    typeof budget?.solMax === "number" && Number.isSafeInteger(budget.solMax) && budget.solMax >= 2 && budget.solMax <= 3 &&
    budget.solHigh + budget.lunaMax + budget.solMax <= 25;
}

function boundedInteger(value: string, min: number, max: number): number | undefined {
  if (!/^\d{1,3}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function isHost(value: string): boolean {
  if (!value || /\s/u.test(value) || value.includes("/") || value.includes("*") || value.length > 256) return false;
  if (value.startsWith("[")) return /^\[[0-9a-f:.]+\](?::\d{1,5})?$/iu.test(value);
  return /^[a-z0-9.-]+(?::\d{1,5})?$/iu.test(value);
}

function inferredOrigin(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${displayHost}:${port}`;
}

function parseOptionalBound(
  name: string,
  value: string | undefined,
  min: number,
  max: number,
  invalid: string[],
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    invalid.push(name);
    return undefined;
  }
  return parsed;
}

function isDirectEntrypoint(): boolean {
  const entry = process.argv[1];
  return typeof entry === "string" && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isDirectEntrypoint()) {
  void startServer().catch(() => {
    process.exitCode = 1;
  });
}
