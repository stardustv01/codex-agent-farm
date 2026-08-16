import {
  ALLOWED_OUTBOUND_METHODS,
  type AllowedOutboundMethod,
  type JsonObject,
  type JsonValue,
} from './types.js';

const ALLOWED_METHOD_SET: ReadonlySet<string> = new Set(ALLOWED_OUTBOUND_METHODS);

/**
 * Error intentionally contains only the denied method.  Request parameters
 * are never interpolated into bridge errors or audit records.
 */
export class OutboundMethodDeniedError extends Error {
  readonly code = 'OUTBOUND_METHOD_DENIED' as const;
  readonly method: string;

  constructor(method: string) {
    super(`Outbound method is not permitted: ${method}`);
    this.name = 'OutboundMethodDeniedError';
    this.method = method;
  }
}

export class OutboundParamsDeniedError extends Error {
  readonly code = 'OUTBOUND_PARAMS_DENIED' as const;
  readonly method: AllowedOutboundMethod;
  readonly field: string | undefined;

  constructor(method: AllowedOutboundMethod, field?: string) {
    super(field ? `Outbound params are not permitted for ${method}: ${field}` : `Outbound params are not permitted for ${method}`);
    this.name = 'OutboundParamsDeniedError';
    this.method = method;
    this.field = field;
  }
}

export function isAllowedOutboundMethod(method: string): method is AllowedOutboundMethod {
  return ALLOWED_METHOD_SET.has(method);
}

export function assertAllowedOutboundMethod(method: string): asserts method is AllowedOutboundMethod {
  if (!isAllowedOutboundMethod(method)) {
    throw new OutboundMethodDeniedError(method);
  }
}

/**
 * Source kinds accepted by the installed app-server ThreadListParams
 * contract. Keep this list explicit: an unknown future enum value must not
 * silently widen the bridge's discovery surface.
 */
export const CODEX_THREAD_SOURCE_KINDS = Object.freeze([
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
] as const);

export type CodexThreadSourceKind = (typeof CODEX_THREAD_SOURCE_KINDS)[number];

/**
 * Bounded discovery used by reconciliation and source-root attestation.
 * The protocol's `unknown` sentinel is intentionally excluded from authority
 * discovery: roots and descendants must have a concrete, supported origin.
 */
export const CODEX_DISCOVERY_SOURCE_KINDS = Object.freeze([
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
] as const);

const CODEX_THREAD_SOURCE_KIND_SET: ReadonlySet<string> = new Set(CODEX_THREAD_SOURCE_KINDS);

const REQUEST_FIELDS: Readonly<Record<AllowedOutboundMethod, ReadonlySet<string>>> = {
  initialize: new Set(['clientInfo', 'capabilities']),
  initialized: new Set(),
  'thread/list': new Set(['cursor', 'limit', 'useStateDbOnly', 'sourceKinds', 'archived']),
  'thread/read': new Set(['threadId', 'includeTurns']),
  'model/list': new Set(['cursor', 'limit']),
};

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 5) return false;
  if (isJsonPrimitive(value)) return true;
  if (Array.isArray(value)) return value.length <= 200 && value.every((entry) => isJsonValue(entry, depth + 1));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).every(([key, entry]) => key.length <= 64 && isJsonValue(entry, depth + 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeCursor(value: unknown): value is string {
  // Cursors are used only inside the local bridge.  Reject controls, paths,
  // and unbounded payloads even though the server may treat a cursor as opaque.
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9._~+=:-]+$/.test(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isSafePositiveInteger(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max;
}

function validateInitialize(value: unknown): void {
  if (!isRecord(value)) throw new OutboundParamsDeniedError('initialize');
  const keys = Object.keys(value);
  if (keys.some((key) => !REQUEST_FIELDS.initialize.has(key))) {
    throw new OutboundParamsDeniedError('initialize', keys.find((key) => !REQUEST_FIELDS.initialize.has(key)));
  }
  const clientInfo = value.clientInfo;
  if (!isRecord(clientInfo) || typeof clientInfo.name !== 'string' || typeof clientInfo.version !== 'string') {
    throw new OutboundParamsDeniedError('initialize', 'clientInfo');
  }
  if (Object.keys(clientInfo).some((key) => key !== 'name' && key !== 'title' && key !== 'version')) {
    throw new OutboundParamsDeniedError('initialize', 'clientInfo');
  }
  if (!/^[A-Za-z0-9._ -]{1,64}$/.test(clientInfo.name) || !/^[A-Za-z0-9._-]{1,32}$/.test(clientInfo.version)) {
    throw new OutboundParamsDeniedError('initialize', 'clientInfo');
  }
  if (clientInfo.title !== undefined && (typeof clientInfo.title !== 'string' || !/^[A-Za-z0-9._ -]{1,96}$/.test(clientInfo.title))) {
    throw new OutboundParamsDeniedError('initialize', 'clientInfo');
  }
  if (value.capabilities !== undefined) {
    const capabilities = value.capabilities;
    if (!isRecord(capabilities)) throw new OutboundParamsDeniedError('initialize', 'capabilities');
    const capabilityKeys = Object.keys(capabilities);
    const booleanCapabilities = new Set(['experimentalApi', 'supportsNotifications', 'requestAttestation']);
    if (capabilityKeys.some((key) => !booleanCapabilities.has(key) && key !== 'optOutNotificationMethods')) {
      throw new OutboundParamsDeniedError('initialize', 'capabilities');
    }
    if (capabilityKeys.some((key) => booleanCapabilities.has(key) && typeof capabilities[key] !== 'boolean')) {
      throw new OutboundParamsDeniedError('initialize', 'capabilities');
    }
    const optOut = capabilities.optOutNotificationMethods;
    if (optOut !== undefined && (!Array.isArray(optOut) || optOut.length > 100 || optOut.some((entry) =>
      typeof entry !== 'string' || entry.length === 0 || entry.length > 128 || !/^[A-Za-z0-9/._:-]+$/.test(entry)))) {
      throw new OutboundParamsDeniedError('initialize', 'capabilities');
    }
  }
}

function validateList(value: unknown, method: 'thread/list' | 'model/list'): void {
  if (!isRecord(value)) throw new OutboundParamsDeniedError(method);
  for (const key of Object.keys(value)) {
    if (!REQUEST_FIELDS[method].has(key)) throw new OutboundParamsDeniedError(method, key);
  }
  if (value.cursor !== undefined && !isSafeCursor(value.cursor)) throw new OutboundParamsDeniedError(method, 'cursor');
  if (value.limit !== undefined && !isSafePositiveInteger(value.limit, 200)) throw new OutboundParamsDeniedError(method, 'limit');
  if (method === 'thread/list' && value.useStateDbOnly !== undefined && typeof value.useStateDbOnly !== 'boolean') {
    throw new OutboundParamsDeniedError(method, 'useStateDbOnly');
  }
  if (method === 'thread/list' && value.archived !== undefined && typeof value.archived !== 'boolean') {
    throw new OutboundParamsDeniedError(method, 'archived');
  }
  if (method === 'thread/list' && value.sourceKinds !== undefined) {
    // The app-server schema permits null and an empty array (both mean its
    // default interactive filter). Non-empty filters are bounded to the
    // complete known enum and reject duplicates to keep requests canonical.
    if (value.sourceKinds !== null) {
      if (!Array.isArray(value.sourceKinds) || value.sourceKinds.length > CODEX_THREAD_SOURCE_KINDS.length) {
        throw new OutboundParamsDeniedError(method, 'sourceKinds');
      }
      const seen = new Set<string>();
      for (const sourceKind of value.sourceKinds) {
        if (typeof sourceKind !== 'string' || !CODEX_THREAD_SOURCE_KIND_SET.has(sourceKind) || seen.has(sourceKind)) {
          throw new OutboundParamsDeniedError(method, 'sourceKinds');
        }
        seen.add(sourceKind);
      }
    }
  }
}

function validateRead(value: unknown): void {
  if (!isRecord(value)) throw new OutboundParamsDeniedError('thread/read');
  for (const key of Object.keys(value)) {
    if (!REQUEST_FIELDS['thread/read'].has(key)) throw new OutboundParamsDeniedError('thread/read', key);
  }
  if (!isSafeIdentifier(value.threadId)) throw new OutboundParamsDeniedError('thread/read', 'threadId');
  if (value.includeTurns !== undefined && typeof value.includeTurns !== 'boolean') {
    throw new OutboundParamsDeniedError('thread/read', 'includeTurns');
  }
}

/** Validate and clone known request parameters before JSON serialization. */
export function validateOutboundParams(method: AllowedOutboundMethod, params: unknown): JsonObject | undefined {
  if (params === undefined) {
    if (method === 'initialize') throw new OutboundParamsDeniedError(method, 'clientInfo');
    return undefined;
  }
  switch (method) {
    case 'initialize':
      validateInitialize(params);
      break;
    case 'thread/list':
    case 'model/list':
      validateList(params, method);
      break;
    case 'thread/read':
      validateRead(params);
      break;
    case 'initialized':
      if (!isRecord(params) || Object.keys(params).length !== 0) throw new OutboundParamsDeniedError(method);
      break;
  }
  if (!isRecord(params) || !isJsonValue(params)) throw new OutboundParamsDeniedError(method);
  // A structured clone prevents callers mutating params while the request is
  // waiting on stdio, and also ensures no prototype data is serialized.
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, value])) as JsonObject;
}
