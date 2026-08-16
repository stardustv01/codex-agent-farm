import { createHash, randomUUID } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import type {
  Principal,
  SessionPayload,
  SessionScope,
} from "./contracts.js";

export const DEFAULT_BODY_LIMIT = 64 * 1024;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;
export const MAX_ID_LENGTH = 256;

export class HttpError extends Error {
  readonly statusCode: number;
  readonly errorCode: string;
  readonly expose: boolean;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    statusCode: number,
    errorCode: string,
    message: string,
    options: {
      readonly expose?: boolean;
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    // Explicit HttpErrors carry a vetted, non-secret message even for a 5xx
    // operational response (for example PAIRING_UNAVAILABLE). Raw thrown
    // errors still take the generic INTERNAL_ERROR path in the handler.
    this.expose = options.expose ?? true;
    this.headers = options.headers;
  }
}

export function requestId(request: FastifyRequest): string {
  return typeof request.id === "string" && request.id.length > 0
    ? request.id
    : randomUUID();
}

export function setSecurityHeaders(reply: FastifyReply, csp: string): void {
  reply.header("content-security-policy", csp);
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  reply.header("cross-origin-opener-policy", "same-origin");
  reply.header("cross-origin-resource-policy", "same-origin");
  reply.header("cache-control", "no-store");
}

export function safeErrorEnvelope(
  request: FastifyRequest,
  error: unknown,
): { error: { code: string; message: string; requestId: string } } {
  const status = getStatusCode(error);
  const known = error instanceof HttpError && error.expose;
  let code = "INTERNAL_ERROR";
  let message = "An unexpected error occurred";

  if (known && error instanceof HttpError) {
    code = error.errorCode;
    message = error.message;
  } else if (status === 400) {
    code = "BAD_REQUEST";
    message = "The request could not be accepted";
  } else if (status === 401) {
    code = "UNAUTHENTICATED";
    message = "Authentication is required";
  } else if (status === 403) {
    code = "FORBIDDEN";
    message = "The request is not permitted";
  } else if (status === 404) {
    code = "NOT_FOUND";
    message = "The requested resource was not found";
  } else if (status === 413) {
    code = "REQUEST_TOO_LARGE";
    message = "The request is too large";
  } else if (status === 429) {
    code = "RATE_LIMITED";
    message = "Too many requests";
  }

  return {
    error: {
      code,
      message,
      requestId: requestId(request),
    },
  };
}

export function getStatusCode(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  ) {
    return (error as { statusCode: number }).statusCode;
  }
  return 500;
}

export function parsePageQuery(query: unknown): {
  page: number;
  pageSize: number;
} {
  const record = isRecord(query) ? query : {};
  let page = parsePositiveInt(record.page, 1);
  if (record.cursor !== undefined) {
    if (typeof record.cursor !== "string") {
      throw new HttpError(400, "INVALID_PAGINATION", "Invalid pagination value");
    }
    const match = /^p_([1-9][0-9]{0,5})$/u.exec(record.cursor);
    if (!match) throw new HttpError(400, "INVALID_PAGINATION", "Invalid pagination value");
    const cursorPage = parsePositiveInt(match[1], 1);
    if (record.page !== undefined && page !== cursorPage) {
      throw new HttpError(400, "INVALID_PAGINATION", "Conflicting pagination values");
    }
    page = cursorPage;
  }
  const rawPageSize = record.pageSize ?? record.limit ?? DEFAULT_PAGE_SIZE;
  const pageSize = parsePositiveInt(rawPageSize, DEFAULT_PAGE_SIZE);
  if (pageSize > MAX_PAGE_SIZE) {
    throw new HttpError(
      400,
      "PAGE_SIZE_TOO_LARGE",
      `pageSize must be at most ${MAX_PAGE_SIZE}`,
    );
  }
  return { page, pageSize };
}

export function parsePositiveInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const text = typeof value === "number" ? String(value) : String(value);
  if (!/^[1-9]\d{0,5}$/u.test(text)) {
    throw new HttpError(400, "INVALID_PAGINATION", "Invalid pagination value");
  }
  const result = Number(text);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new HttpError(400, "INVALID_PAGINATION", "Invalid pagination value");
  }
  return result;
}

export function readString(
  record: Record<string, unknown>,
  key: string,
  options: { readonly max: number; readonly required?: boolean } = { max: 256 },
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    if (options.required) {
      throw new HttpError(400, "INVALID_REQUEST", `${key} is required`);
    }
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > options.max) {
    throw new HttpError(400, "INVALID_REQUEST", `${key} is invalid`);
  }
  return value;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_REQUEST", "JSON object expected");
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Only these fields cross the session-creation boundary.  In particular,
 * ownerId, tenantId, agentSessionId, sourceRootId, and installationId from a
 * caller body are ignored rather than becoming authorization input.
 */
export function sanitizeSessionPayload(value: unknown): SessionPayload {
  const body = isRecord(value) ? value : {};
  const result: { label?: string; sourceAdapter?: string; capabilities?: string[] } = {};
  if (body.label !== undefined) {
    const label = readString(body, "label", { max: 120 });
    if (label !== undefined) result.label = label;
  }
  if (body.sourceAdapter !== undefined) {
    const sourceAdapter = readString(body, "sourceAdapter", { max: 64 });
    if (sourceAdapter !== undefined) result.sourceAdapter = sourceAdapter;
  }
  if (body.capabilities !== undefined) {
    if (
      !Array.isArray(body.capabilities) ||
      body.capabilities.length > 32 ||
      body.capabilities.some(
        (capability) => typeof capability !== "string" || capability.length === 0 || capability.length > 80,
      )
    ) {
      throw new HttpError(400, "INVALID_REQUEST", "capabilities is invalid");
    }
    result.capabilities = [...new Set(body.capabilities as string[])].sort();
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = sortJson(value[key]);
        return result;
      }, {});
  }
  return value;
}

export function assertScope(principal: Principal, scope: string): void {
  if (!principal.scopes.has(scope)) {
    throw new HttpError(403, "INSUFFICIENT_SCOPE", "The token lacks the required scope", {
      headers: {
        "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}"`,
      },
    });
  }
}

export function assertScopedRecord(
  record: { readonly agentSessionId?: string; readonly ownerId?: string; readonly tenantId?: string },
  scope: SessionScope,
): void {
  if (
    (record.agentSessionId !== undefined && record.agentSessionId !== scope.agentSessionId) ||
    (record.ownerId !== undefined && record.ownerId !== scope.ownerId) ||
    (record.tenantId !== undefined && record.tenantId !== scope.tenantId)
  ) {
    // Deliberately non-enumerating: callers cannot use ownership mismatches to
    // probe another tenant's session IDs.
    throw new HttpError(404, "NOT_FOUND", "The requested resource was not found");
  }
}

export function assertSessionId(value: string | undefined): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    throw new HttpError(404, "NOT_FOUND", "The requested resource was not found");
  }
  return value;
}

export function safeHeader(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return undefined;
  }
  return value;
}
