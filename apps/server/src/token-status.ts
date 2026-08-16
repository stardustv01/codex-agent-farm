import type {
  TokenStatus,
  TokenStatusCheck,
  TokenStatusResult,
  TokenStatusVerifier,
} from "./auth.js";

/**
 * The status endpoint is deliberately authenticated independently from the
 * caller's bearer token.  This secret is an Agent Farm service credential,
 * never the token being checked.
 */
export const TOKEN_STATUS_BEARER_HEADER = "authorization";
export const DEFAULT_TOKEN_STATUS_TIMEOUT_MS = 2_000;
export const DEFAULT_TOKEN_STATUS_MAX_RESPONSE_BYTES = 16 * 1024;
export const DEFAULT_TOKEN_STATUS_MAX_REQUEST_BYTES = 16 * 1024;

export interface RemoteTokenStatusVerifierOptions {
  /** HTTPS endpoint owned by the authorization/token-session service. */
  readonly endpoint?: string;
  /** Alias for integrations that name the endpoint as a URL. */
  readonly url?: string;
  /** Dedicated service credential sent as `Authorization: Bearer ...`. */
  readonly bearerSecret?: string;
  /** Alias accepted for config adapters that call the value `secret`. */
  readonly secret?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRequestBytes?: number;
  /** Injectable for deterministic unit tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Alias used by small test adapters. */
  readonly fetch?: typeof fetch;
}

export interface NormalizedTokenStatusRequest {
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
  readonly expectedResource?: string;
}

/**
 * A bounded remote lifecycle verifier.  Every malformed, unavailable, or
 * unexpected response is `unknown`, which the auth boundary rejects.
 *
 * The implementation intentionally has no logger and never includes a
 * request/response body in an exception.  This keeps the status secret and
 * the normalized identity context out of logs when a dependency is down.
 */
export class RemoteTokenStatusVerifier {
  private readonly endpoint: string;
  private readonly bearerSecret: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRequestBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RemoteTokenStatusVerifierOptions) {
    const endpoint = parseHttpsEndpoint(options.endpoint ?? options.url);
    const bearerSecret = options.bearerSecret ?? options.secret;
    if (typeof bearerSecret !== "string" || bearerSecret.trim().length === 0) {
      throw new Error("Token status verifier secret is required");
    }
    if (bearerSecret.length > 8_192) {
      throw new Error("Token status verifier secret is too long");
    }

    this.endpoint = endpoint;
    this.bearerSecret = bearerSecret;
    this.timeoutMs = boundedPositiveInt(
      options.timeoutMs,
      DEFAULT_TOKEN_STATUS_TIMEOUT_MS,
      50,
      30_000,
    );
    this.maxResponseBytes = boundedPositiveInt(
      options.maxResponseBytes,
      DEFAULT_TOKEN_STATUS_MAX_RESPONSE_BYTES,
      256,
      1 * 1024 * 1024,
    );
    this.maxRequestBytes = boundedPositiveInt(
      options.maxRequestBytes,
      DEFAULT_TOKEN_STATUS_MAX_REQUEST_BYTES,
      256,
      1 * 1024 * 1024,
    );
    this.fetchImpl = options.fetchImpl ?? options.fetch ?? fetch;
  }

  /** Adapter shape consumed by `JwtAuthService`. */
  readonly verify: TokenStatusVerifier = async (check) => this.check(check);

  async check(check: TokenStatusCheck): Promise<TokenStatus> {
    const normalized = normalizeTokenStatusCheck(check);
    if (normalized === undefined) return "unknown";

    let body: string;
    try {
      body = JSON.stringify(normalized);
    } catch {
      return "unknown";
    }
    if (new TextEncoder().encode(body).byteLength > this.maxRequestBytes) {
      return "unknown";
    }

    const controller = new AbortController();
    let timeoutReject: ((reason?: unknown) => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutReject = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      timeoutReject?.(new Error("Token status verifier timed out"));
    }, this.timeoutMs);
    try {
      const response = await Promise.race([
        this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            [TOKEN_STATUS_BEARER_HEADER]: `Bearer ${this.bearerSecret}`,
          },
          body,
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);

      if (!isSuccessfulStatus(response.status) || !isJsonContentType(response)) {
        return "unknown";
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        const length = Number.parseInt(declaredLength, 10);
        if (!Number.isSafeInteger(length) || length < 0 || length > this.maxResponseBytes) {
          return "unknown";
        }
      }
      const responseBody = await readBoundedResponse(response, this.maxResponseBytes);
      if (responseBody === undefined || responseBody.trim().length === 0) return "unknown";
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        return "unknown";
      }
      return normalizeRemoteStatus(parsed);
    } catch {
      // Includes timeout, DNS/TLS errors, malformed fetch responses, and any
      // implementation-specific transport failure.  All deny by returning
      // `unknown`.
      return "unknown";
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Construct the callable verifier expected by the JWT auth service. */
export function createRemoteTokenStatusVerifier(
  options: RemoteTokenStatusVerifierOptions,
): TokenStatusVerifier {
  const verifier = new RemoteTokenStatusVerifier(options);
  return verifier.verify;
}

/** Descriptive alias used by callers that prefer the shorter factory name. */
export const createTokenStatusVerifier = createRemoteTokenStatusVerifier;

/**
 * Keep the wire shape explicit.  Do not spread `check`: callers may pass an
 * object containing a raw token/claims field, and those fields must never be
 * serialized to the status service.
 */
export function normalizeTokenStatusCheck(
  check: TokenStatusCheck,
): NormalizedTokenStatusRequest | undefined {
  if (!isBoundedString(check.jti) || !isBoundedString(check.subject)) return undefined;
  if (!isBoundedString(check.ownerId) || !isBoundedString(check.tenantId)) return undefined;

  const result: {
    jti: string;
    tokenId: string;
    subject: string;
    ownerId: string;
    tenantId: string;
    issuer?: string;
    audience?: readonly string[];
    resource?: readonly string[];
    agentSessionId?: string;
    expiresAt?: number;
    notBefore?: number;
    expectedResource?: string;
  } = {
    jti: check.jti,
    tokenId: check.jti,
    subject: check.subject,
    ownerId: check.ownerId,
    tenantId: check.tenantId,
  };
  if (isBoundedString(check.issuer)) result.issuer = check.issuer;
  const audience = normalizeStringArray(check.audience);
  if (audience.length > 0) result.audience = audience;
  const resource = normalizeStringArray(check.resource);
  if (resource.length > 0) result.resource = resource;
  if (isBoundedString(check.agentSessionId)) result.agentSessionId = check.agentSessionId;
  if (isFiniteEpoch(check.expiresAt)) result.expiresAt = check.expiresAt;
  if (isFiniteEpoch(check.notBefore)) result.notBefore = check.notBefore;
  if (isBoundedString(check.expectedResource)) result.expectedResource = check.expectedResource;
  return result;
}

export function normalizeRemoteStatus(value: unknown): TokenStatus {
  if (value === "active" || value === "revoked" || value === "replayed" || value === "unknown") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const candidate = (value as { status?: unknown }).status;
  if (candidate === "active" || candidate === "revoked" || candidate === "replayed" || candidate === "unknown") {
    return candidate;
  }
  return "unknown";
}

function parseHttpsEndpoint(value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Token status verifier endpoint is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Token status verifier endpoint is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Token status verifier endpoint must use HTTPS");
  }
  return parsed.href;
}

function boundedPositiveInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("Token status verifier bound is invalid");
  }
  return value;
}

function isSuccessfulStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function isJsonContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  if (contentType === null) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string | undefined> {
  try {
    if (response.body !== null && response.body !== undefined) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const value = next.value;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            return undefined;
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    }
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength <= maxBytes ? text : undefined;
  } catch {
    return undefined;
  }
}

function normalizeStringArray(value: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (!isBoundedString(item)) return [];
    if (!result.includes(item)) result.push(item);
    if (result.length > 32) return [];
  }
  return result;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function isFiniteEpoch(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Keep the import-visible type referenced for consumers that only import this
// module and want to narrow a generic verifier result.
export type { TokenStatusCheck, TokenStatusResult, TokenStatusVerifier };
