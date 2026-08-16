import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createApp,
  type RawTokenClaims,
  type TokenStatusCheck,
} from "../src/index.js";

const audience = "agent-farm";
const resource = "https://agent-farm.local";

function claims(overrides: Partial<RawTokenClaims> = {}): RawTokenClaims {
  return {
    sub: "owner-a",
    ownerId: "owner-a",
    tenantId: "tenant-a",
    scope: "agent-session:create agent-session:read agent-session:read-details agent-session:render",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    aud: audience,
    resource,
    ...overrides,
  };
}

const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

function appFor(
  tokenClaims: (token: string) => RawTokenClaims,
  tokenStatusVerifier: (input: TokenStatusCheck) => string | boolean,
) {
  const app = createApp({
    auth: {
      audience,
      resource,
      requireJti: true,
      verifyToken: tokenClaims,
      tokenStatusVerifier,
    },
  });
  apps.push(app);
  return app;
}

describe("JWT token lifecycle verification", () => {
  it("requires jti when the deployment opts into token lifecycle checks", async () => {
    const status = vi.fn(() => "active" as const);
    const app = appFor(() => claims(), status);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/not-a-real-session/hierarchy",
      headers: { authorization: "Bearer missing-jti" },
    });

    expect(response.statusCode).toBe(401);
    expect(status).not.toHaveBeenCalled();
  });

  it("rejects revoked and unknown token IDs without exposing bearer material", async () => {
    const app = appFor(
      (token) => claims({ jti: token }),
      ({ jti }) => (jti === "revoked" ? "revoked" : "unknown"),
    );

    const revoked = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/not-a-real-session/hierarchy",
      headers: { authorization: "Bearer revoked" },
    });
    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/not-a-real-session/hierarchy",
      headers: { authorization: "Bearer unknown" },
    });

    expect(revoked.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(revoked.body).not.toContain("revoked");
    expect(revoked.body).not.toContain("jti");
    expect(unknown.body).not.toContain("unknown");
  });

  it("runs lifecycle status after claim validation", async () => {
    const status = vi.fn(() => "active" as const);
    const app = appFor(
      () => claims({ aud: "another-resource", jti: "valid-jti" }),
      status,
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/not-a-real-session/hierarchy",
      headers: { authorization: "Bearer valid-jti" },
    });

    expect(response.statusCode).toBe(401);
    expect(status).not.toHaveBeenCalled();
  });

  it("allows repeated authorized reads for an active JWT", async () => {
    const checks: TokenStatusCheck[] = [];
    const app = appFor(
      (token) => claims({ jti: token }),
      (input) => {
        checks.push(input);
        return "active";
      },
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: {
        authorization: "Bearer stable-jti",
        "idempotency-key": "create-stable",
      },
      payload: { label: "stable" },
    });
    const sessionId = created.json<{ agentSessionId: string }>().agentSessionId;
    const first = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/hierarchy`,
      headers: { authorization: "Bearer stable-jti" },
    });
    const second = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/hierarchy`,
      headers: { authorization: "Bearer stable-jti" },
    });

    expect(created.statusCode).toBe(201);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(checks).toHaveLength(3);
    expect(checks.every((check) => check.jti === "stable-jti")).toBe(true);
    expect(checks.every((check) => !Object.hasOwn(check, "token"))).toBe(true);
    expect(checks.every((check) => !Object.hasOwn(check, "claims"))).toBe(true);
  });
});
