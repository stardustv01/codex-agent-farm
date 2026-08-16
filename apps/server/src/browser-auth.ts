import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import {
  claimsToPrincipal,
} from "./auth.js";
import type {
  AuthService,
  Principal,
  RawTokenClaims,
  TokenVerificationContext,
} from "./contracts.js";
import type { BrowserSessionAuthority } from "./browser-session.js";

/**
 * A browser-facing OAuth authorization-code + PKCE boundary.
 *
 * This module intentionally has no dependency on the application composition
 * root.  The root can register the route helper below and use
 * `authenticateCookie`/`requireCsrf` around its own REST handlers.  OAuth
 * access and refresh tokens stay in this process; only the opaque session
 * identifier is written to the browser.
 */

const DEFAULT_COOKIE_NAME = "__Host-agent-farm";
const DEFAULT_LOGIN_COOKIE_NAME = "__Host-agent-farm-login";
const DEFAULT_PENDING_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_TTL_MS = 60 * 60_000;
const DEFAULT_MAX_PENDING = 1_000;
const DEFAULT_MAX_SESSIONS = 1_000;
const DEFAULT_REFRESH_SKEW_MS = 30_000;
const MAX_PENDING_TTL_MS = 15 * 60_000;
const MAX_SESSION_TTL_MS = 24 * 60 * 60_000;
const MAX_TOKEN_LENGTH = 32 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_SCOPE_LENGTH = 2_048;

export const BROWSER_AUTH_COOKIE_NAME = DEFAULT_COOKIE_NAME;
export const BROWSER_LOGIN_COOKIE_NAME = DEFAULT_LOGIN_COOKIE_NAME;

export type BrowserAuthErrorCode =
  | "invalid_request"
  | "invalid_state"
  | "login_expired"
  | "oauth_denied"
  | "token_exchange_failed"
  | "invalid_token"
  | "not_authenticated"
  | "session_expired"
  | "csrf_failed"
  | "configuration_error";

/** Errors are deliberately generic so OAuth/token response details cannot leak. */
export class BrowserAuthError extends Error {
  readonly code: BrowserAuthErrorCode;
  readonly statusCode: number;

  constructor(
    code: BrowserAuthErrorCode,
    message = "Authentication failed",
    statusCode = code === "csrf_failed" ? 403 : code === "configuration_error" ? 500 : 401,
  ) {
    super(message);
    this.name = "BrowserAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface BrowserAuthClock {
  (): number;
}

export interface BrowserAuthOptions {
  /** Exact, pre-configured HTTPS authorization endpoint. */
  readonly authorizationEndpoint: string;
  /** Exact, pre-configured HTTPS token endpoint. */
  readonly tokenEndpoint: string;
  /** Exact registered OAuth client ID. */
  readonly clientId: string;
  /** Exact registered HTTPS callback URI. */
  readonly redirectUri: string;
  /** Exact RFC 8707 protected-resource URI. */
  readonly resource: string;
  /** Expected access-token audience, when the issuer uses one. */
  readonly audience?: string;
  /** Expected access-token issuer. */
  readonly issuer?: string;
  /** Requested scopes; required scopes default to this set. */
  readonly scopes?: readonly string[];
  /** Scopes that every browser session must carry. */
  readonly requiredScopes?: readonly string[];
  /** Access-token validation is delegated to the existing JWT service. */
  readonly authService: AuthService;
  /** Optional separate JWT service for an OIDC ID token/nonce. */
  readonly idTokenAuthService?: AuthService;
  /** Optional RFC 7009 endpoint. It is never inferred from another URL. */
  readonly revocationEndpoint?: string;
  /** A refresh grant is used only when this is not explicitly false. */
  readonly refreshRotation?: boolean;
  readonly refreshSkewMs?: number;
  readonly pendingTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly maxPendingLogins?: number;
  readonly maxSessions?: number;
  readonly cookieName?: string;
  readonly loginCookieName?: string;
  /** Injectable for deterministic tests and isolated deployments. */
  readonly fetchImpl?: typeof fetch;
  readonly clock?: BrowserAuthClock;
  readonly randomBytes?: (length: number) => Uint8Array;
}

/** Compatibility alias for callers that use an OAuth-specific name. */
export type BrowserOAuthOptions = BrowserAuthOptions;

export interface BrowserLoginStart {
  readonly authorizationUrl: string;
  readonly setCookie: string;
  readonly cookieName: string;
  readonly returnTo: string;
}

export interface BrowserCallbackInput {
  /** Query fields from the exact registered callback URI. */
  readonly query: Readonly<Record<string, unknown>>;
  /** Incoming Cookie header (or the value of the login binding cookie). */
  readonly cookieHeader?: string;
  readonly loginCookie?: string;
}

export interface BrowserSessionView {
  readonly authenticated: true;
  readonly principal: Principal;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface BrowserAuthenticatedSession extends BrowserSessionView {
  /** Internal-only key used by a composition root; never route this field. */
  readonly sessionId: string;
}

export interface BrowserCallbackResult extends BrowserAuthenticatedSession {
  readonly redirectTo: string;
  readonly setCookie: string;
  readonly clearLoginCookie: string;
}

export interface BrowserLogoutResult {
  readonly cleared: boolean;
  readonly clearCookie: string;
  readonly clearLoginCookie: string;
}

export interface BrowserAuthRoutePaths {
  readonly login?: string;
  readonly callback?: string;
  readonly session?: string;
  readonly csrf?: string;
  readonly logout?: string;
}

interface PendingLogin {
  readonly state: string;
  readonly stateHash: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly bindingHash: string;
  readonly returnTo: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface BrowserSessionRecord {
  readonly sessionId: string;
  readonly sessionHash: string;
  principal: Principal;
  csrfToken: string;
  readonly accessToken: string;
  refreshToken?: string;
  accessExpiresAt: number;
  createdAt: number;
  expiresAt: number;
  refreshInFlight?: Promise<void> | undefined;
}

interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type?: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly scope?: string;
}

interface NormalizedOptions {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly audience?: string;
  readonly issuer?: string;
  readonly scopes: readonly string[];
  readonly requiredScopes: readonly string[];
  readonly authService: AuthService;
  readonly idTokenAuthService: AuthService;
  readonly revocationEndpoint?: string;
  readonly refreshRotation: boolean;
  readonly refreshSkewMs: number;
  readonly pendingTtlMs: number;
  readonly sessionTtlMs: number;
  readonly maxPendingLogins: number;
  readonly maxSessions: number;
  readonly cookieName: string;
  readonly loginCookieName: string;
  readonly fetchImpl: typeof fetch;
  readonly clock: BrowserAuthClock;
  readonly randomBytes: (length: number) => Uint8Array;
}

/**
 * Server-side browser auth state.  One instance should be shared by all
 * standalone routes in a process (or backed by an equivalent durable store
 * in a multi-process deployment).
 */
export class BrowserAuthBff implements BrowserSessionAuthority<BrowserAuthenticatedSession> {
  readonly cookieName: string;
  readonly loginCookieName: string;

  private readonly options: NormalizedOptions;
  private readonly pending = new Map<string, PendingLogin>();
  private readonly sessions = new Map<string, BrowserSessionRecord>();

  constructor(options: BrowserAuthOptions) {
    this.options = normalizeOptions(options);
    this.cookieName = this.options.cookieName;
    this.loginCookieName = this.options.loginCookieName;
  }

  /** Begin an OAuth redirect without returning state, nonce, or verifier. */
  beginLogin(returnTo = "/"): BrowserLoginStart {
    this.cleanup();
    const safeReturnTo = normalizeReturnTo(returnTo);
    const state = this.randomToken(32);
    const nonce = this.randomToken(32);
    const verifier = this.randomToken(48);
    const binding = this.randomToken(32);
    const now = this.options.clock();
    const pending: PendingLogin = {
      state,
      stateHash: digest(state),
      nonce,
      verifier,
      bindingHash: digest(binding),
      returnTo: safeReturnTo,
      createdAt: now,
      expiresAt: now + this.options.pendingTtlMs,
    };
    this.pending.set(pending.stateHash, pending);
    this.evictPending();

    const authorization = new URL(this.options.authorizationEndpoint);
    authorization.searchParams.set("client_id", this.options.clientId);
    authorization.searchParams.set("redirect_uri", this.options.redirectUri);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", this.options.scopes.join(" "));
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("nonce", nonce);
    authorization.searchParams.set("code_challenge", pkceChallenge(verifier));
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("resource", this.options.resource);

    return {
      authorizationUrl: authorization.toString(),
      setCookie: serializeCookie(this.loginCookieName, binding, this.options.pendingTtlMs),
      cookieName: this.loginCookieName,
      returnTo: safeReturnTo,
    };
  }

  /** Compatibility alias used by route adapters. */
  startLogin(returnTo = "/"): BrowserLoginStart {
    return this.beginLogin(returnTo);
  }

  /**
   * Consume a callback state exactly once, exchange the code, validate the
   * returned access token through JwtAuthService, and issue an opaque session.
   */
  async completeCallback(input: BrowserCallbackInput): Promise<BrowserCallbackResult> {
    this.cleanup();
    const state = oneQueryValue(input.query.state);
    const code = oneQueryValue(input.query.code);
    if (oneQueryValue(input.query.error) !== undefined || !state || !code) {
      throw new BrowserAuthError("oauth_denied", "OAuth authorization failed", 400);
    }
    const pendingKey = digest(state);
    const pending = this.pending.get(pendingKey);
    if (!pending) {
      throw new BrowserAuthError("invalid_state", "The login state is invalid", 400);
    }
    const binding = input.loginCookie ?? parseCookie(input.cookieHeader, this.loginCookieName);
    if (!binding || !constantTimeEqual(digest(binding), pending.bindingHash)) {
      throw new BrowserAuthError("invalid_state", "The login state is invalid", 400);
    }
    // Delete before the network exchange. Concurrent or repeated callbacks
    // can never redeem the same authorization code through this process.
    this.pending.delete(pendingKey);

    let tokenResponse: OAuthTokenResponse;
    try {
      tokenResponse = await this.exchangeCode(code, pending.verifier);
    } catch {
      throw new BrowserAuthError("token_exchange_failed", "Authentication failed", 401);
    }
    const access = await this.validateAccessToken(tokenResponse.access_token);
    if (tokenResponse.id_token !== undefined) {
      await this.validateNonce(tokenResponse.id_token, pending.nonce, access.principal);
    }

    const now = this.options.clock();
    const expiresFromToken = access.expiresAt;
    const sessionExpiry = Math.min(now + this.options.sessionTtlMs, expiresFromToken);
    const session = this.issueSession({
      principal: access.principal,
      accessToken: tokenResponse.access_token,
      ...(tokenResponse.refresh_token === undefined ? {} : { refreshToken: tokenResponse.refresh_token }),
      accessExpiresAt: expiresFromToken,
      createdAt: now,
      expiresAt: this.options.refreshRotation && tokenResponse.refresh_token !== undefined
        ? now + this.options.sessionTtlMs
        : sessionExpiry,
    });
    return {
      ...this.view(session),
      sessionId: session.sessionId,
      redirectTo: pending.returnTo,
      setCookie: serializeCookie(this.cookieName, session.sessionId, Math.max(0, session.expiresAt - now)),
      clearLoginCookie: clearCookie(this.loginCookieName),
    };
  }

  /** Compatibility alias used by route adapters. */
  async handleCallback(input: BrowserCallbackInput): Promise<BrowserCallbackResult> {
    return this.completeCallback(input);
  }

  /** Read and, when configured, refresh the session behind an incoming cookie. */
  async authenticateCookie(cookieHeader?: string): Promise<BrowserAuthenticatedSession | null> {
    this.cleanup();
    const sessionId = parseCookie(cookieHeader, this.cookieName);
    if (!sessionId) return null;
    const sessionHash = digest(sessionId);
    const session = this.sessions.get(sessionHash);
    if (!session) return null;
    const now = this.options.clock();
    if (session.expiresAt <= now) {
      this.sessions.delete(sessionHash);
      return null;
    }
    try {
      if (session.accessExpiresAt <= now + this.options.refreshSkewMs) {
        await this.refreshSession(session);
      }
    } catch {
      this.sessions.delete(sessionHash);
      throw new BrowserAuthError("session_expired", "Authentication failed", 401);
    }
    if (session.expiresAt <= this.options.clock()) {
      this.sessions.delete(sessionHash);
      return null;
    }
    this.touchSession(sessionHash);
    return {
      ...this.view(session),
      sessionId,
    };
  }

  /** Compatibility alias; route code can use whichever name reads best. */
  async getSession(cookieHeader?: string): Promise<BrowserAuthenticatedSession | null> {
    return this.authenticateCookie(cookieHeader);
  }

  /** Return only the CSRF token, never an OAuth token or session identifier. */
  async csrfToken(cookieHeader?: string): Promise<string | null> {
    const session = await this.authenticateCookie(cookieHeader);
    return session?.csrfToken ?? null;
  }

  /** Enforce a session-bound header before a mutating REST operation. */
  async requireCsrf(cookieHeader: string | undefined, suppliedToken: unknown): Promise<BrowserAuthenticatedSession> {
    const session = await this.authenticateCookie(cookieHeader);
    if (!session) throw new BrowserAuthError("not_authenticated", "Authentication is required", 401);
    if (typeof suppliedToken !== "string" || !constantTimeEqual(suppliedToken, session.csrfToken)) {
      throw new BrowserAuthError("csrf_failed", "CSRF validation failed", 403);
    }
    return session;
  }

  /**
   * Revoke access/refresh tokens when an endpoint is configured, then always
   * delete local state and clear both browser cookies.
   */
  async logout(cookieHeader?: string, suppliedCsrfToken?: unknown): Promise<BrowserLogoutResult> {
    const sessionId = parseCookie(cookieHeader, this.cookieName);
    const session = sessionId ? this.sessions.get(digest(sessionId)) : undefined;
    if (session && (suppliedCsrfToken === undefined || !constantTimeEqual(String(suppliedCsrfToken), session.csrfToken))) {
      throw new BrowserAuthError("csrf_failed", "CSRF validation failed", 403);
    }
    if (session) {
      this.sessions.delete(session.sessionHash);
      await this.revoke(session.accessToken, "access_token");
      if (session.refreshToken) await this.revoke(session.refreshToken, "refresh_token");
    }
    return {
      cleared: session !== undefined,
      clearCookie: clearCookie(this.cookieName),
      clearLoginCookie: clearCookie(this.loginCookieName),
    };
  }

  /** Compatibility alias. */
  async signOut(cookieHeader?: string, suppliedCsrfToken?: unknown): Promise<BrowserLogoutResult> {
    return this.logout(cookieHeader, suppliedCsrfToken);
  }

  /** Remove expired state and sessions and enforce bounds. Safe to call often. */
  cleanup(now = this.options.clock()): { pending: number; sessions: number } {
    for (const [key, value] of this.pending) {
      if (value.expiresAt <= now) this.pending.delete(key);
    }
    for (const [key, value] of this.sessions) {
      if (value.expiresAt <= now) this.sessions.delete(key);
    }
    this.evictPending();
    this.evictSessions();
    return { pending: this.pending.size, sessions: this.sessions.size };
  }

  /** Introspection for bounded-state diagnostics; contains no secrets. */
  sizes(): { pending: number; sessions: number } {
    return { pending: this.pending.size, sessions: this.sessions.size };
  }

  private async exchangeCode(code: string, verifier: string): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      code_verifier: verifier,
      resource: this.options.resource,
    });
    return this.postToken(body);
  }

  private async refreshSession(session: BrowserSessionRecord): Promise<void> {
    if (!this.options.refreshRotation || !session.refreshToken) {
      throw new BrowserAuthError("session_expired", "Authentication failed", 401);
    }
    if (session.refreshInFlight) {
      await session.refreshInFlight;
      return;
    }
    const refreshToken = session.refreshToken;
    const task = (async (): Promise<void> => {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.options.clientId,
        resource: this.options.resource,
      });
      const response = await this.postToken(body);
      const access = await this.validateAccessToken(response.access_token);
      if (!samePrincipal(access.principal, session.principal)) {
        throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
      }
      const now = this.options.clock();
      session.principal = access.principal;
      session.accessExpiresAt = access.expiresAt;
      session.expiresAt = Math.min(session.createdAt + this.options.sessionTtlMs, now + this.options.sessionTtlMs);
      if (response.refresh_token !== undefined) session.refreshToken = response.refresh_token;
    })();
    session.refreshInFlight = task;
    try {
      await task;
    } finally {
      if (session.refreshInFlight === task) session.refreshInFlight = undefined;
    }
  }

  private async validateAccessToken(token: string): Promise<{ principal: Principal; expiresAt: number }> {
    if (!isBoundedToken(token)) throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
    const context: TokenVerificationContext = {
      ...(this.options.audience === undefined ? {} : { audience: this.options.audience }),
      ...(this.options.issuer === undefined ? {} : { issuer: this.options.issuer }),
      resource: this.options.resource,
    };
    let claims: RawTokenClaims;
    try {
      claims = await this.options.authService.authenticateToken(token, context);
    } catch {
      throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
    }
    const now = this.options.clock();
    validateClaims(claims, this.options, now);
    const principal = browserPrincipal(claims);
    return { principal, expiresAt: Number(claims.exp) * 1_000 };
  }

  private async validateNonce(token: string, nonce: string, accessPrincipal: Principal): Promise<void> {
    if (!isBoundedToken(token)) throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
    const service = this.options.idTokenAuthService;
    let claims: RawTokenClaims;
    try {
      claims = await service.authenticateToken(token, {
        audience: this.options.clientId,
        ...(this.options.issuer === undefined ? {} : { issuer: this.options.issuer }),
      });
    } catch {
      throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
    }
    if (claims.nonce !== nonce || typeof claims.nonce !== "string") {
      throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
    }
    if (typeof claims.sub !== "string" || claims.sub !== accessPrincipal.subject) {
      throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
    }
    const audience = claimStrings(claims.aud);
    if (audience.length > 0 && !audience.includes(this.options.clientId)) {
      throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
    }
  }

  private async postToken(body: URLSearchParams): Promise<OAuthTokenResponse> {
    let response: Response;
    try {
      response = await this.options.fetchImpl(this.options.tokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
    } catch {
      throw new BrowserAuthError("token_exchange_failed", "Authentication failed", 401);
    }
    if (!response.ok) throw new BrowserAuthError("token_exchange_failed", "Authentication failed", 401);
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new BrowserAuthError("token_exchange_failed", "Authentication failed", 401);
    }
    if (text.length > MAX_RESPONSE_BYTES) throw new BrowserAuthError("token_exchange_failed", "Authentication failed", 401);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BrowserAuthError("token_exchange_failed", "Authentication failed", 401);
    }
    if (!isRecord(parsed) || !isBoundedToken(parsed.access_token)) {
      throw new BrowserAuthError("token_exchange_failed", "Authentication failed", 401);
    }
    if (parsed.refresh_token !== undefined && !isBoundedToken(parsed.refresh_token)) {
      throw new BrowserAuthError("token_exchange_failed", "Authentication failed", 401);
    }
    if (parsed.id_token !== undefined && !isBoundedToken(parsed.id_token)) {
      throw new BrowserAuthError("token_exchange_failed", "Authentication failed", 401);
    }
    if (parsed.expires_in !== undefined &&
      (typeof parsed.expires_in !== "number" || !Number.isFinite(parsed.expires_in) || parsed.expires_in <= 0 || parsed.expires_in > 86_400)) {
      throw new BrowserAuthError("token_exchange_failed", "Authentication failed", 401);
    }
    return parsed as unknown as OAuthTokenResponse;
  }

  private async revoke(token: string, hint: "access_token" | "refresh_token"): Promise<void> {
    const endpoint = this.options.revocationEndpoint;
    if (!endpoint) return;
    const body = new URLSearchParams({
      token,
      token_type_hint: hint,
      client_id: this.options.clientId,
    });
    try {
      await this.options.fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
      });
    } catch {
      // Local logout is authoritative even if the issuer is unavailable.
    }
  }

  private issueSession(input: {
    readonly principal: Principal;
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly accessExpiresAt: number;
    readonly createdAt: number;
    readonly expiresAt: number;
  }): BrowserSessionRecord {
    const sessionId = this.randomToken(32);
    const session: BrowserSessionRecord = {
      sessionId,
      sessionHash: digest(sessionId),
      principal: input.principal,
      csrfToken: this.randomToken(32),
      accessToken: input.accessToken,
      ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
      accessExpiresAt: input.accessExpiresAt,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    };
    this.sessions.set(session.sessionHash, session);
    this.evictSessions();
    return session;
  }

  private view(session: BrowserSessionRecord): BrowserSessionView {
    return {
      authenticated: true,
      principal: session.principal,
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  private randomToken(length: number): string {
    const bytes = this.options.randomBytes(length);
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
      throw new BrowserAuthError("configuration_error", "Authentication is unavailable", 500);
    }
    return base64Url(bytes);
  }

  private touchSession(key: string): void {
    const value = this.sessions.get(key);
    if (!value) return;
    this.sessions.delete(key);
    this.sessions.set(key, value);
  }

  private evictPending(): void {
    while (this.pending.size > this.options.maxPendingLogins) {
      const key = this.pending.keys().next().value as string | undefined;
      if (key === undefined) return;
      this.pending.delete(key);
    }
  }

  private evictSessions(): void {
    while (this.sessions.size > this.options.maxSessions) {
      const key = this.sessions.keys().next().value as string | undefined;
      if (key === undefined) return;
      this.sessions.delete(key);
    }
  }
}

/** Compatibility factory for functional integrations. */
export function createBrowserAuth(options: BrowserAuthOptions): BrowserAuthBff {
  return new BrowserAuthBff(options);
}

export const createBrowserAuthBff = createBrowserAuth;

/**
 * Register minimal same-origin routes. Application REST handlers should call
 * `bff.requireCsrf` themselves for POST/PUT/PATCH/DELETE creation operations.
 */
export function registerBrowserAuthRoutes(
  app: FastifyInstance,
  bff: BrowserAuthBff,
  paths: BrowserAuthRoutePaths = {},
): void {
  const loginPath = paths.login ?? "/auth/login";
  const callbackPath = paths.callback ?? "/auth/callback";
  const sessionPath = paths.session ?? "/auth/session";
  const csrfPath = paths.csrf ?? "/auth/csrf";
  const logoutPath = paths.logout ?? "/auth/logout";

  app.get(loginPath, async (request, reply) => {
    const query = queryRecord(request);
    const returnTo = typeof query.returnTo === "string" ? query.returnTo : "/";
    const login = bff.beginLogin(returnTo);
    sendSetCookie(reply, login.setCookie);
    reply.code(302).header("location", login.authorizationUrl).send();
  });

  app.get(callbackPath, async (request, reply) => {
    try {
      const result = await bff.completeCallback({
        query: queryRecord(request),
        ...(request.headers.cookie === undefined ? {} : { cookieHeader: request.headers.cookie }),
      });
      sendSetCookie(reply, [result.setCookie, result.clearLoginCookie]);
      reply.code(303).header("location", result.redirectTo).send();
    } catch (error: unknown) {
      const status = error instanceof BrowserAuthError ? error.statusCode : 400;
      reply.code(status).send({ error: { code: "AUTHENTICATION_FAILED", message: "Authentication failed" } });
    }
  });

  app.get(sessionPath, async (request, reply) => {
    try {
      const session = await bff.authenticateCookie(request.headers.cookie);
      if (!session) {
        reply.code(401).send({ authenticated: false });
        return;
      }
      const { sessionId: _sessionId, ...publicSession } = session;
      reply.code(200).send(publicSession);
    } catch {
      reply.code(401).send({ authenticated: false });
    }
  });

  app.get(csrfPath, async (request, reply) => {
    try {
      const session = await bff.authenticateCookie(request.headers.cookie);
      if (!session) {
        reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication is required" } });
        return;
      }
      reply.code(200).send({ csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    } catch {
      reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication is required" } });
    }
  });

  app.post(logoutPath, async (request, reply) => {
    try {
      const result = await bff.logout(request.headers.cookie, request.headers["x-csrf-token"]);
      sendSetCookie(reply, [result.clearCookie, result.clearLoginCookie]);
      reply.code(204).send();
    } catch (error: unknown) {
      const status = error instanceof BrowserAuthError ? error.statusCode : 403;
      reply.code(status).send({ error: { code: "CSRF_FAILED", message: "CSRF validation failed" } });
    }
  });
}

function normalizeOptions(options: BrowserAuthOptions): NormalizedOptions {
  if (!options.authService) throw configError("authService is required");
  const authorizationEndpoint = exactHttps(options.authorizationEndpoint, "authorizationEndpoint");
  const tokenEndpoint = exactHttps(options.tokenEndpoint, "tokenEndpoint");
  const redirectUri = exactHttps(options.redirectUri, "redirectUri");
  const resource = exactHttps(options.resource, "resource");
  const revocationEndpoint = options.revocationEndpoint === undefined
    ? undefined
    : exactHttps(options.revocationEndpoint, "revocationEndpoint");
  if (!nonEmptyBounded(options.clientId, 256)) throw configError("clientId is invalid");
  if (options.audience !== undefined && !nonEmptyBounded(options.audience, 256)) throw configError("audience is invalid");
  if (options.issuer !== undefined) exactHttps(options.issuer, "issuer");
  const scopes = normalizeScopes(options.scopes ?? []);
  const requiredScopes = normalizeScopes(options.requiredScopes ?? scopes);
  if (requiredScopes.some((scope) => !scopes.includes(scope))) {
    throw configError("requiredScopes must be requested");
  }
  const pendingTtlMs = boundedPositive(options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS, MAX_PENDING_TTL_MS, "pendingTtlMs");
  const sessionTtlMs = boundedPositive(options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, MAX_SESSION_TTL_MS, "sessionTtlMs");
  const refreshSkewMs = boundedPositive(options.refreshSkewMs ?? Math.min(DEFAULT_REFRESH_SKEW_MS, sessionTtlMs), sessionTtlMs, "refreshSkewMs");
  const maxPendingLogins = boundedInteger(options.maxPendingLogins ?? DEFAULT_MAX_PENDING, 1, 10_000, "maxPendingLogins");
  const maxSessions = boundedInteger(options.maxSessions ?? DEFAULT_MAX_SESSIONS, 1, 10_000, "maxSessions");
  const cookieName = normalizeCookieName(options.cookieName ?? DEFAULT_COOKIE_NAME, "cookieName");
  const loginCookieName = normalizeCookieName(options.loginCookieName ?? DEFAULT_LOGIN_COOKIE_NAME, "loginCookieName");
  return {
    authorizationEndpoint,
    tokenEndpoint,
    clientId: options.clientId,
    redirectUri,
    resource,
    ...(options.audience === undefined ? {} : { audience: options.audience }),
    ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
    scopes,
    requiredScopes,
    authService: options.authService,
    idTokenAuthService: options.idTokenAuthService ?? options.authService,
    ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
    refreshRotation: options.refreshRotation !== false,
    refreshSkewMs,
    pendingTtlMs,
    sessionTtlMs,
    maxPendingLogins,
    maxSessions,
    cookieName,
    loginCookieName,
    fetchImpl: options.fetchImpl ?? fetch,
    clock: options.clock ?? Date.now,
    randomBytes: options.randomBytes ?? ((length) => randomBytes(length)),
  };
}

function exactHttps(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) throw configError(`${name} is invalid`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError(`${name} is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw configError(`${name} must be an exact HTTPS URL`);
  return value;
}

function normalizeScopes(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 64) throw configError("scopes are invalid");
  const normalized = [...new Set(values)];
  if (normalized.some((scope) => !nonEmptyBounded(scope, 128) || /\s/u.test(scope))) throw configError("scopes are invalid");
  return normalized;
}

function normalizeCookieName(value: string, name: string): string {
  if (!nonEmptyBounded(value, 64) || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(value)) throw configError(`${name} is invalid`);
  return value;
}

function boundedPositive(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw configError(`${name} is invalid`);
  return value;
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw configError(`${name} is invalid`);
  return value;
}

function configError(message: string): BrowserAuthError {
  return new BrowserAuthError("configuration_error", message, 500);
}

function normalizeReturnTo(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  try {
    const parsed = new URL(value, "https://standalone.invalid");
    if (parsed.origin !== "https://standalone.invalid") return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

function pkceChallenge(verifier: string): string {
  return base64Url(new Uint8Array(createHash("sha256").update(verifier, "ascii").digest()));
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function serializeCookie(name: string, value: string, maxAgeMs: number): string {
  const maxAge = Math.max(0, Math.floor(maxAgeMs / 1_000));
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      const decoded = decodeURIComponent(value);
      return decoded.length > 0 && decoded.length <= 512 ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function oneQueryValue(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) return undefined;
  return value;
}

function queryRecord(request: FastifyRequest): Readonly<Record<string, unknown>> {
  const query = request.query;
  return isRecord(query) ? query : {};
}

function sendSetCookie(reply: FastifyReply, values: string | readonly string[]): void {
  reply.header("set-cookie", values);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyBounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isBoundedToken(value: unknown): value is string {
  return nonEmptyBounded(value, MAX_TOKEN_LENGTH) && !/\s/u.test(value);
}

function claimStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function claimScopes(claims: RawTokenClaims): string[] {
  const values = [claims.scope, claims.scopes];
  return values.flatMap((value) => typeof value === "string"
    ? value.split(/\s+/u).filter(Boolean)
    : claimStrings(value)).filter((scope) => scope.length <= MAX_SCOPE_LENGTH);
}

function validateClaims(claims: RawTokenClaims, options: NormalizedOptions, now: number): void {
  if (!isRecord(claims)) throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1_000 <= now) {
    throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
  }
  if (!nonEmptyBounded(claims.sub, 256)) throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
  const owner = claims.ownerId ?? claims.owner_id ?? claims.sub;
  const tenant = claims.tenantId ?? claims.tenant_id;
  if (!nonEmptyBounded(owner, 256) || !nonEmptyBounded(tenant, 256)) throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
  if (options.audience !== undefined && !claimStrings(claims.aud).includes(options.audience)) throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
  if (options.issuer !== undefined && claims.iss !== options.issuer) throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
  if (!claimStrings(claims.resource).includes(options.resource)) throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
  const scopeSet = new Set(claimScopes(claims));
  if (options.requiredScopes.some((scope) => !scopeSet.has(scope))) throw new BrowserAuthError("invalid_token", "Authentication failed", 401);
}

function samePrincipal(left: Principal, right: Principal): boolean {
  return left.subject === right.subject && left.ownerId === right.ownerId && left.tenantId === right.tenantId;
}

/**
 * The standalone browser never needs a JWT identifier.  In particular, a
 * deployment must not accidentally expose a token-shaped `jti` through the
 * `/auth/session` JSON surface.  Scopes and ownership remain available for
 * the application authorization boundary.
 */
function browserPrincipal(claims: RawTokenClaims): Principal {
  const principal = claimsToPrincipal(claims);
  const { tokenId: _tokenId, ...safe } = principal;
  return safe;
}

export default BrowserAuthBff;
