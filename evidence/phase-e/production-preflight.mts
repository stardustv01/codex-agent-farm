#!/usr/bin/env node

/**
 * Offline production packaging preflight.
 *
 * This command intentionally uses non-secret placeholder values. It verifies
 * that the production parser still accepts the complete variable shape and
 * that the already-built standalone/MCP artifacts are self-contained and
 * integrity-matched. It never reads network state, opens a socket, or prints
 * environment values/secrets.
 *
 * Run after `pnpm build`:
 *
 *   node --import tsx evidence/phase-e/production-preflight.mts
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PHASE_A_BINARY_SHA256 } from "../../packages/codex-bridge/dist/index.js";

import { EnvironmentConfigError, parseServerEnvironment } from "../../apps/server/dist/main.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checkoutDirectory = resolve(scriptDirectory, "../..");
const webDistDirectory = resolve(checkoutDirectory, "apps/web/dist");
const requiredEnvironmentNames = [
  "AGENT_FARM_DATABASE",
  "AGENT_FARM_JWKS_URI",
  "AGENT_FARM_ISSUER",
  "AGENT_FARM_AUDIENCE",
  "AGENT_FARM_RESOURCE",
  "AGENT_FARM_AUTHORIZATION_SERVER",
  "AGENT_FARM_BROWSER_AUTHORIZATION_ENDPOINT",
  "AGENT_FARM_BROWSER_TOKEN_ENDPOINT",
  "AGENT_FARM_BROWSER_CLIENT_ID",
  "AGENT_FARM_BROWSER_REDIRECT_URI",
  "AGENT_FARM_CODEX_EXECUTABLE",
  "AGENT_FARM_CODEX_BINARY_SHA256",
  "AGENT_FARM_CODEX_INSTALLATION_ID",
  "AGENT_FARM_CODEX_SESSIONS_ROOT",
  "AGENT_FARM_MCP_GRANT_DIGEST_KEY",
  "AGENT_FARM_TOKEN_STATUS_URL",
  "AGENT_FARM_TOKEN_STATUS_SECRET",
  "AGENT_FARM_ALLOWED_ORIGINS",
  "AGENT_FARM_ALLOWED_HOSTS",
] as const;

const productionFixture: Readonly<Record<string, string>> = {
  AGENT_FARM_DATABASE: "/var/lib/agent-farm/preflight.sqlite",
  AGENT_FARM_JWKS_URI: "https://issuer.example/.well-known/jwks.json",
  AGENT_FARM_ISSUER: "https://issuer.example",
  AGENT_FARM_AUDIENCE: "agent-farm",
  AGENT_FARM_RESOURCE: "https://agent-farm.example",
  AGENT_FARM_AUTHORIZATION_SERVER: "https://issuer.example",
  AGENT_FARM_BROWSER_AUTHORIZATION_ENDPOINT: "https://issuer.example/authorize",
  AGENT_FARM_BROWSER_TOKEN_ENDPOINT: "https://issuer.example/token",
  AGENT_FARM_BROWSER_CLIENT_ID: "agent-farm-preflight",
  AGENT_FARM_BROWSER_REDIRECT_URI: "https://agent-farm.example/auth/callback",
  AGENT_FARM_CODEX_EXECUTABLE: "/var/lib/agent-farm/codex",
  AGENT_FARM_CODEX_BINARY_SHA256: PHASE_A_BINARY_SHA256,
  AGENT_FARM_CODEX_INSTALLATION_ID: "codex-preflight",
  AGENT_FARM_CODEX_SESSIONS_ROOT: "/var/lib/agent-farm/codex-sessions",
  AGENT_FARM_MCP_GRANT_DIGEST_KEY: "preflight-placeholder-key-0123456789abcdef",
  AGENT_FARM_TOKEN_STATUS_URL: "https://issuer.example/token-status",
  AGENT_FARM_TOKEN_STATUS_SECRET: "preflight-placeholder-secret",
  AGENT_FARM_ALLOWED_ORIGINS: "https://agent-farm.example",
  AGENT_FARM_ALLOWED_HOSTS: "agent-farm.example",
};

const checks: Array<readonly [string, () => Promise<void> | void]> = [
  ["production environment policy", checkProductionEnvironment],
  ["MCP resource manifest", checkMcpResourceManifest],
  ["standalone static assets", checkStandaloneAssets],
];

console.log("Agent Farm production preflight (offline; synthetic placeholders; no network or credentials)");
for (const name of requiredEnvironmentNames) console.log(`ENV ${name}: present (fixture)`);

let failed = false;
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`CHECK ${name}: PASS`);
  } catch (error: unknown) {
    failed = true;
    // Keep diagnostics secret-safe: checks below deliberately throw only
    // fixed messages, and parser failures are reduced to variable names.
    if (error instanceof EnvironmentConfigError) {
      const fields = [...error.missing, ...error.invalid].join(", ") || "environment policy";
      console.error(`CHECK ${name}: FAIL (${fields})`);
    } else {
      console.error(`CHECK ${name}: FAIL`);
    }
  }
}

if (failed) process.exitCode = 1;

function checkProductionEnvironment(): void {
  const parsed = parseServerEnvironment(productionFixture);
  assert(parsed.devMode === false, "production mode required");
  assert(parsed.allowedOrigins.length === 1 && parsed.allowedOrigins[0] === "https://agent-farm.example", "HTTPS origin policy failed");

  try {
    parseServerEnvironment({ ...productionFixture, AGENT_FARM_ALLOWED_ORIGINS: "http://agent-farm.example" });
  } catch (error: unknown) {
    if (error instanceof EnvironmentConfigError && error.invalid.includes("AGENT_FARM_ALLOWED_ORIGINS")) return;
  }
  throw new Error("production HTTP origin was accepted");
}

async function checkMcpResourceManifest(): Promise<void> {
  const manifestPath = resolve(webDistDirectory, "mcp-resource.json");
  const resourcePath = resolve(webDistDirectory, "mcp-resource.html");
  const [manifestText, resourceHtml] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(resourcePath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  const digest = createHash("sha256").update(resourceHtml.trimEnd() + "\n", "utf8").digest("hex");
  assert(manifest.resourceUri === "ui://agent-farm/hierarchy.html", "resource URI mismatch");
  assert(manifest.mimeType === "text/html;profile=mcp-app", "resource MIME mismatch");
  assert(manifest.entrypoint === "mcp-resource.html" && manifest.inline === true, "resource entrypoint is not inline");
  assert(manifest.sha256 === digest, "resource digest mismatch");
  assert(manifest.bytes === Buffer.byteLength(resourceHtml.trimEnd() + "\n", "utf8"), "resource byte count mismatch");
  assert(!/(?:src|href)=["'][^"']*assets\//iu.test(resourceHtml), "resource references an external asset");
}

async function checkStandaloneAssets(): Promise<void> {
  const indexPath = resolve(webDistDirectory, "index.html");
  const indexHtml = await readFile(indexPath, "utf8");
  const references = [...indexHtml.matchAll(/(?:src|href)=["']([^"']+)["']/giu)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined)
    .filter((value) => value.startsWith("/assets/") || value.startsWith("./assets/"));
  assert(references.length > 0, "standalone asset references missing");
  for (const reference of references) {
    const relativePath = reference.startsWith("/") ? reference.slice(1) : reference.slice(2);
    const assetPath = resolve(webDistDirectory, relativePath);
    const assetStat = await stat(assetPath);
    assert(assetStat.isFile(), "standalone asset is not a file");
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
