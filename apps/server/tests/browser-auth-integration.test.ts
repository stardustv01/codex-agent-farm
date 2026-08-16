import { afterEach, describe, expect, it } from "vitest";

import type { BrowserAuthBff, BrowserAuthenticatedSession } from "../src/browser-auth.js";
import { createApp } from "../src/index.js";

const principal = {
  subject: "browser-owner",
  ownerId: "browser-owner",
  tenantId: "browser-tenant",
  scopes: new Set([
    "agent-session:create",
    "agent-session:read",
    "agent-session:read-details",
    "agent-session:render",
  ]),
} as const;

const browserSession: BrowserAuthenticatedSession = {
  authenticated: true,
  principal,
  sessionId: "opaque-browser-session",
  csrfToken: "csrf_token_1234567890",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function fakeBrowserAuth(): BrowserAuthBff {
  return {
    beginLogin: () => ({
      authorizationUrl: "https://issuer.example/authorize",
      setCookie: "login=opaque; Secure; HttpOnly; SameSite=Lax; Path=/",
      cookieName: "login",
      returnTo: "/",
    }),
    completeCallback: async () => ({
      ...browserSession,
      redirectTo: "/",
      setCookie: "session=opaque; Secure; HttpOnly; SameSite=Lax; Path=/",
      clearLoginCookie: "login=; Max-Age=0; Secure; HttpOnly; SameSite=Lax; Path=/",
    }),
    authenticateCookie: async (cookie?: string) => cookie?.includes("browser=valid") ? browserSession : null,
    requireCsrf: async (cookie?: string, supplied?: unknown) => {
      if (!cookie?.includes("browser=valid") || supplied !== browserSession.csrfToken) throw new Error("denied");
      return browserSession;
    },
    logout: async () => ({ cleared: true, clearCookie: "session=; Max-Age=0", clearLoginCookie: "login=; Max-Age=0" }),
    cleanup: () => ({ pending: 0, sessions: 0 }),
  } as unknown as BrowserAuthBff;
}

const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe("standalone browser auth integration", () => {
  it("registers auth routes and provisions one durable CSRF-protected view session", async () => {
    const app = createApp({ browserAuth: fakeBrowserAuth() });
    apps.push(app);
    const authSession = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: "browser=valid" },
    });
    expect(authSession.statusCode).toBe(200);
    expect(authSession.json()).toMatchObject({ authenticated: true, csrfToken: browserSession.csrfToken });
    expect(authSession.body).not.toContain(browserSession.sessionId);

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/browser/session",
      headers: { cookie: "browser=valid" },
      payload: {},
    });
    expect(missingCsrf.statusCode).toBe(403);

    const create = () => app.inject({
      method: "POST",
      url: "/api/v1/browser/session",
      headers: { cookie: "browser=valid", "x-csrf-token": browserSession.csrfToken },
      payload: {},
    });
    const first = await create();
    const replay = await create();
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().agentSessionId).toBe(first.json().agentSessionId);

    const hierarchy = await app.inject({
      method: "GET",
      url: `/api/v1/agent-sessions/${first.json().agentSessionId}/hierarchy`,
      headers: { cookie: "browser=valid" },
    });
    expect(hierarchy.statusCode).toBe(200);
  });

  it("never falls back from an explicit invalid bearer to a valid browser cookie", async () => {
    const app = createApp({ browserAuth: fakeBrowserAuth() });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agent-sessions/unknown/hierarchy",
      headers: { authorization: "Bearer invalid", cookie: "browser=valid" },
    });
    expect(response.statusCode).toBe(401);
  });
});
