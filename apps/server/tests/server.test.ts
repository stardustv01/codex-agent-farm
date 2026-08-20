import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CODEX_DISCOVERY_SOURCE_KINDS, type AdapterGateAccepted, type JsonObject, type SanitizedThread } from "@agent-farm/codex-bridge";
import { DurableStore } from "@agent-farm/store";

import {
  TestBridge,
  createApp,
  pairingMessage,
  type RawTokenClaims,
  type StorePort,
} from "../src/index.js";
import { ReadOnlyCodexBridgeAdapter } from "../src/composition.js";
import { DurableStorePort } from "../src/composition.js";

const future = Math.floor(Date.now() / 1_000) + 3_600;

function claims(overrides: Partial<RawTokenClaims> = {}): RawTokenClaims {
  return {
    sub: "owner-a",
    ownerId: "owner-a",
    tenantId: "tenant-a",
    scope: "agent-session:create agent-session:read agent-session:read-details agent-session:render bridge:pair",
    exp: future,
    aud: "agent-farm",
    resource: "https://agent-farm.local",
    ...overrides,
  };
}

const apps: Array<{ close(): Promise<void> }> = [];
const localDataDirectories: string[] = [];
const durables: DurableStore[] = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
  while (durables.length > 0) durables.pop()?.close();
  while (localDataDirectories.length > 0) rmSync(localDataDirectories.pop()!, { recursive: true, force: true });
});

function appFor(
  verifier: (token: string) => RawTokenClaims | Promise<RawTokenClaims> = () => claims(),
  options: Parameters<typeof createApp>[0] = {},
) {
  const resolvedOptions = options.localMode && options.localDataDirectory === undefined
    ? (() => {
        const directory = mkdtempSync(join(tmpdir(), "agent-farm-server-local-"));
        localDataDirectories.push(directory);
        return { ...options, localDataDirectory: directory };
      })()
    : options;
  const app = createApp({
    auth: {
      audience: "agent-farm",
      resource: "https://agent-farm.local",
      verifyToken: verifier,
    },
    ...resolvedOptions,
  });
  apps.push(app);
  return app;
}

async function createSession(app: ReturnType<typeof createApp>, token = "a") {
  return app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": `key-${token}` },
    payload: { label: "safe", ownerId: "forged", tenantId: "forged", agentSessionId: "forged" },
  });
}

function cookiePair(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const match = values.find((value) => value.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`missing ${name} cookie`);
  return match.split(";", 1)[0]!;
}

async function localClient(app: ReturnType<typeof createApp>, host = "127.0.0.1:8787", remoteAddress = "127.0.0.1") {
  const origin = `http://${host}`;
  const bootstrap = await app.inject({ method: "GET", url: "/api/v1/local/bootstrap", remoteAddress, headers: { host } });
  expect(bootstrap.statusCode).toBe(200);
  const bootstrapBody = bootstrap.json<{ csrfToken: string }>();
  const bootstrapCookie = cookiePair(bootstrap, "agent-farm-local-bootstrap");
  const session = await app.inject({
    method: "POST",
    url: "/api/v1/local/session",
    headers: { host, origin, cookie: bootstrapCookie, "x-csrf-token": bootstrapBody.csrfToken },
    remoteAddress,
    payload: {},
  });
  expect([201, 200]).toContain(session.statusCode);
  const sessionBody = session.json<{ agentSessionId: string; csrfToken: string }>();
  const sessionCookie = cookiePair(session, "agent-farm-local-session");
  const status = await app.inject({ method: "GET", url: "/api/v1/local/status", remoteAddress, headers: { host, cookie: sessionCookie } });
  expect(status.statusCode).toBe(200);
  const statusBody = status.json<{ csrfToken: string }>();
  return { host, origin, cookie: sessionCookie, csrfToken: statusBody.csrfToken, agentSessionId: sessionBody.agentSessionId, status };
}

function localMutationHeaders(client: Awaited<ReturnType<typeof localClient>>): Record<string, string> {
  return { host: client.host, origin: client.origin, cookie: client.cookie, "x-csrf-token": client.csrfToken };
}

function updateLocalCsrf(client: Awaited<ReturnType<typeof localClient>>, response: { headers: Record<string, string | string[] | undefined> }): void {
  const raw = response.headers["x-csrf-token"];
  const next = Array.isArray(raw) ? raw[0] : raw;
  if (typeof next === "string") client.csrfToken = next;
}

describe("Agent Farm HTTP composition root", () => {
  it("creates server-owned sessions and ignores forged body identity", async () => {
    const app = appFor();
    const response = await createSession(app);
    expect(response.statusCode).toBe(201);
    const body = response.json<{ agentSessionId: string; session: { agentSessionId: string } }>();
    expect(body.agentSessionId).toBe(body.session.agentSessionId);
    expect(body.agentSessionId).not.toBe("forged");
  });

  it("is idempotent per owner and rejects same-key different payload", async () => {
    const app = appFor();
    const first = await createSession(app);
    const second = await createSession(app);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().agentSessionId).toBe(first.json().agentSessionId);
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: "Bearer a", "idempotency-key": "key-a" },
      payload: { label: "different" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("denies cross-session and cross-tenant reads with a non-enumerating 404", async () => {
    const app = appFor((token) => token === "b" ? claims({ sub: "owner-b", ownerId: "owner-b", tenantId: "tenant-b" }) : claims());
    const own = await createSession(app, "a");
    const sessionId = own.json<{ agentSessionId: string }>().agentSessionId;
    const cross = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/hierarchy`,
      headers: { authorization: "Bearer b" },
    });
    expect(cross.statusCode).toBe(404);
    expect(cross.json()).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: "NOT_FOUND" }) }));
  });

  it("checks issuer, audience, resource, expiry, and scope", async () => {
    const wrongAudience = appFor(() => claims({ aud: "other" }));
    const audienceResponse = await wrongAudience.inject({ method: "GET", url: "/api/v1/sessions/nope/hierarchy", headers: { authorization: "Bearer a" } });
    expect(audienceResponse.statusCode).toBe(401);
    await wrongAudience.close();
    apps.splice(apps.indexOf(wrongAudience), 1);

    const wrongResource = appFor(() => claims({ resource: "https://other.example" }));
    const resourceResponse = await wrongResource.inject({ method: "GET", url: "/api/v1/sessions/nope/hierarchy", headers: { authorization: "Bearer a" } });
    expect(resourceResponse.statusCode).toBe(401);

    const missingResource = appFor(() => claims({ resource: undefined }));
    const missingResourceResponse = await missingResource.inject({ method: "GET", url: "/api/v1/sessions/nope/hierarchy", headers: { authorization: "Bearer a" } });
    expect(missingResourceResponse.statusCode).toBe(401);
    await wrongResource.close();
    apps.splice(apps.indexOf(wrongResource), 1);

    const expired = appFor(() => claims({ exp: Math.floor(Date.now() / 1_000) - 1 }));
    const expiredResponse = await expired.inject({ method: "GET", url: "/api/v1/sessions/nope/hierarchy", headers: { authorization: "Bearer a" } });
    expect(expiredResponse.statusCode).toBe(401);
    await expired.close();
    apps.splice(apps.indexOf(expired), 1);

    const insufficient = appFor(() => claims({ scope: "agent-session:create" }));
    const insufficientResponse = await insufficient.inject({ method: "GET", url: "/api/v1/sessions/nope/hierarchy", headers: { authorization: "Bearer a" } });
    expect(insufficientResponse.statusCode).toBe(403);
  });

  it("requires a fresh valid nonce and exact root binding for pairing", async () => {
    const bridge = new TestBridge((input) => input.message === pairingMessage(input));
    const app = appFor(() => claims(), { bridge });
    const session = await createSession(app);
    const sessionId = session.json<{ agentSessionId: string }>().agentSessionId;
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/bridge/pairing/challenge",
      headers: { authorization: "Bearer a" },
      payload: { installationId: "install-1", publicKey: "pub", sourceRootId: "root-1", agentSessionId: sessionId },
    });
    expect(challengeResponse.statusCode).toBe(201);
    const challenge = challengeResponse.json<{ pairingId: string; nonce: string }>();
    const substituted = await app.inject({
      method: "POST",
      url: "/api/v1/bridge/pairing/complete",
      headers: { authorization: "Bearer a" },
      payload: { ...challenge, installationId: "install-1", sourceRootId: "root-evil", agentSessionId: sessionId, signature: "ok" },
    });
    expect(substituted.statusCode).toBe(403);
    const completed = await app.inject({
      method: "POST",
      url: "/api/v1/bridge/pairing/complete",
      headers: { authorization: "Bearer a" },
      payload: { ...challenge, installationId: "install-1", sourceRootId: "root-1", agentSessionId: sessionId, signature: "ok" },
    });
    expect(completed.statusCode).toBe(201);
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/bridge/pairing/complete",
      headers: { authorization: "Bearer a" },
      payload: { ...challenge, installationId: "install-1", sourceRootId: "root-1", agentSessionId: sessionId, signature: "ok" },
    });
    expect(replay.statusCode).toBe(403);
  });

  it("rejects a caller-selected pairing root when server attestation fails", async () => {
    class RejectingRootBridge extends TestBridge {
      override async attestSourceRoot(): Promise<never> {
        throw new Error("private root diagnostic");
      }
    }
    const app = appFor(() => claims(), { bridge: new RejectingRootBridge() });
    const session = await createSession(app);
    const sessionId = session.json<{ agentSessionId: string }>().agentSessionId;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/bridge/pairing/challenge",
      headers: { authorization: "Bearer a" },
      payload: {
        installationId: "install-1",
        publicKey: "pub",
        sourceRootId: "caller-invented-root",
        agentSessionId: sessionId,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("SOURCE_ROOT_NOT_ATTESTED");
    expect(response.body).not.toContain("private root diagnostic");
  });

  it("bootstraps and directly pairs an attested root in loopback local mode", async () => {
    class LocalBridge extends TestBridge {
      override async listSourceRoots() {
        return [
          { sourceRootId: "root-1", nickname: "Planner", agentPath: "/root", status: "running", updatedAt: "2026-08-10T10:00:00.000Z" },
          { sourceRootId: "root-2", nickname: "Builder", status: "idle" },
        ] as const;
      }
    }
    const bridge = new LocalBridge(() => true);
    const app = appFor(() => claims(), {
      localMode: true,
      bridge,
      localInstallationId: "codex-local-dev",
      orchestrationBudget: { solHigh: 10, lunaMax: 10, solMax: 3 },
    });

    const client = await localClient(app);
    const statusBody = client.status.json<{ candidateRoots: Array<Record<string, unknown>> }>();
    expect(statusBody).toEqual({
      localMode: true,
      csrfToken: expect.any(String),
      sessionExpiresAt: expect.any(String),
      orchestrationBudget: { solHigh: 10, lunaMax: 10, solMax: 3 },
      agentSessionId: expect.stringMatching(/^as_/u),
      paired: false,
      focusVersion: 0,
      focusChangedAt: expect.any(String),
      sourceRootCount: 2,
      candidateRoots: [
        { selectionHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u), chatHandle: expect.stringMatching(/^[a-f0-9]{64}$/u), displayName: "Planner", lifecycle: "running", lastActivityAt: "2026-08-10T10:00:00.000Z" },
        { selectionHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u), chatHandle: expect.stringMatching(/^[a-f0-9]{64}$/u), displayName: "Builder", lifecycle: "idle" },
      ],
    });

    const agentSessionId = client.agentSessionId;
    expect(agentSessionId).toMatch(/^as_/u);
    const selectionHandle = statusBody.candidateRoots[0]?.selectionHandle;
    expect(typeof selectionHandle).toBe("string");

    const rawCaller = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: localMutationHeaders(client),
      payload: { selectionHandle, sourceRootId: "root-1" },
    });
    expect(rawCaller.statusCode).toBe(400);
    expect(rawCaller.json().error.code).toBe("INVALID_SELECTION");
    updateLocalCsrf(client, rawCaller);

    const paired = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: localMutationHeaders(client),
      payload: { selectionHandle },
    });
    expect(paired.statusCode).toBe(201);
    expect(paired.json()).toEqual(expect.objectContaining({
      agentSessionId,
      paired: true,
      expiresAt: expect.any(String),
      activeTask: { displayName: "Planner", lifecycle: "running", lastActivityAt: "2026-08-10T10:00:00.000Z" },
    }));
    expect(paired.json()).not.toHaveProperty("credential");
    expect(paired.json()).not.toHaveProperty("sourceRootId");
    expect(paired.json()).not.toHaveProperty("agentPath");
    updateLocalCsrf(client, paired);
    const pairedStatus = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
    expect(pairedStatus.statusCode).toBe(200);
    expect(pairedStatus.json<{ paired: boolean }>().paired).toBe(true);
    expect(pairedStatus.json<{ candidateRoots: Array<{ active?: true; displayName: string }> }>().candidateRoots)
      .toEqual(expect.arrayContaining([expect.objectContaining({ active: true, displayName: "Planner" })]));
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: localMutationHeaders(client),
      payload: { selectionHandle },
    });
    expect(replay.statusCode).toBe(403);
    expect(replay.json().error.code).toBe("INVALID_SELECTION");

    const foreign = await app.inject({
      method: "GET",
      url: "/api/v1/local/status",
      headers: { host: "evil.test" },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe("LOCAL_MODE_LOOPBACK_REQUIRED");

    // A remote socket must never reach local routes even with a valid bearer:
    // the onRequest loopback gate runs before authentication.
    const remoteWithBearer = await app.inject({
      method: "GET",
      url: "/api/v1/local/status",
      remoteAddress: "203.0.113.5",
      headers: { host: "localhost:8787", authorization: "Bearer local-token" },
    });
    expect(remoteWithBearer.statusCode).toBe(403);
    expect(remoteWithBearer.json().error.code).toBe("LOCAL_MODE_LOOPBACK_REQUIRED");

    const remotePreflight = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/local/status",
      remoteAddress: "203.0.113.5",
      headers: {
        host: "localhost",
        origin: "http://localhost:8787",
        "access-control-request-method": "GET",
      },
    });
    expect(remotePreflight.statusCode).toBe(403);
    expect(remotePreflight.json().error.code).toBe("LOCAL_MODE_LOOPBACK_REQUIRED");

    // Local mode never accepts bearer tokens, even from a loopback socket:
    // the local trust boundary requires the server-issued browser session.
    const loopbackWithBearer = await app.inject({
      method: "GET",
      url: "/api/v1/local/status",
      headers: { host: "127.0.0.1:8787", authorization: "Bearer local-token" },
    });
    expect(loopbackWithBearer.statusCode).toBe(401);
    expect(loopbackWithBearer.json().error.code).toBe("UNAUTHENTICATED");

    const browserSession = await app.inject({ method: "POST", url: "/api/v1/browser/session", headers: { host: "localhost" } });
    const oauthMetadata = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource", headers: { host: "localhost" } });
    expect(browserSession.statusCode).toBe(403);
    expect(browserSession.json().error.code).toBe("LOCAL_MODE_ORIGIN_REQUIRED");
    expect(oauthMetadata.statusCode).toBe(404);

    for (const url of [
      "/api/v1/bridge/pairing/challenge",
      "/api/v1/bridge/pairing",
      "/api/v1/bridge/pairing/complete",
      "/api/v1/bridge/pair",
    ]) {
      const rawPairingRoute = await app.inject({
        method: "POST",
        url,
        headers: localMutationHeaders(client),
        payload: {
          installationId: "private-installation",
          sourceRootId: "private-root",
          agentSessionId,
        },
      });
      expect(rawPairingRoute.statusCode).toBe(404);
      expect(rawPairingRoute.body).not.toContain("private-root");
    }
  });

  it("allows local pairing to be retried after the issued credential expires", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      class ExpiringBridge extends TestBridge {
        override async issuePairingCredential(input: Parameters<TestBridge["issuePairingCredential"]>[0]) {
          const issued = await super.issuePairingCredential(input);
          const expiresAt = new Date(Date.now() + 1_000).toISOString();
          this.setActiveExpiry(Date.parse(expiresAt));
          return { ...issued, expiresAt };
        }
      }
      const app = appFor(() => claims(), { localMode: true, bridge: new ExpiringBridge() });
      const client = await localClient(app);
      const firstHandle = client.status.json<{ candidateRoots: Array<{ selectionHandle: string }> }>().candidateRoots[0]?.selectionHandle;
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/local/pairing/root",
        headers: localMutationHeaders(client),
        payload: { selectionHandle: firstHandle },
      });
      expect(first.statusCode).toBe(201);
      const firstExpiry = Date.parse(first.json<{ expiresAt: string }>().expiresAt);
      expect(firstExpiry).toBeGreaterThan(now);
      updateLocalCsrf(client, first);

      now = firstExpiry + 1;
      const refreshed = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie }, remoteAddress: "127.0.0.1" });
      const secondHandle = refreshed.json<{ candidateRoots: Array<{ selectionHandle: string }> }>().candidateRoots[0]?.selectionHandle;
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/local/pairing/root",
        headers: localMutationHeaders(client),
        payload: { selectionHandle: secondHandle },
      });
      expect(second.statusCode).toBe(201);
    } finally {
      clock.mockRestore();
    }
  });

  it("accepts a bracketed IPv6 loopback request in local mode", async () => {
    const app = appFor(() => claims(), {
      localMode: true,
      allowedHosts: ["[::1]:8787"],
      allowedOrigins: ["http://[::1]:8787"],
    });
    const client = await localClient(app, "[::1]:8787", "::1");
    expect(client.status.statusCode).toBe(200);
    expect(client.status.json()).toEqual(expect.objectContaining({ localMode: true }));
  });

  it("requires a session-bound one-time CSRF value and isolates sessions", async () => {
    const app = appFor(() => claims(), { localMode: true, bridge: new TestBridge(() => true) });
    const first = await localClient(app);
    const second = await localClient(app, "localhost:8787");
    const firstHandle = first.status.json<{ candidateRoots: Array<{ selectionHandle: string }> }>().candidateRoots[0]?.selectionHandle;
    const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: first.host } });
    expect(unauthenticated.statusCode).toBe(401);

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: { host: first.host, origin: first.origin, cookie: first.cookie },
      payload: { sourceRootId: "root-1", agentSessionId: first.agentSessionId },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json().error.code).toBe("CSRF_FAILED");
    const mismatch = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: { ...localMutationHeaders(first), "x-csrf-token": second.csrfToken },
      payload: { sourceRootId: "root-1", agentSessionId: first.agentSessionId },
    });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json().error.code).toBe("CSRF_FAILED");

    const malformedMutation = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: localMutationHeaders(first),
      payload: {},
    });
    expect(malformedMutation.statusCode).toBe(400);
    const replacementAfterFailure = malformedMutation.headers["x-csrf-token"];
    expect(replacementAfterFailure).toMatch(/^[A-Za-z0-9_-]{16,512}$/u);
    const replayAfterFailure = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: localMutationHeaders(first),
      payload: {},
    });
    expect(replayAfterFailure.statusCode).toBe(403);
    first.csrfToken = replacementAfterFailure as string;
    const retryWithReplacement = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: localMutationHeaders(first),
      payload: {},
    });
    expect(retryWithReplacement.statusCode).toBe(400);
    updateLocalCsrf(first, retryWithReplacement);

    const crossSession = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${second.agentSessionId}/hierarchy`,
      headers: { host: first.host, cookie: first.cookie },
    });
    expect(crossSession.statusCode).toBe(404);

    const valid = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: localMutationHeaders(first),
      payload: { selectionHandle: firstHandle },
    });
    expect(valid.statusCode).toBe(201);
    const staleCsrf = first.csrfToken;
    updateLocalCsrf(first, valid);
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: { ...localMutationHeaders(first), "x-csrf-token": staleCsrf },
      payload: { selectionHandle: firstHandle },
    });
    expect(replay.statusCode).toBe(403);
  });

  it("rotates a valid local session on browser reload without changing its owner scope", async () => {
    const app = appFor(() => claims(), { localMode: true });
    const client = await localClient(app);
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/v1/local/bootstrap",
      headers: { host: client.host, cookie: client.cookie },
    });
    const bootstrapCookie = cookiePair(bootstrap, "agent-farm-local-bootstrap");
    const combinedCookies = `${client.cookie}; ${bootstrapCookie}`;
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/local/session",
      headers: {
        host: client.host,
        origin: client.origin,
        cookie: combinedCookies,
        "x-csrf-token": bootstrap.json<{ csrfToken: string }>().csrfToken,
      },
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json<{ agentSessionId: string }>().agentSessionId).toBe(client.agentSessionId);
    const rotatedCookie = cookiePair(refreshed, "agent-farm-local-session");
    expect(rotatedCookie).not.toBe(client.cookie);
    const stale = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
    const current = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: rotatedCookie } });
    expect(stale.statusCode).toBe(401);
    expect(current.statusCode).toBe(200);
  });

  it("accepts a signed launcher focus handoff without exposing the private root in status", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-server-focus-"));
    localDataDirectories.push(directory);
    const app = appFor(() => claims(), { localMode: true, localDataDirectory: directory, bridge: new TestBridge(() => true) });
    const client = await localClient(app);
    const issuedAt = Date.now();
    const sourceRootId = "trusted-current-chat";
    const nonce = "f".repeat(32);
    const signature = createHmac("sha256", readFileSync(join(directory, "local-installation-secret")))
      .update(JSON.stringify(["agent-farm-local-focus-v1", sourceRootId, issuedAt, nonce]), "utf8")
      .digest("hex");
    const rejected = await app.inject({ method: "POST", url: "/api/v1/local/focus", headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }, payload: { sourceRootId, issuedAt, nonce, signature: "0".repeat(64) } });
    expect(rejected.statusCode).toBe(403);
    const accepted = await app.inject({ method: "POST", url: "/api/v1/local/focus", headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }, payload: { sourceRootId, issuedAt, nonce, signature } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ focused: true, focusVersion: 1 });
    expect(JSON.stringify(accepted.json())).not.toContain(sourceRootId);
    const focus = await app.inject({ method: "GET", url: "/api/v1/local/focus", headers: { host: client.host, cookie: client.cookie } });
    expect(focus.statusCode).toBe(200);
    expect(focus.json()).toMatchObject({ focusVersion: 1, focusChangedAt: expect.any(String) });
    expect(JSON.stringify(focus.json())).not.toContain(sourceRootId);
    const replay = await app.inject({ method: "POST", url: "/api/v1/local/focus", headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }, payload: { sourceRootId, issuedAt, nonce, signature } });
    expect(replay.statusCode).toBe(403);
  });

  it("keeps the exact viewed root when durable bindings share an agent session", async () => {
    class SharedSessionBridge extends TestBridge {
      putDuplicateRootFirst(): void {
        const active = this.activeBinding;
        if (active === undefined) throw new Error("expected an active binding");
        this.activeBindings.clear();
        this.activeBindings.set("source-root-test-2", { ...active, sourceRootId: "source-root-test-2" });
        this.activeBindings.set(active.sourceRootId, active);
      }
    }
    const bridge = new SharedSessionBridge(() => true);
    const app = appFor(() => claims(), { localMode: true, bridge });
    const client = await localClient(app);
    const handle = client.status.json<{ candidateRoots: Array<{ selectionHandle: string }> }>().candidateRoots[0]!.selectionHandle;
    const paired = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: localMutationHeaders(client),
      payload: { selectionHandle: handle },
    });
    expect(paired.statusCode).toBe(201);
    updateLocalCsrf(client, paired);

    bridge.putDuplicateRootFirst();
    const status = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json().activeTask).toMatchObject({ displayName: "Planner" });
    const activeCandidates = status.json<{ candidateRoots: Array<{ active?: boolean; displayName: string }> }>()
      .candidateRoots.filter((candidate) => candidate.active === true);
    expect(activeCandidates).toEqual([expect.objectContaining({ displayName: "Planner" })]);
  });

  it("keeps the latest browser switch when an older slow switch finishes later", async () => {
    let releaseSlowSwitch!: () => void;
    let slowSwitchStarted!: () => void;
    const slowSwitchGate = new Promise<void>((resolve) => { releaseSlowSwitch = resolve; });
    const slowSwitchSignal = new Promise<void>((resolve) => { slowSwitchStarted = resolve; });
    class DelayedSwitchBridge extends TestBridge {
      hasActiveCalls = 0;
      ensureCalls = 0;

      override hasActivePairing(input: Parameters<TestBridge["hasActivePairing"]>[0]): boolean {
        this.hasActiveCalls += 1;
        return super.hasActivePairing(input);
      }

      override async issuePairingCredential(input: Parameters<TestBridge["issuePairingCredential"]>[0]) {
        if (input.sourceRootId === "source-root-test-2") {
          slowSwitchStarted();
          await slowSwitchGate;
        }
        return super.issuePairingCredential(input);
      }

      async ensureActivePairing(): Promise<void> {
        this.ensureCalls += 1;
      }
    }
    const bridge = new DelayedSwitchBridge(() => true);
    const app = appFor(() => claims(), { localMode: true, bridge });
    const client = await localClient(app);
    const initialHandle = client.status.json<{ candidateRoots: Array<{ selectionHandle: string }> }>().candidateRoots[0]!.selectionHandle;
    const paired = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: localMutationHeaders(client),
      payload: { selectionHandle: initialHandle },
    });
    expect(paired.statusCode).toBe(201);
    updateLocalCsrf(client, paired);

    const beforeSlow = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
    client.csrfToken = beforeSlow.json<{ csrfToken: string }>().csrfToken;
    const slowHandle = beforeSlow.json<{ candidateRoots: Array<{ selectionHandle: string }> }>().candidateRoots[1]!.selectionHandle;
    const slowSwitch = app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/switch",
      headers: localMutationHeaders(client),
      payload: { selectionHandle: slowHandle, confirmation: true },
    });
    await slowSwitchSignal;

    const whileSlow = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
    client.csrfToken = whileSlow.json<{ csrfToken: string }>().csrfToken;
    const latestHandle = whileSlow.json<{ candidateRoots: Array<{ selectionHandle: string }> }>().candidateRoots[0]!.selectionHandle;
    const latestSwitch = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/switch",
      headers: localMutationHeaders(client),
      payload: { selectionHandle: latestHandle, confirmation: true },
    });
    expect(latestSwitch.statusCode).toBe(200);
    updateLocalCsrf(client, latestSwitch);

    releaseSlowSwitch();
    const superseded = await slowSwitch;
    expect(superseded.statusCode).toBe(200);
    expect(superseded.json()).toEqual(expect.objectContaining({ paired: true, syncing: true }));
    const finalStatus = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
    expect(finalStatus.json().activeTask).toMatchObject({ displayName: "Planner" });
    expect(bridge.listActivePairings("codex-local-dev")).toEqual([
      expect.objectContaining({ sourceRootId: "source-root-test-1" }),
    ]);
    expect(bridge.hasActiveCalls).toBe(1);
    expect(bridge.ensureCalls).toBe(1);
  });

  it("claims one durable binding after restart while isolating other browser sessions", async () => {
    const durable = new DurableStore();
    durables.push(durable);
    const persistedScope = { tenantId: "tenant-persisted", ownerId: "owner-persisted", agentSessionId: "as_persisted" } as const;
    durable.createAgentSession({ ...persistedScope, sourceAdapter: "codex-app-server" });
    const gate: AdapterGateAccepted = {
      status: "accepted",
      adapterVersion: "fixture-v1",
      schemaVersion: "fixture-v1",
      fingerprint: {
        reportedUserAgent: "Codex Desktop/fixture",
        schemaBundleSha256: "schema",
        connectionTime: new Date(0).toISOString(),
      },
    };
    const bridge = new ReadOnlyCodexBridgeAdapter({
      durable,
      client: {
        gate,
        listThreads: async () => ({ threads: [{ sourceThreadId: "root-persisted", status: "active" }] }),
        readThread: async () => ({ thread: { sourceThreadId: "root-persisted", status: "active" }, turns: [] }),
        listModels: async () => ({ models: [] }),
      } as never,
      sourceRootAuthority: {
        attestSourceRoot: async (input) => ({
          installationId: input.installationId,
          sourceRootId: input.sourceRootId,
          sourceSessionId: "source-session-persisted",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          attestationDigest: "a".repeat(64),
        }),
      },
      verifyPairingSignature: () => true,
    });
    await bridge.issuePairingCredential({
      pairingId: "pairing-persisted",
      nonce: "nonce-persisted",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerId: persistedScope.ownerId,
      tenantId: persistedScope.tenantId,
      installationId: "installation-persisted",
      publicKey: "fixture",
      sourceRootId: "root-persisted",
      sourceSessionId: "source-session-persisted",
      sourceRootAttestationDigest: "a".repeat(64),
      sourceRootAttestationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      agentSessionId: persistedScope.agentSessionId,
      requestedScopes: ["bridge:ingest"],
    });

    const directory = mkdtempSync(join(tmpdir(), "agent-farm-claim-"));
    localDataDirectories.push(directory);
    const storePort = new DurableStorePort(durable);
    const app = appFor(() => claims(), {
      localMode: true,
      localInstallationId: "installation-persisted",
      localDataDirectory: directory,
      store: storePort,
      bridge,
    });
    const concurrentClients = await Promise.all([
      localClient(app),
      localClient(app, "localhost:8787"),
    ]);
    const claimed = concurrentClients.find((client) => client.agentSessionId === persistedScope.agentSessionId);
    const isolated = concurrentClients.find((client) => client.agentSessionId !== persistedScope.agentSessionId);
    expect(claimed).toBeDefined();
    expect(isolated).toBeDefined();
    if (claimed === undefined || isolated === undefined) throw new Error("expected one durable claimant and one isolated browser");
    const staleClaimedCookie = claimed.cookie;
    expect(claimed.agentSessionId).toBe(persistedScope.agentSessionId);
    expect(claimed.status.json<{ paired: boolean }>().paired).toBe(true);
    expect(isolated.status.json<{ paired: boolean }>().paired).toBe(false);

    // Rotation/reload retains the persisted owner scope rather than deriving
    // a fresh local principal from the replacement cookie.
    const bootstrap = await app.inject({ method: "GET", url: "/api/v1/local/bootstrap", headers: { host: claimed.host, cookie: claimed.cookie } });
    const rotated = await app.inject({
      method: "POST",
      url: "/api/v1/local/session",
      headers: {
        host: claimed.host,
        origin: claimed.origin,
        cookie: `${claimed.cookie}; ${cookiePair(bootstrap, "agent-farm-local-bootstrap")}`,
        "x-csrf-token": bootstrap.json<{ csrfToken: string }>().csrfToken,
      },
      payload: {},
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json<{ agentSessionId: string }>().agentSessionId).toBe(persistedScope.agentSessionId);
    const rotatedCookie = cookiePair(rotated, "agent-farm-local-session");
    const rotatedStatus = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: claimed.host, cookie: rotatedCookie } });
    expect(rotatedStatus.statusCode).toBe(200);
    expect(rotatedStatus.json<{ paired: boolean }>().paired).toBe(true);

    const crossSessionRead = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${persistedScope.agentSessionId}/hierarchy`,
      headers: { host: isolated.host, cookie: isolated.cookie },
    });
    expect(crossSessionRead.statusCode).toBe(404);

    // A durable restart claim must authorize the same persisted projection,
    // not merely report paired=true. This is the browser's first real read
    // after the in-memory local-session map has been rebuilt.
    durable.agents.upsert(persistedScope, {
      agentId: "agent-root",
      sourceAdapter: "codex-app-server",
      sourceThreadId: "root-persisted",
      role: "root",
      name: "Root",
      lifecycle: "running",
      verificationState: "unverified",
      isRoot: true,
      spawnOrdinal: 1,
    });
    durable.agents.upsert(persistedScope, {
      agentId: "agent-child",
      sourceAdapter: "codex-app-server",
      sourceThreadId: "child-persisted",
      parentSourceThreadId: "root-persisted",
      role: "worker",
      name: "Child",
      lifecycle: "completed",
      verificationState: "unverified",
      spawnOrdinal: 2,
    });
    durable.edges.add(persistedScope, {
      parentAgentId: "agent-root",
      childAgentId: "agent-child",
      source: "app-server",
      spawnOrdinal: 2,
    });

    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const restarted = appFor(() => claims(), {
      localMode: true,
      localInstallationId: "installation-persisted",
      localDataDirectory: directory,
      store: storePort,
      bridge,
    });
    // The browser sends its old signed cookie on the first bootstrap after a
    // restart. The new process must replace that stale cookie, claim the
    // unique durable binding, and authorize the persisted projection.
    const restartBootstrap = await restarted.inject({
      method: "GET",
      url: "/api/v1/local/bootstrap",
      remoteAddress: "127.0.0.1",
      headers: { host: claimed.host, cookie: staleClaimedCookie },
    });
    const remountedSession = await restarted.inject({
      method: "POST",
      url: "/api/v1/local/session",
      remoteAddress: "127.0.0.1",
      headers: {
        host: claimed.host,
        origin: claimed.origin,
        cookie: `${staleClaimedCookie}; ${cookiePair(restartBootstrap, "agent-farm-local-bootstrap")}`,
        "x-csrf-token": restartBootstrap.json<{ csrfToken: string }>().csrfToken,
      },
      payload: {},
    });
    expect([200, 201]).toContain(remountedSession.statusCode);
    const remounted = {
      host: claimed.host,
      cookie: cookiePair(remountedSession, "agent-farm-local-session"),
      agentSessionId: remountedSession.json<{ agentSessionId: string }>().agentSessionId,
    };
    expect(remounted.cookie).not.toBe(staleClaimedCookie);
    expect(remounted.agentSessionId).toBe(persistedScope.agentSessionId);
    const remountedStatus = await restarted.inject({
      method: "GET",
      url: "/api/v1/local/status",
      remoteAddress: "127.0.0.1",
      headers: { host: remounted.host, cookie: remounted.cookie },
    });
    expect(remountedStatus.statusCode).toBe(200);
    expect(remountedStatus.json<{ paired: boolean }>().paired).toBe(true);
    expect(durable.bridgeBindings.resolveUniqueActive("installation-persisted")).toMatchObject({ selectedSourceRootId: "root-persisted" });
    const remountedHierarchy = await restarted.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${remounted.agentSessionId}/hierarchy`,
      remoteAddress: "127.0.0.1",
      headers: { host: remounted.host, cookie: remounted.cookie },
    });
    expect(remountedHierarchy.statusCode).toBe(200);
    expect(remountedHierarchy.json<{ nodes: readonly unknown[]; edges: readonly unknown[] }>().nodes).toHaveLength(2);
    expect(remountedHierarchy.json<{ nodes: readonly unknown[]; edges: readonly unknown[] }>().edges).toHaveLength(1);
  });

  it("does not claim an old durable binding when the trusted launcher names a different task", async () => {
    const durable = new DurableStore();
    durables.push(durable);
    const oldScope = { tenantId: "tenant-old", ownerId: "owner-old", agentSessionId: "as_old_projection" } as const;
    durable.createAgentSession({ ...oldScope, sourceAdapter: "codex-app-server" });
    const gate: AdapterGateAccepted = {
      status: "accepted",
      adapterVersion: "fixture-v1",
      schemaVersion: "fixture-v1",
      fingerprint: { reportedUserAgent: "Codex Desktop/fixture", schemaBundleSha256: "schema", connectionTime: new Date(0).toISOString() },
    };
    const bridge = new ReadOnlyCodexBridgeAdapter({
      durable,
      client: {
        gate,
        listThreads: async () => ({ threads: [
          { sourceThreadId: "root-new", agentNickname: "Launched task", status: "active" },
          { sourceThreadId: "root-old", agentNickname: "Historical task", status: "completed" },
        ] }),
        readThread: async (input: JsonObject) => ({ thread: { sourceThreadId: String(input.threadId), status: "active" }, turns: [] }),
        listModels: async () => ({ models: [] }),
      } as never,
      sourceRootAuthority: {
        attestSourceRoot: async (input) => ({
          installationId: input.installationId,
          sourceRootId: input.sourceRootId,
          sourceSessionId: `source-${input.sourceRootId}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          attestationDigest: "a".repeat(64),
        }),
      },
      verifyPairingSignature: () => true,
    });
    await bridge.issuePairingCredential({
      pairingId: "pairing-old", nonce: "nonce-old", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerId: oldScope.ownerId, tenantId: oldScope.tenantId, installationId: "installation-current-task",
      publicKey: "fixture", sourceRootId: "root-old", sourceSessionId: "source-root-old",
      sourceRootAttestationDigest: "a".repeat(64), sourceRootAttestationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      agentSessionId: oldScope.agentSessionId, requestedScopes: ["bridge:ingest"],
    });

    const directory = mkdtempSync(join(tmpdir(), "agent-farm-current-task-"));
    localDataDirectories.push(directory);
    const app = appFor(() => claims(), {
      localMode: true,
      localInstallationId: "installation-current-task",
      expectedLocalSourceRootId: "root-new",
      localDataDirectory: directory,
      store: new DurableStorePort(durable),
      bridge,
    });
    const client = await localClient(app);
    expect(client.agentSessionId).not.toBe(oldScope.agentSessionId);
    const status = client.status.json<{ paired: boolean; candidateRoots: Array<{ selectionHandle: string; launchTarget?: true; active?: true }> }>();
    expect(status.paired).toBe(false);
    const launched = status.candidateRoots.find((candidate) => candidate.launchTarget === true);
    expect(launched).toBeDefined();
    expect(status.candidateRoots.find((candidate) => candidate.active === true)).toBeUndefined();

    const mounted = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: localMutationHeaders(client),
      payload: { selectionHandle: launched?.selectionHandle },
    });
    expect(mounted.statusCode).toBe(201);
    expect(mounted.json<{ agentSessionId: string }>().agentSessionId).toBe(client.agentSessionId);
    expect(durable.bridgeBindings.listActiveForInstallation("installation-current-task")).toEqual([
      expect.objectContaining({ agentSessionId: client.agentSessionId, selectedSourceRootId: "root-new" }),
    ]);
    expect(durable.bridgeBindings.list(oldScope).find((binding) => binding.selectedSourceRootId === "root-old")?.status).toBe("revoked");
  });

  it("surfaces source-root discovery failures instead of returning a silent empty list", async () => {
    class UnavailableDiscoveryBridge extends TestBridge {
      override async listSourceRoots(): Promise<never> { throw new Error("private discovery failure"); }
    }
    const app = appFor(() => claims(), { localMode: true, bridge: new UnavailableDiscoveryBridge(() => true) });
    const client = await localClient(app);
    expect(client.status.json()).toEqual(expect.objectContaining({
      candidateRoots: [],
      sourceRootCount: 0,
      discoveryError: "source_roots_unavailable",
    }));
    expect(client.status.body).not.toContain("private discovery failure");
  });

  it("keeps a missing durable restart session fail-closed across retries", async () => {
    class MissingSessionBridge extends TestBridge {
      override resolveActivePairing(installationId: string) {
        return {
          tenantId: "tenant-missing",
          ownerId: "owner-missing",
          agentSessionId: "as_missing",
          installationId,
          sourceRootId: "root-missing",
        };
      }
    }
    const app = appFor(() => claims(), {
      localMode: true,
      localInstallationId: "installation-missing",
      bridge: new MissingSessionBridge(),
    });
    const attempt = async () => {
      const bootstrap = await app.inject({ method: "GET", url: "/api/v1/local/bootstrap", headers: { host: "127.0.0.1:8787" } });
      return app.inject({
        method: "POST",
        url: "/api/v1/local/session",
        headers: {
          host: "127.0.0.1:8787",
          origin: "http://127.0.0.1:8787",
          cookie: cookiePair(bootstrap, "agent-farm-local-bootstrap"),
          "x-csrf-token": bootstrap.json<{ csrfToken: string }>().csrfToken,
        },
        payload: {},
      });
    };
    const first = await attempt();
    const retry = await attempt();
    expect(first.statusCode).toBe(503);
    expect(retry.statusCode).toBe(503);
    expect(first.json().error.code).toBe("PAIRING_UNAVAILABLE");
    expect(retry.json().error.code).toBe("PAIRING_UNAVAILABLE");
  });

  it("serves rich local details only to the owning local session and exposes no control surface", async () => {
    const durable = new DurableStore(":memory:");
    durables.push(durable);
    const storePort = new DurableStorePort(durable);
    storePort.setLocalDetailReader(async (sourceThreadId) => ({
      schemaVersion: "agent-farm.local-rollout-detail.v2",
      sourceThreadId,
      messages: [{ role: "assistant", text: "safe final response" }],
      activity: [{ kind: "lifecycle", status: "completed" }],
      tools: [],
      changedFiles: [{ path: "/private/tmp/safe.ts", additions: 3, deletions: 1 }],
      finalSummary: "safe summary",
    }));
    const app = appFor(() => claims(), { localMode: true, store: storePort });
    const owner = await localClient(app);
    const row = durable.db.prepare("SELECT tenant_id, owner_id FROM app_sessions WHERE agent_session_id = ?")
      .get(owner.agentSessionId) as { tenant_id: string; owner_id: string };
    const scope = { tenantId: row.tenant_id, ownerId: row.owner_id, agentSessionId: owner.agentSessionId };
    durable.agents.upsert(scope, {
      agentId: "local-detail-root",
      sourceThreadId: "local-detail-thread",
      name: "Same display name",
      isRoot: true,
      lifecycle: "completed",
    });
    durable.events.ingest(scope, {
      eventKey: "local-detail-revision-1",
      eventType: "thread.status.changed",
      connectionEpoch: "local-detail-epoch",
      sourceThreadId: "local-detail-thread",
      payload: { agentId: "local-detail-root", status: "completed" },
    });
    const hierarchy = await storePort.getHierarchy({ ...scope, page: 1, pageSize: 200 });
    const publicAgentId = hierarchy?.nodes[0]?.agentId;
    expect(publicAgentId).toBeDefined();
    const url = `/api/v1/local/sessions/${owner.agentSessionId}/agents/${publicAgentId as string}/details`;

    const unauthorized = await app.inject({ method: "GET", url, headers: { host: owner.host } });
    expect(unauthorized.statusCode).toBe(401);

    const success = await app.inject({ method: "GET", url, headers: { host: owner.host, cookie: owner.cookie } });
    expect(success.statusCode).toBe(200);
    expect(success.json()).toMatchObject({
      agentSessionId: owner.agentSessionId,
      agent: { agentId: publicAgentId },
      messages: [{ role: "assistant", text: "safe final response" }],
      changedFiles: [{ path: "/private/tmp/safe.ts", additions: 3, deletions: 1 }],
      summary: "safe summary",
      cost: { status: "unavailable" },
    });
    expect(JSON.stringify(success.json())).not.toMatch(/credential|authorization|password|private[-_]?key|function_call|control/iu);
    const ownerRevision = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${owner.agentSessionId}/hierarchy/revision`,
      headers: { host: owner.host, cookie: owner.cookie },
    });
    expect(ownerRevision.json()).toMatchObject({ agentSessionId: owner.agentSessionId, revision: 1 });

    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/local/sessions/${owner.agentSessionId}/agents/agent:${"0".repeat(40)}/details`,
      headers: { host: owner.host, cookie: owner.cookie },
    });
    expect(missing.statusCode).toBe(404);

    const other = await localClient(app, "localhost:8787");
    const crossSession = await app.inject({ method: "GET", url, headers: { host: other.host, cookie: other.cookie } });
    expect(crossSession.statusCode).toBe(404);
    const crossRevision = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${owner.agentSessionId}/hierarchy/revision`,
      headers: { host: other.host, cookie: other.cookie },
    });
    expect(crossRevision.statusCode).toBe(404);
  });

  it("serves an authenticated content-free hierarchy revision scoped to its owner session", async () => {
    const app = appFor((token) => token === "b"
      ? claims({ sub: "owner-b", ownerId: "owner-b", tenantId: "tenant-b" })
      : claims());
    const created = await createSession(app, "a");
    const agentSessionId = created.json<{ agentSessionId: string }>().agentSessionId;
    const revision = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${agentSessionId}/hierarchy/revision`,
      headers: { authorization: "Bearer a" },
    });
    expect(revision.statusCode).toBe(200);
    expect(revision.headers["cache-control"]).toBe("no-store");
    expect(revision.json()).toEqual({
      schemaVersion: "agent-farm.hierarchy-revision.v1",
      agentSessionId,
      revision: 0,
    });
    expect(Object.keys(revision.json())).toEqual(["schemaVersion", "agentSessionId", "revision"]);
    const alias = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${agentSessionId}/hierarchy/revision`,
      headers: { authorization: "Bearer a" },
    });
    expect(alias.json()).toEqual(revision.json());

    const unauthenticated = await app.inject({ method: "GET", url: `/api/v1/agent-sessions/${agentSessionId}/hierarchy/revision` });
    expect(unauthenticated.statusCode).toBe(401);
    const crossOwner = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${agentSessionId}/hierarchy/revision`,
      headers: { authorization: "Bearer b" },
    });
    expect(crossOwner.statusCode).toBe(404);
  });

  it("requires confirmation and preserves the old binding when a switch fails", async () => {
    class SwitchBridge extends TestBridge {
      failSwitch = false;
      lastInput: Parameters<TestBridge["issuePairingCredential"]>[0] | undefined;

      override async issuePairingCredential(input: Parameters<TestBridge["issuePairingCredential"]>[0]) {
        this.lastInput = input;
        if ((input.replaceExisting === true || input.retainExisting === true) && this.failSwitch) throw new Error("switch failed");
        return super.issuePairingCredential(input);
      }
    }
    const bridge = new SwitchBridge(() => true);
    const app = appFor(() => claims(), { localMode: true, bridge });
    const client = await localClient(app);
    const firstHandle = client.status.json<{ candidateRoots: Array<{ selectionHandle: string }> }>().candidateRoots[0]?.selectionHandle;
    const paired = await app.inject({ method: "POST", url: "/api/v1/local/pairing/root", headers: localMutationHeaders(client), payload: { selectionHandle: firstHandle } });
    expect(paired.statusCode).toBe(201);
    updateLocalCsrf(client, paired);

    const refresh = async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ csrfToken: string; candidateRoots: Array<{ selectionHandle: string }> }>();
      client.csrfToken = body.csrfToken;
      return body.candidateRoots[1]?.selectionHandle;
    };
    const secondHandle = await refresh();
    const noConfirmation = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/switch",
      headers: localMutationHeaders(client),
      payload: { selectionHandle: secondHandle, confirmation: false },
    });
    expect(noConfirmation.statusCode).toBe(400);
    expect(noConfirmation.json().error.code).toBe("CONFIRMATION_REQUIRED");
    updateLocalCsrf(client, noConfirmation);

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/switch",
      headers: { host: client.host, origin: client.origin, cookie: client.cookie },
      payload: { selectionHandle: secondHandle, confirmation: true },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json().error.code).toBe("CSRF_FAILED");

    bridge.failSwitch = true;
    const failedSwitch = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/switch",
      headers: localMutationHeaders(client),
      payload: { selectionHandle: secondHandle, confirmation: true },
    });
    expect(failedSwitch.statusCode).toBe(200);
    expect(failedSwitch.json()).toEqual(expect.objectContaining({ paired: true, syncing: true }));
    updateLocalCsrf(client, failedSwitch);
    await vi.waitFor(() => expect(bridge.lastInput?.sourceRootId).toBe("source-root-test-2"));
    const afterFailure = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
    expect(afterFailure.statusCode).toBe(200);
    expect(afterFailure.json<{ paired: boolean }>().paired).toBe(true);
    expect(afterFailure.json<{ agentSessionId: string }>().agentSessionId).toBe(client.agentSessionId);
    expect(bridge.resolveActivePairing("codex-local-dev")?.sourceRootId).toBe("source-root-test-1");

    bridge.failSwitch = false;
    const thirdHandle = await refresh();
    const switched = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/switch",
      headers: localMutationHeaders(client),
      payload: { selectionHandle: thirdHandle, confirmation: true },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toEqual(expect.objectContaining({ paired: true, syncing: true, agentSessionId: expect.stringMatching(/^as_/u) }));
    await vi.waitFor(() => expect(bridge.listActivePairings("codex-local-dev").some((pairing) => pairing.sourceRootId === "source-root-test-2")).toBe(true));
    expect(bridge.listActivePairings("codex-local-dev")).toEqual([
      expect.objectContaining({ sourceRootId: "source-root-test-2" }),
    ]);
    expect(bridge.lastInput?.deferRuntimeActivation).toBe(true);
    expect(bridge.lastInput?.replaceExisting).toBe(true);
    expect(bridge.lastInput?.retainExisting).toBeUndefined();
    expect(bridge.lastInput?.expectedActiveBinding).toMatchObject({
      agentSessionId: client.agentSessionId,
      sourceRootId: "source-root-test-1",
    });
    expect(switched.json<{ agentSessionId: string }>().agentSessionId).not.toBe(client.agentSessionId);
    expect(switched.json()).not.toHaveProperty("credential");
    updateLocalCsrf(client, switched);

    const issuedBeforeReselection = bridge.issued.length;
    const switchedStatus = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
    client.csrfToken = switchedStatus.json<{ csrfToken: string }>().csrfToken;
    const activeHandle = switchedStatus.json<{ candidateRoots: Array<{ displayName: string; selectionHandle: string }> }>()
      .candidateRoots.find((candidate) => candidate.displayName === "Builder")?.selectionHandle;
    const reselected = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/switch",
      headers: localMutationHeaders(client),
      payload: { selectionHandle: activeHandle, confirmation: true },
    });
    expect(reselected.statusCode).toBe(200);
    expect(reselected.json()).not.toHaveProperty("syncing");
    expect(bridge.issued).toHaveLength(issuedBeforeReselection);
    updateLocalCsrf(client, reselected);

    const beforeSwitchBack = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
    client.csrfToken = beforeSwitchBack.json<{ csrfToken: string }>().csrfToken;
    const firstRootHandle = beforeSwitchBack.json<{ candidateRoots: Array<{ displayName: string; selectionHandle: string }> }>()
      .candidateRoots.find((candidate) => candidate.displayName === "Planner")?.selectionHandle;
    const switchedBack = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/switch",
      headers: localMutationHeaders(client),
      payload: { selectionHandle: firstRootHandle, confirmation: true },
    });
    expect(switchedBack.statusCode).toBe(200);
    await vi.waitFor(() => expect(bridge.listActivePairings("codex-local-dev")).toEqual([
      expect.objectContaining({ sourceRootId: "source-root-test-1" }),
    ]));
    updateLocalCsrf(client, switchedBack);

    const other = await localClient(app, "localhost:8787");
    const otherUnpair = await app.inject({ method: "POST", url: "/api/v1/local/pairing/unpair", headers: localMutationHeaders(other), payload: { confirmation: true } });
    expect(otherUnpair.statusCode).toBe(200);
    expect(otherUnpair.json()).toEqual({ paired: false });

    const noUnpairConfirmation = await app.inject({ method: "POST", url: "/api/v1/local/pairing/unpair", headers: localMutationHeaders(client), payload: {} });
    expect(noUnpairConfirmation.statusCode).toBe(400);
    updateLocalCsrf(client, noUnpairConfirmation);
    const unpaired = await app.inject({ method: "POST", url: "/api/v1/local/pairing/unpair", headers: localMutationHeaders(client), payload: { confirmation: true } });
    expect(unpaired.statusCode).toBe(200);
    expect(unpaired.json()).toEqual({ paired: false });
    updateLocalCsrf(client, unpaired);
    const afterUnpair = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
    expect(afterUnpair.statusCode).toBe(401);
  });

  it("does not clear local authority when durable unpair cannot commit", async () => {
    class UnpairFailureBridge extends TestBridge {
      mode: "ok" | "false" | "throw" = "ok";

      override async revokePairing(input: Parameters<TestBridge["revokePairing"]>[0]): Promise<boolean> {
        if (this.mode === "throw") throw new Error("revoke failed");
        if (this.mode === "false") return false;
        return super.revokePairing(input);
      }
    }
    const bridge = new UnpairFailureBridge(() => true);
    const app = appFor(() => claims(), { localMode: true, bridge });
    const client = await localClient(app);
    const handle = client.status.json<{ candidateRoots: Array<{ selectionHandle: string }> }>().candidateRoots[0]?.selectionHandle;
    const paired = await app.inject({ method: "POST", url: "/api/v1/local/pairing/root", headers: localMutationHeaders(client), payload: { selectionHandle: handle } });
    expect(paired.statusCode).toBe(201);
    updateLocalCsrf(client, paired);

    bridge.mode = "throw";
    const thrown = await app.inject({ method: "POST", url: "/api/v1/local/pairing/unpair", headers: localMutationHeaders(client), payload: { confirmation: true } });
    expect(thrown.statusCode).toBe(503);
    updateLocalCsrf(client, thrown);
    expect((await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } })).json<{ paired: boolean }>().paired).toBe(true);

    bridge.mode = "false";
    const falseResult = await app.inject({ method: "POST", url: "/api/v1/local/pairing/unpair", headers: localMutationHeaders(client), payload: { confirmation: true } });
    expect(falseResult.statusCode).toBe(503);
    updateLocalCsrf(client, falseResult);
    expect((await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } })).json<{ paired: boolean }>().paired).toBe(true);

    bridge.mode = "ok";
    const committed = await app.inject({ method: "POST", url: "/api/v1/local/pairing/unpair", headers: localMutationHeaders(client), payload: { confirmation: true } });
    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toEqual({ paired: false });
  });

  it("rejects exact-boundary violations before local handlers", async () => {
    const app = appFor(() => claims(), {
      localMode: true,
      allowedHosts: ["127.0.0.1:8787"],
      allowedOrigins: ["http://127.0.0.1:8787"],
    });
    const badHost = await app.inject({ method: "GET", url: "/api/v1/local/bootstrap", headers: { host: "127.0.0.1" } });
    expect(badHost.statusCode).toBe(403);
    const dnsRebinding = await app.inject({ method: "GET", url: "/api/v1/local/bootstrap", headers: { host: "127.0.0.1.nip.io:8787" } });
    expect(dnsRebinding.statusCode).toBe(403);
    for (const name of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-forwarded-prefix"]) {
      const forwarded = await app.inject({ method: "GET", url: "/api/v1/local/bootstrap", headers: { host: "127.0.0.1:8787", [name]: "127.0.0.1" } });
      expect(forwarded.statusCode).toBe(403);
      expect(forwarded.json().error.code).toBe("LOCAL_MODE_FORWARDED_HEADER_REJECTED");
    }
    for (const origin of ["https://127.0.0.1:8787", "http://evil.test:8787", "null", "malformed-origin"]) {
      const foreignOrigin = await app.inject({ method: "GET", url: "/api/v1/local/bootstrap", headers: { host: "127.0.0.1:8787", origin } });
      expect(foreignOrigin.statusCode).toBe(403);
      expect(foreignOrigin.json().error.code).toBe("LOCAL_MODE_ORIGIN_REQUIRED");
    }
    const bearer = await app.inject({ method: "GET", url: "/api/v1/local/bootstrap", headers: { host: "127.0.0.1:8787", authorization: "Bearer local" } });
    expect(bearer.statusCode).toBe(401);
    for (const url of [
      "/api/v1/local/bootstrap?access_token=secret",
      "/api/v1/local/bootstrap?%61ccess_token=secret",
      "/api/v1/local/bootstrap?ToKeN=secret",
      "/api/v1/local/bootstrap?%41PI_KEY=secret",
      "/api/v1/local/bootstrap?state=Bearer%20abc",
      "/api/v1/local/bootstrap?state=eyJhbGciOiJIUzI1NiJ9.abc.def",
      "/api/v1/local/bootstrap?state=%65%79%4a%68%62%47%63%69%4f%69%4a%49%55%7a%49%31%4e%69%4a%39.abc.def",
      "/api/v1/local/bootstrap?state=BeArEr%20abc123",
      "/api/v1/local/bootstrap?safe=0123456789abcdef0123456789abcdef",
      "/api/v1/local/bootstrap?safe=abcdefghijklmnopqrstuvwxyz123456",
      "/api/v1/local/bootstrap?access_token=one&%61ccess_token=two",
      "/api/v1/local/bootstrap?safe=one&%73ession=two",
    ]) {
      const tokenUrl = await app.inject({ method: "GET", url, headers: { host: "127.0.0.1:8787" } });
      expect(tokenUrl.statusCode).toBe(400);
      expect(tokenUrl.json().error.code).toBe("INVALID_REQUEST");
    }
    const benignQuery = await app.inject({ method: "GET", url: "/api/v1/local/bootstrap?search=abcdefghijklmnopqrstuvwxyz", headers: { host: "127.0.0.1:8787" } });
    expect(benignQuery.statusCode).toBe(200);
  });

  it("sanitizes local root metadata and deduplicates source roots", async () => {
    class NoisyBridge extends TestBridge {
      override async listSourceRoots() {
        return [
          {
            sourceRootId: "root-safe",
            nickname: "Planner\u0000with-control",
            agentPath: "/root\u0001with-control",
            status: "running",
            updatedAt: "2026-08-10\u007fT10:00:00.000Z",
          },
          { sourceRootId: "root-safe", status: "duplicate" },
          { sourceRootId: "root\u0000invalid", status: "ignored" },
          { sourceRootId: "root-invalid-status", status: "bad\u0001status" },
        ];
      }
    }
    const app = appFor(() => claims(), { localMode: true, bridge: new NoisyBridge() });
    const client = await localClient(app);
    const response = client.status;
    expect(response.statusCode).toBe(200);
    const body = response.json<{ candidateRoots: Array<Record<string, unknown>> }>();
    expect(body).toEqual(expect.objectContaining({
      sourceRootCount: 1,
      candidateRoots: [{ selectionHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u), chatHandle: expect.stringMatching(/^[a-f0-9]{64}$/u), displayName: "Chat · 01", lifecycle: "running" }],
    }));
    expect(JSON.stringify(body)).not.toContain("root-safe");
    expect(JSON.stringify(body)).not.toContain("agentPath");
    expect(JSON.stringify(body)).not.toContain("installationId");
  });

  it("lists local roots with the explicit bounded discovery filter and cursor", async () => {
    const calls: JsonObject[] = [];
    const gate: AdapterGateAccepted = {
      status: "accepted",
      adapterVersion: "fixture-v1",
      schemaVersion: "fixture-schema-v1",
      fingerprint: {
        reportedUserAgent: "Codex Desktop/fixture",
        schemaBundleSha256: "schema",
        connectionTime: new Date(0).toISOString(),
      },
    };
    const root = (sourceThreadId: string, parentThreadId?: string, recencyAt?: string): SanitizedThread => ({
      sourceThreadId,
      status: "active",
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
      ...(recencyAt === undefined ? {} : { recencyAt }),
    });
    const adapter = new ReadOnlyCodexBridgeAdapter({
      client: {
        gate,
        async listThreads(params?: JsonObject) {
          calls.push(params ?? {});
          return calls.length === 1
            ? { threads: [root("root-1", undefined, "2026-08-10T10:00:00.000Z"), { ...root("guardian-root"), sourceKind: "subagent" }, root("child-1", "root-1")], nextCursor: "page-2" }
            : { threads: [root("root-2", undefined, "2026-08-11T10:00:00.000Z")] };
        },
        async readThread() {
          return { thread: root("root-1"), turns: [] };
        },
        async listModels() {
          return { models: [] };
        },
      },
    });
    const roots = await adapter.listSourceRoots();
    expect(roots.map((candidate) => candidate.sourceRootId)).toEqual(["root-2", "root-1"]);
    expect(calls).toEqual([
      {
        archived: false,
        useStateDbOnly: true,
        sourceKinds: [...CODEX_DISCOVERY_SOURCE_KINDS],
        limit: 100,
      },
      {
        archived: false,
        useStateDbOnly: true,
        sourceKinds: [...CODEX_DISCOVERY_SOURCE_KINDS],
        limit: 100,
        cursor: "page-2",
      },
    ]);
  });

  it("prefers app-server titles and fills missing root titles from the trusted session index", async () => {
    const calls: JsonObject[] = [];
    const gate: AdapterGateAccepted = {
      status: "accepted",
      adapterVersion: "fixture-v1",
      schemaVersion: "fixture-schema-v1",
      fingerprint: {
        reportedUserAgent: "Codex Desktop/fixture",
        schemaBundleSha256: "schema",
        connectionTime: new Date(0).toISOString(),
      },
    };
    const root = (sourceThreadId: string, chatTitle?: string): SanitizedThread => ({
      sourceThreadId,
      status: "active",
      ...(chatTitle === undefined ? {} : { chatTitle }),
    });
    const adapter = new ReadOnlyCodexBridgeAdapter({
      client: {
        gate,
        async listThreads(params?: JsonObject) {
          calls.push(params ?? {});
          return { threads: [root("root-with-title", "App-server title"), root("root-index-title")] };
        },
        async readChatTitle(sourceThreadId: string) {
          return sourceThreadId === "root-index-title" ? "Codex Desktop title" : "Should not win";
        },
        async readThread() {
          return { thread: root("root-with-title"), turns: [] };
        },
        async listModels() {
          return { models: [] };
        },
      },
    });
    await expect(adapter.listSourceRoots()).resolves.toEqual(expect.arrayContaining([
      { sourceRootId: "root-index-title", chatTitle: "Codex Desktop title", status: "active" },
      { sourceRootId: "root-with-title", chatTitle: "App-server title", status: "active" },
    ]));
    expect(calls).toHaveLength(1);
  });

  it("does not replace an explicit local-mode bearer with the local principal", async () => {
    const app = appFor(() => { throw new Error("invalid bearer"); }, { localMode: true });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/local/status",
      headers: { host: "localhost", authorization: "Bearer invalid" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("does not register local bootstrap routes outside explicit local mode", async () => {
    const app = appFor();
    const response = await app.inject({ method: "GET", url: "/api/v1/local/status" });
    expect(response.statusCode).toBe(404);
  });

  it("enforces body/page limits and does not expose error stacks", async () => {
    const throwingStore: StorePort = {
      async createAgentSession() {
        throw new Error("secret internal stack marker");
      },
      async getHierarchy() {
        throw new Error("secret internal stack marker");
      },
    };
    const app = appFor(() => claims(), { store: throwingStore, bodyLimit: 128 });
    const tooLarge = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: "Bearer a", "idempotency-key": "large" },
      payload: { label: "x".repeat(1_000) },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.body).not.toContain("secret internal stack marker");
    const page = await app.inject({ method: "GET", url: "/api/v1/sessions/nope/hierarchy?pageSize=201", headers: { authorization: "Bearer a" } });
    expect(page.statusCode).toBe(400);
    const internal = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { authorization: "Bearer a", "idempotency-key": "error" }, payload: {} });
    expect(internal.statusCode).toBe(500);
    expect(internal.body).not.toContain("secret internal stack marker");
    expect(internal.body).not.toContain("at ");
  });

  it("applies a bounded per-principal request rate", async () => {
    const app = appFor(() => claims(), { rateLimit: { max: 2, windowMs: 60_000 } });
    const first = await app.inject({ method: "GET", url: "/healthz", headers: { authorization: "Bearer a" } });
    const second = await app.inject({ method: "GET", url: "/healthz", headers: { authorization: "Bearer a" } });
    const third = await app.inject({ method: "GET", url: "/healthz", headers: { authorization: "Bearer a" } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("RATE_LIMITED");
  });

  it("never advertises or dispatches a control tool", async () => {
    const app = appFor();
    const list = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer a" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(list.statusCode).toBe(200);
    expect(list.json().result.tools.map((tool: { name: string }) => tool.name)).not.toContain("control_agent");
    const call = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer a" }, payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "control_agent", arguments: {} } } });
    expect(call.statusCode).toBe(200);
    expect(call.json().error.code).toBe(-32601);
  });
});
