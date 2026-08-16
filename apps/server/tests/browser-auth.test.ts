import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  BrowserAuthBff,
  BrowserAuthError,
  type BrowserAuthOptions,
} from "../src/browser-auth.js";
import type { AuthService, RawTokenClaims, TokenVerificationContext } from "../src/contracts.js";

const NOW = 1_800_000_000_000;
const AUTHORIZATION_ENDPOINT = "https://issuer.example/authorize";
const TOKEN_ENDPOINT = "https://issuer.example/token";
const RESOURCE = "https://agent-farm.example";
const CLIENT_ID = "agent-farm-browser";

function tokenClaims(
  token: string,
  overrides: Partial<RawTokenClaims> = {},
): RawTokenClaims {
  const subject = token === "access-b" ? "owner-b" : "owner-a";
  return {
    sub: subject,
    ownerId: subject,
    tenantId: subject === "owner-b" ? "tenant-b" : "tenant-a",
    aud: "agent-farm-api",
    iss: "https://issuer.example",
    resource: RESOURCE,
    scope: "agent-session:read agent-session:create",
    exp: Math.floor(NOW / 1_000) + 3_600,
    jti: token,
    ...overrides,
  };
}

function cookieValue(setCookie: string, name = "__Host-agent-farm-login"): string {
  const prefix = `${name}=`;
  const value = setCookie.split(";", 1)[0];
  expect(value.startsWith(prefix)).toBe(true);
  return decodeURIComponent(value.slice(prefix.length));
}

function cookieHeader(setCookie: string, name: string): string {
  return `${name}=${encodeURIComponent(cookieValue(setCookie, name))}`;
}

function claimsService(
  overrides: (token: string, context: TokenVerificationContext) => RawTokenClaims = (token) => tokenClaims(token),
): AuthService & { calls: Array<{ token: string; context: TokenVerificationContext }> } {
  const calls: Array<{ token: string; context: TokenVerificationContext }> = [];
  return {
    calls,
    async authenticateToken(token, context) {
      calls.push({ token, context });
      return overrides(token, context);
    },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function options(overrides: Partial<BrowserAuthOptions> = {}): BrowserAuthOptions {
  return {
    authorizationEndpoint: AUTHORIZATION_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: CLIENT_ID,
    redirectUri: "https://standalone.example/auth/callback",
    resource: RESOURCE,
    audience: "agent-farm-api",
    issuer: "https://issuer.example",
    scopes: ["agent-session:read", "agent-session:create"],
    authService: claimsService(),
    clock: () => NOW,
    randomBytes: (length) => new Uint8Array(length).fill(7),
    ...overrides,
  };
}

describe("standalone browser OAuth BFF", () => {
  it("builds an exact HTTPS authorization request and exchanges PKCE without exposing tokens", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("one-time-code");
      expect(body.get("client_id")).toBe(CLIENT_ID);
      expect(body.get("redirect_uri")).toBe("https://standalone.example/auth/callback");
      expect(body.get("resource")).toBe(RESOURCE);
      expect(body.get("code_verifier")).toBeTruthy();
      return response({ access_token: "access-a", refresh_token: "refresh-a" });
    });
    const auth = new BrowserAuthBff(options({
      fetchImpl,
      randomBytes: (() => {
        let counter = 0;
        return (length: number) => new Uint8Array(length).fill(++counter);
      })(),
    }));
    const start = auth.beginLogin("/dashboard?view=tree");
    const url = new URL(start.authorizationUrl);
    expect(url.origin + url.pathname).toBe(AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://standalone.example/auth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("agent-session:read agent-session:create");
    expect(url.searchParams.get("resource")).toBe(RESOURCE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(start.setCookie).toMatch(/HttpOnly/iu);
    expect(start.setCookie).toMatch(/Secure/iu);
    expect(start.setCookie).toMatch(/SameSite=Lax/iu);
    expect(start.setCookie).toMatch(/Path=\//u);

    const result = await auth.completeCallback({
      query: { state: url.searchParams.get("state"), code: "one-time-code" },
      cookieHeader: cookieHeader(start.setCookie, auth.loginCookieName),
    });
    expect(result.redirectTo).toBe("/dashboard?view=tree");
    expect(result.principal.subject).toBe("owner-a");
    expect(result.setCookie).toMatch(new RegExp(`${auth.cookieName}=`, "u"));
    expect(result.setCookie).toMatch(/HttpOnly/iu);
    expect(JSON.stringify(result)).not.toContain("access-a");
    expect(JSON.stringify(result)).not.toContain("refresh-a");
    expect(start.authorizationUrl).not.toContain("access-a");
    expect(start.authorizationUrl).not.toContain("refresh-a");

    const session = await auth.authenticateCookie(cookieHeader(result.setCookie, auth.cookieName));
    expect(session?.principal.subject).toBe("owner-a");
    const service = (auth as unknown as { options: { authService: ReturnType<typeof claimsService> } }).options.authService;
    expect(service.calls[0]?.context).toEqual({
      audience: "agent-farm-api",
      issuer: "https://issuer.example",
      resource: RESOURCE,
    });
  });

  it("uses S256 and consumes state once, while binding the callback to its login cookie", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ access_token: "access-a" }));
    const auth = new BrowserAuthBff(options({
      fetchImpl,
      randomBytes: (() => {
        let counter = 0;
        return (length: number) => new Uint8Array(length).fill(++counter);
      })(),
    }));
    const first = auth.beginLogin();
    const firstUrl = new URL(first.authorizationUrl);
    const verifierBody = new URLSearchParams();
    const callbackCookie = cookieHeader(first.setCookie, auth.loginCookieName);
    await auth.completeCallback({
      query: { state: firstUrl.searchParams.get("state"), code: "code-a" },
      cookieHeader: callbackCookie,
    });
    await expect(auth.completeCallback({
      query: { state: firstUrl.searchParams.get("state"), code: "code-a" },
      cookieHeader: callbackCookie,
    })).rejects.toMatchObject({ code: "invalid_state" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const second = auth.beginLogin();
    const secondUrl = new URL(second.authorizationUrl);
    await expect(auth.completeCallback({
      query: { state: secondUrl.searchParams.get("state"), code: "code-b" },
      cookieHeader: callbackCookie,
    })).rejects.toMatchObject({ code: "invalid_state" });

    // The challenge is derived from the verifier sent to the token endpoint.
    const request = fetchImpl.mock.calls[0]?.[1];
    const body = new URLSearchParams(String(request?.body));
    verifierBody.set("code_verifier", body.get("code_verifier") ?? "");
    const expected = Buffer.from(createHash("sha256").update(verifierBody.get("code_verifier") ?? "", "ascii").digest())
      .toString("base64url");
    expect(firstUrl.searchParams.get("code_challenge")).toBe(expected);
  });

  it("fails closed for wrong resource, principal claims, and expired access tokens", async () => {
    const cases: Array<Partial<RawTokenClaims>> = [
      { resource: "https://other.example" },
      { sub: "", ownerId: "owner-a" },
      { exp: Math.floor(NOW / 1_000) - 1 },
    ];
    for (const claimOverride of cases) {
      const authService = claimsService(() => tokenClaims("access-a", claimOverride));
      const auth = new BrowserAuthBff(options({
        authService,
        fetchImpl: async () => response({ access_token: "access-a" }),
      }));
      const start = auth.beginLogin();
      const url = new URL(start.authorizationUrl);
      await expect(auth.completeCallback({
        query: { state: url.searchParams.get("state"), code: "code-a" },
        cookieHeader: cookieHeader(start.setCookie, auth.loginCookieName),
      })).rejects.toMatchObject({ code: "invalid_token" });
      expect(auth.sizes().sessions).toBe(0);
    }
  });

  it("keeps CSRF session-bound and rejects cross-session cookies", async () => {
    const auth = new BrowserAuthBff(options({
      randomBytes: (() => {
        let counter = 0;
        return (length: number) => new Uint8Array(length).fill(++counter);
      })(),
      fetchImpl: async () => response({ access_token: "access-a" }),
    }));
    const first = auth.beginLogin();
    const firstUrl = new URL(first.authorizationUrl);
    const firstResult = await auth.completeCallback({
      query: { state: firstUrl.searchParams.get("state"), code: "code-a" },
      cookieHeader: cookieHeader(first.setCookie, auth.loginCookieName),
    });
    const second = auth.beginLogin();
    const secondUrl = new URL(second.authorizationUrl);
    const secondResult = await auth.completeCallback({
      query: { state: secondUrl.searchParams.get("state"), code: "code-b" },
      cookieHeader: cookieHeader(second.setCookie, auth.loginCookieName),
    });
    const firstCookie = cookieHeader(firstResult.setCookie, auth.cookieName);
    const secondCookie = cookieHeader(secondResult.setCookie, auth.cookieName);
    await expect(auth.requireCsrf(firstCookie, secondResult.csrfToken)).rejects.toMatchObject({ code: "csrf_failed" });
    await expect(auth.requireCsrf(secondCookie, firstResult.csrfToken)).rejects.toMatchObject({ code: "csrf_failed" });
    await expect(auth.requireCsrf(firstCookie, firstResult.csrfToken)).resolves.toMatchObject({ principal: firstResult.principal });
    expect(firstCookie).not.toBe(secondCookie);
  });

  it("rotates refresh and principal validation atomically, then revokes on logout", async () => {
    let now = NOW;
    const calls: Array<{ body: URLSearchParams; url: string }> = [];
    const authService = claimsService((token) => token === "access-b"
      ? tokenClaims(token)
      : token === "access-a"
        ? tokenClaims(token, { exp: Math.floor((NOW + 4_000) / 1_000) })
        : tokenClaims(token, { exp: Math.floor((NOW + 10_000) / 1_000) }));
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const body = new URLSearchParams(String(init?.body));
      calls.push({ body, url: String(url) });
      if (body.get("grant_type") === "authorization_code") return response({ access_token: "access-a", refresh_token: "refresh-a" });
      if (body.get("grant_type") === "refresh_token") return response({ access_token: "access-a2", refresh_token: "refresh-b" });
      return response({});
    });
    const auth = new BrowserAuthBff(options({
      clock: () => now,
      authService,
      fetchImpl,
      revocationEndpoint: "https://issuer.example/revoke",
      sessionTtlMs: 30_000,
      refreshSkewMs: 1_000,
    }));
    const start = auth.beginLogin();
    const url = new URL(start.authorizationUrl);
    const result = await auth.completeCallback({
      query: { state: url.searchParams.get("state"), code: "code-a" },
      cookieHeader: cookieHeader(start.setCookie, auth.loginCookieName),
    });
    now = NOW + 5_000;
    const session = await auth.authenticateCookie(cookieHeader(result.setCookie, auth.cookieName));
    expect(session?.principal.subject).toBe("owner-a");
    expect(calls[1]?.body.get("refresh_token")).toBe("refresh-a");
    expect(calls[1]?.body.get("resource")).toBe(RESOURCE);

    await auth.logout(cookieHeader(result.setCookie, auth.cookieName), result.csrfToken);
    expect(auth.sizes().sessions).toBe(0);
    expect(calls.some((call) => call.url === "https://issuer.example/revoke" && call.body.get("token") === "access-a")).toBe(true);
    expect(calls.some((call) => call.url === "https://issuer.example/revoke" && call.body.get("token") === "refresh-b")).toBe(true);
    expect(result.clearLoginCookie).toContain("Max-Age=0");
  });

  it("bounds pending state/session memory and cleans expired entries", async () => {
    let now = NOW;
    const auth = new BrowserAuthBff(options({
      clock: () => now,
      maxPendingLogins: 1,
      pendingTtlMs: 100,
      maxSessions: 1,
      sessionTtlMs: 100,
      fetchImpl: async () => response({ access_token: "access-a" }),
    }));
    auth.beginLogin();
    auth.beginLogin();
    expect(auth.sizes().pending).toBe(1);
    now += 101;
    expect(auth.cleanup()).toEqual({ pending: 0, sessions: 0 });
  });

  it("rejects insecure or ambiguous endpoint configuration", () => {
    expect(() => new BrowserAuthBff(options({ tokenEndpoint: "http://issuer.example/token" }))).toThrow(/HTTPS/iu);
    expect(() => new BrowserAuthBff(options({ redirectUri: "https://standalone.example/callback#fragment" }))).toThrow(/HTTPS/iu);
    expect(() => new BrowserAuthBff(options({ resource: "https://agent-farm.example/" }))).not.toThrow();
    expect(() => new BrowserAuthBff(options({ authorizationEndpoint: "https://user:pass@issuer.example/authorize" }))).toThrow(/HTTPS/iu);
    expect(new BrowserAuthError("csrf_failed").statusCode).toBe(403);
  });
});
