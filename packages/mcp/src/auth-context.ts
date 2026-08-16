import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/** The scopes frozen by the Phase C tool contract. */
export const AGENT_FARM_SCOPES = {
  create: "agent-session:create",
  read: "agent-session:read",
  readDetails: "agent-session:read-details",
  render: "agent-session:render",
} as const;

export type AgentFarmScope = (typeof AGENT_FARM_SCOPES)[keyof typeof AGENT_FARM_SCOPES];

/**
 * Claims that have already passed the resource-server's signature, issuer,
 * audience, expiry, replay, and revocation checks. The MCP layer never treats
 * tool arguments, widget state, or host metadata as a source for these values.
 */
export interface AuthContext {
  readonly verified: true;
  readonly ownerId: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
  /** The server-selected Agent Farm session for this token, if one is bound. */
  readonly agentSessionId?: string;
  /** Optional evidence retained by the verifier for audit correlation only. */
  readonly subject?: string;
  readonly issuer?: string;
  readonly audience?: string | readonly string[];
  readonly resource?: string;
  readonly tokenId?: string;
}

export interface AuthContextProviderInput {
  readonly authInfo?: AuthInfo;
}

export type AuthContextProvider = (
  extra?: AuthContextProviderInput,
) => AuthContext | Promise<AuthContext>;

export interface AuthContextInit {
  readonly ownerId: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
  readonly agentSessionId?: string;
  readonly subject?: string;
  readonly issuer?: string;
  readonly audience?: string | readonly string[];
  readonly resource?: string;
  readonly tokenId?: string;
}

export class AuthorizationError extends Error {
  readonly status: 401 | 403;
  readonly code: "unauthorized" | "insufficient_scope" | "invalid_session";
  readonly requiredScopes: readonly string[];

  constructor(
    message: string,
    options: {
      status: 401 | 403;
      code: "unauthorized" | "insufficient_scope" | "invalid_session";
      requiredScopes?: readonly string[];
    },
  ) {
    super(message);
    this.name = "AuthorizationError";
    this.status = options.status;
    this.code = options.code;
    this.requiredScopes = options.requiredScopes ?? [];
  }
}

export function makeAuthContext(input: AuthContextInit): AuthContext {
  const ownerId = boundedClaim(input.ownerId, "owner");
  const tenantId = boundedClaim(input.tenantId, "tenant");
  const scopes = [...new Set(input.scopes.filter((scope) => isBounded(scope)))];

  return {
    verified: true,
    ownerId,
    tenantId,
    scopes,
    ...(input.agentSessionId === undefined
      ? {}
      : { agentSessionId: boundedClaim(input.agentSessionId, "session") }),
    ...(input.subject === undefined ? {} : { subject: boundedClaim(input.subject, "subject") }),
    ...(input.issuer === undefined ? {} : { issuer: boundedClaim(input.issuer, "issuer") }),
    ...(input.audience === undefined
      ? {}
      : {
          audience:
            typeof input.audience === "string"
              ? boundedClaim(input.audience, "audience")
              : input.audience.filter((value) => isBounded(value)).slice(0, 8),
        }),
    ...(input.resource === undefined
      ? {}
      : { resource: boundedClaim(input.resource, "resource") }),
    ...(input.tokenId === undefined
      ? {}
      : { tokenId: boundedClaim(input.tokenId, "token id") }),
  };
}

/**
 * Converts SDK AuthInfo produced by a verifier into the smaller application
 * context. `extra` is trusted only because it is attached by that verifier;
 * missing required claims fail closed.
 */
export function authContextFromAuthInfo(
  authInfo: AuthInfo | undefined,
  options: {
    readonly expectedResource?: string;
    readonly nowSeconds?: number;
  } = {},
): AuthContext {
  if (authInfo === undefined) {
    throw new AuthorizationError("Authorization is required", {
      status: 401,
      code: "unauthorized",
    });
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (authInfo.expiresAt !== undefined && authInfo.expiresAt <= nowSeconds) {
    throw new AuthorizationError("Authorization is expired", {
      status: 401,
      code: "unauthorized",
    });
  }

  if (
    options.expectedResource !== undefined &&
    canonicalResource(authInfo.resource?.toString()) !== canonicalResource(options.expectedResource)
  ) {
    throw new AuthorizationError("Authorization is for a different resource", {
      status: 401,
      code: "unauthorized",
    });
  }

  const claims = authInfo.extra ?? {};
  const ownerId = claimString(claims, ["ownerId", "owner_id", "sub"]);
  const tenantId = claimString(claims, ["tenantId", "tenant_id"]);
  if (ownerId === undefined || tenantId === undefined) {
    throw new AuthorizationError("Authorization has no Agent Farm principal", {
      status: 401,
      code: "unauthorized",
    });
  }

  const sessionClaim = claimString(claims, ["agentSessionId", "agent_session_id"]);
  const subjectClaim = claimString(claims, ["sub"]);
  const issuerClaim = claimString(claims, ["iss", "issuer"]);
  const audienceClaim = claimAudience(claims);
  const tokenIdClaim = claimString(claims, ["jti", "tokenId", "token_id"]);
  return makeAuthContext({
    ownerId,
    tenantId,
    scopes: authInfo.scopes,
    ...(sessionClaim === undefined ? {} : { agentSessionId: sessionClaim }),
    ...(subjectClaim === undefined ? {} : { subject: subjectClaim }),
    ...(issuerClaim === undefined ? {} : { issuer: issuerClaim }),
    ...(audienceClaim === undefined ? {} : { audience: audienceClaim }),
    ...(authInfo.resource === undefined ? {} : { resource: authInfo.resource.toString() }),
    ...(tokenIdClaim === undefined ? {} : { tokenId: tokenIdClaim }),
  });
}

export function requireAuthContext(context: AuthContext | undefined): AuthContext {
  if (context === undefined || context.verified !== true) {
    throw new AuthorizationError("Authorization is required", {
      status: 401,
      code: "unauthorized",
    });
  }
  if (!isBounded(context.ownerId) || !isBounded(context.tenantId)) {
    throw new AuthorizationError("Authorization has no Agent Farm principal", {
      status: 401,
      code: "unauthorized",
    });
  }
  return context;
}

export function requireScope(context: AuthContext, requiredScope: AgentFarmScope): void {
  requireAuthContext(context);
  if (!context.scopes.includes(requiredScope)) {
    throw new AuthorizationError(`Scope ${requiredScope} is required`, {
      status: 403,
      code: "insufficient_scope",
      requiredScopes: [requiredScope],
    });
  }
}

/** Resolve a body hint against the session selected by verified credentials. */
export function requireBoundSession(
  context: AuthContext,
  requestedSessionId?: string,
): string {
  requireAuthContext(context);
  const bound = context.agentSessionId;
  if (bound === undefined) {
    throw new AuthorizationError("No Agent Farm session is bound to authorization", {
      status: 403,
      code: "invalid_session",
    });
  }
  if (requestedSessionId !== undefined && requestedSessionId !== bound) {
    throw new AuthorizationError("Agent Farm session is not authorized", {
      status: 403,
      code: "invalid_session",
    });
  }
  return bound;
}

function claimString(claims: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === "string" && isBounded(value)) return value;
  }
  return undefined;
}

function claimAudience(claims: Record<string, unknown>): string | readonly string[] | undefined {
  const value = claims.aud ?? claims.audience;
  if (typeof value === "string" && isBounded(value)) return value;
  if (Array.isArray(value)) {
    const values = value.filter((item): item is string => typeof item === "string" && isBounded(item));
    return values.length === 0 ? undefined : values.slice(0, 8);
  }
  return undefined;
}

function boundedClaim(value: string, label: string): string {
  if (!isBounded(value)) throw new TypeError(`${label} claim is empty or too long`);
  return value;
}

function canonicalResource(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function isBounded(value: string): boolean {
  return value.trim().length > 0 && value.length <= 256;
}
