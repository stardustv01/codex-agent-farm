import {
  type BridgeLifecycleStatus,
  type BridgeSourceKind,
  type BridgeTurnStatus,
  type SanitizedCollaboration,
  type SanitizedErrorCode,
  type SanitizedFinalSummary,
  type SanitizedItem,
  type SanitizedItemKind,
  type SanitizedModel,
  type SanitizedModelCatalog,
  type SanitizedSubagentActivity,
  type SanitizedThread,
  type SanitizedThreadPage,
  type SanitizedThreadRead,
  type SanitizedThreadSettings,
  type SanitizedTurn,
} from './types.js';

const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CURSOR = /^[A-Za-z0-9._~+=:-]{1,512}$/;
const SAFE_WORD = /^[A-Za-z0-9._:@+-]{1,128}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._: @+()/'-]{0,127}$/;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_CHAT_TITLE_CHARS = 96;

// App-server timestamps are either Unix seconds or Unix milliseconds. Keep
// both interpretations inside a deliberately bounded operational window so a
// malformed number cannot silently become a 1970 date or an extreme Date.
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_TIMESTAMP_MS = Date.UTC(2100, 0, 1);
const MIN_TIMESTAMP_SECONDS = Math.ceil(MIN_TIMESTAMP_MS / 1_000);
const MAX_TIMESTAMP_SECONDS = Math.floor(MAX_TIMESTAMP_MS / 1_000);

/** A Codex agent path is a structural lineage label, never a filesystem path. */
const AGENT_PATH_MAX_CHARS = 512;
const AGENT_PATH_MAX_DEPTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, pattern: RegExp, max = 128): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || !pattern.test(value)) return undefined;
  return value;
}

function opaqueId(value: unknown): string | undefined {
  return stringValue(value, OPAQUE_ID);
}

function safeWord(value: unknown): string | undefined {
  return stringValue(value, SAFE_WORD);
}

function safeLabel(value: unknown): string | undefined {
  return stringValue(value, SAFE_LABEL);
}

export function sanitizeChatTitle(value: unknown, max = MAX_CHAT_TITLE_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0 || normalized.length > max) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(normalized)) return undefined;
  if (!/[\p{L}\p{N}]/u.test(normalized)) return undefined;
  if (/^(?:https?:\/\/|file:|\/|~\/|[A-Za-z]:[\\/])/u.test(normalized) || normalized.includes('\\')) return undefined;
  if (/(?:api[_ -]?key|access[_ -]?token|secret)\s*[:=]/iu.test(normalized)) return undefined;
  return normalized;
}

/**
 * Keep a long Codex-generated title useful without copying the whole first
 * message into the public projection. The first safe non-empty line is the
 * compact signal the desktop chat list presents; all normal title checks are
 * still applied after truncation.
 */
export function compactChatTitle(value: unknown, max = MAX_CHAT_TITLE_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
  for (const line of normalized.split('\n').map((candidate) => candidate.trim()).filter(Boolean)) {
    const bounded = line.length > max ? `${line.slice(0, Math.max(1, max - 3)).trimEnd()}...` : line;
    // Some imported Codex records put a private session path or transport
    // marker on line one and the human title on the next line. Skip only the
    // rejected line; never copy the unsafe metadata into the public label.
    const safe = sanitizeChatTitle(bounded, max);
    if (safe !== undefined) return safe;
  }
  return undefined;
}

function firstCompactDisplayText(record: Record<string, unknown>, keys: readonly string[], max = MAX_CHAT_TITLE_CHARS): string | undefined {
  for (const key of keys) {
    const value = sanitizeChatTitle(record[key], max) ?? compactChatTitle(record[key], max);
    if (value !== undefined) return value;
  }
  return undefined;
}

function workspaceBasename(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value.includes('\0')) return undefined;
  const segments = value.replaceAll('\\', '/').split('/').filter(Boolean);
  return sanitizeChatTitle(segments.at(-1), 64);
}

function timestamp(value: unknown): string | undefined {
  let date: Date;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return undefined;
    const milliseconds = value >= MIN_TIMESTAMP_SECONDS && value <= MAX_TIMESTAMP_SECONDS
      ? value * 1_000
      : value >= MIN_TIMESTAMP_MS && value <= MAX_TIMESTAMP_MS
        ? value
        : undefined;
    if (milliseconds === undefined) return undefined;
    date = new Date(milliseconds);
  } else if (typeof value === 'string' && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value)) {
    date = new Date(value);
  } else {
    return undefined;
  }
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < MIN_TIMESTAMP_MS || milliseconds > MAX_TIMESTAMP_MS) return undefined;
  return date.toISOString();
}

function duration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000 ? Math.round(value) : undefined;
}

function getFirst(record: Record<string, unknown>, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

interface StrictOpaqueField {
  readonly present: boolean;
  readonly value?: string | undefined;
  readonly malformed: boolean;
}

interface StrictFieldOptions {
  readonly nullIsAbsent?: boolean;
}

/**
 * Read optional identifier aliases without silently laundering malformed input.
 * JSON `null`, objects, and conflicting aliases are all rejected by callers.
 */
function strictOpaqueField(record: Record<string, unknown>, keys: readonly string[], options: StrictFieldOptions = {}): StrictOpaqueField {
  let present = false;
  let value: string | undefined;
  for (const key of keys) {
    if (!hasOwn(record, key) || record[key] === undefined) continue;
    if (record[key] === null && options.nullIsAbsent === true) continue;
    present = true;
    const parsed = opaqueId(record[key]);
    if (parsed === undefined) return { present, malformed: true };
    if (value !== undefined && value !== parsed) return { present, malformed: true };
    value = parsed;
  }
  return { present, value, malformed: false };
}

interface AgentPathValue {
  readonly path: string;
  readonly taskName: string;
}

function structuralAgentPath(value: unknown): AgentPathValue | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > AGENT_PATH_MAX_CHARS || !value.startsWith('/')) return undefined;
  const segments = value.slice(1).split('/');
  if (segments.length === 0 || segments.length > AGENT_PATH_MAX_DEPTH || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !SAFE_WORD.test(segment))) {
    return undefined;
  }
  const taskName = segments.at(-1);
  return taskName === undefined ? undefined : { path: value, taskName };
}

interface NestedThreadSpawn {
  readonly spawns: readonly Record<string, unknown>[];
  readonly malformed: boolean;
}

/** Extract the 0.145.0 structural subagent lineage without retaining raw source data. */
function nestedThreadSpawns(raw: Record<string, unknown>): NestedThreadSpawn {
  const spawns: Record<string, unknown>[] = [];
  let malformed = false;
  for (const sourceKey of ['source', 'threadSource'] as const) {
    const sourceValue = raw[sourceKey];
    if (!isRecord(sourceValue)) continue;
    const subagentValue = getFirst(sourceValue, 'subagent', 'subAgent');
    if (subagentValue === undefined) continue;
    if (!isRecord(subagentValue)) {
      malformed = true;
      continue;
    }
    const spawnValue = getFirst(subagentValue, 'thread_spawn', 'threadSpawn');
    if (spawnValue === undefined) continue;
    if (!isRecord(spawnValue)) {
      malformed = true;
      continue;
    }
    spawns.push(spawnValue);
  }
  return { spawns, malformed };
}

interface StrictAgentPathField {
  readonly present: boolean;
  readonly value?: AgentPathValue | undefined;
  readonly malformed: boolean;
}

function strictAgentPathField(record: Record<string, unknown>, keys: readonly string[], options: StrictFieldOptions = {}): StrictAgentPathField {
  let present = false;
  let value: AgentPathValue | undefined;
  for (const key of keys) {
    if (!hasOwn(record, key) || record[key] === undefined) continue;
    if (record[key] === null && options.nullIsAbsent === true) continue;
    present = true;
    const parsed = structuralAgentPath(record[key]);
    if (parsed === undefined) return { present, malformed: true };
    if (value !== undefined && value.path !== parsed.path) return { present, malformed: true };
    value = parsed;
  }
  return { present, value, malformed: false };
}

function lifecycleStatus(value: unknown): BridgeLifecycleStatus {
  if (isRecord(value)) {
    const type = value.type;
    if (typeof type !== 'string') return 'unknown';
    switch (type) {
      case 'idle':
        return 'idle';
      case 'active':
        return 'active';
      case 'systemError':
        return 'failed';
      case 'notLoaded':
        return 'unknown';
      default:
        return 'unknown';
    }
  }
  if (typeof value !== 'string') return 'unknown';
  switch (value.toLowerCase()) {
    case 'idle':
    case 'ready':
    case 'not_loaded':
      return 'idle';
    case 'active':
    case 'running':
    case 'in_progress':
    case 'working':
      return 'active';
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'interrupted':
    case 'cancelled':
    case 'canceled':
      return 'interrupted';
    default:
      return 'unknown';
  }
}

function turnStatus(value: unknown): BridgeTurnStatus {
  if (typeof value !== 'string') return 'unknown';
  switch (value.toLowerCase()) {
    case 'started':
      return 'started';
    case 'active':
    case 'running':
    case 'in_progress':
    case 'inprogress':
    case 'interacted':
      return 'in_progress';
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'failed':
    case 'error':
    case 'errored':
    case 'notfound':
      return 'failed';
    case 'interrupted':
    case 'cancelled':
    case 'canceled':
    case 'shutdown':
      return 'interrupted';
    default:
      return 'unknown';
  }
}

function sourceKind(value: unknown): BridgeSourceKind | undefined {
  if (isRecord(value) && getFirst(value, 'subAgent', 'subagent', 'sub_agent') !== undefined) return 'subagent';
  const text = typeof value === 'string' ? value.toLowerCase() : isRecord(value) ? String(getFirst(value, 'type', 'kind') ?? '').toLowerCase() : '';
  switch (text) {
    case 'cli':
    case 'terminal':
      return 'cli';
    case 'ide':
    case 'vscode':
    case 'editor':
      return 'ide';
    case 'cloud':
      return 'cloud';
    case 'subagent':
    case 'sub_agent':
      return 'subagent';
    case 'unknown':
      return 'unknown';
    default:
      return text ? 'unknown' : undefined;
  }
}

function itemKind(value: unknown): SanitizedItemKind {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (text.includes('collab')) return 'collaboration';
  if (text.includes('subagent') || text.includes('sub_agent')) return 'subagent_activity';
  if (text.includes('setting')) return 'thread_settings';
  if (text.includes('rerout')) return 'model_rerouted';
  if (text.includes('error') || text.includes('failure')) return 'error';
  if (text.includes('turn') || text.includes('lifecycle') || text.includes('status')) return 'lifecycle';
  return 'unknown';
}

function errorCode(value: unknown): SanitizedErrorCode | undefined {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  switch (text) {
    case 'invalid_request':
    case 'invalid-params':
    case 'invalid_params':
      return 'invalid_request';
    case 'method_not_found':
    case 'method-not-found':
      return 'method_not_found';
    case 'not_initialized':
    case 'not-initialized':
      return 'not_initialized';
    case 'permission_denied':
    case 'forbidden':
      return 'permission_denied';
    case 'timeout':
    case 'timed_out':
      return 'timeout';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'internal':
    case 'internal_error':
      return 'internal';
    case 'unknown':
      return 'unknown';
    default:
      return text ? 'unknown' : undefined;
  }
}

function uniqueIds(values: readonly unknown[]): readonly string[] | undefined {
  const result = [...new Set(values.map(opaqueId).filter((value): value is string => value !== undefined))];
  return result.length > 0 ? result : undefined;
}

function collaboration(value: unknown): SanitizedCollaboration | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  const operation = safeWord(getFirst(value, 'operation', 'op', 'tool'));
  const senderId = opaqueId(getFirst(value, 'senderId', 'sender', 'from', 'senderThreadId'));
  const receiverValue = getFirst(value, 'receiverIds', 'receivers', 'receiver', 'to', 'receiverThreadIds');
  const receiverIds = Array.isArray(receiverValue)
    ? uniqueIds(receiverValue)
    : opaqueId(receiverValue)
      ? [opaqueId(receiverValue) as string]
      : undefined;
  const requestedModel = safeWord(getFirst(value, 'requestedModel', 'model', 'requested_model'));
  const requestedReasoningEffort = safeWord(getFirst(value, 'requestedReasoningEffort', 'reasoningEffort', 'effort', 'requested_effort'));
  const statusValue = getFirst(value, 'status', 'state');
  if (operation !== undefined) result.operation = operation;
  if (senderId !== undefined) result.senderId = senderId;
  if (receiverIds !== undefined) result.receiverIds = receiverIds;
  if (requestedModel !== undefined) result.requestedModel = requestedModel;
  if (requestedReasoningEffort !== undefined) result.requestedReasoningEffort = requestedReasoningEffort;
  if (statusValue !== undefined) result.status = turnStatus(statusValue);
  return Object.keys(result).length > 0 ? (result as SanitizedCollaboration) : undefined;
}

interface SubagentActivityParse {
  readonly value?: SanitizedSubagentActivity | undefined;
  readonly malformed: boolean;
}

function parseSubagentActivity(value: unknown): SubagentActivityParse {
  if (!isRecord(value)) return { malformed: true };
  const result: Record<string, unknown> = {};
  const sourceThreadField = strictOpaqueField(value, ['sourceThreadId', 'threadId', 'childThreadId', 'subagentThreadId', 'agentThreadId']);
  const sourceTurnField = strictOpaqueField(value, ['sourceTurnId', 'turnId', 'childTurnId']);
  const parentThreadField = strictOpaqueField(value, ['parentThreadId', 'parentId'], { nullIsAbsent: true });
  const agentPathField = strictAgentPathField(value, ['agentPath', 'agent_path']);
  if (sourceThreadField.malformed || sourceTurnField.malformed || parentThreadField.malformed || agentPathField.malformed) {
    return { malformed: true };
  }
  const sourceThreadId = sourceThreadField.value;
  const sourceTurnId = sourceTurnField.value;
  const parentThreadId = parentThreadField.value;
  const statusValue = getFirst(value, 'status', 'state', 'kind');
  if (sourceThreadId !== undefined) result.sourceThreadId = sourceThreadId;
  if (sourceTurnId !== undefined) result.sourceTurnId = sourceTurnId;
  if (parentThreadId !== undefined) result.parentThreadId = parentThreadId;
  if (agentPathField.value !== undefined) {
    result.agentPath = agentPathField.value.path;
    result.agentTaskName = agentPathField.value.taskName;
  }
  if (statusValue !== undefined) result.status = turnStatus(statusValue);
  return Object.keys(result).length > 0 ? { value: result as SanitizedSubagentActivity, malformed: false } : { malformed: false };
}

function settings(value: unknown): SanitizedThreadSettings | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  const model = safeWord(getFirst(value, 'model', 'effectiveModel', 'modelId'));
  const provider = safeWord(getFirst(value, 'provider', 'modelProvider', 'effectiveProvider'));
  const reasoningEffort = safeWord(getFirst(value, 'reasoningEffort', 'effort', 'effectiveReasoningEffort'));
  if (model !== undefined) result.model = model;
  if (provider !== undefined) result.provider = provider;
  if (reasoningEffort !== undefined) result.reasoningEffort = reasoningEffort;
  return Object.keys(result).length > 0 ? (result as SanitizedThreadSettings) : undefined;
}

function modelReroute(value: unknown): { fromModel?: string; toModel?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const fromModel = safeWord(getFirst(value, 'fromModel', 'from', 'previousModel'));
  const toModel = safeWord(getFirst(value, 'toModel', 'to', 'model'));
  return fromModel === undefined && toModel === undefined ? undefined : { ...(fromModel === undefined ? {} : { fromModel }), ...(toModel === undefined ? {} : { toModel }) };
}

export function minimizeItem(raw: unknown): SanitizedItem | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = itemKind(getFirst(raw, 'type', 'itemType', 'kind'));
  const result: Record<string, unknown> = { kind };
  const sourceItemId = opaqueId(getFirst(raw, 'id', 'itemId', 'sourceItemId'));
  const statusValue = getFirst(raw, 'status', 'state');
  const startedAt = timestamp(getFirst(raw, 'startedAt', 'startTime', 'createdAt'));
  const completedAt = timestamp(getFirst(raw, 'completedAt', 'endTime', 'updatedAt'));
  const durationMs = duration(getFirst(raw, 'durationMs', 'duration'));
  const collab = collaboration(getFirst(raw, 'collaboration', 'collabAgentToolCall', 'collab')) ?? collaboration(raw);
  const activityKeys = ['subagentActivity', 'subAgentActivity', 'activity'] as const;
  const hasNestedActivity = activityKeys.some((key) => hasOwn(raw, key) && raw[key] !== undefined);
  const activityParse: SubagentActivityParse = hasNestedActivity
    ? parseSubagentActivity(getFirst(raw, ...activityKeys))
    : kind === 'subagent_activity'
      ? parseSubagentActivity(raw)
      : { malformed: false };
  if (activityParse.malformed) return undefined;
  const activity = activityParse.value;
  const effectiveSettings = settings(getFirst(raw, 'effectiveSettings', 'threadSettings', 'settings'));
  const rerouted = modelReroute(getFirst(raw, 'modelRerouted', 'rerouted', 'modelReroute'));
  const nestedErrorCode = isRecord(raw.error) ? raw.error.code : undefined;
  const safeError = errorCode(getFirst(raw, 'errorCode', 'code') ?? nestedErrorCode);
  if (sourceItemId !== undefined) result.sourceItemId = sourceItemId;
  if (statusValue !== undefined) result.status = turnStatus(statusValue);
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (completedAt !== undefined) result.completedAt = completedAt;
  if (durationMs !== undefined) result.durationMs = durationMs;
  if (collab !== undefined) result.collaboration = collab;
  if (activity !== undefined) result.subagentActivity = activity;
  if (effectiveSettings !== undefined) result.effectiveSettings = effectiveSettings;
  if (rerouted !== undefined) result.modelRerouted = rerouted;
  if (safeError !== undefined) result.errorCode = safeError;
  return result as unknown as SanitizedItem;
}

export function minimizeTurn(raw: unknown): SanitizedTurn | undefined {
  if (!isRecord(raw)) return undefined;
  const sourceTurnId = opaqueId(getFirst(raw, 'id', 'turnId', 'sourceTurnId'));
  if (!sourceTurnId) return undefined;
  const rawItems = getFirst(raw, 'items', 'turnItems');
  const items = Array.isArray(rawItems)
    ? rawItems.map(minimizeItem).filter((item): item is SanitizedItem => item !== undefined)
    : undefined;
  const result: Record<string, unknown> = { sourceTurnId, status: turnStatus(getFirst(raw, 'status', 'state')) };
  const startedAt = timestamp(getFirst(raw, 'startedAt', 'startTime', 'createdAt'));
  const completedAt = timestamp(getFirst(raw, 'completedAt', 'endTime', 'updatedAt'));
  const durationMs = duration(getFirst(raw, 'durationMs', 'duration'));
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (completedAt !== undefined) result.completedAt = completedAt;
  if (durationMs !== undefined) result.durationMs = durationMs;
  if (items !== undefined) result.items = items;
  return result as unknown as SanitizedTurn;
}

export function minimizeThread(raw: unknown): SanitizedThread | undefined {
  if (!isRecord(raw)) return undefined;
  const sourceThreadField = strictOpaqueField(raw, ['id', 'threadId', 'sourceThreadId']);
  const sourceThreadId = sourceThreadField.value;
  if (sourceThreadField.malformed || sourceThreadId === undefined) return undefined;

  // The real 0.145.0 app-server carries subagent lineage below
  // source.subAgent/subagent.thread_spawn.  Treat malformed lineage as an
  // invalid thread rather than quietly converting it into an unrelated root.
  const nested = nestedThreadSpawns(raw);
  if (nested.malformed) return undefined;
  const sessionField = strictOpaqueField(raw, ['sessionId', 'session_id'], { nullIsAbsent: true });
  const parentField = strictOpaqueField(raw, ['parentThreadId', 'parentId'], { nullIsAbsent: true });
  const forkedFromField = strictOpaqueField(raw, ['forkedFromId', 'forked_from_id'], { nullIsAbsent: true });
  if (sessionField.malformed || parentField.malformed || forkedFromField.malformed) return undefined;

  let nestedParentThreadId: string | undefined;
  let nestedAgentPath: AgentPathValue | undefined;
  let nestedAgentNickname: string | undefined;
  let nestedAgentRole: string | undefined;
  for (const spawn of nested.spawns) {
    const spawnParent = strictOpaqueField(spawn, ['parent_thread_id', 'parentThreadId', 'parent_id', 'parentId'], { nullIsAbsent: true });
    const spawnPath = strictAgentPathField(spawn, ['agent_path', 'agentPath'], { nullIsAbsent: true });
    if (spawnParent.malformed || spawnPath.malformed) return undefined;
    if (spawnParent.value !== undefined) {
      if (nestedParentThreadId !== undefined && nestedParentThreadId !== spawnParent.value) return undefined;
      nestedParentThreadId = spawnParent.value;
    }
    if (spawnPath.value !== undefined) {
      if (nestedAgentPath !== undefined && nestedAgentPath.path !== spawnPath.value.path) return undefined;
      nestedAgentPath = spawnPath.value;
    }
    const nickname = safeLabel(getFirst(spawn, 'agent_nickname', 'agentNickname', 'nickname'));
    const role = safeLabel(getFirst(spawn, 'agent_role', 'agentRole', 'role'));
    if (nickname !== undefined) nestedAgentNickname = nestedAgentNickname ?? nickname;
    if (role !== undefined) nestedAgentRole = nestedAgentRole ?? role;
  }

  if (parentField.value !== undefined && nestedParentThreadId !== undefined && parentField.value !== nestedParentThreadId) {
    return undefined;
  }

  const result: Record<string, unknown> = { sourceThreadId, status: lifecycleStatus(getFirst(raw, 'status', 'state')) };
  const fields: Array<[keyof SanitizedThread, string | undefined]> = [
    // Current app-server roots may expose `title: null` beside the public
    // label in `name` or a bounded `preview`. Validate each alias independently
    // so a nullable earlier field cannot suppress a later valid title.
    ['chatTitle', nested.spawns.length === 0 ? firstCompactDisplayText(raw, ['title', 'name', 'preview']) : undefined],
    ['workspaceName', nested.spawns.length === 0 ? workspaceBasename(raw.cwd) ?? workspaceBasename(raw.workingDirectory) : undefined],
    ['modelProvider', safeWord(getFirst(raw, 'modelProvider', 'provider'))],
    ['cliVersion', safeWord(getFirst(raw, 'cliVersion', 'version'))],
    ['agentNickname', nestedAgentNickname ?? safeLabel(getFirst(raw, 'agentNickname', 'nickname'))],
    ['agentRole', nestedAgentRole ?? safeLabel(getFirst(raw, 'agentRole', 'role'))],
    ['createdAt', timestamp(getFirst(raw, 'createdAt', 'created_at'))],
    ['updatedAt', timestamp(getFirst(raw, 'updatedAt', 'updated_at'))],
    ['recencyAt', timestamp(getFirst(raw, 'recencyAt', 'recency_at'))],
  ];
  if (sessionField.value !== undefined) result.sessionId = sessionField.value;
  const parentThreadId = parentField.value ?? nestedParentThreadId;
  if (parentThreadId !== undefined) result.parentThreadId = parentThreadId;
  if (forkedFromField.value !== undefined) result.forkedFromId = forkedFromField.value;
  if (nestedAgentPath !== undefined) {
    result.agentPath = nestedAgentPath.path;
    result.agentTaskName = nestedAgentPath.taskName;
  }
  for (const [key, value] of fields) {
    if (value !== undefined) result[key] = value;
  }
  // Some app-server rows include `sourceKind: null` beside the authoritative
  // nested source object. Skip null aliases so guardian/subagent records are
  // still classified and cannot become selectable roots.
  const sourceValue = [raw.sourceKind, raw.source, raw.threadSource].find((value) => value !== undefined && value !== null);
  const kind = sourceKind(sourceValue);
  if (nested.spawns.length > 0) result.sourceKind = 'subagent';
  else if (kind !== undefined) result.sourceKind = kind;
  return result as unknown as SanitizedThread;
}

function cursor(value: unknown): string | undefined {
  return typeof value === 'string' && CURSOR.test(value) ? value : undefined;
}

export function minimizeThreadPage(raw: unknown): SanitizedThreadPage | undefined {
  if (!isRecord(raw)) return undefined;
  const values = getFirst(raw, 'data', 'threads', 'items');
  if (!Array.isArray(values)) return undefined;
  const threads: SanitizedThread[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const thread = minimizeThread(value);
    if (thread && !seen.has(thread.sourceThreadId)) {
      seen.add(thread.sourceThreadId);
      threads.push(thread);
    }
  }
  const nextCursor = cursor(getFirst(raw, 'nextCursor', 'next_cursor', 'cursor'));
  return nextCursor === undefined ? { threads } : { threads, nextCursor };
}

export function minimizeThreadRead(raw: unknown): SanitizedThreadRead | undefined {
  if (!isRecord(raw)) return undefined;
  const threadValue = getFirst(raw, 'thread', 'data');
  const thread = minimizeThread(threadValue);
  if (!thread) return undefined;
  const values = raw.turns !== undefined ? raw.turns : isRecord(threadValue) ? threadValue.turns : undefined;
  const turns: SanitizedTurn[] = [];
  const seen = new Set<string>();
  if (Array.isArray(values)) {
    for (const value of values) {
      const turn = minimizeTurn(value);
      if (turn && !seen.has(turn.sourceTurnId)) {
        seen.add(turn.sourceTurnId);
        turns.push(turn);
      }
    }
  }
  const nextCursor = cursor(getFirst(raw, 'nextCursor', 'next_cursor', 'cursor'));
  return nextCursor === undefined ? { thread, turns } : { thread, turns, nextCursor };
}

function capability(value: unknown): string | undefined {
  return safeWord(value);
}

function minimizeModel(raw: unknown): SanitizedModel | undefined {
  if (!isRecord(raw)) return undefined;
  const model = safeWord(getFirst(raw, 'model', 'id', 'modelId'));
  const provider = safeWord(getFirst(raw, 'provider', 'modelProvider'));
  const displayLabel = safeLabel(getFirst(raw, 'displayLabel', 'label', 'name'));
  const values = getFirst(raw, 'capabilities', 'features');
  const capabilities = Array.isArray(values)
    ? [...new Set(values.map(capability).filter((item): item is string => item !== undefined))]
    : undefined;
  const result: Record<string, unknown> = {};
  if (model !== undefined) result.model = model;
  if (provider !== undefined) result.provider = provider;
  if (displayLabel !== undefined) result.displayLabel = displayLabel;
  if (capabilities !== undefined && capabilities.length > 0) result.capabilities = capabilities;
  return Object.keys(result).length > 0 ? (result as SanitizedModel) : undefined;
}

export function minimizeModelCatalog(raw: unknown): SanitizedModelCatalog | undefined {
  if (!isRecord(raw)) return undefined;
  const values = getFirst(raw, 'data', 'models', 'items');
  if (!Array.isArray(values)) return undefined;
  const models = values.map(minimizeModel).filter((item): item is SanitizedModel => item !== undefined);
  const nextCursor = cursor(getFirst(raw, 'nextCursor', 'next_cursor', 'cursor'));
  return nextCursor === undefined ? { models } : { models, nextCursor };
}

const SENSITIVE_SUMMARY_LINE = /\b(prompt|reasoning|chain[- ]of[- ]thought|tool\s*(?:args?|arguments?|result|call)|terminal|command(?:s)?|cwd|git(?:\s|_)?(?:diff|info)|approval|password|config)\b/i;
const COMMAND_LINE = /^(?:[$>#]\s*)?(?:cd|cat|curl|git|npm|pnpm|node|python(?:3)?|bash|zsh|sh|rm|mv|cp|mkdir|chmod|osascript|ffmpeg)\b/i;
const PATH = /(?:~\/|\/(?:Users|private|tmp|var|home|Applications|Volumes)\/|[A-Za-z]:\\)[^\s,;)}\]]*/g;
const TOKEN = /\b(?:Bearer\s+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,})\S*/gi;

/** Remove known sensitive lines and redact paths/tokens from opt-in summaries. */
export function redactSummaryText(value: string, maxChars = MAX_SUMMARY_CHARS): { text: string; truncated: boolean } {
  const safeMax = Math.max(1, Math.min(maxChars, MAX_SUMMARY_CHARS));
  const cleanLines = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split(/\r?\n/)
    .filter((line) => !SENSITIVE_SUMMARY_LINE.test(line) && !COMMAND_LINE.test(line))
    .map((line) => line.replace(PATH, (match) => {
      const punctuation = match.match(/[.!?]+$/)?.[0] ?? '';
      return `[redacted-path]${punctuation}`;
    }).replace(TOKEN, (match) => {
      const punctuation = match.match(/[.!?]+$/)?.[0] ?? '';
      return `[redacted-token]${punctuation}`;
    }).trim())
    .filter(Boolean);
  const joined = cleanLines.join('\n').trim();
  return joined.length <= safeMax ? { text: joined, truncated: false } : { text: joined.slice(0, safeMax).trimEnd(), truncated: true };
}

/**
 * Final messages are disabled unless explicitly enabled by the selected-root
 * consent.  The raw message is consumed once and is never returned, logged,
 * hashed, or queued by this function.
 */
export function minimizeFinalSummary(
  raw: unknown,
  options: { readonly enabled?: boolean; readonly maxChars?: number } = {},
): SanitizedFinalSummary | undefined {
  if (options.enabled !== true || !isRecord(raw)) return undefined;
  const sourceThreadId = opaqueId(getFirst(raw, 'sourceThreadId', 'threadId'));
  if (!sourceThreadId) return undefined;
  const sourceTurnId = opaqueId(getFirst(raw, 'sourceTurnId', 'turnId'));
  const textValue = getFirst(raw, 'text', 'message', 'finalMessage');
  if (typeof textValue !== 'string') return undefined;
  const redacted = redactSummaryText(textValue, options.maxChars);
  if (!redacted.text) return undefined;
  return sourceTurnId === undefined
    ? { sourceThreadId, text: redacted.text, truncated: redacted.truncated, provenance: 'final_agent_message' }
    : { sourceThreadId, sourceTurnId, text: redacted.text, truncated: redacted.truncated, provenance: 'final_agent_message' };
}
