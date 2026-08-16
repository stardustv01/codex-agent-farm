import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  createMcpHttpSessionManager,
  handleMcpHttpRequest,
  type McpApplication,
  type McpAuthInfo,
  type McpHttpSessionManagerOptions,
  type McpNodeRequest,
} from "@agent-farm/mcp";
import {
  HIERARCHY_REVISION_SCHEMA_VERSION,
  HierarchyRevisionSchema,
  PublicAgentDetailsSchema,
  PublicHierarchyPageSchema,
  LocalAgentDetailSchema,
} from "@agent-farm/contracts";

import {
  AuthenticationError,
  JwtAuthService,
  assertTokenClaims,
  claimsToPrincipal,
  extractBearerToken,
  type JwtAuthOptions,
} from "./auth.js";
import {
  BrowserAuthError,
  type BrowserAuthBff,
  registerBrowserAuthRoutes,
} from "./browser-auth.js";
import type {
  AgentDetails,
  AgentSessionRecord,
  AuthService,
  BridgePort,
  McpPort,
  McpTool,
  OrchestrationBudget,
  PairingChallenge,
  Principal,
  RawTokenClaims,
  SessionPayload,
  SessionScope,
  SourceRootCandidate,
  StorePort,
} from "./contracts.js";
import { DEFAULT_ORCHESTRATION_BUDGET } from "./contracts.js";
import { DisabledBridge, InMemoryStore, createSessionId } from "./fakes.js";
import { DEFAULT_PAIRING_TTL_MS, PairingLedger, pairingMessage, verifyPairing } from "./pairing.js";
import {
  DEFAULT_BODY_LIMIT,
  DEFAULT_PAGE_SIZE,
  HttpError,
  MAX_PAGE_SIZE,
  asRecord,
  assertScope,
  assertSessionId,
  assertScopedRecord,
  canonicalJson,
  getStatusCode,
  isRecord,
  parsePageQuery,
  readString,
  safeErrorEnvelope,
  safeHeader,
  sanitizeSessionPayload,
  setSecurityHeaders,
  sha256,
} from "./security.js";
import type { OAuthMetadata } from "./contracts.js";
import {
  LocalBrowserSessionService,
  LocalSessionError,
} from "./local-session.js";
import {
  LocalSelectionError,
  LocalSelectionRegistry,
  type LocalSelectionBinding,
  type LocalSelectionCandidate,
} from "./local-selection.js";

export interface ServerOptions {
  readonly store?: StorePort;
  readonly bridge?: BridgePort;
  readonly mcp?: McpPort;
  /** Factory for a fresh SDK McpApplication per MCP protocol session. */
  readonly mcpApplicationFactory?: () => McpApplication;
  /** Bounds/clock hooks for the app-scoped stateful MCP session registry. */
  readonly mcpSession?: Omit<McpHttpSessionManagerOptions, "applicationFactory">;
  readonly auth?: JwtAuthOptions;
  readonly authService?: AuthService;
  /**
   * Loopback-only install-and-run mode. When enabled the server exposes the
   * local browser-session bootstrap/pairing endpoints; OAuth is never
   * registered and loopback position alone is not authentication.
   */
  readonly localMode?: boolean;
  /** Agent Farm-owned directory for local installation key material. */
  readonly localDataDirectory?: string;
  /** User-configurable sub-agent orchestration budget surfaced by local status. */
  readonly orchestrationBudget?: OrchestrationBudget;
  /** Server-owned Codex installation id used by the local pairing flow. */
  readonly localInstallationId?: string;
  /** Server-only source root expected by the trusted Codex task launcher. */
  readonly expectedLocalSourceRootId?: string;
  /** Optional same-origin OAuth BFF for the standalone dashboard. */
  readonly browserAuth?: BrowserAuthBff;
  readonly bodyLimit?: number;
  readonly maxPageSize?: number;
  readonly logger?: boolean;
  readonly staticRoot?: string;
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly csp?: string;
  readonly rateLimit?: {
    readonly max: number;
    readonly windowMs: number;
  };
  readonly oauth?: Partial<OAuthMetadata> & {
    readonly authorizationServer?: string;
    readonly resourceMetadataUrl?: string;
  };
  readonly pairingTtlMs?: number;
  readonly pairingScopes?: readonly string[];
}

export interface HealthStatus {
  readonly status: "ok" | "not_ready";
  readonly service: "agent-farm-server";
  readonly version: "v1";
}

interface SessionIdempotencyEntry {
  readonly requestHash: string;
  readonly promise: Promise<AgentSessionRecord>;
}

interface RateBucket {
  startedAt: number;
  count: number;
}

interface LocalPairingBinding {
  /** Credential expiry, or a bounded reservation expiry, in epoch milliseconds. */
  readonly expiresAt: number;
}

interface LocalScopeOverride {
  readonly principal: Principal;
  readonly agentSessionId: string;
}

interface DurableLocalClaim extends LocalScopeOverride {
  readonly record: AgentSessionRecord;
  readonly sourceRootId: string;
}

const DEFAULT_CSP = [
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
const PUBLIC_TOOL_NAMES = new Set([
  "create_agent_session",
  "get_agent_hierarchy",
  "get_agent_details",
  "render_agent_hierarchy",
]);
const TOOL_SCOPES: Record<string, string> = {
  create_agent_session: "agent-session:create",
  get_agent_hierarchy: "agent-session:read",
  get_agent_details: "agent-session:read-details",
  render_agent_hierarchy: "agent-session:render",
};
const LOCAL_SCOPES = new Set([
  "agent-session:create",
  "agent-session:read",
  "agent-session:read-details",
  "agent-session:render",
  "bridge:pair",
]);



/**
 * Create the Fastify composition root.  No handler launches Codex or calls a
 * process API; all integrations arrive through the narrow ports in
 * contracts.ts.
 */
export function createApp(options: ServerOptions = {}): FastifyInstance {
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const maxPageSize = Math.max(1, Math.min(options.maxPageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE));
  const store: StorePort = options.store ?? new InMemoryStore();
  const bridge: BridgePort = options.bridge ?? new DisabledBridge();
  const mcp = options.mcp;
  const authOptions = options.auth ?? {};
  const auth: AuthService =
    options.authService ?? new JwtAuthService(authOptions);
  if (options.localMode && options.localDataDirectory === undefined) {
    throw new LocalSessionError("configuration_error", "Local session data directory is required");
  }
  const localSessions = options.localMode
    ? new LocalBrowserSessionService({ dataDirectory: options.localDataDirectory! })
    : undefined;
  const localSelections = options.localMode ? new LocalSelectionRegistry() : undefined;
  const pairing = new PairingLedger();
  const idempotency = new Map<string, SessionIdempotencyEntry>();
  const localPairingBindings = new Map<string, LocalPairingBinding>();
  /** Agent Farm view-session ID bound to each opaque local browser session. */
  const localViewSessions = new Map<string, string>();
  /** Exact private source root currently viewed by each browser session. */
  const localViewSourceRoots = new Map<string, string>();
  /** Private browser-local chat registry; source roots never cross HTTP. */
  const localChatSessions = new Map<string, Map<string, LocalScopeOverride>>();
  /** Restart-claim override for the one durable installation binding. */
  const localScopeOverrides = new Map<string, LocalScopeOverride>();
  /** Arrival-ordered view mutation version; the latest switch always wins. */
  const localViewSelectionVersions = new Map<string, number>();
  /** One cached resolver result and one process-local browser claimant. */
  let localClaimResolution: Promise<DurableLocalClaim | null> | undefined;
  let localClaimTaken = false;
  let trustedFocusSourceRootId = options.expectedLocalSourceRootId;
  let trustedFocusVersion = trustedFocusSourceRootId === undefined ? 0 : 1;
  let trustedFocusChangedAt = Date.now();
  const localCsrfByRequest = new WeakMap<FastifyRequest, string>();
  const pruneLocalPairingBindings = (): void => {
    const now = Date.now();
    for (const [bindingKey, binding] of localPairingBindings) {
      if (binding.expiresAt <= now) localPairingBindings.delete(bindingKey);
    }
  };
  const rememberLocalChat = (browserSessionId: string, sourceRootId: string, scope: LocalScopeOverride): void => {
    const chats = localChatSessions.get(browserSessionId) ?? new Map<string, LocalScopeOverride>();
    chats.set(sourceRootId, scope);
    localChatSessions.set(browserSessionId, chats);
  };
  const restoreDurableChat = async (installationId: string, sourceRootId: string): Promise<LocalScopeOverride | undefined> => {
    const activePairings = bridge.listActivePairings !== undefined
      ? await bridge.listActivePairings(installationId)
      : [await bridge.resolveActivePairing?.(installationId)].filter((value) => value !== null && value !== undefined);
    const active = activePairings.find((candidate) => candidate.installationId === installationId && candidate.sourceRootId === sourceRootId);
    if (active === undefined) return undefined;
    const getSession = store.getAgentSession ?? store.getSession;
    if (getSession === undefined) throw new HttpError(503, "PAIRING_UNAVAILABLE", "The local pairing is temporarily unavailable");
    const principal = localPrincipalForBinding(active);
    const record = await getSession.call(store, { ownerId: principal.ownerId, tenantId: principal.tenantId, agentSessionId: active.agentSessionId });
    if (record === null) throw new HttpError(503, "PAIRING_UNAVAILABLE", "The local pairing is temporarily unavailable");
    assertScopedRecord(record, { ownerId: principal.ownerId, tenantId: principal.tenantId, agentSessionId: active.agentSessionId });
    return { principal, agentSessionId: active.agentSessionId };
  };
  const rateBuckets = new Map<string, RateBucket>();
  // A standalone local view can legitimately burst one hierarchy request plus
  // up to 32 bounded detail reads on every task switch. Keep the public API's
  // conservative default while giving the already loopback-gated local UI
  // enough headroom for repeated switches and revision polling.
  const rateLimit = options.rateLimit ?? (options.localMode
    ? { max: 1_200, windowMs: 60_000 }
    : { max: 120, windowMs: 60_000 });
  const pairingScopes = new Set(options.pairingScopes ?? ["bridge:ingest"]);
  const metadata: OAuthMetadata = {
    resource: options.oauth?.resource ?? "https://agent-farm.local",
    ...(options.oauth?.authorizationServer
      ? { authorizationServer: options.oauth.authorizationServer }
      : {}),
    scopesSupported: options.oauth?.scopesSupported ?? [
      "agent-session:create",
      "agent-session:read",
      "agent-session:read-details",
      "agent-session:render",
      "bridge:pair",
    ],
  };

  const app = Fastify({
    bodyLimit,
    logger: options.logger ?? false,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });
  const mcpSessionManager = options.mcpApplicationFactory === undefined
    ? undefined
    : createMcpHttpSessionManager({
        applicationFactory: options.mcpApplicationFactory,
        ...(options.mcpSession ?? {}),
      });

  if (mcpSessionManager !== undefined) {
    app.addHook("onClose", async () => {
      await mcpSessionManager.cleanup();
    });
  }
  if (!options.localMode && options.browserAuth !== undefined) {
    registerBrowserAuthRoutes(app, options.browserAuth);
    app.addHook("onClose", async () => {
      options.browserAuth?.cleanup();
    });
  }

  // Local-mode loopback/bearer enforcement must run before @fastify/cors so a
  // remote client cannot receive a CORS preflight response before the guard.
  // Fastify runs onRequest hooks in registration order; registering this hook
  // before the cors plugin puts the loopback gate ahead of the preflight
  // short-circuit.
  if (options.localMode) {
    app.post("/api/v1/local/focus", async (request, reply) => {
      const body = asRecord(request.body);
      if (Object.keys(body).some((key) => key !== "sourceRootId" && key !== "issuedAt" && key !== "nonce" && key !== "signature") ||
        localSessions?.verifyFocusProof({ sourceRootId: body.sourceRootId, issuedAt: body.issuedAt, nonce: body.nonce, signature: body.signature }) !== true) {
        throw new HttpError(403, "INVALID_FOCUS_PROOF", "The current chat signal is invalid");
      }
      trustedFocusSourceRootId = body.sourceRootId as string;
      trustedFocusVersion += 1;
      trustedFocusChangedAt = Date.now();
      reply.code(200).send({ focused: true, focusVersion: trustedFocusVersion });
    });

    // Current-chat polling must not run the expensive source-root discovery or
    // rotate one-time selection capabilities. The browser requests the full
    // catalog only after this lightweight version changes.
    app.get("/api/v1/local/focus", async (request, reply) => {
      await authenticated(request);
      const session = localSessions?.authenticate(request.headers.cookie);
      const agentSessionId = session === undefined ? undefined : localViewSessions.get(session.sessionId);
      if (session === undefined || agentSessionId === undefined) {
        throw new HttpError(401, "UNAUTHENTICATED", "Authentication is required");
      }
      reply.code(200).send({
        focusVersion: trustedFocusVersion,
        focusChangedAt: new Date(trustedFocusChangedAt).toISOString(),
        agentSessionId,
      });
    });

    app.addHook("onRequest", async (request, reply) => {
      if (!isLoopbackRequest(request, options.allowedHosts)) {
        throw new HttpError(403, "LOCAL_MODE_LOOPBACK_REQUIRED", "Local mode is available only over loopback");
      }
      if (hasForwardedHeader(request)) {
        throw new HttpError(403, "LOCAL_MODE_FORWARDED_HEADER_REJECTED", "Forwarded requests are not accepted");
      }
      if (request.headers.authorization !== undefined) {
        throw new HttpError(401, "UNAUTHENTICATED", "Local mode does not accept bearer tokens");
      }
      if (hasTokenLikeUrl(request.url)) {
        throw new HttpError(400, "INVALID_REQUEST", "The request is invalid");
      }
      const origin = request.headers.origin;
      if (typeof origin === "string" && !isExactLocalOrigin(origin, request)) {
        throw new HttpError(403, "LOCAL_MODE_ORIGIN_REQUIRED", "The request origin is not allowed");
      }
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS" && origin === undefined) {
        throw new HttpError(403, "LOCAL_MODE_ORIGIN_REQUIRED", "The request origin is not allowed");
      }
    });
  }

  // @fastify/cors is registered even for a standalone deployment.  An empty
  // origin list is intentionally deny-by-default; credentials never combine
  // with a wildcard origin.
  void app.register(cors, {
    credentials: true,
    methods: ["GET", "HEAD", "POST", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "X-Idempotency-Key",
      "X-Request-Id",
      "X-CSRF-Token",
    ],
    origin: (origin, callback) => {
      const allowedOrigins = options.allowedOrigins ?? [];
      if (origin && allowedOrigins.includes(origin)) {
        callback(null, origin);
      } else {
        callback(null, false);
      }
    },
  });

  if (options.staticRoot) {
    void app.register(fastifyStatic, {
      root: options.staticRoot,
      // The standalone Vite build is mounted at the server root. API/MCP
      // routes remain exact Fastify routes and therefore win over this
      // wildcard static route.
      prefix: "/",
      decorateReply: false,
      index: "index.html",
    });
  }

  app.addHook("onRequest", async (request, reply) => {
    setSecurityHeaders(reply, options.csp ?? DEFAULT_CSP);


    if (options.allowedHosts !== undefined && !isAllowedHost(request.headers.host, options.allowedHosts)) {
      throw new HttpError(400, "INVALID_HOST", "The request host is not allowed");
    }

    const contentLength = request.headers["content-length"];
    if (typeof contentLength === "string") {
      const parsed = Number(contentLength);
      if (Number.isFinite(parsed) && parsed > bodyLimit) {
        throw new HttpError(413, "REQUEST_TOO_LARGE", "The request is too large");
      }
    }

    const now = Date.now();
    // Rate-limit the network principal rather than a bearer hash. Otherwise a
    // caller could evade the limit by minting many malformed tokens; no token
    // material is retained in the bucket map.
    const identity = request.ip;
    const bucket = rateBuckets.get(identity);
    if (!bucket || now - bucket.startedAt >= rateLimit.windowMs) {
      rateBuckets.set(identity, { startedAt: now, count: 1 });
    } else {
      bucket.count += 1;
      if (bucket.count > rateLimit.max) {
        reply.header("retry-after", String(Math.ceil((rateLimit.windowMs - (now - bucket.startedAt)) / 1000)));
        throw new HttpError(429, "RATE_LIMITED", "Too many requests");
      }
    }
  });

  // Local mutations consume the supplied one-time CSRF token before handler
  // dispatch. Emit its replacement even when the handler later fails so the
  // client can recover without reviving replayable material.
  if (options.localMode) {
    app.addHook("onSend", async (request, reply) => {
      const nextCsrf = localCsrfByRequest.get(request);
      if (nextCsrf !== undefined) reply.header("x-csrf-token", nextCsrf);
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof LocalSessionError) {
      const mappedCode = error.code === "csrf_failed"
        ? "CSRF_FAILED"
        : error.code === "not_authenticated"
          ? "UNAUTHENTICATED"
          : "CONFIGURATION_ERROR";
      const mapped = new HttpError(
        error.statusCode,
        mappedCode,
        mappedCode === "CSRF_FAILED" ? "CSRF validation failed" : mappedCode === "UNAUTHENTICATED" ? "Authentication is required" : "Authentication failed",
      );
      reply.code(error.statusCode).send(safeErrorEnvelope(request, mapped));
      return;
    }
    const statusCode = getStatusCode(error);
    if (error instanceof HttpError && error.headers) {
      for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
    }
    if (reply.sent) return;
    reply.code(statusCode).send(safeErrorEnvelope(request, error));
  });

  app.setNotFoundHandler((request, reply) => {
    if (shouldServeSpaIndex(request) && options.staticRoot) {
      const indexPath = join(options.staticRoot, "index.html");
      if (existsSync(indexPath)) {
        reply.type("text/html; charset=utf-8").send(createReadStream(indexPath));
        return;
      }
    }
    reply.code(404).send(safeErrorEnvelope(request, new HttpError(404, "NOT_FOUND", "The requested resource was not found")));
  });

  app.get("/healthz", async (_request, reply): Promise<HealthStatus> => {
    reply.code(200);
    return { status: "ok", service: "agent-farm-server", version: "v1" };
  });
  app.get("/health", async (_request, reply): Promise<HealthStatus> => {
    reply.code(200);
    return { status: "ok", service: "agent-farm-server", version: "v1" };
  });
  app.get("/readyz", async (_request, reply): Promise<HealthStatus> => {
    const ready = await serviceReady(store) && (await serviceReady(options.bridge)) && (await serviceReady(mcp));
    const status: HealthStatus = {
      status: ready ? "ok" : "not_ready",
      service: "agent-farm-server",
      version: "v1",
    };
    reply.code(ready ? 200 : 503);
    return status;
  });
  app.get("/ready", async (_request, reply): Promise<HealthStatus> => {
    const ready = await serviceReady(store) && (await serviceReady(options.bridge)) && (await serviceReady(mcp));
    const status: HealthStatus = {
      status: ready ? "ok" : "not_ready",
      service: "agent-farm-server",
      version: "v1",
    };
    reply.code(ready ? 200 : 503);
    return status;
  });

  if (!options.localMode) {
    app.get("/.well-known/oauth-protected-resource", async (_request, reply) => {
      const value: Record<string, unknown> = {
        resource: metadata.resource,
        scopes_supported: metadata.scopesSupported,
        bearer_methods_supported: ["header"],
      };
      if (metadata.authorizationServer) {
        value.authorization_servers = [metadata.authorizationServer];
      }
      reply.code(200).send(value);
    });
    // Some OAuth clients request metadata relative to the protected API path.
    app.get("/.well-known/oauth-protected-resource/mcp", async (_request, reply) => {
      const value: Record<string, unknown> = {
        resource: metadata.resource,
        scopes_supported: metadata.scopesSupported,
        bearer_methods_supported: ["header"],
      };
      if (metadata.authorizationServer) value.authorization_servers = [metadata.authorizationServer];
      reply.code(200).send(value);
    });
  }

  if (options.localMode) {
    app.get("/api/v1/local/bootstrap", async (request, reply) => {
      const issue = localSessions?.issueBootstrap(isSecureTransport(request));
      if (issue === undefined) throw new HttpError(500, "CONFIGURATION_ERROR", "Local authentication is unavailable");
      reply.header("set-cookie", issue.setCookie);
      reply.code(200).send({ localMode: true, csrfToken: issue.csrfToken, expiresAt: new Date(issue.expiresAt).toISOString() });
    });

    app.get("/api/v1/local/status", async (request, reply) => {
      const principal = await authenticated(request);
      const session = localSessions?.authenticate(request.headers.cookie);
      if (session === undefined || localSessions === undefined || localSelections === undefined) throw new HttpError(500, "CONFIGURATION_ERROR", "Local authentication is unavailable");
      const agentSessionId = localViewSessions.get(session.sessionId);
      if (agentSessionId === undefined) throw new HttpError(401, "UNAUTHENTICATED", "Authentication is required");
      const viewedSourceRootId = localViewSourceRoots.get(session.sessionId);
      const installationId = options.localInstallationId ?? "codex-local-dev";
      const selectionBinding = localSelectionBinding(principal, session.sessionId, installationId, agentSessionId);
      const csrfToken = localSessions.currentCsrfToken(request.headers.cookie);
      let paired = false;
      let activeSourceRootId: string | undefined;
      const browserChats = localChatSessions.get(session.sessionId);
      let monitoredSourceRootIds = new Set<string>();
      let roots: SourceRootCandidate[] = [];
      let discoveryError: "source_roots_unavailable" | undefined;
      try {
        const activePairings = bridge.listActivePairings !== undefined
          ? await bridge.listActivePairings(installationId)
          : [await bridge.resolveActivePairing?.(installationId)].filter((value) => value !== null && value !== undefined);
        const active = activePairings.find((candidate) =>
          candidate.installationId === installationId &&
          candidate.tenantId === principal.tenantId &&
          candidate.ownerId === principal.ownerId &&
          candidate.agentSessionId === agentSessionId &&
          (viewedSourceRootId === undefined || candidate.sourceRootId === viewedSourceRootId),
        );
        paired = active !== undefined;
        monitoredSourceRootIds = new Set(activePairings.map((candidate) => candidate.sourceRootId));
        if (active !== undefined) activeSourceRootId = active.sourceRootId;
      } catch {
        throw new HttpError(503, "PAIRING_UNAVAILABLE", "The local pairing is temporarily unavailable");
      }
      try {
        if (bridge.listSourceRoots !== undefined) roots = [...await bridge.listSourceRoots()];
      } catch {
        discoveryError = "source_roots_unavailable";
      }
      // Every status call is a new exact candidate generation. A small bounded
      // set of recent generations remains valid so another same-origin tab or
      // a focus refresh cannot invalidate an already-started user click.
      const snapshot = localSelections.issueSnapshot(selectionBinding, roots, activeSourceRootId, trustedFocusSourceRootId);
      const candidateRoots: readonly LocalSelectionCandidate[] = snapshot.candidates.map((candidate, index) => {
        const root = roots[index];
        return root !== undefined && (browserChats?.has(root.sourceRootId) === true || monitoredSourceRootIds.has(root.sourceRootId))
          ? { ...candidate, ...(root.sourceRootId === activeSourceRootId ? { active: true as const } : {}), bound: true as const }
          : candidate;
      });
      const activeCandidate = candidateRoots.find((candidate) => candidate.active === true);
      reply.code(200).send({
        localMode: true,
        csrfToken,
        sessionExpiresAt: new Date(session.expiresAt).toISOString(),
        orchestrationBudget: options.orchestrationBudget ?? DEFAULT_ORCHESTRATION_BUDGET,
        agentSessionId,
        paired,
        focusVersion: trustedFocusVersion,
        focusChangedAt: new Date(trustedFocusChangedAt).toISOString(),
        ...(paired && activeCandidate !== undefined ? { activeTask: {
          displayName: activeCandidate.displayName,
          ...(activeCandidate.chatTitle === undefined ? {} : { chatTitle: activeCandidate.chatTitle }),
          ...(activeCandidate.workspaceName === undefined ? {} : { workspaceName: activeCandidate.workspaceName }),
          lifecycle: activeCandidate.lifecycle,
          ...(activeCandidate.lastActivityAt === undefined ? {} : { lastActivityAt: activeCandidate.lastActivityAt }),
        } } : {}),
        sourceRootCount: candidateRoots.length,
        candidateRoots,
        ...(discoveryError === undefined ? {} : { discoveryError }),
      });
    });

    app.post("/api/v1/local/session", async (request, reply) => {
      const issue = localSessions?.createSession(
        request.headers.cookie,
        request.headers["x-csrf-token"],
        request.headers.cookie,
        isSecureTransport(request),
      );
      if (issue === undefined) throw new HttpError(500, "CONFIGURATION_ERROR", "Local authentication is unavailable");
      reply.header("set-cookie", issue.setCookie);
      reply.header("x-csrf-token", issue.csrfToken);
      const installationId = options.localInstallationId ?? "codex-local-dev";
      const existingAgentSessionId = localViewSessions.get(issue.session.sessionId);
      const getSession = store.getAgentSession ?? store.getSession;
      if (existingAgentSessionId !== undefined && getSession !== undefined) {
        const existingOverride = localScopeOverrides.get(issue.session.sessionId);
        const existingPrincipal = existingOverride?.principal ?? localPrincipalForAuthenticatedSession(issue.session.sessionId);
        const existing = await getSession.call(store, {
          ownerId: existingPrincipal.ownerId,
          tenantId: existingPrincipal.tenantId,
          agentSessionId: existingAgentSessionId,
        });
        if (existing !== null) {
          assertScopedRecord(existing, {
            ownerId: existingPrincipal.ownerId,
            tenantId: existingPrincipal.tenantId,
            agentSessionId: existing.agentSessionId,
          });
          reply.code(200).send({
            agentSessionId: existing.agentSessionId,
            session: publicSession(existing),
            csrfToken: issue.csrfToken,
          });
          return;
        }
        if (existingOverride !== undefined) {
          // A claimed durable session disappearing is a fail-closed state;
          // silently deriving a new owner would create a phantom remount.
          throw new HttpError(503, "PAIRING_UNAVAILABLE", "The local pairing is temporarily unavailable");
        }
        // A deliberate unpair/revocation removes the in-memory scope. Do not
        // resurrect a deleted/unknown durable session on the next bootstrap.
        localViewSessions.delete(issue.session.sessionId);
        localViewSourceRoots.delete(issue.session.sessionId);
        localScopeOverrides.delete(issue.session.sessionId);
      }

      if (localClaimResolution === undefined) {
        // Resolve and validate once for the process. A rejected promise stays
        // rejected, so a missing durable session can never fall through to a
        // phantom derived session on retry or a concurrent request.
        localClaimResolution = (async (): Promise<DurableLocalClaim | null> => {
          const active = await bridge.resolveActivePairing?.(installationId);
          if (active === null || active === undefined) return null;
          if (trustedFocusSourceRootId !== undefined && active.sourceRootId !== trustedFocusSourceRootId) return null;
          if (active.installationId !== installationId || getSession === undefined) {
            throw new Error("durable local claim is unavailable");
          }
          const claimedPrincipal = localPrincipalForBinding(active);
          const claimed = await getSession.call(store, {
            ownerId: claimedPrincipal.ownerId,
            tenantId: claimedPrincipal.tenantId,
            agentSessionId: active.agentSessionId,
          });
          if (claimed === null) throw new Error("durable local claim is unavailable");
          assertScopedRecord(claimed, {
            ownerId: claimedPrincipal.ownerId,
            tenantId: claimedPrincipal.tenantId,
            agentSessionId: active.agentSessionId,
          });
          return { principal: claimedPrincipal, agentSessionId: active.agentSessionId, sourceRootId: active.sourceRootId, record: claimed };
        })();
      }
      let durableClaim: DurableLocalClaim | null;
      try {
        durableClaim = await localClaimResolution;
      } catch {
        throw new HttpError(503, "PAIRING_UNAVAILABLE", "The local pairing is temporarily unavailable");
      }
      if (durableClaim !== null && !localClaimTaken) {
        // All concurrent requests await the same resolution. This synchronous
        // claim mark gives the durable scope to exactly one browser session.
        localClaimTaken = true;
        localScopeOverrides.set(issue.session.sessionId, {
          principal: durableClaim.principal,
          agentSessionId: durableClaim.agentSessionId,
        });
        localViewSessions.set(issue.session.sessionId, durableClaim.agentSessionId);
        localViewSourceRoots.set(issue.session.sessionId, durableClaim.sourceRootId);
        reply.code(200).send({
          agentSessionId: durableClaim.record.agentSessionId,
          session: publicSession(durableClaim.record),
          csrfToken: issue.csrfToken,
        });
        return;
      }

      const principal = localPrincipalForAuthenticatedSession(issue.session.sessionId);
      assertScope(principal, "agent-session:create");
      const payload: SessionPayload = { label: "Local", sourceAdapter: "codex-app-server" };
      const input = {
        ownerId: principal.ownerId,
        tenantId: principal.tenantId,
        agentSessionId: createSessionId(),
        idempotencyKey: `local-${sha256(installationId)}`,
        requestHash: sha256(canonicalJson(payload)),
        payload,
      } as const;
      const record = await store.createAgentSession(input);
      assertScopedRecord(record, {
        ownerId: principal.ownerId,
        tenantId: principal.tenantId,
        agentSessionId: record.agentSessionId,
      });
      localViewSessions.set(issue.session.sessionId, record.agentSessionId);
      reply.code(record.agentSessionId === input.agentSessionId ? 201 : 200).send({
        agentSessionId: record.agentSessionId,
        session: publicSession(record),
        csrfToken: issue.csrfToken,
      });
    });

    app.post("/api/v1/local/pairing/root", async (request, reply) => {
      const principal = await authenticatedMutation(request);
      assertScope(principal, "bridge:pair");
      const body = asRecord(request.body);
      // Local selection is handle-only. Caller-supplied raw roots/session
      // identities are rejected before any attestation or pairing work.
      if (Object.keys(body).some((key) => key !== "selectionHandle")) {
        throw new HttpError(400, "INVALID_SELECTION", "The selected local task is no longer available");
      }
      const selectionHandle = readString(body, "selectionHandle", { max: 128, required: true }) as string;
      const session = localSessions?.authenticate(request.headers.cookie);
      const agentSessionId = session === undefined ? undefined : localViewSessions.get(session.sessionId);
      if (session === undefined || agentSessionId === undefined || localSelections === undefined) {
        throw new HttpError(401, "UNAUTHENTICATED", "Authentication is required");
      }
      const installationId = options.localInstallationId ?? "codex-local-dev";
      const selectionBinding = localSelectionBinding(principal, session.sessionId, installationId, agentSessionId);
      let selected: ReturnType<LocalSelectionRegistry["consume"]>;
      try {
        selected = localSelections.consume(selectionHandle, selectionBinding);
      } catch (error: unknown) {
        if (error instanceof LocalSelectionError) {
          throw new HttpError(403, "INVALID_SELECTION", "The selected local task is no longer available");
        }
        throw error;
      }
      const sourceRootId = selected.sourceRootId;
      const existingChat = localChatSessions.get(session.sessionId)?.get(sourceRootId) ?? await restoreDurableChat(installationId, sourceRootId);
      if (existingChat !== undefined && await bridge.hasActivePairing?.({
        tenantId: existingChat.principal.tenantId,
        ownerId: existingChat.principal.ownerId,
        agentSessionId: existingChat.agentSessionId,
        installationId,
        sourceRootId,
      })) {
        rememberLocalChat(session.sessionId, sourceRootId, existingChat);
        localScopeOverrides.set(session.sessionId, existingChat);
        localViewSessions.set(session.sessionId, existingChat.agentSessionId);
        localViewSourceRoots.set(session.sessionId, sourceRootId);
        reply.code(200).send({ agentSessionId: existingChat.agentSessionId, paired: true, activeTask: selected.activeTask });
        return;
      }
      const bindingKey = sha256(canonicalJson({
        tenantId: principal.tenantId,
        ownerId: principal.ownerId,
        agentSessionId,
        installationId,
        sourceRootId,
      }));
      pruneLocalPairingBindings();
      if (localPairingBindings.has(bindingKey)) {
        throw new HttpError(409, "PAIRING_ALREADY_COMPLETED", "The selected Codex source root is already paired");
      }
      // Reserve before attestation so concurrent loopback requests cannot mint
      // two credentials for one binding. Failed attempts release the key; a
      // successful issuance records the credential expiry, while a durable
      // active bridge binding (when available) remains authoritative after
      // this process restarts.
      localPairingBindings.set(bindingKey, { expiresAt: Date.now() + DEFAULT_PAIRING_TTL_MS });
      let completed = false;
      try {
        await ensureSession(principal, agentSessionId);
        pruneLocalPairingBindings();
        const activePairings = bridge.listActivePairings !== undefined
          ? await bridge.listActivePairings(installationId)
          : [await bridge.resolveActivePairing?.(installationId)].filter((value) => value !== null && value !== undefined);
        const exactActive = activePairings.find((candidate) =>
          candidate.tenantId === principal.tenantId && candidate.ownerId === principal.ownerId && candidate.agentSessionId === agentSessionId,
        );
        const authoritativeReplacement = selected.launchTarget === true && trustedFocusSourceRootId === selected.sourceRootId;
        let durableActive: (typeof activePairings)[number] | undefined;
        if (activePairings.length > 0) {
          if (authoritativeReplacement) {
            if (activePairings.length !== 1) {
              throw new HttpError(409, "PAIRING_UNAVAILABLE", "Pairing is temporarily unavailable");
            }
            durableActive = activePairings[0];
          } else if (exactActive === undefined) {
            throw new HttpError(409, "PAIRING_UNAVAILABLE", "Pairing is temporarily unavailable");
          } else {
            throw new HttpError(409, "PAIRING_ALREADY_COMPLETED", "The local pairing is already complete");
          }
        }
        if (await bridge.hasActivePairing?.({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          agentSessionId,
          installationId,
          sourceRootId,
        })) {
          throw new HttpError(409, "PAIRING_ALREADY_COMPLETED", "The selected Codex source root is already paired");
        }
        const challenge = await createAttestedPairingChallengeForSelection(principal, {
          installationId,
          publicKey: "local-loopback",
          sourceRootId,
          agentSessionId,
          requestedScopes: [...pairingScopes],
        });
        const consumed = pairing.consume(challenge.pairingId);
        let issued: Awaited<ReturnType<BridgePort["issuePairingCredential"]>>;
        try {
          issued = await bridge.issuePairingCredential({
            ...consumed,
            ...(durableActive === undefined ? {} : {
              replaceExisting: true,
              expectedSourceRootId: durableActive.sourceRootId,
              expectedActiveBinding: durableActive,
            }),
          });
        } catch {
          throw new HttpError(503, "PAIRING_UNAVAILABLE", "Pairing is temporarily unavailable");
        }
        const issuedExpiry = Date.parse(issued.expiresAt);
        localPairingBindings.set(bindingKey, {
          expiresAt: Number.isFinite(issuedExpiry)
            ? issuedExpiry
            : Date.now() + DEFAULT_PAIRING_TTL_MS,
        });
        completed = true;
        rememberLocalChat(session.sessionId, sourceRootId, { principal, agentSessionId });
        localViewSourceRoots.set(session.sessionId, sourceRootId);
        reply.code(201).send({
          agentSessionId: consumed.agentSessionId,
          paired: true,
          expiresAt: issued.expiresAt,
          activeTask: selected.activeTask,
        });
      } finally {
        if (!completed) localPairingBindings.delete(bindingKey);
      }
    });

    app.post("/api/v1/local/pairing/switch", async (request, reply) => {
      const principal = await authenticatedMutation(request);
      assertScope(principal, "bridge:pair");
      const body = asRecord(request.body);
      if (Object.keys(body).some((key) => key !== "selectionHandle" && key !== "confirmation") || body.confirmation !== true) {
        throw new HttpError(400, "CONFIRMATION_REQUIRED", "Confirmation is required");
      }
      const selectionHandle = readString(body, "selectionHandle", { max: 128, required: true }) as string;
      const session = localSessions?.authenticate(request.headers.cookie);
      const agentSessionId = session === undefined ? undefined : localViewSessions.get(session.sessionId);
      if (session === undefined || agentSessionId === undefined || localSelections === undefined) {
        throw new HttpError(401, "UNAUTHENTICATED", "Authentication is required");
      }
      const viewSelectionVersion = (localViewSelectionVersions.get(session.sessionId) ?? 0) + 1;
      localViewSelectionVersions.set(session.sessionId, viewSelectionVersion);
      const isLatestViewSelection = (): boolean => localViewSelectionVersions.get(session.sessionId) === viewSelectionVersion;
      const installationId = options.localInstallationId ?? "codex-local-dev";
      const activePairings = bridge.listActivePairings !== undefined
        ? await bridge.listActivePairings(installationId)
        : [await bridge.resolveActivePairing?.(installationId)].filter((value) => value !== null && value !== undefined);
      const active = activePairings.find((candidate) =>
        candidate.tenantId === principal.tenantId && candidate.ownerId === principal.ownerId && candidate.agentSessionId === agentSessionId,
      );
      const selectionBinding = localSelectionBinding(principal, session.sessionId, installationId, agentSessionId);
      let selected: ReturnType<LocalSelectionRegistry["consume"]>;
      try {
        selected = localSelections.consume(selectionHandle, selectionBinding, { allowReplay: true });
      } catch (error: unknown) {
        if (error instanceof LocalSelectionError) {
          throw new HttpError(403, "INVALID_SELECTION", "The selected local task is no longer available");
        }
        throw error;
      }
      const existingChat = localChatSessions.get(session.sessionId)?.get(selected.sourceRootId) ?? await restoreDurableChat(installationId, selected.sourceRootId);
      const existingActive = existingChat === undefined ? undefined : activePairings.find((candidate) =>
        candidate.tenantId === existingChat.principal.tenantId &&
        candidate.ownerId === existingChat.principal.ownerId &&
        candidate.agentSessionId === existingChat.agentSessionId &&
        candidate.installationId === installationId &&
        candidate.sourceRootId === selected.sourceRootId,
      );
      if (existingChat !== undefined && existingActive !== undefined) {
        if (!isLatestViewSelection()) {
          throw new HttpError(409, "SWITCH_SUPERSEDED", "A newer chat selection is already active");
        }
        rememberLocalChat(session.sessionId, selected.sourceRootId, existingChat);
        localScopeOverrides.set(session.sessionId, existingChat);
        localViewSessions.set(session.sessionId, existingChat.agentSessionId);
        localViewSourceRoots.set(session.sessionId, selected.sourceRootId);
        // The durable snapshot can be shown immediately. Remount or retry its
        // sole authorized runtime worker without making navigation wait for a
        // complete reconciliation.
        void Promise.resolve(bridge.ensureActivePairing?.(existingActive)).catch(() => undefined);
        reply.code(200).send({ agentSessionId: existingChat.agentSessionId, paired: true, activeTask: selected.activeTask });
        return;
      }
      if (selected.replayed === true) {
        throw new HttpError(403, "INVALID_SELECTION", "The selected local task is no longer available");
      }
      if (active === undefined) {
        throw new HttpError(409, "PAIRING_UNAVAILABLE", "Pairing is temporarily unavailable");
      }
      // A different Codex root receives a different projection session. Reusing
      // the old session would retain historical agents and mix two tasks.
      const nextPrincipal = localPrincipalForSession(`${session.sessionId}:${selected.sourceRootId}`, installationId);
      const nextAgentSessionId = createSessionId();
      const nextPayload: SessionPayload = { label: "Local", sourceAdapter: "codex-app-server" };
      const nextRecord = await store.createAgentSession({
        ownerId: nextPrincipal.ownerId,
        tenantId: nextPrincipal.tenantId,
        agentSessionId: nextAgentSessionId,
        idempotencyKey: `local-switch-${sha256(canonicalJson({ installationId, sourceRootId: selected.sourceRootId, sessionId: session.sessionId }))}`,
        requestHash: sha256(canonicalJson(nextPayload)),
        payload: nextPayload,
      });
      assertScopedRecord(nextRecord, { ownerId: nextPrincipal.ownerId, tenantId: nextPrincipal.tenantId, agentSessionId: nextRecord.agentSessionId });
      const newBindingKey = sha256(canonicalJson({
        tenantId: nextPrincipal.tenantId,
        ownerId: nextPrincipal.ownerId,
        agentSessionId: nextRecord.agentSessionId,
        installationId,
        sourceRootId: selected.sourceRootId,
      }));
      pruneLocalPairingBindings();
      if (localPairingBindings.has(newBindingKey)) {
        throw new HttpError(409, "PAIRING_ALREADY_COMPLETED", "The selected local task is already paired");
      }
      localPairingBindings.set(newBindingKey, { expiresAt: Date.now() + DEFAULT_PAIRING_TTL_MS });
      if (!isLatestViewSelection()) {
        localPairingBindings.delete(newBindingKey);
        throw new HttpError(409, "SWITCH_SUPERSEDED", "A newer chat selection is already active");
      }
      const pendingScope = { principal: nextPrincipal, agentSessionId: nextRecord.agentSessionId };
      localScopeOverrides.set(session.sessionId, pendingScope);
      localViewSessions.set(session.sessionId, nextRecord.agentSessionId);
      localViewSourceRoots.set(session.sessionId, selected.sourceRootId);
      // Navigation is now independent from the expensive source-root
      // attestation and first reconciliation. The selected session exposes no
      // hierarchy until those trusted checks succeed.
      reply.code(200).send({
        agentSessionId: nextRecord.agentSessionId,
        paired: true,
        syncing: true,
        activeTask: selected.activeTask,
      });
      setImmediate(() => {
        void (async (): Promise<void> => {
          const challenge = await createAttestedPairingChallengeForSelection(nextPrincipal, {
            installationId,
            publicKey: "local-loopback",
            sourceRootId: selected.sourceRootId,
            agentSessionId: nextRecord.agentSessionId,
            requestedScopes: [...pairingScopes],
          });
          const consumed = pairing.consume(challenge.pairingId);
          if (!isLatestViewSelection()) {
            throw new HttpError(409, "SWITCH_SUPERSEDED", "A newer chat selection is already active");
          }
          const issued = await bridge.issuePairingCredential({
            ...consumed,
            ownerId: nextPrincipal.ownerId,
            tenantId: nextPrincipal.tenantId,
            agentSessionId: nextRecord.agentSessionId,
            replaceExisting: true,
            expectedActiveBinding: active,
            activationStillCurrent: isLatestViewSelection,
            deferRuntimeActivation: true,
          });
          const issuedExpiry = Date.parse(issued.expiresAt);
          localPairingBindings.set(newBindingKey, {
            expiresAt: Number.isFinite(issuedExpiry) ? issuedExpiry : Date.now() + DEFAULT_PAIRING_TTL_MS,
          });
          rememberLocalChat(session.sessionId, selected.sourceRootId, pendingScope);
        })().catch(() => {
          localPairingBindings.delete(newBindingKey);
          // Roll back only if this failed selection still owns the browser
          // pointer. A newer selection must never be overwritten.
          if (isLatestViewSelection()) {
            const previousScope = { principal, agentSessionId };
            localScopeOverrides.set(session.sessionId, previousScope);
            localViewSessions.set(session.sessionId, agentSessionId);
            localViewSourceRoots.set(session.sessionId, active.sourceRootId);
          }
        });
      });
    });

    app.post("/api/v1/local/pairing/unpair", async (request, reply) => {
      const principal = await authenticatedMutation(request);
      assertScope(principal, "bridge:pair");
      const body = asRecord(request.body);
      if (Object.keys(body).some((key) => key !== "confirmation") || body.confirmation !== true) {
        throw new HttpError(400, "CONFIRMATION_REQUIRED", "Confirmation is required");
      }
      const session = localSessions?.authenticate(request.headers.cookie);
      const agentSessionId = session === undefined ? undefined : localViewSessions.get(session.sessionId);
      if (session === undefined || agentSessionId === undefined) {
        throw new HttpError(401, "UNAUTHENTICATED", "Authentication is required");
      }
      const installationId = options.localInstallationId ?? "codex-local-dev";
      const viewedSourceRootId = localViewSourceRoots.get(session.sessionId);
      const activePairings = bridge.listActivePairings !== undefined
        ? await bridge.listActivePairings(installationId)
        : [await bridge.resolveActivePairing?.(installationId)].filter((value) => value !== null && value !== undefined);
      const active = activePairings.find((candidate) =>
        candidate.tenantId === principal.tenantId &&
        candidate.ownerId === principal.ownerId &&
        candidate.agentSessionId === agentSessionId &&
        (viewedSourceRootId === undefined || candidate.sourceRootId === viewedSourceRootId),
      );
      const ownsActive = active !== null && active !== undefined &&
        active.tenantId === principal.tenantId && active.ownerId === principal.ownerId && active.agentSessionId === agentSessionId;
      if (ownsActive) {
        try {
          if (bridge.revokePairing === undefined) throw new Error("pairing revocation is unavailable");
          const revoked = await bridge.revokePairing({
            tenantId: principal.tenantId,
            ownerId: principal.ownerId,
            agentSessionId,
            installationId,
            sourceRootId: active!.sourceRootId,
            reason: "unpair",
          });
          if (revoked !== true) throw new Error("pairing revocation was not committed");
        } catch {
          throw new HttpError(503, "PAIRING_UNAVAILABLE", "Pairing is temporarily unavailable");
        }
        const oldBindingKey = sha256(canonicalJson({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          agentSessionId,
          installationId,
          sourceRootId: active!.sourceRootId,
        }));
        localPairingBindings.delete(oldBindingKey);
        if (localSelections !== undefined) localSelections.invalidate(localSelectionBinding(principal, session.sessionId, installationId, agentSessionId));
        localScopeOverrides.delete(session.sessionId);
        localViewSessions.delete(session.sessionId);
        localViewSourceRoots.delete(session.sessionId);
        localChatSessions.get(session.sessionId)?.delete(active!.sourceRootId);
      }
      reply.code(200).send({ paired: false });
    });
  }

  // Provision one durable Agent Farm view session for the current standalone
  // browser login. The opaque browser-session ID never leaves the server; its
  // hash is used only as an owner-scoped idempotency key.
  if (!options.localMode) {
    app.post("/api/v1/browser/session", async (request, reply) => {
      const browser = await authenticatedBrowserMutation(request);
      assertScope(browser.principal, "agent-session:create");
      const payload: SessionPayload = { label: "Standalone", sourceAdapter: "standalone" };
      const input = {
        ownerId: browser.principal.ownerId,
        tenantId: browser.principal.tenantId,
        agentSessionId: createSessionId(),
        idempotencyKey: `browser-${sha256(browser.sessionId)}`,
        requestHash: sha256(canonicalJson(payload)),
        payload,
      } as const;
      const record = await store.createAgentSession(input);
      assertScopedRecord(record, {
        ownerId: browser.principal.ownerId,
        tenantId: browser.principal.tenantId,
        agentSessionId: record.agentSessionId,
      });
      reply.code(record.agentSessionId === input.agentSessionId ? 201 : 200).send({
        agentSessionId: record.agentSessionId,
        session: publicSession(record),
      });
    });
  }

  app.post("/api/v1/sessions", async (request, reply) => {
    const principal = await authenticatedMutation(request);
    assertScope(principal, "agent-session:create");
    const { record, replay } = await createSession(principal, request);
    reply.code(replay ? 200 : 201).send({
      agentSessionId: record.agentSessionId,
      session: publicSession(record),
    });
  });
  app.post("/api/v1/agent-sessions", async (request, reply) => {
    const principal = await authenticatedMutation(request);
    assertScope(principal, "agent-session:create");
    const { record, replay } = await createSession(principal, request);
    reply.code(replay ? 200 : 201).send({
      agentSessionId: record.agentSessionId,
      session: publicSession(record),
    });
  });

  const hierarchyHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await authenticated(request);
    assertScope(principal, "agent-session:read");
    const sessionId = sessionParam(request);
    const { page, pageSize } = parsePageQuery(request.query);
    if (pageSize > maxPageSize) {
      throw new HttpError(400, "PAGE_SIZE_TOO_LARGE", `pageSize must be at most ${maxPageSize}`);
    }
    const value = await readHierarchy(principal, sessionId, page, pageSize);
    reply.code(200).send(value);
  };
  app.get("/api/v1/sessions/:sessionId/hierarchy", hierarchyHandler);
  app.get("/api/v1/agent-sessions/:sessionId/hierarchy", hierarchyHandler);

  const hierarchyRevisionHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await authenticated(request);
    assertScope(principal, "agent-session:read");
    const agentSessionId = sessionParam(request);
    const scope = { ownerId: principal.ownerId, tenantId: principal.tenantId, agentSessionId } as const;
    const revision = store.getHierarchyRevision === undefined
      ? (await readHierarchy(principal, agentSessionId, 1, 1)).watermark
      : await store.getHierarchyRevision(scope);
    if (revision === null) throw new HttpError(404, "NOT_FOUND", "The requested resource was not found");
    const parsed = HierarchyRevisionSchema.safeParse({
      schemaVersion: HIERARCHY_REVISION_SCHEMA_VERSION,
      agentSessionId,
      revision,
    });
    if (!parsed.success) throw new HttpError(500, "STORE_CONTRACT_ERROR", "Hierarchy revision is unavailable");
    reply.header("cache-control", "no-store").code(200).send(parsed.data);
  };
  app.get("/api/v1/sessions/:sessionId/hierarchy/revision", hierarchyRevisionHandler);
  app.get("/api/v1/agent-sessions/:sessionId/hierarchy/revision", hierarchyRevisionHandler);

  const detailsHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await authenticated(request);
    assertScope(principal, "agent-session:read-details");
    const sessionId = sessionParam(request);
    const params = asRecord(request.params);
    const agentId = readString(params, "agentId", { max: 256, required: true });
    const details = await readDetails(principal, sessionId, agentId as string);
    reply.code(200).send(details);
  };
  app.get("/api/v1/sessions/:sessionId/agents/:agentId", detailsHandler);
  app.get("/api/v1/sessions/:sessionId/agents/:agentId/details", detailsHandler);
  app.get("/api/v1/agent-sessions/:sessionId/agents/:agentId", detailsHandler);

  app.get("/api/v1/local/sessions/:sessionId/agents/:agentId/details", async (request, reply) => {
    if (!options.localMode) throw new HttpError(404, "NOT_FOUND", "The requested resource was not found");
    const principal = await authenticated(request);
    assertScope(principal, "agent-session:read-details");
    const sessionId = sessionParam(request);
    const params = asRecord(request.params);
    const agentId = readString(params, "agentId", { max: 256, required: true });
    const getter = store.getLocalAgentDetails;
    if (!getter) throw new HttpError(404, "NOT_FOUND", "The requested resource was not found");
    const value = await getter.call(store, {
      ownerId: principal.ownerId,
      tenantId: principal.tenantId,
      agentSessionId: sessionId,
      agentId: agentId as string,
    });
    if (value === null) throw new HttpError(404, "NOT_FOUND", "The requested resource was not found");
    const parsed = LocalAgentDetailSchema.safeParse(value);
    if (!parsed.success || parsed.data.agentSessionId !== sessionId) throw new HttpError(500, "STORE_CONTRACT_ERROR", "Local detail projection is unavailable");
    reply.code(200).send(parsed.data);
  });

  const renderHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await authenticated(request);
    assertScope(principal, "agent-session:render");
    const sessionId = sessionParam(request);
    const { page, pageSize } = parsePageQuery(request.query);
    const value = await readHierarchy(principal, sessionId, page, pageSize);
    reply.code(200).send(value);
  };
  app.get("/api/v1/sessions/:sessionId/render", renderHandler);
  app.get("/api/v1/agent-sessions/:sessionId/render", renderHandler);

  // The raw attested pairing protocol is a production/OAuth API. Local mode
  // exposes only the opaque handle route above, so a browser session can
  // never submit or receive raw root, installation, or credential fields.
  if (!options.localMode) {
    app.post("/api/v1/bridge/pairing/challenge", async (request, reply) => {
      const principal = await authenticatedMutation(request);
      assertScope(principal, "bridge:pair");
      const challenge = await createAttestedPairingChallenge(principal, request);
      // Return no derived signature material or bridge credential in the
      // challenge response.
      reply.code(201).send({
        pairingId: challenge.pairingId,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        agentSessionId: challenge.agentSessionId,
        requestedScopes: challenge.requestedScopes,
        message: pairingMessage(challenge),
      });
    });
    app.post("/api/v1/bridge/pairing", async (request, reply) => {
      const principal = await authenticatedMutation(request);
      assertScope(principal, "bridge:pair");
      const challenge = await createAttestedPairingChallenge(principal, request);
      reply.code(201).send({ pairingId: challenge.pairingId, nonce: challenge.nonce, expiresAt: challenge.expiresAt, message: pairingMessage(challenge) });
    });
    app.post("/api/v1/bridge/pairing/complete", async (request, reply) => {
      const principal = await authenticatedMutation(request);
      assertScope(principal, "bridge:pair");
      const body = asRecord(request.body);
      const pairingId = readString(body, "pairingId", { max: 256, required: true }) as string;
      const nonce = readString(body, "nonce", { max: 512, required: true }) as string;
      const signature = readString(body, "signature", { max: 8_192, required: true }) as string;
      const challenge = pairing.get(pairingId);
      if (!challenge || challenge.used || challenge.nonce !== nonce) {
        throw new HttpError(403, "PAIRING_REPLAY", "Pairing challenge is invalid or already used");
      }
      // The authenticated principal and every device/root/session binding come
      // from the challenge, never from caller-supplied owner or tenant fields.
      if (challenge.ownerId !== principal.ownerId || challenge.tenantId !== principal.tenantId) {
        throw new HttpError(403, "PAIRING_BINDING_MISMATCH", "Pairing binding is invalid");
      }
      const suppliedInstallation = readString(body, "installationId", { max: 256, required: true });
      const suppliedRoot = readString(body, "sourceRootId", { max: 512, required: true });
      const suppliedSession = readString(body, "agentSessionId", { max: 256, required: true });
      if (
        suppliedInstallation !== challenge.installationId ||
        suppliedRoot !== challenge.sourceRootId ||
        suppliedSession !== challenge.agentSessionId
      ) {
        throw new HttpError(403, "PAIRING_BINDING_MISMATCH", "Pairing binding is invalid");
      }
      const consumed = pairing.consume(pairingId);
      const valid = await verifyPairing(bridge, consumed, signature);
      if (!valid) {
        throw new HttpError(403, "INVALID_PAIRING_SIGNATURE", "Pairing signature is invalid");
      }
      try {
        const credential = await bridge.issuePairingCredential(consumed);
        reply.code(201).send({
          pairingId: consumed.pairingId,
          agentSessionId: consumed.agentSessionId,
          credential: credential.credential,
          expiresAt: credential.expiresAt,
        });
      } catch {
        throw new HttpError(503, "PAIRING_UNAVAILABLE", "Pairing is temporarily unavailable");
      }
    });
    // Keep the alias challenge-only; credential issuance remains explicit.
    app.post("/api/v1/bridge/pair", async (request, reply) => {
      const principal = await authenticatedMutation(request);
      assertScope(principal, "bridge:pair");
      const challenge = await createAttestedPairingChallenge(principal, request);
      reply.code(201).send({ pairingId: challenge.pairingId, nonce: challenge.nonce, expiresAt: challenge.expiresAt, message: pairingMessage(challenge) });
    });
  }

  // When the composition supplies the real SDK application, route through the
  // app-scoped stateful Streamable HTTP manager. The legacy JSON-RPC adapter
  // remains available for narrow REST/unit-test compositions that inject only
  // an McpPort.
  const mcpHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (options.mcpApplicationFactory !== undefined) {
      const { authInfo } = await authenticatedWithInfo(request);
      const rawRequest = request.raw as McpNodeRequest;
      rawRequest.auth = authInfo;
      reply.hijack();
      try {
        await handleMcpHttpRequest(rawRequest, reply.raw, request.body, {
          ...(mcpSessionManager === undefined ? {} : { sessionManager: mcpSessionManager }),
          applicationFactory: options.mcpApplicationFactory,
          enableJsonResponse: true,
          ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
          ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
        });
      } catch {
        // The SDK has already emitted its own protocol error whenever possible.
        // If construction/dispatch failed before headers were written, return a
        // deliberately generic JSON-RPC error without leaking token or stack
        // material.
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader("content-type", "application/json");
          reply.raw.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal server error" } }));
        }
      } finally {
        // Do not leave the bearer token attached to the long-lived Fastify raw
        // request object after the SDK has consumed it.
        delete rawRequest.auth;
      }
      return;
    }

    if (request.method !== "POST") {
      if (options.localMode && request.method === "DELETE") {
        // DELETE is a mutation even when this narrow legacy adapter returns
        // 405; validate the local session/CSRF boundary before that response.
        await authenticatedWithInfo(request);
      }
      reply.code(405).send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } });
      return;
    }
    const principal = (await authenticatedWithInfo(request)).principal;
    const body = asRecord(request.body);
    const method = typeof body.method === "string" ? body.method : "";
    const rpcId = body.id ?? null;
    if (method === "initialize") {
      reply.code(200).send({
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "agent-farm", version: "0.1.0" },
          capabilities: { tools: {} },
        },
      });
      return;
    }
    if (method === "tools/list") {
      const tools = await listTools(principal);
      reply.code(200).send({ jsonrpc: "2.0", id: rpcId, result: { tools } });
      return;
    }
    if (method === "tools/call") {
      const params = isRecord(body.params) ? body.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      if (!PUBLIC_TOOL_NAMES.has(name)) {
        reply.code(200).send({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "Tool not found" } });
        return;
      }
      const requiredScope = TOOL_SCOPES[name];
      if (requiredScope === undefined) {
        reply.code(200).send({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "Tool not found" } });
        return;
      }
      assertScope(principal, requiredScope);
      const args = isRecord(params.arguments) ? params.arguments : {};
      const result = await callTool(name, args, principal);
      reply.code(200).send({ jsonrpc: "2.0", id: rpcId, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
      return;
    }
    reply.code(200).send({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "Method not found" } });
  };
  app.route({ method: ["GET", "POST", "DELETE"], url: "/mcp", handler: mcpHandler });

  return app;

  function localPrincipalForAuthenticatedSession(sessionId: string): Principal {
    const override = localScopeOverrides.get(sessionId);
    return override?.principal ?? localPrincipalForSession(sessionId, options.localInstallationId);
  }

  async function authenticated(request: FastifyRequest): Promise<Principal> {
    // An explicit Authorization header always selects bearer auth. Never fall
    // back to a cookie after a malformed/expired bearer attempt.
    if (request.headers.authorization === undefined && options.localMode) {
      if (!isLoopbackRequest(request, options.allowedHosts)) {
        throw new HttpError(403, "LOCAL_MODE_LOOPBACK_REQUIRED", "Local mode is available only over loopback");
      }
      try {
        const session = localSessions?.authenticate(request.headers.cookie);
        if (session === undefined) throw new HttpError(500, "CONFIGURATION_ERROR", "Local authentication is unavailable");
        return localPrincipalForAuthenticatedSession(session.sessionId);
      } catch (error: unknown) {
        if (error instanceof LocalSessionError) throw error;
        throw new HttpError(401, "UNAUTHENTICATED", "Authentication is required");
      }
    }
    if (request.headers.authorization === undefined && options.browserAuth !== undefined) {
      try {
        const session = await options.browserAuth.authenticateCookie(request.headers.cookie);
        if (session) return session.principal;
      } catch {
        // Browser auth failures use the same non-enumerating REST response.
      }
      throw new HttpError(401, "UNAUTHENTICATED", "Authentication is required");
    }
    return (await authenticatedWithInfo(request)).principal;
  }

  async function authenticatedMutation(request: FastifyRequest): Promise<Principal> {
    if (request.headers.authorization !== undefined) {
      return (await authenticatedWithInfo(request)).principal;
    }
    if (options.localMode) {
      if (localSessions === undefined) throw new HttpError(500, "CONFIGURATION_ERROR", "Local authentication is unavailable");
      const validation = localSessions.requireCsrf(request.headers.cookie, request.headers["x-csrf-token"]);
      localCsrfByRequest.set(request, validation.csrfToken);
      return localPrincipalForAuthenticatedSession(validation.session.sessionId);
    }
    return (await authenticatedBrowserMutation(request)).principal;
  }

  async function authenticatedBrowserMutation(
    request: FastifyRequest,
  ): Promise<{ principal: Principal; sessionId: string }> {
    if (options.browserAuth === undefined || request.headers.authorization !== undefined) {
      throw new HttpError(401, "UNAUTHENTICATED", "Authentication is required");
    }
    try {
      const session = await options.browserAuth.requireCsrf(
        request.headers.cookie,
        request.headers["x-csrf-token"],
      );
      return { principal: session.principal, sessionId: session.sessionId };
    } catch (error: unknown) {
      const status = error instanceof BrowserAuthError ? error.statusCode : 403;
      throw new HttpError(
        status === 401 ? 401 : 403,
        status === 401 ? "UNAUTHENTICATED" : "CSRF_FAILED",
        status === 401 ? "Authentication is required" : "CSRF validation failed",
      );
    }
  }

  async function authenticatedWithInfo(request: FastifyRequest): Promise<{ principal: Principal; authInfo: McpAuthInfo }> {
    if (request.headers.authorization === undefined && options.localMode) {
      if (!isLoopbackRequest(request, options.allowedHosts)) {
        throw new HttpError(403, "LOCAL_MODE_LOOPBACK_REQUIRED", "Local mode is available only over loopback");
      }
      if (localSessions === undefined) throw new HttpError(500, "CONFIGURATION_ERROR", "Local authentication is unavailable");
      if (request.method === "POST" || request.method === "DELETE" || request.method === "PUT" || request.method === "PATCH") {
        const validation = localSessions.requireCsrf(request.headers.cookie, request.headers["x-csrf-token"]);
        localCsrfByRequest.set(request, validation.csrfToken);
      } else {
        localSessions.authenticate(request.headers.cookie);
      }
      const session = localSessions.authenticate(request.headers.cookie);
      const principal = localPrincipalForAuthenticatedSession(session.sessionId);
      return {
        principal,
        authInfo: {
          // The MCP manager must not collapse two browser sessions onto one
          // auth key. This is a server-derived digest-backed subject, never a
          // raw cookie, session id, or CSRF value.
          token: principal.subject,
          clientId: principal.subject,
          scopes: [...principal.scopes],
          extra: {
            ownerId: principal.ownerId,
            tenantId: principal.tenantId,
            sub: principal.subject,
          },
        },
      };
    }
    const token = extractBearerToken(request.headers.authorization);
    const metadataUrl = options.oauth?.resourceMetadataUrl ?? "/.well-known/oauth-protected-resource";
    if (!token) {
      throw new HttpError(401, "UNAUTHENTICATED", "Authentication is required", {
        headers: {
          "www-authenticate": `Bearer realm="agent-farm", resource_metadata="${metadataUrl}"`,
        },
      });
    }
    let claims: RawTokenClaims;
    try {
      const expectedResource = authOptions.resource ?? options.oauth?.resource;
      claims = await auth.authenticateToken(token, {
        ...(authOptions.audience ? { audience: authOptions.audience } : {}),
        ...(authOptions.issuer ? { issuer: authOptions.issuer } : {}),
        ...(expectedResource ? { resource: expectedResource } : {}),
      });
      assertTokenClaims(claims, {
        ...authOptions,
        ...(expectedResource ? { resource: expectedResource } : {}),
      }, {
        ...(authOptions.audience ? { audience: authOptions.audience } : {}),
        ...(authOptions.issuer ? { issuer: authOptions.issuer } : {}),
        ...(expectedResource ? { resource: expectedResource } : {}),
      });
    } catch (error: unknown) {
      const code = error instanceof AuthenticationError ? error.code : "invalid_token";
      const detail = code === "expired_token" ? "Token expired" : "Authentication failed";
      throw new HttpError(401, "UNAUTHENTICATED", detail, {
        headers: {
          "www-authenticate": `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`,
        },
      });
    }
    const principal = claimsToPrincipal(claims);
    const expectedResource = authOptions.resource ?? options.oauth?.resource;
    const resource = authInfoResource(claims, expectedResource);
    const extra: Record<string, unknown> = {
      ownerId: principal.ownerId,
      tenantId: principal.tenantId,
      sub: principal.subject,
      ...(principal.issuer === undefined ? {} : { iss: principal.issuer }),
      ...(principal.audience === undefined ? {} : { aud: principal.audience }),
      ...(principal.tokenId === undefined ? {} : { jti: principal.tokenId }),
    };
    if (typeof claims.sid === "string" && claims.sid.length > 0 && claims.sid.length <= 256) {
      // `sid` is a refresh-stable OAuth grant identifier. It is distinct from
      // the manager-generated Agent Farm session ID and is required for MCP
      // session continuity across token refresh.
      extra.sid = claims.sid;
    }
    const sessionClaim = claims.agentSessionId ?? claims.agent_session_id;
    if (typeof sessionClaim === "string" && sessionClaim.length > 0 && sessionClaim.length <= 256) {
      extra.agentSessionId = sessionClaim;
    }
    const authInfo: McpAuthInfo = {
      token,
      clientId: principal.subject,
      scopes: [...principal.scopes],
      ...(typeof claims.exp === "number" && Number.isFinite(claims.exp) ? { expiresAt: claims.exp } : {}),
      ...(resource === undefined ? {} : { resource }),
      extra,
    };
    return { principal, authInfo };
  }

  async function createAttestedPairingChallenge(
    principal: Principal,
    request: FastifyRequest,
  ): Promise<PairingChallenge> {
    const body = asRecord(request.body);
    const installationId = readString(body, "installationId", { max: 256, required: true }) as string;
    const publicKey = readString(body, "publicKey", { max: 8_192, required: true }) as string;
    const sourceRootId = readString(body, "sourceRootId", { max: 512, required: true }) as string;
    const agentSessionId = readString(body, "agentSessionId", { max: 256, required: true }) as string;
    const requestedScopes = parsePairingScopes(body.requestedScopes, pairingScopes);
    return createAttestedPairingChallengeForSelection(principal, {
      installationId,
      publicKey,
      sourceRootId,
      agentSessionId,
      requestedScopes,
    });
  }

  async function createAttestedPairingChallengeForSelection(
    principal: Principal,
    selection: {
      readonly installationId: string;
      readonly publicKey: string;
      readonly sourceRootId: string;
      readonly agentSessionId: string;
      readonly requestedScopes: readonly string[];
    },
  ): Promise<PairingChallenge> {
    const { installationId, publicKey, sourceRootId, agentSessionId, requestedScopes } = selection;
    await ensureSession(principal, agentSessionId);
    if (!bridge.attestSourceRoot) {
      throw new HttpError(503, "SOURCE_ROOT_AUTHORITY_UNAVAILABLE", "Pairing is temporarily unavailable");
    }
    let attestation: Awaited<ReturnType<NonNullable<BridgePort["attestSourceRoot"]>>>;
    try {
      attestation = await bridge.attestSourceRoot({ installationId, sourceRootId });
    } catch {
      throw new HttpError(403, "SOURCE_ROOT_NOT_ATTESTED", "The selected Codex source root is not available");
    }
    const attestationExpiry = Date.parse(attestation.expiresAt);
    const remainingMs = attestationExpiry - Date.now();
    if (
      attestation.installationId !== installationId ||
      attestation.sourceRootId !== sourceRootId ||
      typeof attestation.sourceSessionId !== "string" ||
      attestation.sourceSessionId.length < 1 ||
      attestation.sourceSessionId.length > 256 ||
      !/^[a-f0-9]{64}$/u.test(attestation.attestationDigest) ||
      !Number.isFinite(attestationExpiry) ||
      remainingMs < 1_000
    ) {
      throw new HttpError(403, "SOURCE_ROOT_NOT_ATTESTED", "The selected Codex source root is not available");
    }
    const ttlMs = Math.min(options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS, remainingMs);
    return pairing.create({
      ownerId: principal.ownerId,
      tenantId: principal.tenantId,
      installationId,
      publicKey,
      sourceRootId,
      sourceSessionId: attestation.sourceSessionId,
      sourceRootAttestationDigest: attestation.attestationDigest,
      sourceRootAttestationExpiresAt: attestation.expiresAt,
      agentSessionId,
      requestedScopes,
    }, ttlMs);
  }

  async function createSession(
    principal: Principal,
    request: FastifyRequest,
  ): Promise<{ record: AgentSessionRecord; replay: boolean }> {
    const idempotencyKey = safeHeader(
      request.headers["idempotency-key"] ?? request.headers["x-idempotency-key"],
      256,
    );
    if (!idempotencyKey) {
      throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required");
    }
    const payload: SessionPayload = sanitizeSessionPayload(request.body);
    const requestHash = sha256(canonicalJson(payload));
    const key = `${principal.tenantId}:${principal.ownerId}:${idempotencyKey}`;
    const prior = idempotency.get(key);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request");
      }
      return { record: await prior.promise, replay: true };
    }
    const input = {
      ownerId: principal.ownerId,
      tenantId: principal.tenantId,
      agentSessionId: createSessionId(),
      idempotencyKey,
      requestHash,
      payload,
    } as const;
    const promise = store.createAgentSession(input);
    idempotency.set(key, { requestHash, promise });
    try {
      const record = await promise;
      // A durable store may return the original session after a process
      // restart when the same owner-scoped idempotency key and payload are
      // replayed. The in-memory HTTP ledger cannot know that old generated ID,
      // so a different ID is an expected replay - not a store contract failure.
      const durableReplay = record.agentSessionId !== input.agentSessionId;
      assertScopedRecord(record, {
        ownerId: principal.ownerId,
        tenantId: principal.tenantId,
        agentSessionId: record.agentSessionId,
      });
      return { record, replay: durableReplay };
    } catch (error: unknown) {
      idempotency.delete(key);
      if (isRecord(error) && error.code === "IDEMPOTENCY_CONFLICT") {
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request");
      }
      throw error;
    }
  }

  async function ensureSession(principal: Principal, agentSessionId: string): Promise<void> {
    const scope: SessionScope = { ownerId: principal.ownerId, tenantId: principal.tenantId, agentSessionId };
    const get = store.getAgentSession ?? store.getSession;
    if (get) {
      const session = await get.call(store, scope);
      if (!session) throw new HttpError(404, "NOT_FOUND", "The requested resource was not found");
      assertScopedRecord(session, scope);
      return;
    }
    const hierarchy = await store.getHierarchy({ ...scope, page: 1, pageSize: 1 });
    if (!hierarchy) throw new HttpError(404, "NOT_FOUND", "The requested resource was not found");
  }

  async function readHierarchy(
    principal: Principal,
    agentSessionId: string,
    page: number,
    pageSize: number,
  ): Promise<Record<string, unknown>> {
    const scope = { ownerId: principal.ownerId, tenantId: principal.tenantId, agentSessionId } as const;
    const hierarchy = await store.getHierarchy({ ...scope, page, pageSize });
    if (!hierarchy) throw new HttpError(404, "NOT_FOUND", "The requested resource was not found");
    assertScopedRecord(hierarchy, scope);
    const parsed = PublicHierarchyPageSchema.safeParse(hierarchy);
    if (!parsed.success || parsed.data.agentSessionId !== agentSessionId) {
      // A store adapter that returns the pre-v1 hierarchy is a contract
      // violation, not an invitation to run the old recursive redactor. The
      // latter could accidentally preserve a newly-added private field.
      throw new HttpError(500, "STORE_CONTRACT_ERROR", "Hierarchy projection is unavailable");
    }
    return parsed.data;
  }

  async function readDetails(
    principal: Principal,
    agentSessionId: string,
    agentId: string,
  ): Promise<AgentDetails> {
    const getDetails = store.getAgentDetails ?? store.getDetails;
    if (!getDetails) throw new HttpError(404, "NOT_FOUND", "The requested resource was not found");
    const details = await getDetails.call(store, {
      ownerId: principal.ownerId,
      tenantId: principal.tenantId,
      agentSessionId,
      agentId,
    });
    if (!details) throw new HttpError(404, "NOT_FOUND", "The requested resource was not found");
    assertScopedRecord(details, { ownerId: principal.ownerId, tenantId: principal.tenantId, agentSessionId });
    const parsed = PublicAgentDetailsSchema.safeParse(details);
    if (!parsed.success || parsed.data.agentSessionId !== agentSessionId) {
      throw new HttpError(500, "STORE_CONTRACT_ERROR", "Agent details projection is unavailable");
    }
    return parsed.data as unknown as AgentDetails;
  }

  async function listTools(principal: Principal): Promise<readonly McpTool[]> {
    const provided = mcp?.listTools ? await mcp.listTools(principal) : [];
    const byName = new Map<string, McpTool>();
    for (const tool of provided) {
      if (PUBLIC_TOOL_NAMES.has(tool.name)) byName.set(tool.name, tool);
    }
    const defaults: McpTool[] = [
      { name: "create_agent_session", description: "Create an Agent Farm view session", requiredScope: "agent-session:create" },
      { name: "get_agent_hierarchy", description: "Read a paginated agent hierarchy", requiredScope: "agent-session:read" },
      { name: "get_agent_details", description: "Read one agent's details", requiredScope: "agent-session:read-details" },
      { name: "render_agent_hierarchy", description: "Read a bounded render snapshot", requiredScope: "agent-session:render" },
    ];
    return defaults.map((tool) => byName.get(tool.name) ?? tool).filter((tool) => principal.scopes.has(tool.requiredScope ?? ""));
  }

  async function callTool(
    name: string,
    args: Record<string, unknown>,
    principal: Principal,
  ): Promise<unknown> {
    if (mcp?.callTool) {
      const value = await mcp.callTool(name, args, principal);
      return publicRecord(value);
    }
    if (name === "create_agent_session") {
      const idempotencyKey = readString(args, "idempotencyKey", { max: 256, required: true }) as string;
      const payload = sanitizeSessionPayload(args);
      const requestHash = sha256(canonicalJson(payload));
      const input = {
        ownerId: principal.ownerId,
        tenantId: principal.tenantId,
        agentSessionId: createSessionId(),
        idempotencyKey,
        requestHash,
        payload,
      } as const;
      const record = await store.createAgentSession(input);
      if (record.agentSessionId !== input.agentSessionId) {
        throw new HttpError(500, "STORE_CONTRACT_ERROR", "Session store returned an invalid session identity");
      }
      assertScopedRecord(record, input);
      return { agentSessionId: record.agentSessionId, session: publicSession(record) };
    }
    const sessionId = readString(args, "agentSessionId", { max: 256, required: true }) as string;
    if (name === "get_agent_hierarchy" || name === "render_agent_hierarchy") {
      const page = args.page === undefined ? 1 : Number(args.page);
      const pageSize = args.pageSize === undefined ? DEFAULT_PAGE_SIZE : Number(args.pageSize);
      if (!Number.isSafeInteger(page) || !Number.isSafeInteger(pageSize) || page < 1 || pageSize < 1 || pageSize > maxPageSize) {
        throw new HttpError(400, "INVALID_PAGINATION", "Invalid pagination value");
      }
      return readHierarchy(principal, sessionId, page, pageSize);
    }
    if (name === "get_agent_details") {
      const agentId = readString(args, "agentId", { max: 256, required: true }) as string;
      return publicRecord(await readDetails(principal, sessionId, agentId));
    }
    throw new HttpError(404, "NOT_FOUND", "The requested resource was not found");
  }
}

export const buildServer = createApp;
export const createServer = createApp;
export const buildApp = createApp;
export default createApp;

export { PairingLedger, pairingMessage } from "./pairing.js";
export { InMemoryStore, DisabledBridge, TestBridge } from "./fakes.js";
export * from "./contracts.js";
export { JwtAuthService, AuthenticationError, assertTokenClaims, claimsToPrincipal } from "./auth.js";
export type {
  JwtAuthOptions,
  TokenStatus,
  TokenStatusCheck,
  TokenStatusResult,
  TokenStatusVerifier,
} from "./auth.js";
export { HttpError } from "./security.js";

interface CanonicalHost {
  readonly hostname: string;
  readonly port?: number;
}

function localPrincipalForSession(sessionId: string, installationId = "codex-local-dev"): Principal {
  const sessionOwner = sha256(`agent-farm-local-session:${sessionId}`).slice(0, 48);
  const tenant = sha256(`agent-farm-local-installation:${installationId}`).slice(0, 48);
  return {
    subject: `local-${sessionOwner}`,
    ownerId: `local-${sessionOwner}`,
    tenantId: `local-${tenant}`,
    scopes: new Set(LOCAL_SCOPES),
  };
}

function localPrincipalForBinding(binding: {
  readonly tenantId: string;
  readonly ownerId: string;
}): Principal {
  const subject = sha256(canonicalJson({
    purpose: "agent-farm-local-durable-binding",
    tenantId: binding.tenantId,
    ownerId: binding.ownerId,
  })).slice(0, 48);
  return {
    subject: `local-${subject}`,
    ownerId: binding.ownerId,
    tenantId: binding.tenantId,
    scopes: new Set(LOCAL_SCOPES),
  };
}

function localSelectionBinding(
  principal: Principal,
  localSessionId: string,
  installationId: string,
  agentSessionId: string,
): LocalSelectionBinding {
  return {
    tenantId: principal.tenantId,
    ownerId: principal.ownerId,
    sessionBinding: sha256(`agent-farm-local-browser:${localSessionId}`),
    installationId,
    agentSessionId,
  };
}

function isLoopbackRequest(request: FastifyRequest, allowedHosts?: readonly string[]): boolean {
  const ip = request.ip.toLowerCase();
  const loopbackIp = ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "[::1]" ||
    ip === "[::ffff:127.0.0.1]";
  if (!loopbackIp) return false;
  const host = request.headers.host;
  if (!isLoopbackHostHeader(host)) return false;
  if (allowedHosts === undefined) return true;
  return allowedHosts.some((candidate) => exactHostMatch(host, candidate));
}

function exactHostMatch(actualValue: string | undefined, expectedValue: string): boolean {
  const actual = canonicalHost(actualValue);
  const expected = canonicalHost(expectedValue);
  return actual !== undefined && expected !== undefined && expected.port !== undefined && actual.hostname === expected.hostname && actual.port === expected.port;
}

function hasForwardedHeader(request: FastifyRequest): boolean {
  return [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-forwarded-prefix",
  ].some((name) => request.headers[name] !== undefined);
}

function hasTokenLikeUrl(value: string): boolean {
  // Fragments are not normally sent over HTTP, but reject a raw fragment if
  // an in-process adapter supplies one. Decode every bounded key/value before
  // classification so percent-encoded or mixed-case aliases cannot bypass
  // the token-bearing URL guard.
  if (value.includes("#") || value.length > 8_192) return true;
  const question = value.indexOf("?");
  const rawPath = question < 0 ? value : value.slice(0, question);
  try { decodeURIComponent(rawPath); } catch { return true; }
  if (question < 0) return false;
  const rawQuery = value.slice(question + 1);
  if (rawQuery.length > 4_096) return true;
  const sensitive = /(?:access|id|refresh|auth|bearer|session|cookie|credential|secret|csrf|code|nonce|password|jwt|token)/u;
  const parts = rawQuery.length === 0 ? [] : rawQuery.split("&");
  if (parts.length > 128) return true;
  for (const part of parts) {
    const separator = part.indexOf("=");
    const rawKey = separator < 0 ? part : part.slice(0, separator);
    const rawValue = separator < 0 ? "" : part.slice(separator + 1);
    let key: string;
    let queryValue: string;
    try {
      key = decodeURIComponent(rawKey.replaceAll("+", " ")).toLowerCase().replace(/[._-]/gu, "");
      queryValue = decodeURIComponent(rawValue.replaceAll("+", " "));
    } catch {
      return true;
    }
    if (key === "apikey" || sensitive.test(key)) return true;
    // Treat credential-shaped values as unsafe even under a benign-looking
    // key. JWT headers commonly start with `eyJ` and may have a short test
    // payload/signature; opaque bearer/API values are bounded base64url or
    // hexadecimal strings. Rejecting these values keeps secrets out of URL
    // history/referrers instead of relying on the query key allowlist.
    if (
      /^bearer\s+/iu.test(queryValue) ||
      /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{2,}(?:\.[A-Za-z0-9_-]{2,})?$/u.test(queryValue) ||
      /^(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{32,})$/u.test(queryValue)
    ) return true;
  }
  return false;
}

function isExactLocalOrigin(value: string, request: FastifyRequest): boolean {
  if (value.length > 512 || value === "null") return false;
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return false;
  }
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || (origin.protocol !== "http:" && origin.protocol !== "https:")) return false;
  const host = canonicalHost(request.headers.host);
  if (origin.hostname.endsWith(".")) return false;
  const originHostname = origin.hostname.replace(/^\[|\]$/gu, "").toLowerCase().replace(/\.+$/u, "");
  if (host === undefined || originHostname !== host.hostname) return false;
  const originPort = origin.port === "" ? undefined : Number(origin.port);
  if (originPort !== host.port) return false;
  const protocol = typeof request.protocol === "string" ? `${request.protocol}:` : "http:";
  return origin.protocol === protocol;
}

function isSecureTransport(request: FastifyRequest): boolean {
  return request.protocol === "https" || (request.raw.socket as { encrypted?: boolean }).encrypted === true;
}

function isLoopbackHostHeader(value: string | undefined): boolean {
  const raw = value?.trim();
  if (raw !== undefined && !raw.startsWith("[")) {
    const hostnamePart = raw.split(":", 1)[0] ?? raw;
    if (hostnamePart.endsWith(".")) return false;
  }
  const host = canonicalHost(value);
  return host !== undefined && (
    host.hostname === "localhost" ||
    host.hostname === "127.0.0.1" ||
    host.hostname === "::1"
  );
}

/**
 * Host allowlists are opt-in so existing in-process/unit compositions keep
 * working. Production main always supplies a non-empty list. A loopback host
 * is never synthesized here: it matches only when explicitly listed.
 */
function isAllowedHost(value: string | undefined, allowedHosts: readonly string[]): boolean {
  const actual = canonicalHost(value);
  if (actual === undefined || allowedHosts.length === 0) return false;
  return allowedHosts.some((candidate) => {
    const allowed = canonicalHost(candidate);
    if (allowed === undefined || allowed.hostname !== actual.hostname) return false;
    return allowed.port === undefined || allowed.port === actual.port;
  });
}

function canonicalHost(value: string | undefined): CanonicalHost | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length === 0 || /\s|[/\\,*]/u.test(text) || text.length > 256) return undefined;
  let hostname = text;
  let port: number | undefined;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) return undefined;
    hostname = text.slice(1, close);
    const suffix = text.slice(close + 1);
    if (suffix.length > 0) {
      if (!suffix.startsWith(":")) return undefined;
      port = parseHostPort(suffix.slice(1));
      if (port === undefined) return undefined;
    }
    if (!/^[0-9a-f:.]+$/iu.test(hostname)) return undefined;
  } else {
    const colonCount = [...text].filter((character) => character === ":").length;
    if (colonCount > 1) return undefined;
    if (colonCount === 1) {
      const separator = text.lastIndexOf(":");
      hostname = text.slice(0, separator);
      port = parseHostPort(text.slice(separator + 1));
      if (port === undefined) return undefined;
    }
    if (!/^[a-z0-9.-]+$/iu.test(hostname)) return undefined;
  }
  hostname = hostname.toLowerCase().replace(/\.+$/u, "");
  if (hostname.length === 0 || hostname.length > 253) return undefined;
  return port === undefined ? { hostname } : { hostname, port };
}

function parseHostPort(value: string): number | undefined {
  if (!/^\d{1,5}$/u.test(value)) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function shouldServeSpaIndex(request: FastifyRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = request.url.split("?", 1)[0] ?? "/";
  if (
    pathname.startsWith("/api/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/.well-known/") ||
    pathname.startsWith("/static/")
  ) {
    return false;
  }
  const accept = request.headers.accept;
  return pathname === "/" || (typeof accept === "string" && accept.toLowerCase().includes("text/html"));
}

async function serviceReady(service: { ready?: () => boolean | Promise<boolean> } | undefined): Promise<boolean> {
  if (!service || !service.ready) return true;
  try {
    return await service.ready();
  } catch {
    return false;
  }
}

function authInfoResource(claims: RawTokenClaims, fallback: string | undefined): URL | undefined {
  const raw = claims.resource;
  const claimCandidates = [
    ...(typeof raw === "string" ? [raw] : []),
    ...(Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : []),
  ];
  // RFC 8707 permits an array of resource indicators.  Prefer the exact
  // resource that JwtAuthService validated; selecting the first array member
  // could otherwise make the MCP layer reject a valid multi-resource token.
  const candidates = fallback === undefined
    ? claimCandidates
    : [fallback, ...claimCandidates.filter((candidate) => candidate !== fallback)];
  for (const candidate of candidates) {
    try {
      const value = new URL(candidate);
      if (value.protocol === "https:" || value.protocol === "http:") return value;
    } catch {
      // Ignore malformed optional claims; JwtAuthService already enforced the
      // configured expected resource before this helper is called.
    }
  }
  return undefined;
}

function sessionParam(request: FastifyRequest): string {
  const params = asRecord(request.params);
  return assertSessionId(readString(params, "sessionId", { max: 256, required: true }));
}

function parsePairingScopes(value: unknown, allowed: ReadonlySet<string>): readonly string[] {
  if (value === undefined) return [...allowed];
  if (!Array.isArray(value) || value.length > 16) {
    throw new HttpError(400, "INVALID_REQUEST", "requestedScopes is invalid");
  }
  const scopes = [...new Set(value.filter((item): item is string => typeof item === "string"))];
  if (scopes.length !== value.length || scopes.some((scope) => !allowed.has(scope))) {
    throw new HttpError(403, "INVALID_PAIRING_SCOPE", "Requested bridge scope is not permitted");
  }
  return scopes.sort();
}

function publicSession(record: AgentSessionRecord): Record<string, unknown> {
  return publicRecord({
    agentSessionId: record.agentSessionId,
    status: record.status,
    sourceAdapter: record.sourceAdapter,
    label: record.label,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    watermark: record.watermark,
    capabilities: record.capabilities,
  });
}

function publicRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return redactRecord(value, 0);
}

const PRIVATE_FIELD = /^(ownerId|tenantId|sourceThreadId|sourceSessionId|rootSource|sourceRoot|installationId)$/u;
const SECRET_FIELD = /(token|secret|credential|password|authorization|cookie|prompt|reasoning|command|path|diff|tool.?arg|raw.?payload|stack)/iu;
const PUBLIC_REASONING_FIELD = new Set(["requestedReasoningEffort", "observedReasoningEffort"]);

function redactRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth > 5) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_FIELD.test(key) || (SECRET_FIELD.test(key) && !PUBLIC_REASONING_FIELD.has(key))) continue;
    result[key] = redactValue(item, depth + 1);
  }
  return result;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 5) return null;
  if (typeof value === "string") return value.length > 4_096 ? `${value.slice(0, 4_096)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => redactValue(item, depth + 1));
  if (isRecord(value)) return redactRecord(value, depth);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return null;
}
