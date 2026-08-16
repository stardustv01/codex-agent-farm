import { createHash } from 'node:crypto';
import {
  ALLOWED_OUTBOUND_METHODS,
  type AdapterGateResult,
  type ConnectionFingerprint,
  type StableMethodSchema,
  type StableSchemaBundle,
  type TestedAdapter,
} from './types.js';

/** Phase A evidence values; the generated adapter schema hash is still gated separately. */
export const PHASE_A_BINARY_SHA256 = '1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590';
export const PHASE_A_SCHEMA_HASHES = Object.freeze({
  stable: 'b6ec47c51bef8a6857dd9435f9919a43ba6616a5a9e3ab25087451cbc93d9f06',
  stableV2: '593425b1eb89403245ca6ba34df03160166d016a1ca39685984883e8d8185c3f',
  clientRequest: 'cc9f6e191a032bdfdc96d768f4ddaba4ced75408017af3ac0dbcc4d00c1faaa8',
  serverNotification: '7f9f9ac791c067e3e9840a9a6543a3a0d3de86e64b2d764ede4c2f3b01bcba64',
});
export const PHASE_A_USER_AGENT_PREFIX = 'Codex Desktop/0.145.0';

/** Required stable fields for the Phase A app-server protocol surface. */
export const REQUIRED_STABLE_METHOD_SCHEMAS: readonly StableMethodSchema[] = [
  { method: 'initialize', requestFields: ['clientInfo'], responseFields: ['userAgent'] },
  { method: 'initialized', requestFields: [], responseFields: [] },
  {
    method: 'thread/list',
    requestFields: ['archived', 'cursor', 'limit', 'sourceKinds', 'useStateDbOnly'],
    responseFields: ['data', 'nextCursor'],
  },
  { method: 'thread/read', requestFields: ['includeTurns', 'threadId'], responseFields: ['thread'] },
  { method: 'model/list', requestFields: ['cursor', 'limit'], responseFields: ['data', 'nextCursor'] },
] as const;

/**
 * A deterministic JSON representation used only for schema fingerprints and
 * sanitized event hashes.  It sorts object keys and never accepts functions,
 * symbols, bigint, or cyclic values.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const encode = (entry: unknown): string => {
    if (entry === null) return 'null';
    if (typeof entry === 'string') return JSON.stringify(entry);
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new TypeError('non-finite number');
      return JSON.stringify(entry);
    }
    if (typeof entry === 'boolean') return entry ? 'true' : 'false';
    if (Array.isArray(entry)) return `[${entry.map((item) => encode(item)).join(',')}]`;
    if (typeof entry === 'object') {
      if (seen.has(entry)) throw new TypeError('cyclic value');
      seen.add(entry);
      const result = `{${Object.entries(entry)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`)
        .join(',')}}`;
      seen.delete(entry);
      return result;
    }
    throw new TypeError('unsupported value');
  };
  return encode(value);
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateStableSchemaBundle(
  methods: readonly StableMethodSchema[] = REQUIRED_STABLE_METHOD_SCHEMAS,
  version = 'codex-app-server-stable-v1',
): StableSchemaBundle {
  const sortedMethods = methods
    .map((method) => ({
      method: method.method,
      requestFields: [...method.requestFields].sort(),
      responseFields: [...method.responseFields].sort(),
    }))
    .sort((left, right) => left.method.localeCompare(right.method));
  const unsigned = { version, methods: sortedMethods };
  return { ...unsigned, sha256: sha256Text(stableStringify(unsigned)) };
}

const REQUIRED_METHOD_SET = new Set(ALLOWED_OUTBOUND_METHODS);
const MAX_SCHEMA_HASH_ENTRIES = 32;
const MAX_SCHEMA_HASH_KEY_LENGTH = 128;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SCHEMA_HASH_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  const set = new Set(actual);
  return expected.every((member) => set.has(member));
}

/**
 * Schema-file evidence is metadata only, but it still arrives at the bridge
 * boundary as a caller-provided record. Keep it finite and strictly typed so
 * equality cannot be turned into an unbounded traversal or prototype trick.
 */
function isBoundedSchemaHashMap(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const entries = Object.entries(value);
    if (entries.length === 0 || entries.length > MAX_SCHEMA_HASH_ENTRIES) return false;
    return entries.every(([key, hash]) =>
      key.length <= MAX_SCHEMA_HASH_KEY_LENGTH && SCHEMA_HASH_KEY.test(key) &&
      typeof hash === 'string' && SHA256_HEX.test(hash),
    );
  } catch {
    return false;
  }
}

function schemaHashEvidence(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>> | undefined,
): 'match' | 'missing' | 'mismatch' {
  if (actual === undefined) return 'missing';
  if (!isBoundedSchemaHashMap(expected) || !isBoundedSchemaHashMap(actual)) return 'mismatch';
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  if (expectedEntries.length !== actualEntries.length) return 'mismatch';
  return expectedEntries.every(([key, hash], index) => {
    const actualEntry = actualEntries[index];
    return actualEntry !== undefined && actualEntry[0] === key && actualEntry[1] === hash;
  }) ? 'match' : 'mismatch';
}

export interface SchemaValidation {
  readonly valid: boolean;
  readonly missingMethods: readonly string[];
  readonly missingFields: readonly string[];
}

export function validateStableSchema(schema: StableSchemaBundle): SchemaValidation {
  const byMethod = new Map(schema.methods.map((method) => [method.method, method]));
  const missingMethods = [...REQUIRED_METHOD_SET].filter((method) => !byMethod.has(method));
  const missingFields: string[] = [];
  for (const required of REQUIRED_STABLE_METHOD_SCHEMAS) {
    const actual = byMethod.get(required.method);
    if (!actual) continue;
    if (!sameMembers(actual.requestFields, required.requestFields)) {
      for (const field of required.requestFields) {
        if (!actual.requestFields.includes(field)) missingFields.push(`${required.method}:request:${field}`);
      }
    }
    if (!sameMembers(actual.responseFields, required.responseFields)) {
      for (const field of required.responseFields) {
        if (!actual.responseFields.includes(field)) missingFields.push(`${required.method}:response:${field}`);
      }
    }
  }
  return { valid: missingMethods.length === 0 && missingFields.length === 0, missingMethods, missingFields };
}

export interface AdapterGateInput {
  readonly fingerprint: ConnectionFingerprint;
  readonly schema: StableSchemaBundle;
  readonly testedAdapters: readonly TestedAdapter[];
}

/**
 * Select an explicitly tested adapter or quarantine the connection.  The
 * function returns only sanitized fingerprint metadata and safe reason codes;
 * it does not retain the supplied schema or binary bytes.
 */
export function evaluateAdapterGate(input: AdapterGateInput): AdapterGateResult {
  const { fingerprint, schema, testedAdapters } = input;
  if (!fingerprint.reportedUserAgent) {
    return { status: 'quarantined', reason: 'missing-user-agent', fingerprint };
  }
  const schemaValidation = validateStableSchema(schema);
  if (!schemaValidation.valid) {
    return {
      status: 'quarantined',
      reason: 'schema-invalid',
      schemaVersion: schema.version,
      missingMethods: schemaValidation.missingMethods,
      missingFields: schemaValidation.missingFields,
      fingerprint,
    };
  }
  const generated = generateStableSchemaBundle(schema.methods, schema.version);
  if (generated.sha256 !== schema.sha256 || generated.sha256 !== fingerprint.schemaBundleSha256) {
    return {
      status: 'quarantined',
      reason: 'schema-fingerprint-mismatch',
      schemaVersion: schema.version,
      fingerprint,
    };
  }
  let hasSchemaHashesMissing = false;
  let hasSchemaHashesMismatch = false;
  const adapter = testedAdapters.find((candidate) => {
    const binaryMatches = candidate.binarySha256 === undefined || candidate.binarySha256 === fingerprint.binarySha256;
    const userAgentMatches = fingerprint.reportedUserAgent.startsWith(candidate.userAgentPrefix);
    const baseMatches = binaryMatches && userAgentMatches && candidate.schemaBundleSha256 === fingerprint.schemaBundleSha256;
    if (!baseMatches) return false;
    if (candidate.schemaHashes === undefined) return true;
    const evidence = schemaHashEvidence(candidate.schemaHashes, fingerprint.schemaHashes);
    if (evidence === 'missing') hasSchemaHashesMissing = true;
    if (evidence === 'mismatch') hasSchemaHashesMismatch = true;
    return evidence === 'match';
  });
  if (!adapter) {
    const hasBinaryMismatch = testedAdapters.some(
      (candidate) => candidate.schemaBundleSha256 === fingerprint.schemaBundleSha256 && candidate.binarySha256 !== undefined,
    );
    const hasUserAgentMismatch = testedAdapters.some(
      (candidate) => candidate.schemaBundleSha256 === fingerprint.schemaBundleSha256,
    );
    return {
      status: 'quarantined',
      reason: hasSchemaHashesMissing
        ? 'schema-hashes-missing'
        : hasSchemaHashesMismatch
          ? 'schema-hashes-mismatch'
          : hasBinaryMismatch
            ? 'binary-fingerprint-mismatch'
            : hasUserAgentMismatch
              ? 'user-agent-mismatch'
              : 'unsupported-fingerprint',
      schemaVersion: schema.version,
      fingerprint,
    };
  }
  return {
    status: 'accepted',
    adapterVersion: adapter.adapterVersion,
    schemaVersion: schema.version,
    fingerprint,
  };
}
