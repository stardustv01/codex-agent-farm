import { createHash, randomUUID } from "node:crypto";

import { ConstraintError } from "./errors.js";
import { LocalCostEstimateSchema } from "@agent-farm/contracts";

export const nowMillis = (): number => Date.now();

export function id(): string {
  return randomUUID();
}

export function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ConstraintError("INVALID_INPUT", `${field} must not be empty`);
  }
  return normalized;
}

export function optional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

/** Stable JSON used for idempotency and sanitized-event hashes. */
export function stableJson(value: unknown): string {
  return serializeCanonical(value, DEFAULT_SERIALIZATION_LIMITS);
}

export function sha256(value: unknown): string {
  const input = typeof value === "string" ? assertString(value) : stableJson(value);
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Keep only the small, documented sanitized event vocabulary.  The bridge is
 * the first minimisation boundary, but keeping this guard in the persistence
 * layer ensures a caller can never accidentally retain an unknown field.
 */
const EVENT_KEYS = new Set([
  "type",
  "eventType",
  "kind",
  "version",
  "schemaVersion",
  "eventId",
  "agentId",
  "parentAgentId",
  "childAgentId",
  "sourceAdapter",
  "sourceThreadId",
  "sourceSessionId",
  "parentSourceThreadId",
  "forkedFromAgentId",
  "sourceKind",
  "sourceOperationId",
  "edgeId",
  "parentSessionId",
  "childSessionId",
  "role",
  "nickname",
  "cliVersion",
  "name",
  "lifecycle",
  "status",
  "requestedModel",
  "requestedEffort",
  "requestedProvider",
  "observedModel",
  "observedEffort",
  "observedProvider",
  "trustClass",
  "evidenceSource",
  "provider",
  "model",
  "effort",
  "summary",
  "resultSummary",
  "errorSummary",
  "errorCode",
  "turnId",
  "itemId",
  "correlationId",
  "authority",
  "redactionVersion",
  "isRoot",
  "root",
  "timestamp",
  "createdAt",
  "updatedAt",
  "verificationState",
  "agent",
  "agents",
  "edge",
  "edges",
  "identityEvidence",
  "values",
  "from",
  "to",
  "snapshot",
  "correctedAgentIds",
  "correctedEdgeIds",
  "capabilities",
  "generation",
  "startedAt",
  "endedAt",
  "durationMs",
  "errorCode",
  "watermark",
  "cursor",
  "source",
  "usage",
  "usageSegments",
  "pricingSnapshotId",
  "cost",
  "currency",
  "selfMicros",
  "childrenMicros",
  "totalMicros",
  "pricing",
  "reason",
  "snapshotId",
  "sourceUrls",
  "retrievedAt",
  "verifiedAt",
  "rates",
  "standardInputMultiplier",
  "longContextThresholdInputTokens",
  "longContextInputMultiplier",
  "longContextOutputMultiplier",
  "cacheWriteMultiplier",
  "snapshotHash",
  "note",
  "inputPerMillionUsd",
  "cachedInputPerMillionUsd",
  "outputPerMillionUsd",
]);

const USAGE_KEYS = new Set([
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "observedAt",
]);

/**
 * Usage is the one nested object allowed in a projection event.  Do not route
 * it through the general event vocabulary: keys such as `model` or `summary`
 * are valid elsewhere but must never hitchhike inside telemetry. Unknown
 * children are ignored without reading their values; known children are
 * checked as typed counters before they can reach SQLite.
 */
function sanitizeUsage(value: unknown, context: SerializationContext, depth: number): Record<string, unknown> {
  if (!isPlainRecord(value)) unsafePayload();
  const keys = ownEnumerableKeys(value);
  if (keys.length > 32) unsafePayload();
  const output: Record<string, unknown> = {};
  for (const key of USAGE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const raw = dataProperty(value, key);
    if (key === "observedAt") {
      if (raw !== undefined && (typeof raw !== "string" || raw.length > 80 || /[\u0000-\u001f\u007f]/u.test(raw) || !Number.isFinite(Date.parse(raw)))) unsafePayload();
      if (raw !== undefined) {
        charge(context, quotedBytes(key) + quotedBytes(raw as string) + 1);
        output[key] = raw;
      }
      continue;
    }
    if (!Number.isSafeInteger(raw) || (raw as number) < 0) unsafePayload();
    charge(context, quotedBytes(key) + primitiveBytes(raw as number) + 1);
    output[key] = raw;
  }
  const required = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(output, key))) unsafePayload();
  const input = output.inputTokens as number;
  const cached = output.cachedInputTokens as number;
  const cacheWrite = output.cacheWriteInputTokens as number;
  const total = output.totalTokens as number;
  if (cached + cacheWrite > input || total !== input + (output.outputTokens as number)) unsafePayload();
  return output;
}

function sanitizeUsageSegments(value: unknown, context: SerializationContext, depth: number): Record<string, unknown> {
  if (!isPlainRecord(value)) unsafePayload();
  const keys = ownEnumerableKeys(value);
  if (keys.length > 4) unsafePayload();
  const complete = dataProperty(value, "complete");
  if (typeof complete !== "boolean") unsafePayload();
  const rawSegments = dataProperty(value, "segments");
  if (!Array.isArray(rawSegments) || rawSegments.length > 1_024) unsafePayload();
  const segments: Record<string, unknown>[] = [];
  for (const raw of rawSegments) {
    if (!isPlainRecord(raw)) unsafePayload();
    const segmentKeys = ownEnumerableKeys(raw);
    if (segmentKeys.length > 5) unsafePayload();
    const turnId = dataProperty(raw, "turnId");
    const provider = dataProperty(raw, "provider");
    const model = dataProperty(raw, "model");
    const effort = dataProperty(raw, "effort");
    if (![turnId, provider, model, effort].every((item) => typeof item === "string" && item.length > 0 && item.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(item))) unsafePayload();
    const usage = sanitizeUsage(dataProperty(raw, "usage"), context, depth + 1);
    segments.push({ turnId, provider, model, effort, usage });
  }
  return { complete, segments };
}

function sanitizeCost(value: unknown, context: SerializationContext, depth: number): unknown {
  const parsed = LocalCostEstimateSchema.safeParse(value);
  if (!parsed.success) unsafePayload();
  // The strict contract is the allowlist. Canonical normalization may retain
  // dynamic reviewed model-rate keys only after that strict parse succeeds.
  return normalizeValue(parsed.data, context, depth);
}

export function sanitizePayload(payload: unknown): Record<string, unknown> {
  if (!isPlainRecord(payload)) {
    failSafe("INVALID_PAYLOAD", "Payload must be a JSON object");
  }

  const context = createContext(SANITIZED_PAYLOAD_LIMITS);
  const sanitized = sanitizeObject(payload as Record<string, unknown>, context, 0);
  // The second pass makes the byte bound explicit and guarantees that the
  // value returned to callers has exactly the same canonical representation
  // used by the persistence layer and event hash.
  serializeCanonical(sanitized, SANITIZED_PAYLOAD_LIMITS);
  return sanitized;
}

/**
 * These bounds are deliberately conservative.  They protect every caller of
 * stableJson (idempotency, audit metadata, capabilities, and event payloads)
 * from unbounded work while leaving room for normal Agent Farm snapshots.
 */
const DEFAULT_SERIALIZATION_LIMITS: SerializationLimits = Object.freeze({
  maxDepth: 32,
  // Each usage segment contains its own bounded usage object and scalar
  // fields; 1,024 valid segments require slightly over 10,000 JSON nodes.
  maxNodes: 20_000,
  maxArrayLength: 1_024,
  maxObjectKeys: 256,
  maxStringBytes: 16 * 1024,
  // Local usage evidence permits 1,024 strictly bounded invocation segments.
  // A fully populated projection is ~300 KiB, so canonical hashing must admit
  // that reviewed schema maximum without becoming unbounded.
  maxSerializedBytes: 1024 * 1024,
});

const SANITIZED_PAYLOAD_LIMITS: SerializationLimits = Object.freeze({
  ...DEFAULT_SERIALIZATION_LIMITS,
  // Projection events can carry the same 1,024-segment strict contract. Keep
  // a separate lower event cap with sufficient measured headroom.
  maxSerializedBytes: 512 * 1024,
});

interface SerializationLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
  readonly maxStringBytes: number;
  readonly maxSerializedBytes: number;
}

interface SerializationContext {
  readonly limits: SerializationLimits;
  readonly active: WeakSet<object>;
  nodes: number;
  serializedBytes: number;
}

const OMIT = Symbol("omit-undefined");
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor", "toJSON"]);
const SAFE_ERRORS = new WeakSet<object>();

function failSafe(code: string, message: string): never {
  const error = new ConstraintError(code, message);
  SAFE_ERRORS.add(error);
  throw error;
}

function isSafeError(error: unknown): error is ConstraintError {
  return typeof error === "object" && error !== null && SAFE_ERRORS.has(error);
}

function isArrayValue(value: unknown, onError: () => never): value is object[] {
  try {
    return Array.isArray(value);
  } catch {
    // A revoked Proxy can make Array.isArray throw before the normal object
    // guards run.  Route that native error through our safe boundary.
    return onError();
  }
}

function unsafeSerialization(): never {
  // Do not include a key, value, or native exception text here.  App-server
  // payloads may contain prompts, credentials, or other sensitive content.
  return failSafe("UNSAFE_SERIALIZATION", "Payload cannot be safely serialized");
}

function unsafePayload(): never {
  return failSafe("UNSAFE_PAYLOAD", "Payload cannot be safely persisted");
}

function assertString(value: string, limits: SerializationLimits = DEFAULT_SERIALIZATION_LIMITS): string {
  if (Buffer.byteLength(value, "utf8") > limits.maxStringBytes) unsafeSerialization();
  return value;
}

function createContext(limits: SerializationLimits): SerializationContext {
  return { limits, active: new WeakSet<object>(), nodes: 0, serializedBytes: 0 };
}

function charge(context: SerializationContext, bytes: number): void {
  // Charge before constructing a child value.  This prevents a broad object
  // full of large strings from consuming unbounded memory before final JSON
  // size validation runs.
  context.serializedBytes += bytes;
  if (!Number.isSafeInteger(context.serializedBytes) || context.serializedBytes > context.limits.maxSerializedBytes) {
    unsafeSerialization();
  }
}

function quotedBytes(value: string): number {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") unsafeSerialization();
  return Buffer.byteLength(encoded, "utf8");
}

function primitiveBytes(value: boolean | number | null): number {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") unsafeSerialization();
  return Buffer.byteLength(encoded, "utf8");
}

function addNode(context: SerializationContext): void {
  context.nodes += 1;
  if (context.nodes > context.limits.maxNodes) unsafeSerialization();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || isArrayValue(value, unsafePayload)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    // Proxy traps can throw arbitrary errors (which may contain secrets).
    unsafePayload();
  }
}

function ownEnumerableKeys(value: object): string[] {
  try {
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) unsafeSerialization();
    return Object.keys(value);
  } catch (error) {
    if (isSafeError(error)) throw error;
    unsafeSerialization();
  }
}

function dataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // Accessors are not trusted: reading one can execute arbitrary code and
    // can expose a prompt/token through an error or side effect.
    if (!descriptor || !("value" in descriptor)) unsafeSerialization();
    return descriptor.value;
  } catch (error) {
    if (isSafeError(error)) throw error;
    unsafeSerialization();
  }
}

function enterObject(context: SerializationContext, value: object): void {
  if (context.active.has(value)) unsafeSerialization();
  context.active.add(value);
}

function leaveObject(context: SerializationContext, value: object): void {
  context.active.delete(value);
}

function normalizeValue(value: unknown, context: SerializationContext, depth: number): unknown {
  if (depth > context.limits.maxDepth) unsafeSerialization();
  addNode(context);

  if (value === undefined) return OMIT;
  if (value === null) {
    charge(context, primitiveBytes(value));
    return null;
  }
  switch (typeof value) {
    case "string":
      assertString(value, context.limits);
      charge(context, quotedBytes(value));
      return value;
    case "boolean":
      charge(context, primitiveBytes(value));
      return value;
    case "number":
      if (!Number.isFinite(value)) unsafeSerialization();
      charge(context, primitiveBytes(value));
      return value;
    case "object":
      if (isArrayValue(value, unsafeSerialization)) return normalizeArray(value, context, depth);
      return normalizeObject(value, context, depth);
    default:
      // Functions, symbols, bigint, and other non-JSON values are rejected,
      // rather than silently coerced into a potentially misleading payload.
      unsafeSerialization();
  }
}

function normalizeArray(value: object[], context: SerializationContext, depth: number): unknown[] {
  let length: number;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!descriptor || typeof descriptor.value !== "number") unsafeSerialization();
    length = descriptor.value;
  } catch (error) {
    if (isSafeError(error)) throw error;
    unsafeSerialization();
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > context.limits.maxArrayLength) unsafeSerialization();
  enterObject(context, value);
  charge(context, 1); // [
  try {
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (index > 0) charge(context, 1); // comma
      let item: unknown = undefined;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor) {
          if (!("value" in descriptor)) unsafeSerialization();
          item = descriptor.value;
        }
      } catch (error) {
        if (isSafeError(error)) throw error;
        unsafeSerialization();
      }
      const normalized = normalizeValue(item, context, depth + 1);
      // JSON.stringify represents undefined array entries and holes as null.
      output.push(normalized === OMIT ? null : normalized);
      if (normalized === OMIT) charge(context, primitiveBytes(null));
    }
    charge(context, 1); // ]
    return output;
  } finally {
    leaveObject(context, value);
  }
}

function normalizeObject(value: object, context: SerializationContext, depth: number): Record<string, unknown> {
  if (!isPlainRecord(value)) unsafeSerialization();
  enterObject(context, value);
  try {
    const keys = ownEnumerableKeys(value);
    if (keys.length > context.limits.maxObjectKeys) unsafeSerialization();
    keys.sort();
    charge(context, 1); // {
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let emitted = 0;
    for (const key of keys) {
      assertString(key, context.limits);
      if (PROTOTYPE_KEYS.has(key)) unsafeSerialization();
      const valueAtKey = dataProperty(value, key);
      const normalized = normalizeValue(valueAtKey, context, depth + 1);
      if (normalized === OMIT) continue;
      if (emitted > 0) charge(context, 1); // comma
      charge(context, quotedBytes(key) + 1); // key and colon
      output[key] = normalized;
      emitted += 1;
    }
    charge(context, 1); // }
    return output;
  } finally {
    leaveObject(context, value);
  }
}

function serializeCanonical(value: unknown, limits: SerializationLimits): string {
  const context = createContext(limits);
  try {
    const normalized = normalizeValue(value, context, 0);
    if (normalized === OMIT) unsafeSerialization();
    const serialized = JSON.stringify(normalized);
    if (typeof serialized !== "string") unsafeSerialization();
    if (Buffer.byteLength(serialized, "utf8") > limits.maxSerializedBytes) unsafeSerialization();
    return serialized;
  } catch (error) {
    if (isSafeError(error)) throw error;
    unsafeSerialization();
  }
}

function sanitizeValue(value: unknown, context: SerializationContext, depth: number, arrayItem = false): unknown {
  if (depth > context.limits.maxDepth) unsafePayload();
  addNode(context);
  if (value === undefined) return arrayItem ? null : OMIT;
  if (value === null) {
    charge(context, primitiveBytes(value));
    return null;
  }
  switch (typeof value) {
    case "string":
      try {
        assertString(value, context.limits);
      } catch (error) {
        if (isSafeError(error)) return failSafe("PAYLOAD_TOO_LARGE", "Payload cannot be safely persisted");
        unsafePayload();
      }
      charge(context, quotedBytes(value));
      return value;
    case "boolean":
      charge(context, primitiveBytes(value));
      return value;
    case "number":
      if (!Number.isFinite(value)) unsafePayload();
      charge(context, primitiveBytes(value));
      return value;
    case "object":
      if (isArrayValue(value, unsafePayload)) return sanitizeArray(value, context, depth);
      if (!isPlainRecord(value)) unsafePayload();
      return sanitizeObject(value as Record<string, unknown>, context, depth);
    default:
      unsafePayload();
  }
}

function sanitizeArray(value: object[], context: SerializationContext, depth: number): unknown[] {
  let length: number;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!descriptor || typeof descriptor.value !== "number") unsafePayload();
    length = descriptor.value;
  } catch (error) {
    if (isSafeError(error)) throw error;
    unsafePayload();
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > context.limits.maxArrayLength) unsafePayload();
  enterObject(context, value);
  charge(context, 1);
  try {
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (index > 0) charge(context, 1);
      let item: unknown = undefined;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor) {
          if (!("value" in descriptor)) unsafePayload();
          item = descriptor.value;
        }
      } catch (error) {
        if (isSafeError(error)) throw error;
        unsafePayload();
      }
      const normalized = sanitizeValue(item, context, depth + 1, true);
      output.push(normalized === OMIT ? null : normalized);
      if (normalized === OMIT) charge(context, primitiveBytes(null));
    }
    charge(context, 1);
    return output;
  } finally {
    leaveObject(context, value);
  }
}

function sanitizeObject(input: Record<string, unknown>, context: SerializationContext, depth: number): Record<string, unknown> {
  if (!isPlainRecord(input)) unsafePayload();
  enterObject(context, input);
  try {
    let keys: string[];
    try {
      keys = ownEnumerableKeys(input);
    } catch (error) {
      if (isSafeError(error)) return failSafe("UNSAFE_PAYLOAD", "Payload cannot be safely persisted");
      unsafePayload();
    }
    if (keys.length > context.limits.maxObjectKeys) unsafePayload();
    keys.sort();
    charge(context, 1);
    const output: Record<string, unknown> = {};
    let emitted = 0;
    for (const key of keys) {
      // Unknown fields are dropped without reading their values.  This is
      // important for minimization: a prompt/token hidden under an unknown
      // key must never be evaluated, serialized, or echoed in an error.
      if (!EVENT_KEYS.has(key) || PROTOTYPE_KEYS.has(key)) continue;
      let value: unknown;
      try {
        value = dataProperty(input, key);
      } catch (error) {
        if (isSafeError(error)) return failSafe("UNSAFE_PAYLOAD", "Payload cannot be safely persisted");
        unsafePayload();
      }
      const normalized = key === "usage" && value !== null && value !== undefined
        ? sanitizeUsage(value, context, depth + 1)
        : key === "usageSegments" && value !== null && value !== undefined
          ? sanitizeUsageSegments(value, context, depth + 1)
        : key === "cost" && value !== null && value !== undefined
          ? sanitizeCost(value, context, depth + 1)
        : sanitizeValue(value, context, depth + 1);
      if (normalized === OMIT) continue;
      if (emitted > 0) charge(context, 1);
      charge(context, quotedBytes(key) + 1);
      output[key] = normalized;
      emitted += 1;
    }
    charge(context, 1);
    return output;
  } finally {
    leaveObject(context, input);
  }
}

export function parseJson<T>(value: string, fallback: T): T {
  if (Buffer.byteLength(value, "utf8") > DEFAULT_SERIALIZATION_LIMITS.maxSerializedBytes) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    // Validate persisted JSON against the same bounded canonical serializer.
    // SQLite rows are trusted only after this check; malformed or oversized
    // rows fail closed to the caller-provided safe fallback.
    stableJson(parsed);
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function bool(value: number | boolean): boolean {
  return value === true || value === 1;
}
