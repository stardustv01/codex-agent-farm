import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The only model/effort pair retained from an ordered turn context. */
export interface RolloutObservedHistory {
  readonly model?: string;
  readonly effort?: string;
}

/** A sanitized spawn request; the original function-call arguments are never returned. */
export interface RolloutRequestedSpawn {
  readonly taskName?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

/** Cumulative usage reported by Codex's token_count telemetry. */
export interface RolloutTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  /** Latest event timestamp that contributed this cumulative value. */
  readonly observedAt?: string;
}

/**
 * One per-invocation usage observation.  The cumulative `usage` value above
 * is useful for a monotonic health watermark, but it cannot safely be priced
 * across reroutes or long-context calls.  A segment is complete only when a
 * `last_token_usage` record was correlated to the exact allowed turn and the
 * cumulative delta matched it byte-for-byte.
 */
export interface RolloutUsageSegment {
  readonly turnId: string;
  readonly usage: RolloutTokenUsage;
  readonly model: string;
  readonly effort: string;
  readonly provider: string;
}

/** Minimal identity evidence extracted from one trusted rollout file. */
export interface RolloutIdentityEvidence {
  readonly sourceThreadId: string;
  /** Latest explicit lifecycle event in this exact trusted rollout segment. */
  readonly lifecycle?: TrustedLocalTopologyNode['status'];
  readonly modelProvider?: string;
  readonly observedHistory: readonly RolloutObservedHistory[];
  readonly requestedSpawns: readonly RolloutRequestedSpawn[];
  /** Latest monotonic cumulative usage, if the rollout recorded it unambiguously. */
  readonly usage?: RolloutTokenUsage;
  /** Bounded per-invocation usage, when token telemetry supplies it. */
  readonly usageSegments?: readonly RolloutUsageSegment[];
  /** False means at least one usage invocation could not be attributed. */
  readonly usageSegmentsComplete?: boolean;
  /** Present only when token telemetry was observed but could not be trusted. */
  readonly usageAmbiguous?: boolean;
}

export interface RolloutIdentityReaderOptions {
  /** Absolute directory under which rollout files may be read. */
  readonly sessionsRoot: string;
  readonly maxFileBytes?: number;
  readonly maxLineBytes?: number;
  readonly maxLines?: number;
  readonly maxRecords?: number;
  readonly maxObservedHistory?: number;
  readonly maxRequestedSpawns?: number;
  readonly maxArgumentBytes?: number;
  readonly maxUsageSegments?: number;
  /** Maximum filesystem entries examined while resolving one thread file. */
  readonly maxDirectoryEntries?: number;
  /** Maximum directory depth below sessionsRoot. */
  readonly maxDirectoryDepth?: number;
  /** Maximum sanitized nodes admitted by one topology scan. */
  readonly maxTopologyNodes?: number;
  readonly maxTopologyFiles?: number;
  /** Aggregate bytes actually read across topology headers and admitted details. */
  readonly maxTopologyBytes?: number;
  readonly maxTopologyRecords?: number;
}

export interface TrustedLocalRolloutResolver {
  readIdentity(threadId: string): Promise<RolloutIdentityEvidence | undefined>;
  readDetail(threadId: string): Promise<LocalRolloutDetail | undefined>;
  /** Additive structural fallback for descendants omitted by app-server list/read. */
  discoverTopology(rootThreadId: string): Promise<readonly TrustedLocalTopologyNode[] | undefined>;
}

export interface TrustedLocalTopologyNode {
  readonly sourceThreadId: string;
  readonly parentThreadId?: string;
  readonly agentPath?: string;
  readonly agentTaskName?: string;
  readonly status: 'idle' | 'active' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  readonly modelProvider?: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface RolloutLocalMessage { readonly role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown'; readonly text: string; readonly occurredAt?: string }
export interface RolloutLocalActivity { readonly kind: 'collaboration' | 'subagent_activity' | 'thread_settings' | 'model_rerouted' | 'lifecycle' | 'error' | 'unknown'; readonly status?: string; readonly startedAt?: string }
export interface RolloutLocalChangedFile { readonly path: string; readonly additions?: number; readonly deletions?: number }
export interface RolloutLocalToolActivity { readonly name: string; readonly status?: string; readonly arguments?: string; readonly result?: string; readonly startedAt?: string; readonly completedAt?: string; readonly durationMs?: number }
export interface LocalRolloutDetail {
  readonly schemaVersion: 'agent-farm.local-rollout-detail.v2';
  readonly sourceThreadId: string;
  readonly messages: readonly RolloutLocalMessage[];
  readonly activity: readonly RolloutLocalActivity[];
  readonly tools: readonly RolloutLocalToolActivity[];
  readonly changedFiles: readonly RolloutLocalChangedFile[];
  readonly finalSummary?: string;
}

const SENSITIVE_KEY = /(?:^|[_-])(credential|credentials|token|tokens|password|passwd|cookie|authorization|private[_-]?key)(?:$|[_-])/iu;
const SENSITIVE_VALUE = /(?:bearer\s+[A-Za-z0-9._~+/=-]{6,}|(?:access|refresh|id|auth|api)[_-]?token\s*[:=]\s*\S+|(?:password|passwd|cookie|authorization|credential|private[_-]?key)\s*[:=]\s*\S+)/iu;
const MAX_DETAIL_TEXT = 16_000;

function safeDetailText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DETAIL_TEXT || CONTROL.test(value) || SENSITIVE_VALUE.test(value)) return undefined;
  return value;
}

function safeStructuredDetailText(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  const parts: string[] = [];
  let total = 0;
  for (const item of value) {
    if (!isRecord(item) || sensitiveRecord(item)) continue;
    if (item.type !== 'input_text' && item.type !== 'output_text' && item.type !== 'text') continue;
    const part = safeDetailText(item.text);
    if (part === undefined || total + part.length + (parts.length > 0 ? 1 : 0) > MAX_DETAIL_TEXT) continue;
    parts.push(part);
    total += part.length + (parts.length > 1 ? 1 : 0);
  }
  return parts.length === 0 ? undefined : parts.join(' ');
}

function resolvedTurnLabel(
  payload: Record<string, unknown>,
  directKey: 'model' | 'effort' | 'model_provider',
  settingsKey: 'model' | 'reasoning_effort' | 'model_provider',
): { value?: string; malformed: boolean } {
  const direct = optionalSafeLabel(payload, directKey, safeWord);
  const settings = objectValue(objectValue(payload, 'collaboration_mode') ?? {}, 'settings');
  const nested = settings === undefined ? { malformed: false } : optionalSafeLabel(settings, settingsKey, safeWord);
  if (direct.malformed || nested.malformed || (direct.value !== undefined && nested.value !== undefined && direct.value !== nested.value)) return { malformed: true };
  const value = direct.value ?? nested.value;
  return value === undefined ? { malformed: false } : { value, malformed: false };
}

function sensitiveRecord(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => SENSITIVE_KEY.test(key) || /(?:credential|token|password|passwd|cookie|authorization|privateKey)/iu.test(key));
}

const CODEX_CONTROL_TOOL = /^(?:spawn_agent|send_message|followup_task|wait_agent|interrupt_agent|list_agents|request_user_input|update_goal|create_goal)$/u;

function sanitizedToolValue(value: unknown): string | undefined {
  const sanitize = (input: unknown, depth: number): unknown => {
    if (depth > 8) return undefined;
    if (typeof input === 'string') return safeDetailText(input);
    if (typeof input === 'number' || typeof input === 'boolean' || input === null) return input;
    if (Array.isArray(input)) return input.slice(0, 128).map((item) => sanitize(item, depth + 1)).filter((item) => item !== undefined);
    if (!isRecord(input)) return undefined;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input).slice(0, 128)) {
      if (SENSITIVE_KEY.test(key)) continue;
      const safe = sanitize(item, depth + 1);
      if (safe !== undefined) result[key] = safe;
    }
    return result;
  };
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > DEFAULT_MAX_ARGUMENT_BYTES) return undefined;
    try { parsed = JSON.parse(value); } catch { return safeDetailText(value); }
  }
  const safe = sanitize(parsed, 0);
  if (safe === undefined) return undefined;
  const text = typeof safe === 'string' ? safe : JSON.stringify(safe);
  return text.length <= MAX_DETAIL_TEXT && !SENSITIVE_VALUE.test(text) ? text : undefined;
}

function parseChangedFiles(value: unknown): LocalRolloutDetail['changedFiles'] {
  if (!Array.isArray(value) || value.length > 1_024) return [];
  const result: Array<{ path: string; additions?: number; deletions?: number }> = [];
  for (const item of value) {
    if (!isRecord(item) || sensitiveRecord(item)) continue;
    const path = safeDetailText(item.path);
    const additions = safeNonNegativeInteger(item.additions);
    const deletions = safeNonNegativeInteger(item.deletions);
    if (path === undefined || !isAbsolute(path)) continue;
    result.push({ path, ...(additions === undefined ? {} : { additions }), ...(deletions === undefined ? {} : { deletions }) });
  }
  return result;
}

// Long-running recursive chats can grow a single rollout well past the former
// 64/128 MiB budgets. Identity is read line-by-line (never whole-file
// materialized) so a valid long chat does not lose model/effort or lifecycle
// evidence, while the per-line and per-file byte caps still prevent an
// operator from turning this local reader into an unbounded file-to-memory
// path. Reads stay sequential (one rollout at a time) and are bounded by the
// existing line, record, history, spawn, and argument limits under the
// 200-node farm ceiling. Both caps are per-file, not a fleet-wide budget.
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_LINES = 20_000;
const DEFAULT_MAX_RECORDS = 20_000;
const DEFAULT_MAX_OBSERVED_HISTORY = 2_048;
const DEFAULT_MAX_REQUESTED_SPAWNS = 2_048;
const DEFAULT_MAX_ARGUMENT_BYTES = 32 * 1024;
// Must not exceed the strict contracts/reconciler LocalUsageSegments bound.
const DEFAULT_MAX_USAGE_SEGMENTS = 1_024;
const ABSOLUTE_MAX_USAGE_SEGMENTS = 1_024;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 50_000;
const DEFAULT_MAX_DIRECTORY_DEPTH = 8;
const DEFAULT_MAX_TOPOLOGY_NODES = 200;
const DEFAULT_MAX_TOPOLOGY_FILES = 5_000;
const DEFAULT_MAX_TOPOLOGY_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_TOPOLOGY_RECORDS = 100_000;
const TOPOLOGY_HEADER_BYTES = 64 * 1024;
const TOPOLOGY_DETAIL_FILE_BYTES = 8 * 1024 * 1024;
const ABSOLUTE_MAX_FILE_BYTES = 512 * 1024 * 1024;
const ABSOLUTE_MAX_LINE_BYTES = 16 * 1024 * 1024;
const ABSOLUTE_MAX_LINES = 100_000;
const ABSOLUTE_MAX_RECORDS = 100_000;
const ABSOLUTE_MAX_ARRAY_ITEMS = 10_000;
const ABSOLUTE_MAX_ARGUMENT_BYTES = 256 * 1024;
const ABSOLUTE_MAX_DIRECTORY_ENTRIES = 250_000;
const ABSOLUTE_MAX_DIRECTORY_DEPTH = 16;
const ABSOLUTE_MAX_TOPOLOGY_NODES = 1_000;
const ABSOLUTE_MAX_TOPOLOGY_FILES = 20_000;
const ABSOLUTE_MAX_TOPOLOGY_BYTES = 512 * 1024 * 1024;
const ABSOLUTE_MAX_TOPOLOGY_RECORDS = 500_000;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const SAFE_WORD = /^[A-Za-z0-9._:@+/-]{1,128}$/u;
const SAFE_TASK_LABEL = /^[a-z0-9][a-z0-9_]{0,127}$/u;
const SAFE_AGENT_PATH = /^\/root(?:\/[A-Za-z0-9._:@+-]{1,128}){0,63}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MIN_UNIX_SECONDS = 946_684_800;
const MAX_UNIX_SECONDS = 4_102_444_800;

interface ReaderLimits {
  readonly maxFileBytes: number;
  readonly maxLineBytes: number;
  readonly maxLines: number;
  readonly maxRecords: number;
  readonly maxObservedHistory: number;
  readonly maxRequestedSpawns: number;
  readonly maxArgumentBytes: number;
  readonly maxUsageSegments: number;
  readonly maxDirectoryEntries: number;
  readonly maxDirectoryDepth: number;
  readonly maxTopologyNodes: number;
  readonly maxTopologyFiles: number;
  readonly maxTopologyBytes: number;
  readonly maxTopologyRecords: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : undefined;
}

function limits(options: RolloutIdentityReaderOptions): ReaderLimits | undefined {
  if (!isAbsolute(options.sessionsRoot) || options.sessionsRoot.length === 0 || options.sessionsRoot.length > 4_096 || CONTROL.test(options.sessionsRoot)) {
    return undefined;
  }
  const maxFileBytes = boundedInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, ABSOLUTE_MAX_FILE_BYTES);
  const maxLineBytes = boundedInteger(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, ABSOLUTE_MAX_LINE_BYTES);
  const maxLines = boundedInteger(options.maxLines, DEFAULT_MAX_LINES, ABSOLUTE_MAX_LINES);
  const maxRecords = boundedInteger(options.maxRecords, DEFAULT_MAX_RECORDS, ABSOLUTE_MAX_RECORDS);
  const maxObservedHistory = boundedInteger(options.maxObservedHistory, DEFAULT_MAX_OBSERVED_HISTORY, ABSOLUTE_MAX_ARRAY_ITEMS);
  const maxRequestedSpawns = boundedInteger(options.maxRequestedSpawns, DEFAULT_MAX_REQUESTED_SPAWNS, ABSOLUTE_MAX_ARRAY_ITEMS);
  const maxArgumentBytes = boundedInteger(options.maxArgumentBytes, DEFAULT_MAX_ARGUMENT_BYTES, ABSOLUTE_MAX_ARGUMENT_BYTES);
  const maxUsageSegments = boundedInteger(options.maxUsageSegments, DEFAULT_MAX_USAGE_SEGMENTS, ABSOLUTE_MAX_USAGE_SEGMENTS);
  const maxDirectoryEntries = boundedInteger(options.maxDirectoryEntries, DEFAULT_MAX_DIRECTORY_ENTRIES, ABSOLUTE_MAX_DIRECTORY_ENTRIES);
  const maxDirectoryDepth = boundedInteger(options.maxDirectoryDepth, DEFAULT_MAX_DIRECTORY_DEPTH, ABSOLUTE_MAX_DIRECTORY_DEPTH);
  const maxTopologyNodes = boundedInteger(options.maxTopologyNodes, DEFAULT_MAX_TOPOLOGY_NODES, ABSOLUTE_MAX_TOPOLOGY_NODES);
  const maxTopologyFiles = boundedInteger(options.maxTopologyFiles, DEFAULT_MAX_TOPOLOGY_FILES, ABSOLUTE_MAX_TOPOLOGY_FILES);
  const maxTopologyBytes = boundedInteger(options.maxTopologyBytes, DEFAULT_MAX_TOPOLOGY_BYTES, ABSOLUTE_MAX_TOPOLOGY_BYTES);
  const maxTopologyRecords = boundedInteger(options.maxTopologyRecords, DEFAULT_MAX_TOPOLOGY_RECORDS, ABSOLUTE_MAX_TOPOLOGY_RECORDS);
  if (maxFileBytes === undefined || maxLineBytes === undefined || maxLines === undefined || maxRecords === undefined || maxObservedHistory === undefined || maxRequestedSpawns === undefined || maxArgumentBytes === undefined || maxUsageSegments === undefined || maxDirectoryEntries === undefined || maxDirectoryDepth === undefined || maxTopologyNodes === undefined || maxTopologyFiles === undefined || maxTopologyBytes === undefined || maxTopologyRecords === undefined) {
    return undefined;
  }
  return { maxFileBytes, maxLineBytes, maxLines, maxRecords, maxObservedHistory, maxRequestedSpawns, maxArgumentBytes, maxUsageSegments, maxDirectoryEntries, maxDirectoryDepth, maxTopologyNodes, maxTopologyFiles, maxTopologyBytes, maxTopologyRecords };
}

function safeTopologyStatus(value: unknown): TrustedLocalTopologyNode['status'] {
  if (value === 'idle') return 'idle';
  if (value === 'active' || value === 'started' || value === 'in_progress' || value === 'task_started' || value === 'turn.started') return 'active';
  if (value === 'completed' || value === 'task_complete' || value === 'task_completed' || value === 'turn.completed') return 'completed';
  if (value === 'failed' || value === 'task_failed' || value === 'turn.failed') return 'failed';
  if (value === 'interrupted' || value === 'aborted' || value === 'task_interrupted' || value === 'task_aborted' ||
      value === 'turn.interrupted' || value === 'turn.aborted' || value === 'turn_aborted') return 'interrupted';
  return 'unknown';
}

/**
 * Read lifecycle only from an event's explicit task/turn event type.
 *
 * Many non-lifecycle events (for example `patch_apply_end`) carry their own
 * operation-level `status: "completed"`. Treating that generic status as the
 * thread lifecycle makes a still-running root oscillate between active and
 * completed after every tool call.
 */
function eventLifecycle(payload: Record<string, unknown>): TrustedLocalTopologyNode['status'] {
  return safeTopologyStatus(safeWord(payload.type));
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

function safeWord(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_WORD.test(value) ? value : undefined;
}

function safeTaskLabel(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TASK_LABEL.test(value) ? value : undefined;
}

function safeUnixSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_UNIX_SECONDS && value <= MAX_UNIX_SECONDS ? value : undefined;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 80 || CONTROL.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseTokenUsage(value: unknown, observedAt: string | undefined): RolloutTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = safeNonNegativeInteger(value.input_tokens);
  const cachedInputTokens = safeNonNegativeInteger(value.cached_input_tokens);
  const cacheWriteInputTokens = safeNonNegativeInteger(value.cache_write_input_tokens);
  const outputTokens = safeNonNegativeInteger(value.output_tokens);
  const reasoningOutputTokens = safeNonNegativeInteger(value.reasoning_output_tokens);
  const totalTokens = safeNonNegativeInteger(value.total_tokens);
  if ([inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens, totalTokens].some((item) => item === undefined)) return undefined;
  const input = inputTokens as number;
  const cached = cachedInputTokens as number;
  const cacheWrite = cacheWriteInputTokens as number;
  const output = outputTokens as number;
  const total = totalTokens as number;
  if (cached > input || cacheWrite > input || cached + cacheWrite > input || total < input || total < output || total !== input + output) return undefined;
  return {
    inputTokens: inputTokens as number,
    cachedInputTokens: cachedInputTokens as number,
    cacheWriteInputTokens: cacheWriteInputTokens as number,
    outputTokens: outputTokens as number,
    reasoningOutputTokens: reasoningOutputTokens as number,
    totalTokens: totalTokens as number,
    ...(observedAt === undefined ? {} : { observedAt }),
  };
}

function monotonicTokenUsage(previous: RolloutTokenUsage | undefined, next: RolloutTokenUsage): boolean {
  if (!previous) return true;
  return next.inputTokens >= previous.inputTokens &&
    next.cachedInputTokens >= previous.cachedInputTokens &&
    next.cacheWriteInputTokens >= previous.cacheWriteInputTokens &&
    next.outputTokens >= previous.outputTokens &&
    next.reasoningOutputTokens >= previous.reasoningOutputTokens &&
    next.totalTokens >= previous.totalTokens;
}

function sameTokenUsage(left: RolloutTokenUsage, right: RolloutTokenUsage): boolean {
  return left.inputTokens === right.inputTokens && left.cachedInputTokens === right.cachedInputTokens &&
    left.cacheWriteInputTokens === right.cacheWriteInputTokens && left.outputTokens === right.outputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens && left.totalTokens === right.totalTokens;
}

function usageDelta(previous: RolloutTokenUsage | undefined, next: RolloutTokenUsage): RolloutTokenUsage | undefined {
  if (previous === undefined) return next;
  if (!monotonicTokenUsage(previous, next)) return undefined;
  return {
    inputTokens: next.inputTokens - previous.inputTokens,
    cachedInputTokens: next.cachedInputTokens - previous.cachedInputTokens,
    cacheWriteInputTokens: next.cacheWriteInputTokens - previous.cacheWriteInputTokens,
    outputTokens: next.outputTokens - previous.outputTokens,
    reasoningOutputTokens: next.reasoningOutputTokens - previous.reasoningOutputTokens,
    totalTokens: next.totalTokens - previous.totalTokens,
    ...(next.observedAt === undefined ? {} : { observedAt: next.observedAt }),
  };
}

function optionalSafeLabel(record: Record<string, unknown>, key: string, validator: (value: unknown) => string | undefined): { value?: string; malformed: boolean } {
  if (!own(record, key) || record[key] === null || record[key] === undefined) return { malformed: false };
  const value = validator(record[key]);
  return value === undefined ? { malformed: true } : { value, malformed: false };
}

function objectValue(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function safePathValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && isAbsolute(value) && !CONTROL.test(value) ? value : undefined;
}

function inside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath.length > 0 && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

/** Reject symlink path components before opening the already-realpath'd file. */
async function hasOnlyRealPathComponents(root: string, candidate: string): Promise<boolean> {
  const normalizedCandidate = resolve(candidate);
  if (!inside(root, normalizedCandidate)) return false;
  const relativePath = relative(root, normalizedCandidate);
  let current = root;
  for (const component of relativePath.split(sep)) {
    if (!component || component === '.' || component === '..') return false;
    current = join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

async function readBoundedUtf8(filename: string, maxBytes: number): Promise<string | undefined> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(filename, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) return undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) return undefined;
      if (bytesRead < chunk.length) break;
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return decoder.decode(Buffer.concat(chunks, total));
  } finally {
    await handle.close();
  }
}

/**
 * Stream a trusted rollout file into newline-delimited lines without ever
 * materializing the whole file. A line larger than `maxLineBytes` is
 * discarded (oversized `compacted`/tool-output records are not identity or
 * detail evidence); total bytes read remain bounded by `maxBytes`, and the
 * number of retained lines is bounded by `maxLines`.
 */
async function readBoundedLines(
  filename: string,
  maxBytes: number,
  maxLines: number,
  maxLineBytes: number,
): Promise<string[] | undefined> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(filename, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) return undefined;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const lines: string[] = [];
    let buffer = '';
    let position = 0;
    let totalBytes = 0;
    while (totalBytes < stat.size) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) return undefined;
      buffer += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.length === 0 || line.length > maxLineBytes) continue;
        lines.push(line);
        if (lines.length > maxLines) return undefined;
      }
      // Bound an unterminated pathological line without retaining its prefix.
      if (buffer.length > maxLineBytes) buffer = '';
    }
    if (buffer.length > 0) {
      let line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      if (line.length > 0 && line.length <= maxLineBytes) {
        lines.push(line);
        if (lines.length > maxLines) return undefined;
      }
    }
    return lines;
  } finally {
    await handle.close();
  }
}

async function resolveTrustedRolloutPath(rawPath: unknown, options: RolloutIdentityReaderOptions): Promise<string | undefined> {
  const pathValue = safePathValue(rawPath);
  if (pathValue === undefined) return undefined;
  try {
    const configuredRoot = resolve(options.sessionsRoot);
    const root = await realpath(configuredRoot);
    const rootStat = await lstat(configuredRoot);
    if (!rootStat.isDirectory()) return undefined;
    const candidate = resolve(pathValue);
    if (!inside(configuredRoot, candidate) || !(await hasOnlyRealPathComponents(configuredRoot, candidate))) return undefined;
    const resolved = await realpath(candidate);
    if (!inside(root, resolved)) return undefined;
    const candidateStat = await lstat(candidate);
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

async function trustedRolloutFile(rawPath: unknown, options: RolloutIdentityReaderOptions, maxBytes: number): Promise<string | undefined> {
  const resolved = await resolveTrustedRolloutPath(rawPath, options);
  return resolved === undefined ? undefined : readBoundedUtf8(resolved, maxBytes);
}

async function trustedRolloutLines(
  rawPath: unknown,
  options: RolloutIdentityReaderOptions,
  readerLimits: ReaderLimits,
): Promise<string[] | undefined> {
  const resolved = await resolveTrustedRolloutPath(rawPath, options);
  return resolved === undefined
    ? undefined
    : readBoundedLines(resolved, readerLimits.maxFileBytes, readerLimits.maxLines, readerLimits.maxLineBytes);
}

async function trustedRolloutPrefix(rawPath: unknown, options: RolloutIdentityReaderOptions, maxBytes: number): Promise<{ text: string; bytesRead: number } | undefined> {
  const pathValue = safePathValue(rawPath);
  if (pathValue === undefined) return undefined;
  try {
    const configuredRoot = resolve(options.sessionsRoot);
    const root = await realpath(configuredRoot);
    const candidate = resolve(pathValue);
    if (!inside(configuredRoot, candidate) || !(await hasOnlyRealPathComponents(configuredRoot, candidate))) return undefined;
    const resolved = await realpath(candidate);
    if (!inside(root, resolved)) return undefined;
    const candidateStat = await lstat(candidate);
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) return undefined;
    const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, candidateStat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const completeLength = candidateStat.size <= bytesRead ? bytesRead : buffer.lastIndexOf(0x0a, bytesRead - 1) + 1;
      if (completeLength === 0) return { text: '', bytesRead };
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, completeLength)), bytesRead };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

interface TopologyCandidate {
  readonly filename: string;
  readonly node: TrustedLocalTopologyNode;
}

function topologyScalarAlias(
  source: Record<string, unknown>,
  keys: readonly string[],
  validator: (value: unknown) => string | undefined,
): { value?: string; malformed: boolean } {
  let value: string | undefined;
  for (const key of keys) {
    if (!own(source, key) || source[key] === null || source[key] === undefined) continue;
    const parsed = validator(source[key]);
    if (parsed === undefined || (value !== undefined && value !== parsed)) return { malformed: true };
    value = parsed;
  }
  return value === undefined ? { malformed: false } : { value, malformed: false };
}

function topologyObjectAlias(source: Record<string, unknown>, keys: readonly string[]): { value?: Record<string, unknown>; malformed: boolean } {
  let value: Record<string, unknown> | undefined;
  for (const key of keys) {
    if (!own(source, key) || source[key] === null || source[key] === undefined) continue;
    const parsed = objectValue(source, key);
    // Multiple object spellings are ambiguous even if their serialization
    // happens to match; one canonical structural assertion is required.
    if (parsed === undefined || value !== undefined) return { malformed: true };
    value = parsed;
  }
  return value === undefined ? { malformed: false } : { value, malformed: false };
}

function topologyHeader(text: string, filename: string): TrustedLocalTopologyNode | undefined {
  let match: TrustedLocalTopologyNode | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (!isRecord(record) || record.type !== 'session_meta') continue;
    const payload = objectValue(record, 'payload');
    if (payload === undefined) continue;
    const id = safeId(payload.id);
    if (id === undefined || !basename(filename).endsWith(`-${id}.jsonl`)) continue;
    if (match !== undefined) return undefined;
    const directParent = topologyScalarAlias(payload, ['parent_thread_id', 'parentThreadId', 'forked_from_id', 'forkedFromId'], safeId);
    const source = objectValue(payload, 'source');
    const subagent = source === undefined ? { malformed: false } : topologyObjectAlias(source, ['subagent', 'subAgent']);
    const spawn = subagent.value === undefined ? { malformed: false } : topologyObjectAlias(subagent.value, ['thread_spawn', 'threadSpawn']);
    const spawnParent = spawn.value === undefined ? { malformed: false } : topologyScalarAlias(spawn.value, ['parent_thread_id', 'parentThreadId'], safeId);
    const path = spawn.value === undefined ? { malformed: false } : topologyScalarAlias(spawn.value, ['agent_path', 'agentPath'], (value) =>
      typeof value === 'string' && SAFE_AGENT_PATH.test(value) ? value : undefined);
    if (directParent.malformed || subagent.malformed || spawn.malformed || spawnParent.malformed || path.malformed) return undefined;
    // A generic fork or related chat is not a subagent. Supplemental topology
    // requires the exact trusted collaboration spawn structure, parent, and
    // task path; the already-attested root itself is supplied separately.
    if (spawn.value === undefined || spawnParent.value === undefined || path.value === undefined) return undefined;
    if (directParent.value !== undefined && directParent.value !== spawnParent.value) return undefined;
    const parentThreadId = spawnParent.value;
    const agentPath = path.value;
    const agentTaskName = agentPath?.split('/').at(-1);
    match = {
      sourceThreadId: id,
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
      ...(agentPath === undefined ? {} : { agentPath, ...(agentTaskName === undefined ? {} : { agentTaskName }) }),
      status: 'unknown',
    };
  }
  return match;
}

function topologyDetail(text: string, node: TrustedLocalTopologyNode, maxRecords: number): TrustedLocalTopologyNode {
  let matching = false;
  let records = 0;
  let result = node;
  let model: string | undefined;
  let effort: string | undefined;
  let provider: string | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    if (++records > maxRecords) return node;
    let record: unknown;
    try { record = JSON.parse(line); } catch { return node; }
    if (!isRecord(record)) continue;
    const payload = objectValue(record, 'payload');
    if (payload === undefined) continue;
    if (record.type === 'session_meta') {
      matching = safeId(payload.id) === node.sourceThreadId;
      if (matching) {
        const initialStatus = safeTopologyStatus(payload.status);
        if (initialStatus !== 'unknown') result = { ...result, status: initialStatus };
        provider = safeWord(payload.model_provider) ?? provider;
      }
      continue;
    }
    if (!matching) continue;
    if (record.type === 'turn_context') {
      const resolvedModel = resolvedTurnLabel(payload, 'model', 'model');
      const resolvedEffort = resolvedTurnLabel(payload, 'effort', 'reasoning_effort');
      const resolvedProvider = resolvedTurnLabel(payload, 'model_provider', 'model_provider');
      const settings = objectValue(objectValue(payload, 'collaboration_mode') ?? {}, 'settings');
      const providerAlias = settings === undefined ? { malformed: false } : optionalSafeLabel(settings, 'provider', safeWord);
      if (resolvedModel.malformed || resolvedEffort.malformed || resolvedProvider.malformed || providerAlias.malformed ||
          (resolvedProvider.value !== undefined && providerAlias.value !== undefined && resolvedProvider.value !== providerAlias.value)) return node;
      model = resolvedModel.value ?? model;
      effort = resolvedEffort.value ?? effort;
      provider = resolvedProvider.value ?? providerAlias.value ?? provider;
    } else if (record.type === 'event_msg') {
      const lifecycle = eventLifecycle(payload);
      if (lifecycle !== 'unknown') result = { ...result, status: lifecycle };
    }
  }
  return { ...result, ...(provider === undefined ? {} : { modelProvider: provider }), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
}

function appendBounded<T>(target: T[], value: T, maxItems: number): boolean {
  if (target.length >= maxItems) return false;
  target.push(value);
  return true;
}

function parseSpawnArguments(value: unknown, maxBytes: number): RolloutRequestedSpawn | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const task = optionalSafeLabel(parsed, 'task_name', safeTaskLabel);
  const model = optionalSafeLabel(parsed, 'model', safeWord);
  const effort = optionalSafeLabel(parsed, 'reasoning_effort', safeWord);
  if (task.malformed || model.malformed || effort.malformed) return undefined;
  const result: RolloutRequestedSpawn = {
    ...(task.value === undefined ? {} : { taskName: task.value }),
    ...(model.value === undefined ? {} : { model: model.value }),
    ...(effort.value === undefined ? {} : { reasoningEffort: effort.value }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function parseEvidenceText(
  lines: readonly string[],
  threadId: string,
  readerLimits: ReaderLimits,
  allowedTurnIds: ReadonlySet<string>,
): RolloutIdentityEvidence | undefined {
  const observedHistory: RolloutObservedHistory[] = [];
  const requestedSpawns: RolloutRequestedSpawn[] = [];
  let matchingSessionSeen = false;
  let activeMatchingSession = false;
  let activeAllowedTurn = false;
  let activeTurnId: string | undefined;
  let activeProvider: string | undefined;
  let activeModel: string | undefined;
  let activeEffort: string | undefined;
  let modelProvider: string | undefined;
  let lifecycle: TrustedLocalTopologyNode['status'] | undefined;
  let usage: RolloutTokenUsage | undefined;
  let usageAmbiguous = false;
  const usageSegments: RolloutUsageSegment[] = [];
  let usageTelemetrySeen = false;
  let usageSegmentsComplete = true;
  if (lines.length > readerLimits.maxLines) return undefined;
  let recordCount = 0;
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    recordCount += 1;
    if (recordCount > readerLimits.maxRecords) return undefined;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!isRecord(record) || typeof record.type !== 'string') return undefined;
    const payload = objectValue(record, 'payload');
    if (record.type === 'session_meta') {
      // Rollout files can contain a later inherited/nested session segment.
      // Only the requested thread's segment is authoritative; a second
      // matching segment is ambiguous and must remain unavailable.
      if (payload === undefined) return undefined;
      const sessionId = safeId(payload.id);
      if (sessionId === undefined) return undefined;
      if (sessionId !== threadId) {
        activeAllowedTurn = false;
        activeTurnId = undefined;
        activeProvider = undefined;
        activeModel = undefined;
        activeEffort = undefined;
        activeMatchingSession = false;
        continue;
      }
      // In live app-server evidence, raw `thread.sessionId` identifies the
      // subagent thread, while rollout `session_meta.payload.session_id`
      // identifies the shared top-level session. They are different concepts
      // and must not be compared. Ownership is established by raw
      // `thread.id` == requested thread id == matching `session_meta.payload.id`,
      // plus the exact own-turn allowlist below.
      if (matchingSessionSeen) return undefined;
      matchingSessionSeen = true;
      activeMatchingSession = true;
      const provider = optionalSafeLabel(payload, 'model_provider', safeWord);
      if (provider.malformed) return undefined;
      modelProvider = provider.value;
      continue;
    }
    if (record.type === 'turn_context') {
      activeAllowedTurn = false;
      activeTurnId = undefined;
      activeProvider = undefined;
      activeModel = undefined;
      activeEffort = undefined;
      if (!matchingSessionSeen) continue;
      if (payload === undefined) continue;
      // The rollout file can contain inherited context with a valid-looking
      // model pair. Correlate only to the exact turns returned by thread/read.
      const turnId = safeId(payload.turn_id);
      if (turnId === undefined || !allowedTurnIds.has(turnId)) continue;
      activeAllowedTurn = true;
      activeMatchingSession = true;
      const model = resolvedTurnLabel(payload, 'model', 'model');
      const effort = resolvedTurnLabel(payload, 'effort', 'reasoning_effort');
      const provider = resolvedTurnLabel(payload, 'model_provider', 'model_provider');
      if (model.malformed || effort.malformed || provider.malformed) return undefined;
      activeTurnId = turnId;
      // The exact session_meta provider remains authoritative when a turn
      // omits the otherwise identical provider label.
      activeProvider = provider.value ?? modelProvider;
      activeModel = model.value;
      activeEffort = effort.value;
      const observation: RolloutObservedHistory = {
        ...(model.value === undefined ? {} : { model: model.value }),
        ...(effort.value === undefined ? {} : { effort: effort.value }),
      };
      if (Object.keys(observation).length > 0 && !appendBounded(observedHistory, observation, readerLimits.maxObservedHistory)) return undefined;
      continue;
    }
    if (record.type === 'event_msg' && activeMatchingSession && payload !== undefined && payload.type === 'token_count') {
      const info = objectValue(payload, 'info');
      // Some Codex heartbeats carry a null/absent info object. They are not
      // usage observations and must not poison later valid cumulative totals.
      if (info === undefined) continue;
      usageTelemetrySeen = true;
      const total = objectValue(info, 'total_token_usage');
      if (total === undefined) {
        usageAmbiguous = true;
        usageSegmentsComplete = false;
        continue;
      }
      const observedAt = safeTimestamp(record.timestamp);
      const parsed = parseTokenUsage(total, observedAt);
      if (parsed === undefined || !monotonicTokenUsage(usage, parsed)) {
        usageAmbiguous = true;
        usageSegmentsComplete = false;
        continue;
      }
      // Codex can repeat an unchanged cumulative heartbeat. It represents no
      // invocation and must neither duplicate a segment nor poison completeness.
      if (usage !== undefined && sameTokenUsage(usage, parsed)) continue;
      const last = parseTokenUsage(objectValue(info, 'last_token_usage'), observedAt);
      const delta = usageDelta(usage, parsed);
      // `model_context_window` is intentionally ignored: it is capacity, not
      // evidence of billable tokens consumed by this invocation.
      if (last === undefined || delta === undefined || !sameTokenUsage(last, delta) ||
          !activeAllowedTurn || activeTurnId === undefined || activeProvider === undefined ||
          activeModel === undefined || activeEffort === undefined) {
        usageSegmentsComplete = false;
      } else if (usageSegments.length >= readerLimits.maxUsageSegments) {
        // Retention is bounded, but crossing that bound must not erase the
        // independent identity evidence or the already-attributed prefix.
        // The omitted suffix makes the cost explicitly partial.
        usageSegmentsComplete = false;
      } else {
        usageSegments.push({
          turnId: activeTurnId,
          provider: activeProvider,
          model: activeModel,
          effort: activeEffort,
          usage: last,
        });
      }
      usage = parsed;
      continue;
    }
    if (record.type === 'event_msg' && activeMatchingSession && payload !== undefined) {
      const candidate = eventLifecycle(payload);
      if (candidate !== 'unknown') lifecycle = candidate;
    }
    if (matchingSessionSeen && activeAllowedTurn && record.type === 'response_item' && payload !== undefined && payload.type === 'function_call' && payload.name === 'spawn_agent') {
      const spawn = parseSpawnArguments(payload.arguments, readerLimits.maxArgumentBytes);
      if (spawn === undefined || !appendBounded(requestedSpawns, spawn, readerLimits.maxRequestedSpawns)) return undefined;
    }
  }
  if (!matchingSessionSeen) return undefined;
  return {
    sourceThreadId: threadId,
    ...(lifecycle === undefined ? {} : { lifecycle }),
    ...(modelProvider === undefined ? {} : { modelProvider }),
    observedHistory: Object.freeze(observedHistory),
    requestedSpawns: Object.freeze(requestedSpawns),
    ...(usage === undefined || usageAmbiguous ? {} : { usage }),
    ...(usageAmbiguous ? { usageAmbiguous: true } : {}),
    ...(usageSegments.length === 0 ? {} : { usageSegments: Object.freeze(usageSegments) }),
    ...(usageTelemetrySeen ? { usageSegmentsComplete: usageSegmentsComplete && !usageAmbiguous } : {}),
  };
}

function allowedTurnIds(
  rawThread: Record<string, unknown>,
  rawThreadRead: Record<string, unknown>,
  readerLimits: ReaderLimits,
): ReadonlySet<string> | undefined {
  const createdAt = safeUnixSeconds(rawThread.createdAt);
  if (createdAt === undefined) return undefined;
  const turnsValue = own(rawThread, 'turns') ? rawThread.turns : rawThreadRead.turns;
  if (!Array.isArray(turnsValue) || turnsValue.length > readerLimits.maxRecords) return undefined;
  const result = new Set<string>();
  for (const turn of turnsValue) {
    if (!isRecord(turn)) return undefined;
    const turnId = safeId(turn.id);
    if (turnId === undefined) return undefined;
    const startedAt = safeUnixSeconds(turn.startedAt);
    if (startedAt === undefined) return undefined;
    // Child turns begin at or after the owning thread's creation timestamp;
    // inherited parent turns precede it and are excluded from the allowlist.
    if (startedAt >= createdAt) result.add(turnId);
  }
  return result;
}

/**
 * Read one trusted rollout path carried by a raw thread/read response. The
 * path and all raw records are consumed only inside this function and never
 * appear in a return value, exception, log, or hash.
 */
export async function readRolloutIdentityEvidence(
  rawThreadRead: unknown,
  threadId: string,
  options: RolloutIdentityReaderOptions,
): Promise<RolloutIdentityEvidence | undefined> {
  try {
    if (safeId(threadId) !== threadId) return undefined;
    const readerLimits = limits(options);
    if (readerLimits === undefined || !isRecord(rawThreadRead)) return undefined;
    const rawThread = objectValue(rawThreadRead, 'thread') ?? objectValue(rawThreadRead, 'data');
    if (rawThread === undefined) return undefined;
    const rawId = rawThread.id;
    if (rawId === undefined || rawId !== threadId) return undefined;
    const turnIds = allowedTurnIds(rawThread, rawThreadRead, readerLimits);
    if (turnIds === undefined) return undefined;
    const lines = await trustedRolloutLines(rawThread.path, options, readerLimits);
    return lines === undefined ? undefined : parseEvidenceText(lines, threadId, readerLimits, turnIds);
  } catch {
    return undefined;
  }
}

/**
 * Read local recorded content for one exact thread. This shares the identity
 * reader's trusted-path and own-turn boundary but never emits function-call
 * arguments or any record containing a credential-like key.
 */
export async function readRolloutLocalDetail(
  rawThreadRead: unknown,
  threadId: string,
  options: RolloutIdentityReaderOptions,
): Promise<LocalRolloutDetail | undefined> {
  try {
    const readerLimits = limits(options);
    if (readerLimits === undefined || !isRecord(rawThreadRead)) return undefined;
    const rawThread = objectValue(rawThreadRead, 'thread');
    if (rawThread === undefined || safeId(rawThread.id) !== threadId) return undefined;
    const ownTurns = allowedTurnIds(rawThread, rawThreadRead, readerLimits);
    if (ownTurns === undefined) return undefined;
    const lines = await trustedRolloutLines(rawThread.path, options, readerLimits);
    if (lines === undefined) return undefined;
    const messages: LocalRolloutDetail['messages'][number][] = [];
    const activity: LocalRolloutDetail['activity'][number][] = [];
    const tools: LocalRolloutDetail['tools'][number][] = [];
    const toolByCallId = new Map<string, number>();
    const changedFiles: LocalRolloutDetail['changedFiles'][number][] = [];
    let finalSummary: string | undefined;
    let matching = false;
    let matchingSeen = false;
    let activeTurn = false;
    if (lines.length > readerLimits.maxLines) return undefined;
    let records = 0;
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      if (++records > readerLimits.maxRecords) return undefined;
      let record: unknown;
      try { record = JSON.parse(line); } catch { return undefined; }
      if (!isRecord(record) || sensitiveRecord(record)) continue;
      const payload = objectValue(record, 'payload');
      if (record.type === 'session_meta') {
        if (payload === undefined) return undefined;
        const id = safeId(payload.id);
        if (id === threadId && matching) return undefined;
        if (id === threadId) matchingSeen = true;
        matching = id === threadId;
        activeTurn = false;
        continue;
      }
      if (record.type === 'turn_context') {
        if (!matchingSeen || payload === undefined || sensitiveRecord(payload)) continue;
        const turnId = safeId(payload.turn_id);
        activeTurn = turnId !== undefined && ownTurns.has(turnId);
        if (activeTurn) matching = true;
        const startedAt = safeTimestamp(record.timestamp);
        if (activeTurn && activity.length < 1_024) activity.push({ kind: 'thread_settings', status: 'active', ...(startedAt === undefined ? {} : { startedAt }) });
        continue;
      }
      if (!matching || payload === undefined || sensitiveRecord(payload)) continue;
      if (!activeTurn) continue;
      const occurredAt = safeTimestamp(record.timestamp);
      if (record.type === 'response_item') {
        const type = safeWord(payload.type);
        if (type === 'function_call' || type === 'custom_tool_call') {
          const name = safeDetailText(payload.name);
          if (name === undefined || CODEX_CONTROL_TOOL.test(name) || tools.length >= 1_024) continue;
          const startedAt = occurredAt;
          const callId = safeId(payload.call_id ?? payload.id);
          const toolArguments = sanitizedToolValue(payload.arguments ?? payload.input);
          const entry = { name, status: 'called', ...(toolArguments === undefined ? {} : { arguments: toolArguments }), ...(startedAt === undefined ? {} : { startedAt }) };
          tools.push(entry);
          if (callId !== undefined) toolByCallId.set(callId, tools.length - 1);
          continue;
        }
        if (type === 'function_call_output' || type === 'custom_tool_call_output') {
          const callId = safeId(payload.call_id ?? payload.id);
          const index = callId === undefined ? undefined : toolByCallId.get(callId);
          if (index === undefined) continue;
          const prior = tools[index];
          if (prior === undefined) continue;
          const result = sanitizedToolValue(payload.output ?? payload.result);
          tools[index] = { ...prior, status: payload.success === false ? 'failed' : 'completed', ...(result === undefined ? {} : { result }), ...(occurredAt === undefined ? {} : { completedAt: occurredAt }), ...(prior.startedAt === undefined || occurredAt === undefined ? {} : { durationMs: Math.max(0, Date.parse(occurredAt) - Date.parse(prior.startedAt)) }) };
          continue;
        }
        const role = payload.role === 'user' || payload.role === 'assistant' || payload.role === 'system' || payload.role === 'tool' ? payload.role : 'unknown';
        const messageText = safeDetailText(payload.text ?? payload.message) ?? safeStructuredDetailText(payload.content);
        if (messageText !== undefined && messages.length < 1_024) messages.push({ role, text: messageText, ...(occurredAt === undefined ? {} : { occurredAt }) });
        const summary = safeDetailText(payload.summary ?? payload.final_output);
        if (summary !== undefined) finalSummary = summary;
        changedFiles.push(...parseChangedFiles(payload.changed_files).slice(0, 1_024 - changedFiles.length));
      } else if (record.type === 'event_msg') {
        const kind = safeWord(payload.type) ?? 'unknown';
        if (activity.length < 1_024) activity.push({ kind: kind === 'model_rerouted' ? 'model_rerouted' : kind.includes('error') ? 'error' : 'lifecycle', status: kind, ...(occurredAt === undefined ? {} : { startedAt: occurredAt }) });
        const summary = safeDetailText(payload.summary ?? payload.message);
        if (summary !== undefined && /(?:final|complete|completed|result)/iu.test(kind)) finalSummary = summary;
        changedFiles.push(...parseChangedFiles(payload.changed_files).slice(0, 1_024 - changedFiles.length));
      }
    }
    return { schemaVersion: 'agent-farm.local-rollout-detail.v2', sourceThreadId: threadId, messages, activity, tools, changedFiles, ...(finalSummary === undefined ? {} : { finalSummary }) };
  } catch {
    return undefined;
  }
}

async function exactRolloutPath(threadId: string, options: RolloutIdentityReaderOptions, readerLimits: ReaderLimits): Promise<string | undefined> {
  const configuredRoot = resolve(options.sessionsRoot);
  const rootStat = await lstat(configuredRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
  const suffix = `-${threadId}.jsonl`;
  const pending: Array<{ path: string; depth: number }> = [{ path: configuredRoot, depth: 0 }];
  let examined = 0;
  let match: string | undefined;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const entries = await readdir(current.path, { withFileTypes: true });
    for (const entry of entries) {
      if (++examined > readerLimits.maxDirectoryEntries || entry.isSymbolicLink()) return undefined;
      const candidate = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= readerLimits.maxDirectoryDepth) return undefined;
        pending.push({ path: candidate, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !basename(candidate).endsWith(suffix)) continue;
      if (match !== undefined) return undefined;
      match = candidate;
    }
  }
  return match;
}

function localThreadRead(lines: readonly string[], filename: string, threadId: string, readerLimits: ReaderLimits): unknown {
  if (lines.length > readerLimits.maxLines) return undefined;
  const turnIds = new Set<string>();
  let records = 0;
  let matching = false;
  let matchingSeen = false;
  let forkSnapshotAt: number | undefined;
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    if (++records > readerLimits.maxRecords) return undefined;
    let record: unknown;
    try { record = JSON.parse(line); } catch { return undefined; }
    if (!isRecord(record)) return undefined;
    const payload = objectValue(record, 'payload');
    if (record.type === 'session_meta') {
      if (payload === undefined) return undefined;
      const id = safeId(payload.id);
      if (id === undefined) return undefined;
      if (id === threadId) {
        if (matchingSeen) return undefined;
        matchingSeen = true;
        matching = true;
        if (safeId(payload.forked_from_id) !== undefined || safeId(payload.parent_thread_id) !== undefined) {
          const timestamp = safeTimestamp(record.timestamp);
          if (timestamp === undefined) return undefined;
          forkSnapshotAt = Date.parse(timestamp);
        }
      } else {
        matching = false;
      }
      continue;
    }
    if (record.type !== 'turn_context' || !matchingSeen || payload === undefined) continue;
    const turnId = safeId(payload.turn_id);
    if (turnId === undefined) return undefined;
    if (forkSnapshotAt !== undefined) {
      const timestamp = safeTimestamp(record.timestamp);
      if (timestamp === undefined || Date.parse(timestamp) <= forkSnapshotAt) continue;
    }
    turnIds.add(turnId);
  }
  if (!matchingSeen) return undefined;
  const turns = [...turnIds].map((id) => ({ id, startedAt: MIN_UNIX_SECONDS }));
  return { thread: { id: threadId, path: filename, createdAt: MIN_UNIX_SECONDS, turns } };
}

/**
 * Resolve exact Codex rollout files without an app-server RPC. File discovery
 * is filename-exact, bounded, symlink-free, and then revalidated by the same
 * trusted path/open checks as the raw thread/read readers. A missing or
 * duplicate file/session remains unavailable.
 */
export function createTrustedLocalRolloutResolver(options: RolloutIdentityReaderOptions): TrustedLocalRolloutResolver {
  const resolveRead = async (threadId: string): Promise<unknown> => {
    if (safeId(threadId) !== threadId) return undefined;
    const readerLimits = limits(options);
    if (readerLimits === undefined) return undefined;
    try {
      const filename = await exactRolloutPath(threadId, options, readerLimits);
      if (filename === undefined) return undefined;
      const lines = await trustedRolloutLines(filename, options, readerLimits);
      return lines === undefined ? undefined : localThreadRead(lines, filename, threadId, readerLimits);
    } catch {
      return undefined;
    }
  };
  return Object.freeze({
    readIdentity: async (threadId: string) => {
      const raw = await resolveRead(threadId);
      return raw === undefined ? undefined : readRolloutIdentityEvidence(raw, threadId, options);
    },
    readDetail: async (threadId: string) => {
      const raw = await resolveRead(threadId);
      return raw === undefined ? undefined : readRolloutLocalDetail(raw, threadId, options);
    },
    discoverTopology: async (rootThreadId: string) => {
      if (safeId(rootThreadId) !== rootThreadId) return undefined;
      const readerLimits = limits(options);
      if (readerLimits === undefined) return undefined;
      try {
        const configuredRoot = resolve(options.sessionsRoot);
        const rootStat = await lstat(configuredRoot);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
        const pending: Array<{ path: string; depth: number }> = [{ path: configuredRoot, depth: 0 }];
        const byId = new Map<string, TopologyCandidate>();
        let examined = 0;
        let fileCount = 0;
        let bytesRead = 0;
        let headerRecords = 0;
        while (pending.length > 0) {
          const current = pending.pop();
          if (!current) break;
          const entries = (await readdir(current.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            if (++examined > readerLimits.maxDirectoryEntries || entry.isSymbolicLink()) return undefined;
            const candidate = join(current.path, entry.name);
            if (entry.isDirectory()) {
              if (current.depth >= readerLimits.maxDirectoryDepth) return undefined;
              pending.push({ path: candidate, depth: current.depth + 1 });
              continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            if (++fileCount > readerLimits.maxTopologyFiles) return undefined;
            const candidateStat = await lstat(candidate);
            if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) return undefined;
            const prefix = await trustedRolloutPrefix(candidate, options, TOPOLOGY_HEADER_BYTES);
            if (prefix === undefined || (bytesRead += prefix.bytesRead) > readerLimits.maxTopologyBytes) return undefined;
            headerRecords += prefix.text.split('\n').reduce((count, line) => count + (line.length > 0 ? 1 : 0), 0);
            if (headerRecords > readerLimits.maxTopologyRecords) return undefined;
            const node = topologyHeader(prefix.text, candidate);
            if (node === undefined) continue;
            if (byId.has(node.sourceThreadId)) return undefined;
            byId.set(node.sourceThreadId, { filename: candidate, node });
          }
        }
        const admitted = new Map<string, TopologyCandidate>();
        const admittedIds = new Set<string>([rootThreadId]);
        let progressed = true;
        while (progressed) {
          progressed = false;
          for (const candidate of byId.values()) {
            const node = candidate.node;
            if (admittedIds.has(node.sourceThreadId) || node.parentThreadId === undefined || !admittedIds.has(node.parentThreadId)) continue;
            if (admitted.size >= readerLimits.maxTopologyNodes) return undefined;
            admitted.set(node.sourceThreadId, candidate);
            admittedIds.add(node.sourceThreadId);
            progressed = true;
          }
        }
        const enriched = new Map<string, TrustedLocalTopologyNode>();
        for (const [id, candidate] of admitted) {
          const stat = await lstat(candidate.filename);
          let node = candidate.node;
          if (stat.size <= Math.min(readerLimits.maxFileBytes, TOPOLOGY_DETAIL_FILE_BYTES) && bytesRead + stat.size <= readerLimits.maxTopologyBytes) {
            const text = await trustedRolloutFile(candidate.filename, options, Math.min(readerLimits.maxFileBytes, TOPOLOGY_DETAIL_FILE_BYTES));
            if (text !== undefined) {
              bytesRead += Buffer.byteLength(text, 'utf8');
              node = topologyDetail(text, node, Math.min(readerLimits.maxRecords, readerLimits.maxTopologyRecords));
            }
          }
          enriched.set(id, node);
        }
        const depth = (node: TrustedLocalTopologyNode): number => {
          let result = 1;
          let cursor = node.parentThreadId;
          const seen = new Set<string>([node.sourceThreadId]);
          while (cursor !== undefined && cursor !== rootThreadId) {
            if (seen.has(cursor)) return Number.MAX_SAFE_INTEGER;
            seen.add(cursor);
            result += 1;
            cursor = enriched.get(cursor)?.parentThreadId;
          }
          return cursor === rootThreadId ? result : Number.MAX_SAFE_INTEGER;
        };
        const result = [...enriched.values()].sort((a, b) => depth(a) - depth(b) || (a.parentThreadId ?? '').localeCompare(b.parentThreadId ?? '') || (a.agentTaskName ?? '').localeCompare(b.agentTaskName ?? '') || a.sourceThreadId.localeCompare(b.sourceThreadId));
        return result.some((node) => depth(node) > readerLimits.maxDirectoryDepth) ? undefined : result;
      } catch {
        return undefined;
      }
    },
  });
}
