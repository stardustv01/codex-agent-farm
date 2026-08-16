import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type KeyInput,
} from "jose";

import type {
  AuthService,
  RawTokenClaims,
  TokenVerificationContext,
} from "./contracts.js";

/**
 * The only token lifecycle states that the resource server accepts.  The
 * status verifier is deliberately separate from JWT cryptographic
 * verification: a validly signed token can still be revoked, unknown, or
 * rejected as a replay by the issuer's durable token/session store.
 */
export type TokenStatus = "active" | "revoked" | "replayed" | "unknown";

export interface TokenStatusCheck {
  /** The canonical JWT `jti`; `tokenId` is provided as a descriptive alias. */
  readonly jti: string;
  readonly tokenId: string;
  readonly subject: string;
  readonly ownerId: string;
  readonly tenantId: string;
  readonly issuer?: string;
  readonly audience?: readonly string[];
  readonly resource?: readonly string[];
  readonly agentSessionId?: string;
  readonly expiresAt?: number;
  readonly notBefore?: number;
  /** The request's expected resource, when the route supplied one. */
  readonly expectedResource?: string;
}

export type TokenStatusResult =
  | TokenStatus
  | boolean
  | { readonly status?: unknown };

/**
 * A production callback for a durable token/session status store.  It is
 * called only after JWT signature and standard claim checks pass.  The input
 * intentionally excludes the bearer and raw claims so accidental logging by
 * the resource server cannot disclose credentials or unbounded claim data.
 */
export type TokenStatusVerifier = (
  input: TokenStatusCheck,
) => TokenStatusResult | Promise<TokenStatusResult>;

export interface JwtAuthOptions {
  /** A caller supplied verifier is preferred for local/dev and test wiring. */
  readonly verifyToken?: (
    token: string,
  ) => Promise<RawTokenClaims> | RawTokenClaims;
  /** A public key or secret for jose.jwtVerify. */
  readonly key?: KeyInput;
  /** A remote JWKS URL. It is never contacted until a request is verified. */
  readonly jwksUri?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly resource?: string;
  readonly requireResourceClaim?: boolean;
  readonly requireExpiration?: boolean;
  readonly requireTenant?: boolean;
  /** Require a non-empty, bounded JWT ID before accepting a token. */
  readonly requireJti?: boolean;
  /**
   * Resolve durable token/session state after signature and claims checks.
   * `active` is reusable across requests; no global one-use JWT rule is
   * imposed.  Any other state (or a verifier failure) fails closed.
   */
  readonly tokenStatusVerifier?: TokenStatusVerifier;
  /** Descriptive alias for integrations that name the operation explicitly. */
  readonly verifyTokenStatus?: TokenStatusVerifier;
  /** Compatibility alias for a revocation-oriented integration. */
  readonly revocationVerifier?: TokenStatusVerifier;
  readonly clockToleranceSeconds?: number;
}

export class AuthenticationError extends Error {
  readonly code:
    | "missing_token"
    | "malformed_token"
    | "invalid_token"
    | "expired_token"
    | "wrong_issuer"
    | "wrong_audience"
    | "wrong_resource"
    | "missing_subject"
    | "missing_tenant"
    | "missing_jti"
    | "revoked_token"
    | "replayed_token"
    | "unknown_token";

  constructor(
    code: AuthenticationError["code"],
    message = "Authentication failed",
  ) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

/**
 * Authenticates a bearer token and normalizes claims at the trust boundary.
 * The request never supplies owner, tenant, session, or source-root identity.
 */
export class JwtAuthService implements AuthService {
  private readonly options: JwtAuthOptions;
  private readonly remoteKey?: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: JwtAuthOptions = {}) {
    this.options = options;
    if (options.jwksUri) {
      this.remoteKey = createRemoteJWKSet(new URL(options.jwksUri));
    }
  }

  async authenticateToken(
    token: string,
    context: TokenVerificationContext,
  ): Promise<RawTokenClaims> {
    if (!token || token.length > 16_384) {
      throw new AuthenticationError("malformed_token");
    }

    let claims: RawTokenClaims;
    if (this.options.verifyToken) {
      try {
        claims = await this.options.verifyToken(token);
      } catch {
        throw new AuthenticationError("invalid_token");
      }
    } else {
      const key = this.options.key ?? this.remoteKey;
      if (!key) {
        // Failing closed is important: an accidentally unconfigured server
        // must not turn into an anonymous data API.
        throw new AuthenticationError("invalid_token");
      }
      try {
        const expectedIssuer = context.issuer ?? this.options.issuer;
        const expectedAudience = context.audience ?? this.options.audience;
        const result = await jwtVerify(token, key, {
          ...(expectedIssuer === undefined ? {} : { issuer: expectedIssuer }),
          ...(expectedAudience === undefined ? {} : { audience: expectedAudience }),
          clockTolerance: this.options.clockToleranceSeconds ?? 0,
        });
        claims = result.payload as RawTokenClaims;
      } catch (error: unknown) {
        const code = error instanceof Error ? error.message.toLowerCase() : "";
        if (code.includes("expired")) {
          throw new AuthenticationError("expired_token");
        }
        throw new AuthenticationError("invalid_token");
      }
    }

    assertTokenClaims(claims, this.options, context);
    const statusVerifier = resolveTokenStatusVerifier(this.options);
    if (statusVerifier) {
      await assertTokenStatus(claims, context, statusVerifier);
    }
    return claims;
  }
}

/** Validate JWT-standard and RFC 8707 claims after any injected verifier. */
export function assertTokenClaims(
  claims: RawTokenClaims,
  options: JwtAuthOptions,
  context: TokenVerificationContext,
): void {
  const now = Math.floor(Date.now() / 1000);
  const tolerance = options.clockToleranceSeconds ?? 0;
  if (options.requireExpiration !== false) {
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
      throw new AuthenticationError("invalid_token");
    }
    if (claims.exp <= now - tolerance) {
      throw new AuthenticationError("expired_token");
    }
  } else if (typeof claims.exp === "number" && claims.exp <= now - tolerance) {
    throw new AuthenticationError("expired_token");
  }

  if (typeof claims.nbf === "number" && claims.nbf > now + tolerance) {
    throw new AuthenticationError("invalid_token");
  }

  const jti = claims.jti;
  if (
    jti !== undefined &&
    (typeof jti !== "string" || jti.trim().length === 0 || jti.length > 256)
  ) {
    throw new AuthenticationError("invalid_token");
  }
  const agentSessionId = claims.agentSessionId ?? claims.agent_session_id;
  if (
    agentSessionId !== undefined &&
    (typeof agentSessionId !== "string" ||
      agentSessionId.trim().length === 0 ||
      agentSessionId.length > 256)
  ) {
    throw new AuthenticationError("invalid_token");
  }
  if (
    typeof claims.agentSessionId === "string" &&
    typeof claims.agent_session_id === "string" &&
    claims.agentSessionId !== claims.agent_session_id
  ) {
    throw new AuthenticationError("invalid_token");
  }
  // A status verifier identifies a token by jti.  Requiring it implicitly in
  // that mode prevents an untracked token from bypassing the durable lookup;
  // callers can also turn the requirement on explicitly for deployments that
  // do not yet install a status verifier.
  if ((options.requireJti === true || resolveTokenStatusVerifier(options)) && typeof jti !== "string") {
    throw new AuthenticationError("missing_jti");
  }

  const expectedIssuer = context.issuer ?? options.issuer;
  if (expectedIssuer !== undefined && claims.iss !== expectedIssuer) {
    throw new AuthenticationError("wrong_issuer");
  }

  const expectedAudience = context.audience ?? options.audience;
  if (expectedAudience !== undefined) {
    const audience = asStringArray(claims.aud);
    if (!audience.includes(expectedAudience)) {
      throw new AuthenticationError("wrong_audience");
    }
  }

  const expectedResource = context.resource ?? options.resource;
  if (expectedResource !== undefined) {
    const resource = asStringArray(claims.resource);
    // RFC 8707 resource binding is explicit. An audience match is not a
    // substitute for the requested resource indicator.
    const requireResource = options.requireResourceClaim !== false;
    if (requireResource && !resource.includes(expectedResource)) {
      throw new AuthenticationError("wrong_resource");
    }
  }

  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new AuthenticationError("missing_subject");
  }
  const owner = claims.ownerId ?? claims.owner_id ?? claims.sub;
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new AuthenticationError("missing_subject");
  }
  const tenantClaim = claims.tenantId ?? claims.tenant_id;
  if (options.requireTenant !== false && tenantClaim === undefined) {
    throw new AuthenticationError("missing_tenant");
  }
  const tenant = tenantClaim ?? "default";
  if (typeof tenant !== "string" || tenant.length === 0 || tenant.length > 256) {
    throw new AuthenticationError("missing_tenant");
  }
}

function resolveTokenStatusVerifier(
  options: JwtAuthOptions,
): TokenStatusVerifier | undefined {
  return options.tokenStatusVerifier ?? options.verifyTokenStatus ?? options.revocationVerifier;
}

/**
 * Perform the lifecycle check after all cryptographic and standard-claim
 * checks.  The verifier receives a bounded, normalized identity context only;
 * neither token material nor raw claims are retained or included in errors.
 */
async function assertTokenStatus(
  claims: RawTokenClaims,
  context: TokenVerificationContext,
  verifier: TokenStatusVerifier,
): Promise<void> {
  const jti = claims.jti;
  if (typeof jti !== "string" || jti.length === 0 || jti.length > 256) {
    throw new AuthenticationError("missing_jti");
  }
  const ownerId = claims.ownerId ?? claims.owner_id ?? claims.sub;
  const tenantId = claims.tenantId ?? claims.tenant_id;
  if (
    typeof claims.sub !== "string" ||
    typeof ownerId !== "string" ||
    typeof tenantId !== "string"
  ) {
    // `assertTokenClaims` already guards these branches.  Keep this second
    // guard local so a future claim-validation change cannot call a durable
    // verifier with an unsafe or ambiguous identity.
    throw new AuthenticationError("invalid_token");
  }

  const resource = asStringArray(claims.resource);
  const input: TokenStatusCheck = {
    jti,
    tokenId: jti,
    subject: claims.sub,
    ownerId,
    tenantId,
    ...(typeof claims.iss === "string" ? { issuer: claims.iss } : {}),
    ...(asStringArray(claims.aud).length > 0 ? { audience: asStringArray(claims.aud) } : {}),
    ...(resource.length > 0 ? { resource } : {}),
    ...(typeof claims.agentSessionId === "string"
      ? { agentSessionId: claims.agentSessionId }
      : typeof claims.agent_session_id === "string"
        ? { agentSessionId: claims.agent_session_id }
        : {}),
    ...(typeof claims.exp === "number" && Number.isFinite(claims.exp)
      ? { expiresAt: claims.exp }
      : {}),
    ...(typeof claims.nbf === "number" && Number.isFinite(claims.nbf)
      ? { notBefore: claims.nbf }
      : {}),
    ...(context.resource === undefined ? {} : { expectedResource: context.resource }),
  };

  let result: TokenStatusResult;
  try {
    result = await verifier(input);
  } catch (error: unknown) {
    // Never propagate verifier details: they may contain a token, claims, or
    // backend diagnostics.  A status-store outage is an authentication deny.
    if (error instanceof AuthenticationError && isLifecycleErrorCode(error.code)) {
      throw error;
    }
    throw new AuthenticationError("invalid_token");
  }

  const status = normalizeTokenStatus(result);
  if (status === "active") return;
  if (status === "revoked") throw new AuthenticationError("revoked_token");
  if (status === "replayed") throw new AuthenticationError("replayed_token");
  throw new AuthenticationError("unknown_token");
}

function normalizeTokenStatus(value: TokenStatusResult): TokenStatus {
  if (value === true) return "active";
  if (value === false) return "unknown";
  if (typeof value === "string") {
    return isTokenStatus(value) ? value : "unknown";
  }
  if (value && typeof value === "object" && typeof value.status === "string") {
    return isTokenStatus(value.status) ? value.status : "unknown";
  }
  return "unknown";
}

function isTokenStatus(value: string): value is TokenStatus {
  return value === "active" || value === "revoked" || value === "replayed" || value === "unknown";
}

function isLifecycleErrorCode(
  code: AuthenticationError["code"],
): code is "revoked_token" | "replayed_token" | "unknown_token" {
  return code === "revoked_token" || code === "replayed_token" || code === "unknown_token";
}

export function claimsToPrincipal(
  claims: RawTokenClaims,
): import("./contracts.js").Principal {
  const subject = String(claims.sub);
  const ownerId = String(claims.ownerId ?? claims.owner_id ?? subject);
  const tenantId = String(claims.tenantId ?? claims.tenant_id ?? "default");
  const scopes = new Set<string>([
    ...asScopeArray(claims.scope),
    ...asScopeArray(claims.scopes),
  ]);
  return {
    subject,
    ownerId,
    tenantId,
    scopes,
    audience: asStringArray(claims.aud),
    ...(typeof claims.iss === "string" ? { issuer: claims.iss } : {}),
    ...(typeof claims.jti === "string" ? { tokenId: claims.jti } : {}),
    ...(typeof claims.agentSessionId === "string"
      ? { agentSessionId: claims.agentSessionId }
      : typeof claims.agent_session_id === "string"
        ? { agentSessionId: claims.agent_session_id }
        : {}),
  };
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function asScopeArray(value: unknown): string[] {
  return typeof value === "string"
    ? value
        .split(/\s+/u)
        .map((scope) => scope.trim())
        .filter(Boolean)
    : asStringArray(value);
}

export function extractBearerToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^Bearer[ \t]+([^ \t]+)$/iu.exec(value.trim());
  return match?.[1] ?? null;
}

export function claimsForTests(
  claims: JWTPayload & Record<string, unknown>,
): RawTokenClaims {
  return claims;
}
