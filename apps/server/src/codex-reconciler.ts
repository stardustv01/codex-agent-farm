import { randomUUID } from "node:crypto";

import {
  CODEX_DISCOVERY_SOURCE_KINDS,
  type RolloutTokenUsage,
  type RolloutIdentityEvidence,
  type TrustedLocalTopologyNode,
} from "@agent-farm/codex-bridge";
import {
  sha256,
  stableJson,
  type AgentLifecycle,
  type AgentRecord,
  type DurableStore,
  type EventIngestResult,
  type PrincipalScope,
  type SanitizedEventInput,
  type TokenUsageRecord,
  type VerificationState,
} from "@agent-farm/store";
import { estimateSegmentedSelfCost, type LocalCostEstimate, type LocalUsageSegments } from "@agent-farm/contracts";

import type { CodexRuntimeBinding } from "./codex-runtime.js";
import type { ReviewedPricingProvider } from "./pricing.js";
import {
  CODEX_AUTO_REVIEW_DISPLAY_NAME,
  canonicalCodexModel,
  isCodexAutoReviewModel,
} from "./auto-review.js";

/**
 * The reconciler intentionally depends on this small structural surface
 * rather than the concrete bridge client.  AppServerClient satisfies this
 * interface, while tests and future adapters can provide a read-only facade.
 */
export interface CodexSnapshotClient {
  listThreads(params?: Readonly<Record<string, unknown>>): Promise<unknown>;
  readThread(params: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** Optional bounded identity evidence from the trusted local rollout store. */
  readRolloutIdentity?: (threadId: string) => Promise<RolloutIdentityEvidence | undefined>;
  /** Optional trusted-local descendants omitted by app-server list/read. */
  discoverRolloutTopology?: (rootThreadId: string) => Promise<readonly TrustedLocalTopologyNode[] | undefined>;
}

export type AppServerClientLike = CodexSnapshotClient;
export type VerifiedCodexRuntimeBinding = CodexRuntimeBinding;

export interface CodexReconciliationLimits {
  /** Maximum number of thread/list pages fetched in one pass. */
  readonly maxListPages?: number;
  /** Maximum number of entries accepted from thread/list. */
  readonly maxListItems?: number;
  /** Maximum number of thread/read calls across the complete pass (one per node). */
  readonly maxReadPages?: number;
  /** Maximum number of turns accepted across all one-shot thread/read calls. */
  readonly maxTurns?: number;
  /** Maximum number of items accepted across all unpaginated turns. */
  readonly maxItems?: number;
  /** Maximum number of unique root/child nodes in one pre-transaction graph. */
  readonly maxNodes?: number;
  /** Request page size. The bridge itself caps this at 200. */
  readonly listPageSize?: number;
}

export interface CodexReconcilerOptions {
  readonly client: CodexSnapshotClient;
  readonly store: DurableStore;
  /** This binding must already have passed the pairing/runtime verification gate. */
  readonly binding: CodexRuntimeBinding;
  readonly sourceAdapter?: string;
  readonly connectionEpoch?: string;
  /** Optional caller-owned retry/run token. Same token means exact retry. */
  readonly reconciliationId?: string;
  readonly limits?: CodexReconciliationLimits;
  readonly pricing?: ReviewedPricingProvider;
}

export interface CodexReconciliationResult {
  readonly status: "reconciled";
  readonly sourceAdapter: string;
  readonly connectionEpoch: string;
  /** Snapshot-content revision; distinct from the app-server connection epoch. */
  readonly reconciliationRevision: string;
  /** Agent Farm ingest watermark after the atomic reconciliation commit. */
  readonly watermark: number;
  readonly correctedAgentIds: readonly string[];
  readonly correctedEdgeIds: readonly string[];
  readonly sourceThreadIds: readonly string[];
  readonly listPages: number;
  readonly readPages: number;
  readonly turnCount: number;
  readonly itemCount: number;
}

export type ReconciliationErrorCode =
  | "INVALID_BINDING"
  | "SESSION_NOT_FOUND"
  | "INVALID_PAGE"
  | "LIST_PAGE_LIMIT"
  | "LIST_ITEM_LIMIT"
  | "CURSOR_LOOP"
  | "ROOT_NOT_FOUND"
  | "DUPLICATE_THREAD"
  | "ORPHAN_THREAD"
  | "THREAD_CYCLE"
  | "CROSS_ROOT"
  | "READ_PAGE_LIMIT"
  | "TURN_LIMIT"
  | "ITEM_LIMIT"
  | "NODE_LIMIT"
  | "THREAD_READ_FAILED"
  | "THREAD_MISMATCH"
  | "RECONCILIATION_WRITE_FAILED";

/** Stable, secret-free error classification for callers and logs. */
export class CodexReconciliationError extends Error {
  readonly code: ReconciliationErrorCode;

  constructor(code: ReconciliationErrorCode) {
    super(code);
    this.name = "CodexReconciliationError";
    this.code = code;
  }
}

/** Compatibility alias for callers that use the shorter domain noun. */
export class ReconciliationError extends CodexReconciliationError {}

interface SafeThread {
  readonly sourceThreadId: string;
  readonly sessionId?: string;
  readonly parentThreadId?: string;
  readonly modelProvider?: string;
  readonly status: AgentLifecycle;
  readonly agentNickname?: string;
  readonly agentRole?: string;
  /** Structural Codex subagent lineage label; never a filesystem path. */
  readonly agentPath?: string;
  /** Last structural path segment, preferred for public/store name. */
  readonly agentTaskName?: string;
  readonly sourceKind?: string;
  readonly cliVersion?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

interface SafeCollaboration {
  /** Bounded bridge operation, retained to distinguish spawn from messaging. */
  readonly operation?: string;
  readonly receiverIds?: readonly string[];
  /** Internal marker; malformed receiver references never cross the boundary. */
  readonly malformedReceiverIds?: boolean;
  readonly requestedModel?: string;
  readonly requestedReasoningEffort?: string;
  readonly requestedProvider?: string;
}

interface SafeSettings {
  readonly model?: string;
  readonly provider?: string;
  readonly reasoningEffort?: string;
}

interface SafeReroute {
  readonly toModel?: string;
}

interface SafeSubagentActivity {
  readonly sourceThreadId?: string;
  readonly parentThreadId?: string;
  readonly agentPath?: string;
  readonly agentTaskName?: string;
  readonly status?: string;
}

interface SafeItem {
  readonly sourceItemId?: string;
  readonly collaboration?: SafeCollaboration;
  readonly subagentActivity?: SafeSubagentActivity;
  readonly effectiveSettings?: SafeSettings;
  readonly modelRerouted?: SafeReroute;
}

interface SafeTurn {
  readonly sourceTurnId: string;
  /** Sanitized source lifecycle/status, when the turn supplied one. */
  readonly status?: string;
  readonly items: readonly SafeItem[];
}

interface SafeListPage {
  readonly threads: readonly SafeThread[];
  readonly nextCursor?: string;
}

interface SafeReadPage {
  readonly thread: SafeThread;
  readonly turns: readonly SafeTurn[];
  readonly nextCursor?: string;
}

interface SafeItemParse {
  readonly value: SafeItem;
  readonly malformed: boolean;
}

interface SafeRolloutObservedHistory {
  readonly model?: string;
  readonly effort?: string;
}

interface SafeRolloutRequestedSpawn {
  readonly taskName?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly autoReview?: boolean;
}

/**
 * The bridge returns this shape only after bounded path/record sanitization.
 * The reconciler nevertheless copies the small allowlisted vocabulary instead
 * of retaining the adapter object, so a test/future facade cannot smuggle raw
 * rollout paths, prompts, or function-call arguments into the plan or events.
 */
interface SafeRolloutIdentity {
  readonly sourceThreadId: string;
  readonly lifecycle?: AgentLifecycle;
  readonly modelProvider?: string;
  readonly observedHistory: readonly SafeRolloutObservedHistory[];
  readonly requestedSpawns: readonly SafeRolloutRequestedSpawn[];
  /** Latest cumulative usage; null clears a previously stored ambiguous value. */
  readonly usage?: TokenUsageRecord | null;
  readonly usageSegments?: LocalUsageSegments;
  readonly autoReview: boolean;
}

interface SafeSubagentActivityParse {
  readonly value?: SafeSubagentActivity;
  readonly malformed: boolean;
}

interface CollectedSnapshot {
  readonly threads: readonly SafeThread[];
  readonly readThreads: ReadonlyMap<string, SafeThread>;
  readonly reads: ReadonlyMap<string, readonly SafeTurn[]>;
  readonly listPages: number;
  readonly readPages: number;
  readonly turnCount: number;
  readonly itemCount: number;
  readonly rolloutIdentity: ReadonlyMap<string, SafeRolloutIdentity>;
}

interface IdentityValues {
  readonly provider: string | null;
  readonly model: string | null;
  readonly effort: string | null;
}

interface AgentPlan {
  readonly sourceThreadId: string;
  readonly parentSourceThreadId: string | null;
  readonly agentId: string;
  readonly thread: SafeThread;
  readonly requested: IdentityValues;
  readonly observed: IdentityValues;
  readonly verificationState: VerificationState;
  readonly requestedEvidenceSource: string;
  readonly observedEvidenceSource: string;
  readonly isRoot: boolean;
  readonly displayName: string | null;
  readonly role: string | null;
  /** Undefined means no trusted rollout observation was returned; null clears a known-but-ambiguous value. */
  readonly usage?: TokenUsageRecord | null;
  readonly usageSegments?: LocalUsageSegments;
}

interface ReconciliationPlan extends CollectedSnapshot {
  readonly sourceAdapter: string;
  readonly connectionEpoch: string;
  readonly scope: PrincipalScope;
  readonly agents: readonly AgentPlan[];
  readonly publicBySource: ReadonlyMap<string, string>;
  readonly requestedByAgent: ReadonlyMap<string, IdentityValues>;
  readonly observedByAgent: ReadonlyMap<string, IdentityValues>;
  readonly reconciliationRevision: string;
}

const SOURCE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const SAFE_WORD = /^[A-Za-z0-9._:@+/-]{1,256}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._: @+()/'-]{0,127}$/;
const ROLLOUT_TASK_NAME = /^[a-z0-9][a-z0-9_]{0,127}$/;
const AGENT_PATH_MAX_CHARS = 512;
const AGENT_PATH_MAX_DEPTH = 64;
const CURSOR = /^[A-Za-z0-9._~+=:-]{1,512}$/;
const LIFECYCLES: readonly AgentLifecycle[] = [
  "unknown",
  "pending",
  "queued",
  "active",
  "idle",
  "completed",
  "failed",
  "interrupted",
  "disconnected",
];

const DEFAULT_LIMITS: Required<CodexReconciliationLimits> = {
  maxListPages: 256,
  maxListItems: 20_000,
  maxReadPages: 2_048,
  maxTurns: 100_000,
  maxItems: 200_000,
  maxNodes: 50_000,
  listPageSize: 200,
};

function boundedPositive(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new CodexReconciliationError("INVALID_PAGE");
  return Math.min(value, ceiling);
}

function resolveLimits(input: CodexReconciliationLimits | undefined): Required<CodexReconciliationLimits> {
  return {
    maxListPages: boundedPositive(input?.maxListPages, DEFAULT_LIMITS.maxListPages, 10_000),
    maxListItems: boundedPositive(input?.maxListItems, DEFAULT_LIMITS.maxListItems, 1_000_000),
    maxReadPages: boundedPositive(input?.maxReadPages, DEFAULT_LIMITS.maxReadPages, 100_000),
    maxTurns: boundedPositive(input?.maxTurns, DEFAULT_LIMITS.maxTurns, 1_000_000),
    maxItems: boundedPositive(input?.maxItems, DEFAULT_LIMITS.maxItems, 2_000_000),
    maxNodes: boundedPositive(input?.maxNodes, DEFAULT_LIMITS.maxNodes, 1_000_000),
    listPageSize: boundedPositive(input?.listPageSize, DEFAULT_LIMITS.listPageSize, 200),
  };
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && SOURCE_ID.test(value) ? value : undefined;
}

function safeWord(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_WORD.test(value) ? value : undefined;
}

function safeLabel(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_LABEL.test(value) ? value : undefined;
}

function safeAgentPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > AGENT_PATH_MAX_CHARS || !value.startsWith("/")) return undefined;
  const segments = value.slice(1).split("/");
  if (segments.length === 0 || segments.length > AGENT_PATH_MAX_DEPTH || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || !/^[A-Za-z0-9._:@+-]{1,128}$/.test(segment))) return undefined;
  return value;
}

function safeAgentTaskName(value: unknown): string | undefined {
  return typeof value === "string" && value !== "." && value !== ".." && /^[A-Za-z0-9._:@+-]{1,128}$/.test(value) ? value : undefined;
}

function safeFallbackThread(value: TrustedLocalTopologyNode): SafeThread | undefined {
  const sourceThreadId = safeId(value.sourceThreadId);
  const parentThreadId = safeId(value.parentThreadId);
  const agentPath = safeAgentPath(value.agentPath);
  const agentTaskName = safeAgentTaskName(value.agentTaskName);
  const modelProvider = safeWord(value.modelProvider);
  if (!sourceThreadId || !parentThreadId || (value.agentPath !== undefined && !agentPath) ||
      (value.agentTaskName !== undefined && !agentTaskName) || (value.modelProvider !== undefined && !modelProvider) ||
      !LIFECYCLES.includes(value.status)) return undefined;
  return {
    sourceThreadId,
    parentThreadId,
    status: value.status,
    ...(agentPath === undefined ? {} : { agentPath }),
    ...(agentTaskName === undefined ? {} : { agentTaskName }),
    ...(modelProvider === undefined ? {} : { modelProvider }),
    sourceKind: "rollout-fallback",
  };
}

function safeRolloutIdentity(value: RolloutIdentityEvidence | undefined, sourceThreadId: string): SafeRolloutIdentity | undefined {
  if (!value || typeof value !== "object" || value.sourceThreadId !== sourceThreadId) return undefined;
  const modelProvider = value.modelProvider === undefined || value.modelProvider === null ? undefined : safeWord(value.modelProvider);
  const rolloutLifecycle = value.lifecycle === undefined || value.lifecycle === null ? undefined : lifecycle(value.lifecycle);
  if (value.lifecycle !== undefined && value.lifecycle !== null && rolloutLifecycle === "unknown" && value.lifecycle !== "unknown") return undefined;
  if (value.modelProvider !== undefined && value.modelProvider !== null && modelProvider === undefined) return undefined;
  if (!Array.isArray(value.observedHistory) || !Array.isArray(value.requestedSpawns)) return undefined;
  // The bridge already imposes tighter bounds. Keep an adapter/facade failure
  // from turning into unbounded work if a malformed implementation is passed
  // through this deliberately small structural interface.
  if (value.observedHistory.length > 10_000 || value.requestedSpawns.length > 10_000) return undefined;
  const observedHistory: SafeRolloutObservedHistory[] = [];
  let autoReview = false;
  for (const entry of value.observedHistory) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const candidate = entry as { readonly model?: unknown; readonly effort?: unknown };
    const rawModel = candidate.model === undefined || candidate.model === null ? undefined : safeWord(candidate.model);
    const model = rawModel === undefined ? undefined : canonicalCodexModel(rawModel);
    if (isCodexAutoReviewModel(rawModel)) autoReview = true;
    const effort = candidate.effort === undefined || candidate.effort === null ? undefined : safeWord(candidate.effort);
    if ((candidate.model !== undefined && candidate.model !== null && model === undefined) || (candidate.effort !== undefined && candidate.effort !== null && effort === undefined)) return undefined;
    if (model === undefined && effort === undefined) continue;
    observedHistory.push({
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    });
  }
  const requestedSpawns: SafeRolloutRequestedSpawn[] = [];
  for (const entry of value.requestedSpawns) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const candidate = entry as { readonly taskName?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown };
    const taskName = candidate.taskName === undefined || candidate.taskName === null ? undefined : typeof candidate.taskName === "string" && ROLLOUT_TASK_NAME.test(candidate.taskName) ? candidate.taskName : undefined;
    const rawModel = candidate.model === undefined || candidate.model === null ? undefined : safeWord(candidate.model);
    const model = rawModel === undefined ? undefined : canonicalCodexModel(rawModel);
    const spawnAutoReview = isCodexAutoReviewModel(rawModel);
    const reasoningEffort = candidate.reasoningEffort === undefined || candidate.reasoningEffort === null ? undefined : safeWord(candidate.reasoningEffort);
    if ((candidate.taskName !== undefined && candidate.taskName !== null && taskName === undefined) || (candidate.model !== undefined && candidate.model !== null && model === undefined) || (candidate.reasoningEffort !== undefined && candidate.reasoningEffort !== null && reasoningEffort === undefined)) return undefined;
    if (taskName === undefined && model === undefined && reasoningEffort === undefined) continue;
    requestedSpawns.push({
      ...(taskName === undefined ? {} : { taskName }),
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(spawnAutoReview ? { autoReview: true } : {}),
    });
  }
  const rawUsage = value.usage;
  const usage = rawUsage === undefined ? (value.usageAmbiguous === true ? null : undefined) : {
    inputTokens: rawUsage.inputTokens,
    cachedInputTokens: rawUsage.cachedInputTokens,
    cacheWriteInputTokens: rawUsage.cacheWriteInputTokens,
    outputTokens: rawUsage.outputTokens,
    reasoningOutputTokens: rawUsage.reasoningOutputTokens,
    totalTokens: rawUsage.totalTokens,
    ...(rawUsage.observedAt === undefined ? {} : { observedAt: rawUsage.observedAt }),
  } satisfies TokenUsageRecord;
  if (rawUsage !== undefined && [rawUsage.inputTokens, rawUsage.cachedInputTokens, rawUsage.cacheWriteInputTokens, rawUsage.outputTokens, rawUsage.reasoningOutputTokens, rawUsage.totalTokens].some((item) => !Number.isSafeInteger(item) || item < 0)) return undefined;
  if (rawUsage !== undefined && (rawUsage.cachedInputTokens + rawUsage.cacheWriteInputTokens > rawUsage.inputTokens || rawUsage.totalTokens !== rawUsage.inputTokens + rawUsage.outputTokens || (rawUsage.observedAt !== undefined && !Number.isFinite(Date.parse(rawUsage.observedAt))))) return undefined;
  let usageSegments: LocalUsageSegments | undefined;
  if (value.usageSegments !== undefined || value.usageSegmentsComplete !== undefined) {
    // An incomplete stream may have no attributable invocation yet. Keep its
    // independent model/effort evidence instead of rejecting the whole record.
    if (typeof value.usageSegmentsComplete !== "boolean" || (value.usageSegments === undefined && value.usageSegmentsComplete)) return undefined;
    const rawSegments = value.usageSegments ?? [];
    if (!Array.isArray(rawSegments) || rawSegments.length > 1_024) return undefined;
    const segments = rawSegments.map((segment) => ({
      turnId: safeWord(segment.turnId),
      provider: safeWord(segment.provider),
      model: safeWord(segment.model) === undefined ? undefined : canonicalCodexModel(segment.model),
      effort: safeWord(segment.effort),
      usage: segment.usage,
    }));
    if (rawSegments.some((segment) => isCodexAutoReviewModel(segment.model))) autoReview = true;
    if (segments.some((segment) => Object.values(segment).some((item) => item === undefined)) || segments.some((segment) => !segment.usage || !validRolloutUsage(segment.usage))) return undefined;
    usageSegments = { complete: value.usageSegmentsComplete, segments: segments as LocalUsageSegments["segments"] };
  }
  if (modelProvider === undefined && rolloutLifecycle === undefined && observedHistory.length === 0 && requestedSpawns.length === 0 && usage === undefined && usageSegments === undefined) return undefined;
  return {
    sourceThreadId,
    ...(rolloutLifecycle === undefined ? {} : { lifecycle: rolloutLifecycle }),
    ...(modelProvider === undefined ? {} : { modelProvider }),
    observedHistory,
    requestedSpawns,
    autoReview,
    ...(usage === undefined ? {} : { usage }),
    ...(usageSegments === undefined ? {} : { usageSegments }),
  };
}

function validRolloutUsage(usage: TokenUsageRecord): boolean {
  return [usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens, usage.outputTokens, usage.reasoningOutputTokens, usage.totalTokens].every((item) => Number.isSafeInteger(item) && item >= 0) &&
    usage.cachedInputTokens + usage.cacheWriteInputTokens <= usage.inputTokens && usage.totalTokens === usage.inputTokens + usage.outputTokens &&
    (usage.observedAt === undefined || Number.isFinite(Date.parse(usage.observedAt)));
}

function taskNameFromPath(value: string): string | undefined {
  const taskName = value.slice(value.lastIndexOf("/") + 1);
  return taskName !== "." && taskName !== ".." && SAFE_WORD.test(taskName) ? taskName : undefined;
}

interface StrictReferenceField {
  readonly present: boolean;
  readonly value?: string | undefined;
  readonly malformed: boolean;
}

/**
 * Read structural thread references without laundering malformed aliases.
 * App-server versions have used several names for the same child id; when
 * more than one is present they must agree byte-for-byte.
 */
function strictReferenceField(source: Record<string, unknown>, keys: readonly string[]): StrictReferenceField {
  let present = false;
  let value: string | undefined;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] === undefined) continue;
    present = true;
    const parsed = safeId(source[key]);
    if (parsed === undefined) return { present, malformed: true };
    if (value !== undefined && value !== parsed) return { present, malformed: true };
    value = parsed;
  }
  return { present, value, malformed: false };
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function lifecycle(value: unknown): AgentLifecycle {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();
  return LIFECYCLES.includes(normalized as AgentLifecycle) ? normalized as AgentLifecycle : "unknown";
}

function optionalField<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value } as Record<string, T>;
}

function safeThread(value: unknown): SafeThread | undefined {
  const source = record(value);
  if (!source) return undefined;
  const sourceThreadField = strictReferenceField(source, ["sourceThreadId", "id", "threadId"]);
  const sourceThreadId = sourceThreadField.value;
  if (sourceThreadField.malformed || !sourceThreadId) return undefined;
  const sessionId = safeId(source.sessionId ?? source.session_id);
  const parentCandidate = source.parentThreadId ?? source.parentId;
  const forkedFromCandidate = source.forkedFromId ?? source.forked_from_id;
  const parentPresent = parentCandidate !== null && parentCandidate !== undefined;
  const forkedFromPresent = forkedFromCandidate !== null && forkedFromCandidate !== undefined;
  const parentThreadId = parentPresent ? safeId(parentCandidate) : undefined;
  const forkedFromId = forkedFromPresent ? safeId(forkedFromCandidate) : undefined;
  // Codex bridge-minimized snapshots may expose spawn lineage as
  // `forkedFromId` instead of `parentThreadId`. Both are accepted as the
  // same parent assertion, but an invalid or conflicting assertion is
  // ambiguous and must fail closed before graph traversal or reads.
  if ((parentPresent && parentThreadId === undefined) || (forkedFromPresent && forkedFromId === undefined)) return undefined;
  if (parentThreadId !== undefined && forkedFromId !== undefined && parentThreadId !== forkedFromId) return undefined;
  const canonicalParentThreadId = parentThreadId ?? forkedFromId;
  const pathPresent = Object.prototype.hasOwnProperty.call(source, "agentPath") && source.agentPath !== undefined;
  const taskNamePresent = Object.prototype.hasOwnProperty.call(source, "agentTaskName") && source.agentTaskName !== undefined;
  const agentPath = pathPresent ? safeAgentPath(source.agentPath) : undefined;
  const agentTaskName = taskNamePresent ? safeAgentTaskName(source.agentTaskName) : agentPath === undefined ? undefined : taskNameFromPath(agentPath);
  if ((pathPresent && agentPath === undefined) || (taskNamePresent && agentTaskName === undefined)) return undefined;
  if (agentPath !== undefined && agentTaskName !== taskNameFromPath(agentPath)) return undefined;
  return {
    sourceThreadId,
    ...optionalField("sessionId", sessionId),
    ...optionalField("parentThreadId", canonicalParentThreadId),
    ...optionalField("modelProvider", safeWord(source.modelProvider ?? source.provider)),
    status: lifecycle(source.status ?? source.state),
    ...optionalField("agentNickname", safeLabel(source.agentNickname ?? source.nickname)),
    ...optionalField("agentRole", safeLabel(source.agentRole ?? source.role)),
    ...optionalField("agentPath", agentPath),
    ...optionalField("agentTaskName", agentTaskName),
    ...optionalField("sourceKind", safeWord(source.sourceKind ?? source.source)),
    ...optionalField("cliVersion", safeWord(source.cliVersion ?? source.version)),
    ...optionalField("createdAt", safeTimestamp(source.createdAt ?? source.created_at)),
    ...optionalField("updatedAt", safeTimestamp(source.updatedAt ?? source.updated_at)),
  };
}

function safeCollaboration(value: unknown): SafeCollaboration | undefined {
  const source = record(value);
  if (!source) return undefined;
  const operation = safeWord(source.operation ?? source.op ?? source.tool);
  const receiverKeys = ["receiverIds", "receivers", "receiver", "to", "receiverThreadIds"] as const;
  let receiverIds: string[] | undefined;
  let malformedReceiverIds = false;
  let receiverFieldPresent = false;
  for (const key of receiverKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] === undefined) continue;
    receiverFieldPresent = true;
    const raw = source[key];
    const parsed = Array.isArray(raw)
      ? raw.map(safeId)
      : [safeId(raw)];
    if (parsed.some((id) => id === undefined)) malformedReceiverIds = true;
    const valid = [...new Set(parsed.filter((id): id is string => id !== undefined))];
    if (receiverIds !== undefined && stableJson([...receiverIds].sort()) !== stableJson([...valid].sort())) malformedReceiverIds = true;
    if (receiverIds === undefined && valid.length > 0) receiverIds = valid;
  }
  const requestedModel = safeWord(source.requestedModel ?? source.model);
  const requestedReasoningEffort = safeWord(source.requestedReasoningEffort ?? source.reasoningEffort ?? source.effort);
  const requestedProvider = safeWord(source.requestedProvider ?? source.provider);
  if (!operation && !receiverIds?.length && !requestedModel && !requestedReasoningEffort && !requestedProvider && !malformedReceiverIds) return undefined;
  return {
    ...optionalField("operation", operation),
    ...optionalField("receiverIds", receiverIds),
    ...(receiverFieldPresent && malformedReceiverIds ? { malformedReceiverIds: true } : {}),
    ...optionalField("requestedModel", requestedModel),
    ...optionalField("requestedReasoningEffort", requestedReasoningEffort),
    ...optionalField("requestedProvider", requestedProvider),
  };
}

function safeSettings(value: unknown): SafeSettings | undefined {
  const source = record(value);
  if (!source) return undefined;
  const model = safeWord(source.model ?? source.effectiveModel ?? source.modelId);
  const provider = safeWord(source.provider ?? source.modelProvider ?? source.effectiveProvider);
  const reasoningEffort = safeWord(source.reasoningEffort ?? source.effort ?? source.effectiveReasoningEffort);
  if (!model && !provider && !reasoningEffort) return undefined;
  return {
    ...optionalField("model", model),
    ...optionalField("provider", provider),
    ...optionalField("reasoningEffort", reasoningEffort),
  };
}

function safeReroute(value: unknown): SafeReroute | undefined {
  const source = record(value);
  if (!source) return undefined;
  const toModel = safeWord(source.toModel ?? source.to ?? source.model);
  return toModel === undefined ? undefined : { toModel };
}

function parseSubagentActivity(value: unknown): SafeSubagentActivityParse {
  const source = record(value);
  if (!source) return { malformed: true };
  const sourceThreadField = strictReferenceField(source, ["sourceThreadId", "threadId", "childThreadId", "subagentThreadId", "agentThreadId"]);
  const parentThreadField = strictReferenceField(source, ["parentThreadId", "parentId"]);
  let agentPath: string | undefined;
  for (const key of ["agentPath", "agent_path"] as const) {
    if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] === undefined) continue;
    const parsed = safeAgentPath(source[key]);
    if (parsed === undefined || (agentPath !== undefined && agentPath !== parsed)) return { malformed: true };
    agentPath = parsed;
  }
  let agentTaskName: string | undefined;
  for (const key of ["agentTaskName", "agent_task_name", "taskName"] as const) {
    if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] === undefined) continue;
    const parsed = safeAgentTaskName(source[key]);
    if (parsed === undefined || (agentTaskName !== undefined && agentTaskName !== parsed)) return { malformed: true };
    agentTaskName = parsed;
  }
  if (sourceThreadField.malformed || parentThreadField.malformed ||
      (agentPath !== undefined && agentTaskName !== undefined && taskNameFromPath(agentPath) !== agentTaskName)) {
    return { malformed: true };
  }
  if (agentPath !== undefined && agentTaskName === undefined) agentTaskName = taskNameFromPath(agentPath);
  const statusValue = source.status ?? source.state ?? source.kind;
  const status = typeof statusValue === "string" ? safeWord(statusValue) : undefined;
  const hasValue = sourceThreadField.value !== undefined || parentThreadField.value !== undefined || agentPath !== undefined || agentTaskName !== undefined || status !== undefined;
  if (!hasValue) return { malformed: false };
  return {
    malformed: false,
    value: {
      ...optionalField("sourceThreadId", sourceThreadField.value),
      ...optionalField("parentThreadId", parentThreadField.value),
      ...optionalField("agentPath", agentPath),
      ...optionalField("agentTaskName", agentTaskName),
      ...optionalField("status", status),
    },
  };
}

function parseSafeItem(value: unknown): SafeItemParse {
  const source = record(value);
  if (!source) return { value: {}, malformed: false };
  const collaborationValue = source.collaboration ?? source.collabAgentToolCall ?? source.collab;
  const nestedCollaboration = safeCollaboration(collaborationValue);
  // Parse item-level aliases as a second integrity check even when a nested
  // collaboration object is present; a malformed receiver must not disappear
  // merely because a valid nested shape won precedence.
  const directCollaboration = safeCollaboration(source);
  const collaboration = nestedCollaboration ?? directCollaboration;
  const collaborationMalformed = nestedCollaboration?.malformedReceiverIds === true || directCollaboration?.malformedReceiverIds === true;
  const activityKeys = ["subagentActivity", "subAgentActivity", "activity"] as const;
  const hasNestedActivity = activityKeys.some((key) => Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined);
  const activityParse = hasNestedActivity
    ? parseSubagentActivity(activityKeys.map((key) => source[key]).find((candidate) => candidate !== undefined))
    : [source.kind, source.type, source.itemType].some((kind) => kind === "subagent_activity" || kind === "subagent.activity")
      ? parseSubagentActivity(source)
      : { malformed: false };
  const nestedSettings = safeSettings(source.effectiveSettings ?? source.threadSettings ?? source.settings);
  const nestedReroute = safeReroute(source.modelRerouted ?? source.modelReroute ?? source.rerouted);
  const result: SafeItem = {
    ...optionalField("sourceItemId", safeId(source.sourceItemId ?? source.id ?? source.itemId)),
    // Bridge-minimized items carry a nested collaboration object. Accept the
    // same safe vocabulary at item level for narrow structural test/adapters,
    // never the raw item itself.
    ...optionalField("collaboration", collaboration),
    ...optionalField("subagentActivity", activityParse.value),
    ...optionalField("effectiveSettings", nestedSettings ?? safeSettings(source)),
    ...optionalField("modelRerouted", nestedReroute ?? safeReroute(source)),
  };
  return { value: result, malformed: collaborationMalformed || activityParse.malformed };
}

function safeTurn(value: unknown): SafeTurn | undefined {
  const source = record(value);
  if (!source) return undefined;
  const sourceTurnId = safeId(source.sourceTurnId ?? source.id ?? source.turnId);
  if (!sourceTurnId) return undefined;
  const values = source.items ?? source.turnItems;
  const items: SafeItem[] = [];
  if (Array.isArray(values)) {
    for (const candidate of values) {
      const parsed = parseSafeItem(candidate);
      if (parsed.malformed) throw new CodexReconciliationError("INVALID_PAGE");
      items.push(parsed.value);
    }
  }
  const statusValue = source.status ?? source.state;
  const status = typeof statusValue === "string" ? safeWord(statusValue) : undefined;
  return { sourceTurnId, ...optionalField("status", status), items };
}

function safeListPage(value: unknown): SafeListPage {
  const source = record(value);
  if (!source) throw new CodexReconciliationError("INVALID_PAGE");
  const values = source.threads ?? source.data ?? source.items;
  if (!Array.isArray(values)) throw new CodexReconciliationError("INVALID_PAGE");
  const threads: SafeThread[] = [];
  for (const candidate of values) {
    const thread = safeThread(candidate);
    if (!thread) throw new CodexReconciliationError("INVALID_PAGE");
    threads.push(thread);
  }
  const rawNext = source.nextCursor ?? source.next_cursor;
  if (rawNext === undefined || rawNext === null) return { threads };
  if (typeof rawNext !== "string" || !CURSOR.test(rawNext)) throw new CodexReconciliationError("INVALID_PAGE");
  return { threads, nextCursor: rawNext };
}

function safeReadPage(value: unknown): SafeReadPage {
  const source = record(value);
  if (!source) throw new CodexReconciliationError("INVALID_PAGE");
  const thread = safeThread(source.thread ?? source.data);
  if (!thread) throw new CodexReconciliationError("INVALID_PAGE");
  const rawTurns = source.turns ?? record(source.thread ?? source.data)?.turns;
  if (rawTurns !== undefined && !Array.isArray(rawTurns)) throw new CodexReconciliationError("INVALID_PAGE");
  const turns: SafeTurn[] = [];
  for (const candidate of (Array.isArray(rawTurns) ? rawTurns : [])) {
    const turn = safeTurn(candidate);
    if (!turn) throw new CodexReconciliationError("INVALID_PAGE");
    turns.push(turn);
  }
  const rawNext = source.nextCursor ?? source.next_cursor;
  if (rawNext === undefined || rawNext === null) return { thread, turns };
  if (typeof rawNext !== "string" || !CURSOR.test(rawNext)) throw new CodexReconciliationError("INVALID_PAGE");
  return { thread, turns, nextCursor: rawNext };
}

function scopeOf(binding: CodexRuntimeBinding): PrincipalScope {
  return {
    tenantId: binding.tenantId,
    ownerId: binding.ownerId,
    agentSessionId: binding.agentSessionId,
  };
}

function assertBinding(binding: CodexRuntimeBinding): void {
  if (!binding || typeof binding !== "object") throw new CodexReconciliationError("INVALID_BINDING");
  const candidate = binding as CodexRuntimeBinding & { readonly verified?: unknown };
  if (
    binding.status === "revoked" ||
    binding.status === "expired" ||
    (candidate.verified !== undefined && candidate.verified !== true) ||
    !safeId(binding.tenantId) ||
    !safeId(binding.ownerId) ||
    !safeId(binding.agentSessionId) ||
    !safeId(binding.sourceRootId)
  ) throw new CodexReconciliationError("INVALID_BINDING");
}

function assertEpoch(epoch: string): void {
  if (!SOURCE_ID.test(epoch)) throw new CodexReconciliationError("INVALID_BINDING");
}

function stableAgentId(sourceAdapter: string, sourceThreadId: string): string {
  // The source identifier remains private in the store; the public id is a
  // deterministic opaque projection and therefore survives reconnects.
  return `agent:${sha256({ sourceAdapter, sourceThreadId }).slice(0, 40)}`;
}

function valuesFromParts(value: {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly reasoningEffort?: string | undefined;
} | undefined): IdentityValues {
  return {
    provider: value?.provider ?? null,
    model: value?.model === undefined ? null : canonicalCodexModel(value.model),
    effort: value?.effort ?? value?.reasoningEffort ?? null,
  };
}

function mergeIdentity(current: IdentityValues, next: IdentityValues): IdentityValues {
  return {
    provider: next.provider ?? current.provider,
    model: next.model ?? current.model,
    effort: next.effort ?? current.effort,
  };
}

function verifyIdentity(requested: IdentityValues, observed: IdentityValues): VerificationState {
  let compared = false;
  for (const key of ["provider", "model", "effort"] as const) {
    if (requested[key] === null) continue;
    compared = true;
    if (observed[key] === null) return "unverified";
    if (observed[key] !== requested[key]) return "mismatch";
  }
  // A requested identity may intentionally omit provider/model/effort. Only
  // the dimensions actually requested participate in verification.
  return compared ? "verified" : "unverified";
}

function cursorMapToChildren(threads: readonly SafeThread[]): Map<string, SafeThread[]> {
  const children = new Map<string, SafeThread[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const list = children.get(thread.parentThreadId) ?? [];
    list.push(thread);
    children.set(thread.parentThreadId, list);
  }
  return children;
}

function validateGraph(threads: readonly SafeThread[], rootId: string): readonly SafeThread[] {
  const byId = new Map<string, SafeThread>();
  for (const thread of threads) {
    const existing = byId.get(thread.sourceThreadId);
    // A source identity appearing twice is ambiguous even when the sanitized
    // records happen to be byte-identical. A repeated page/cursor can otherwise
    // make a partial source graph look complete, so reject every duplicate.
    if (existing) throw new CodexReconciliationError("DUPLICATE_THREAD");
    byId.set(thread.sourceThreadId, thread);
  }
  const root = byId.get(rootId);
  if (!root) throw new CodexReconciliationError("ROOT_NOT_FOUND");
  // `thread/list` is installation-global. A selected Codex task may itself be
  // a subagent of another visible task, so its upstream parent is outside the
  // selected projection boundary, not proof of a cross-root payload. Treat
  // the trusted bound id as this view's root and keep only descendants below
  // it; read/list consistency still validates every included child edge.
  const selectedRoot = root.parentThreadId === undefined
    ? root
    : (({ parentThreadId: _upstreamParent, ...boundedRoot }) => boundedRoot)(root);

  const children = cursorMapToChildren([...byId.values()]);
  const selected: SafeThread[] = [];
  const seen = new Set<string>();
  const queue = [selectedRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.sourceThreadId)) continue;
    seen.add(current.sourceThreadId);
    selected.push(current);
    for (const child of children.get(current.sourceThreadId) ?? []) queue.push(child);
  }
  // `thread/list` is a global source index: unrelated historical roots may
  // contain orphaned or cyclic records that are outside the configured root.
  // Validate only the selected root subtree; an orphan/cycle reachable from
  // this root remains fail-closed, while unrelated global debris is ignored.
  for (const thread of selected) {
    if (thread.parentThreadId !== undefined && !byId.has(thread.parentThreadId)) {
      throw new CodexReconciliationError("ORPHAN_THREAD");
    }
    const visited = new Set<string>();
    let cursor: string | undefined = thread.sourceThreadId;
    while (cursor !== undefined) {
      if (visited.has(cursor)) throw new CodexReconciliationError("THREAD_CYCLE");
      visited.add(cursor);
      cursor = byId.get(cursor)?.parentThreadId;
    }
  }
  selected.sort((left, right) => left.sourceThreadId.localeCompare(right.sourceThreadId));
  // Keep the root first for deterministic event ordering and public output.
  const rootIndex = selected.findIndex((thread) => thread.sourceThreadId === rootId);
  if (rootIndex > 0) {
    const [selectedRoot] = selected.splice(rootIndex, 1);
    if (selectedRoot) selected.unshift(selectedRoot);
  }
  return selected;
}

async function collectThreads(
  client: CodexSnapshotClient,
  limits: Required<CodexReconciliationLimits>,
): Promise<{ readonly threads: readonly SafeThread[]; readonly pages: number }> {
  const collected = new Map<string, SafeThread>();
  let pages = 0;
  let itemCount = 0;

  // Archived and non-archived results are separate app-server indexes. A
  // single explicit sourceKinds query only returns active/interactive roots,
  // which is why completed nested agents can otherwise disappear after a
  // restart. The page and item ceilings apply to the combined traversal.
  for (const archived of [false, true] as const) {
    const seenCursors = new Set<string>();
    const seenIdsInSet = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      if (pages >= limits.maxListPages) throw new CodexReconciliationError("LIST_PAGE_LIMIT");
      let raw: unknown;
      try {
        raw = await client.listThreads(Object.freeze({
          archived,
          useStateDbOnly: false,
          sourceKinds: CODEX_DISCOVERY_SOURCE_KINDS,
          limit: limits.listPageSize,
          ...(cursor === undefined ? {} : { cursor }),
        }));
      } catch {
        throw new CodexReconciliationError("INVALID_PAGE");
      }
      pages += 1;
      const value = safeListPage(raw);
      itemCount += value.threads.length;
      if (itemCount > limits.maxListItems) throw new CodexReconciliationError("LIST_ITEM_LIMIT");
      for (const thread of value.threads) {
        if (seenIdsInSet.has(thread.sourceThreadId)) {
          throw new CodexReconciliationError("DUPLICATE_THREAD");
        }
        seenIdsInSet.add(thread.sourceThreadId);
        const prior = collected.get(thread.sourceThreadId);
        if (prior !== undefined) {
          // A server may surface the same immutable record in both indexes;
          // dedupe that benign overlap, but never merge conflicting lineage or
          // lifecycle metadata from the two authority sets.
          if (stableJson(prior) !== stableJson(thread)) {
            throw new CodexReconciliationError("DUPLICATE_THREAD");
          }
          continue;
        }
        collected.set(thread.sourceThreadId, thread);
      }
      if (value.nextCursor === undefined) break;
      if (seenCursors.has(value.nextCursor)) throw new CodexReconciliationError("CURSOR_LOOP");
      seenCursors.add(value.nextCursor);
      cursor = value.nextCursor;
    }
  }
  return { threads: [...collected.values()], pages };
}

interface ChildReference {
  readonly sourceThreadId: string;
  readonly parentThreadId?: string;
  /** The reference shape determines whether an explicit parent is a
   *  direct lineage assertion or merely an interaction callback. */
  readonly kind: "activity" | "collaboration";
}

/** Only explicit bridge spawn operations can assert a new parent edge. */
function isSpawnOperation(operation: string | undefined): boolean {
  if (operation === undefined) return false;
  const normalized = operation.toLowerCase();
  return normalized === "spawn" || normalized === "spawn_agent" || normalized === "spawnagent" ||
    normalized === "thread_spawn" || normalized === "thread-spawn" || normalized === "threadspawn" ||
    normalized === "subagent_spawn" || normalized === "subagent-spawn" || normalized === "subagentspawn";
}

/**
 * Extract only structural child references from sanitized turn items. Raw
 * prompts, messages, and arbitrary item fields never enter this traversal.
 */
function childReferences(turns: readonly SafeTurn[]): readonly ChildReference[] {
  const refs: ChildReference[] = [];
  const add = (sourceThreadId: string, kind: ChildReference["kind"], parentThreadId?: string): void => {
    refs.push({
      sourceThreadId,
      kind,
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
    });
  };
  for (const turn of turns) {
    for (const item of turn.items) {
      const activity = item.subagentActivity;
      if (activity?.sourceThreadId !== undefined) add(activity.sourceThreadId, "activity", activity.parentThreadId);
      if (isSpawnOperation(item.collaboration?.operation)) {
        for (const receiver of item.collaboration?.receiverIds ?? []) add(receiver, "collaboration");
      }
    }
  }
  return refs;
}

/** Infer a lifecycle only from an explicit latest turn status. */
function lifecycleFromTurns(turns: readonly SafeTurn[]): AgentLifecycle | undefined {
  const status = turns.at(-1)?.status?.toLowerCase();
  switch (status) {
    case "completed":
    case "complete":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "interrupted":
    case "aborted":
    case "cancelled":
    case "canceled":
      return "interrupted";
    case "started":
    case "start":
    case "running":
    case "in_progress":
    case "in-progress":
    case "active":
    case "working":
      return "active";
    default:
      // `unknown`, `not_loaded`, and unrelated statuses are deliberately
      // non-authoritative when they are the latest turn state.
      return undefined;
  }
}

interface ReadTarget {
  readonly sourceThreadId: string;
  readonly listedThread?: SafeThread;
  /** Candidate direct referrers collected before this child is read. */
  readonly expectedParentThreadIds?: ReadonlySet<string>;
  readonly discovered: boolean;
}

interface HeldRead {
  readonly target: ReadTarget;
  readonly thread: SafeThread;
  readonly turns: readonly SafeTurn[];
}

async function collectRead(
  client: CodexSnapshotClient,
  selected: readonly SafeThread[],
  limits: Required<CodexReconciliationLimits>,
  supplementalIds: ReadonlySet<string> = new Set(),
): Promise<{
  readonly reads: ReadonlyMap<string, readonly SafeTurn[]>;
  readonly readThreads: ReadonlyMap<string, SafeThread>;
  readonly rolloutIdentity: ReadonlyMap<string, SafeRolloutIdentity>;
  readonly discoveredThreads: readonly SafeThread[];
  readonly pages: number;
  readonly turns: number;
  readonly items: number;
}> {
  const reads = new Map<string, readonly SafeTurn[]>();
  const readThreads = new Map<string, SafeThread>();
  const rolloutIdentity = new Map<string, SafeRolloutIdentity>();
  const discoveredThreads = new Map<string, SafeThread>();
  const initialIds = new Set(selected.map((thread) => thread.sourceThreadId));
  const queuedIds = new Set<string>();
  // A child can appear in inherited spawn history on an ancestor and in the
  // actual parent's history before its one-shot thread/read occurs. Keep a
  // bounded set of candidate direct referrers rather than rejecting the
  // second, potentially valid, assertion as a cross-root conflict.
  const candidateParentsById = new Map<string, Set<string>>();
  // A queued child may be read before a later queue entry (its actual parent)
  // contributes a candidate. Hold that read's turns until canonical lineage
  // is validated; held turns never expand descendants or request rollout
  // identity evidence.
  const heldReads = new Map<string, HeldRead>();
  const activatedReads = new Set<string>();
  const queue: ReadTarget[] = [];
  // `validateGraph` keeps the root first but sorts descendants for stable
  // output. Re-establish breadth-first read order here so direct children are
  // read before grandchildren even when thread/list returned lexical order.
  const listedByParent = cursorMapToChildren(selected);
  const orderedSelected: SafeThread[] = [];
  const orderedIds = new Set<string>();
  const orderedQueue: SafeThread[] = selected[0] === undefined ? [] : [selected[0]];
  while (orderedQueue.length > 0) {
    const listed = orderedQueue.shift();
    if (listed === undefined || orderedIds.has(listed.sourceThreadId)) continue;
    orderedIds.add(listed.sourceThreadId);
    orderedSelected.push(listed);
    for (const child of listedByParent.get(listed.sourceThreadId) ?? []) orderedQueue.push(child);
  }
  for (const listed of selected) if (!orderedIds.has(listed.sourceThreadId)) orderedSelected.push(listed);
  for (const listed of orderedSelected) {
    queue.push({
      sourceThreadId: listed.sourceThreadId,
      listedThread: listed,
      ...(listed.parentThreadId === undefined ? {} : { expectedParentThreadIds: new Set([listed.parentThreadId]) }),
      discovered: false,
    });
    queuedIds.add(listed.sourceThreadId);
  }
  if (queuedIds.size > limits.maxNodes) throw new CodexReconciliationError("NODE_LIMIT");
  let pages = 0;
  let turnCount = 0;
  let itemCount = 0;
  const addCandidateParent = (childId: string, parentId: string): Set<string> => {
    let candidateParents = candidateParentsById.get(childId);
    if (candidateParents === undefined) {
      candidateParents = new Set<string>();
      candidateParentsById.set(childId, candidateParents);
    }
    if (!candidateParents.has(parentId)) {
      // The number of candidate direct referrers is bounded independently of
      // receiver-array size; it cannot grow beyond the node budget.
      if (candidateParents.size >= limits.maxNodes) throw new CodexReconciliationError("NODE_LIMIT");
      candidateParents.add(parentId);
    }
    return candidateParents;
  };
  const activateRead = async (record: HeldRead): Promise<void> => {
    const { target, thread, turns } = record;
    if (activatedReads.has(target.sourceThreadId)) return;
    activatedReads.add(target.sourceThreadId);
    for (const reference of childReferences(turns)) {
      const childId = reference.sourceThreadId;
      // A subagent activity record may describe an ancestor/sibling callback
      // rather than a direct spawn. An explicit parent that is not the
      // currently read thread proves that interaction shape, so it must not
      // be interpreted as a new edge from this target. Collaboration spawn
      // references have no explicit parent and remain direct assertions.
      if (reference.kind === "activity" && reference.parentThreadId !== undefined && reference.parentThreadId !== target.sourceThreadId) {
        continue;
      }
      if (childId === target.sourceThreadId) throw new CodexReconciliationError("THREAD_CYCLE");
      // References to nodes already established by thread/list are
      // interactions, not new lineage assertions. Ancestor/sibling
      // activity must not rewrite the authoritative list graph.
      if (initialIds.has(childId)) continue;
      const held = heldReads.get(childId);
      if (held !== undefined) {
        // A held node's turns remain opaque until its own canonical parent is
        // validated. A direct referrer can confirm that candidate without
        // expanding the held node or treating the ref as a reparenting.
        if (held.thread.parentThreadId === target.sourceThreadId) {
          addCandidateParent(childId, target.sourceThreadId);
        }
        continue;
      }
      const discovered = discoveredThreads.get(childId);
      // Once a recursively discovered node has been directly read and
      // activated, later activity that mentions it is an interaction (often
      // an ancestor/sibling callback), not a second parent assertion.
      if (discovered !== undefined) {
        if (discovered.parentThreadId === target.sourceThreadId) {
          addCandidateParent(childId, target.sourceThreadId);
        }
        continue;
      }
      const candidateParents = addCandidateParent(childId, target.sourceThreadId);
      if (!queuedIds.has(childId)) {
        if (queuedIds.size >= limits.maxNodes) throw new CodexReconciliationError("NODE_LIMIT");
        queuedIds.add(childId);
        queue.push({ sourceThreadId: childId, expectedParentThreadIds: candidateParents, discovered: true });
      }
    }
    reads.set(target.sourceThreadId, turns);
    // Rollout identity is an optional, bounded supplement to topology. It is
    // deliberately fetched once per activated node and always before the
    // plan/store transaction. Held, lineage-invalid nodes never call this
    // reader.
    if (typeof client.readRolloutIdentity === "function") {
      try {
        const rawIdentity = await client.readRolloutIdentity(target.sourceThreadId);
        const identity = safeRolloutIdentity(rawIdentity, target.sourceThreadId);
        if (identity !== undefined) rolloutIdentity.set(target.sourceThreadId, identity);
      } catch {
        // Missing local rollout evidence is represented as unverified identity,
        // never as a thread/read or graph failure.
      }
    }
    if (target.discovered) discoveredThreads.set(target.sourceThreadId, thread);
  };

  const drainHeldReads = async (): Promise<void> => {
    for (;;) {
      let progressed = false;
      for (const [childId, held] of [...heldReads.entries()]) {
        const canonicalParent = held.thread.parentThreadId;
        if (canonicalParent === undefined) throw new CodexReconciliationError("ORPHAN_THREAD");
        if (!candidateParentsById.get(childId)?.has(canonicalParent)) continue;
        heldReads.delete(childId);
        await activateRead(held);
        progressed = true;
      }
      if (!progressed) return;
    }
  };

  for (;;) {
    if (queue.length === 0) {
      // Activating a held node can discover more descendants. Keep the
      // closure loop alive until both the read queue and held set reach a
      // fixpoint, rather than returning before those newly queued reads.
      await drainHeldReads();
      if (queue.length === 0) break;
    }
    const target = queue.shift();
    if (!target) continue;
    const listed = target.listedThread;
    if (listed !== undefined && supplementalIds.has(target.sourceThreadId)) {
      readThreads.set(target.sourceThreadId, listed);
      reads.set(target.sourceThreadId, []);
      if (typeof client.readRolloutIdentity === "function") {
        try {
          const identity = safeRolloutIdentity(await client.readRolloutIdentity(target.sourceThreadId), target.sourceThreadId);
          if (identity !== undefined) rolloutIdentity.set(target.sourceThreadId, identity);
        } catch { /* optional enrichment remains unavailable */ }
      }
      continue;
    }
    const turns: SafeTurn[] = [];
    const seenTurns = new Set<string>();
    if (pages >= limits.maxReadPages) throw new CodexReconciliationError("READ_PAGE_LIMIT");
    let raw: unknown;
    try {
      // The official ThreadReadParams shape is intentionally tiny. Reads are
      // one-shot per thread; pagination belongs to thread/list, not read.
      raw = await client.readThread({ threadId: target.sourceThreadId, includeTurns: true });
    } catch {
      throw new CodexReconciliationError("THREAD_READ_FAILED");
    }
    pages += 1;
    const value = safeReadPage(raw);
    if (value.nextCursor !== undefined) throw new CodexReconciliationError("INVALID_PAGE");
    if (value.thread.sourceThreadId !== target.sourceThreadId) throw new CodexReconciliationError("THREAD_MISMATCH");
    if (target.discovered) {
      // A child discovered from a turn must provide canonical lineage. The
      // parent may be added to the candidate closure after this one-shot read,
      // but missing lineage is an orphan, not an invitation to guess.
      if (value.thread.parentThreadId === undefined) throw new CodexReconciliationError("ORPHAN_THREAD");
    } else if (listed) {
      // Some app-server read responses omit relationship metadata that was
      // present in thread/list. An explicitly returned parent must agree;
      // absence alone is not evidence of a reparenting.
      const selectedViewRoot = listed.sourceThreadId === selected[0]?.sourceThreadId && listed.parentThreadId === undefined;
      if (!selectedViewRoot && value.thread.parentThreadId !== undefined && value.thread.parentThreadId !== listed.parentThreadId) {
        throw new CodexReconciliationError("CROSS_ROOT");
      }
    } else if (value.thread.parentThreadId !== undefined &&
               (target.expectedParentThreadIds === undefined || !target.expectedParentThreadIds.has(value.thread.parentThreadId))) {
      throw new CodexReconciliationError("CROSS_ROOT");
    }
    // When both endpoints provide session metadata for this same thread,
    // disagreement means the snapshot is internally ambiguous. Per-thread
    // session ids are intentionally not compared across parent/child nodes.
    if (value.thread.sessionId !== undefined && listed?.sessionId !== undefined && value.thread.sessionId !== listed.sessionId) {
      throw new CodexReconciliationError("CROSS_ROOT");
    }
    if (value.thread.agentPath !== undefined && listed?.agentPath !== undefined && value.thread.agentPath !== listed.agentPath) {
      throw new CodexReconciliationError("CROSS_ROOT");
    }
    if (value.thread.agentTaskName !== undefined && listed?.agentTaskName !== undefined && value.thread.agentTaskName !== listed.agentTaskName) {
      throw new CodexReconciliationError("CROSS_ROOT");
    }
    readThreads.set(target.sourceThreadId, value.thread);
    for (const turn of value.turns) {
      if (seenTurns.has(turn.sourceTurnId)) continue;
      seenTurns.add(turn.sourceTurnId);
      turns.push(turn);
      turnCount += 1;
      itemCount += turn.items.length;
      if (turnCount > limits.maxTurns) throw new CodexReconciliationError("TURN_LIMIT");
      if (itemCount > limits.maxItems) throw new CodexReconciliationError("ITEM_LIMIT");
    }
    const record: HeldRead = { target, thread: value.thread, turns };
    const lineageValid = !target.discovered ||
      (target.expectedParentThreadIds !== undefined && value.thread.parentThreadId !== undefined && target.expectedParentThreadIds.has(value.thread.parentThreadId));
    if (target.discovered && !lineageValid) {
      // The read itself is retained for later closure validation, but its
      // turns/children/rollout evidence remain held and cannot expand the
      // graph until a canonical parent candidate is confirmed.
      heldReads.set(target.sourceThreadId, record);
    } else {
      await activateRead(record);
    }
    await drainHeldReads();
  }
  // All reachable referrers have now been expanded. A held canonical parent
  // that never became a candidate is a genuine cross-root result; no writes
  // have occurred yet, preserving reconciliation atomicity.
  if (heldReads.size > 0) throw new CodexReconciliationError("CROSS_ROOT");
  return { reads, readThreads, rolloutIdentity, discoveredThreads: [...discoveredThreads.values()], pages, turns: turnCount, items: itemCount };
}

function priorAgentIds(store: DurableStore, scope: PrincipalScope, sourceAdapter: string): Map<string, string> {
  const bySource = new Map<string, string>();
  for (const agent of store.agents.list(scope)) {
    if (agent.sourceThreadId && (agent.sourceAdapter === sourceAdapter || agent.sourceAdapter === null)) {
      bySource.set(agent.sourceThreadId, agent.agentId);
    }
  }
  return bySource;
}

function durableTerminalLifecycle(value: AgentLifecycle | undefined): value is "completed" | "failed" | "interrupted" {
  return value === "completed" || value === "failed" || value === "interrupted";
}

function buildPlan(options: CodexReconcilerOptions, sourceAdapter: string, epoch: string, listed: readonly SafeThread[], listPages: number, read: Awaited<ReturnType<typeof collectRead>>): ReconciliationPlan {
  const scope = scopeOf(options.binding);
  const selected = validateGraph(listed, options.binding.sourceRootId);
  const existingAgents = options.store.agents.list(scope);
  const existingBySource = new Map(existingAgents.filter((agent) => agent.sourceThreadId).map((agent) => [agent.sourceThreadId as string, agent]));
  // list establishes the graph; read may provide fresher lifecycle/name
  // metadata. Relationship fields remain list-authoritative after the
  // explicit parent consistency check in collectRead.
  const selectedWithReadMetadata = selected.map((listedThread) => {
    const readThread = read.readThreads.get(listedThread.sourceThreadId);
    if (!readThread) return listedThread;
    const rolloutLifecycle = read.rolloutIdentity.get(listedThread.sourceThreadId)?.lifecycle;
    const turnLifecycle = lifecycleFromTurns(read.reads.get(listedThread.sourceThreadId) ?? []);
    const appServerStatus = readThread.status === "unknown"
      ? turnLifecycle ?? (listedThread.status === "unknown" ? rolloutLifecycle ?? "unknown" : listedThread.status)
      : readThread.status;
    // An explicit terminal event from the latest sanitized turn or trusted
    // rollout closes a stale app-server `active` snapshot. A current active
    // turn still wins over an older rollout terminal, so newly resumed work is
    // never forced back to its previous terminal state.
    const observedStatus = durableTerminalLifecycle(turnLifecycle) && !durableTerminalLifecycle(appServerStatus)
      ? turnLifecycle
      : turnLifecycle === undefined && durableTerminalLifecycle(rolloutLifecycle) && !durableTerminalLifecycle(appServerStatus)
        ? rolloutLifecycle
        : appServerStatus;
    const priorStatus = existingBySource.get(listedThread.sourceThreadId)?.lifecycle;
    const status = observedStatus === "unknown" && durableTerminalLifecycle(priorStatus)
      ? priorStatus
      : observedStatus;
    return {
      ...listedThread,
      // A thread/read response may expose `not_loaded`/unknown while its
      // latest sanitized turn, list entry, or rollout carries a known status.
      // Only a prior terminal state is durable across a fully unknown refresh:
      // retaining an old active/idle/queued state would fabricate live work.
      // A current active turn wins; otherwise explicit terminal evidence may
      // close a stale app-server active snapshot. No timestamp-based lifecycle
      // is manufactured.
      status,
      ...(readThread.sessionId === undefined ? {} : { sessionId: readThread.sessionId }),
      ...(readThread.modelProvider === undefined ? {} : { modelProvider: readThread.modelProvider }),
      ...(readThread.agentNickname === undefined ? {} : { agentNickname: readThread.agentNickname }),
      ...(readThread.agentRole === undefined ? {} : { agentRole: readThread.agentRole }),
      ...(readThread.agentPath === undefined ? {} : { agentPath: readThread.agentPath }),
      ...(readThread.agentTaskName === undefined ? {} : { agentTaskName: readThread.agentTaskName }),
      ...(readThread.sourceKind === undefined ? {} : { sourceKind: readThread.sourceKind }),
      ...(readThread.cliVersion === undefined ? {} : { cliVersion: readThread.cliVersion }),
      ...(readThread.createdAt === undefined ? {} : { createdAt: readThread.createdAt }),
      ...(readThread.updatedAt === undefined ? {} : { updatedAt: readThread.updatedAt }),
    } satisfies SafeThread;
  });
  const selectedReads = new Map<string, readonly SafeTurn[]>();
  for (const thread of selectedWithReadMetadata) selectedReads.set(thread.sourceThreadId, read.reads.get(thread.sourceThreadId) ?? []);
  const existing = priorAgentIds(options.store, scope, sourceAdapter);
  const publicBySource = new Map<string, string>();
  for (const thread of selectedWithReadMetadata) publicBySource.set(thread.sourceThreadId, existing.get(thread.sourceThreadId) ?? stableAgentId(sourceAdapter, thread.sourceThreadId));

  const requestedByAgent = new Map<string, IdentityValues>();
  const observedByAgent = new Map<string, IdentityValues>();
  const requestedEvidenceSourceByAgent = new Map<string, string>();
  const observedEvidenceSourceByAgent = new Map<string, string>();
  const autoReviewAgentIds = new Set<string>();
  for (const thread of selectedWithReadMetadata) {
    const agentId = publicBySource.get(thread.sourceThreadId);
    if (!agentId) continue;
    let requested: IdentityValues = { provider: null, model: null, effort: null };
    let observed: IdentityValues = { provider: null, model: null, effort: null };
    for (const turn of selectedReads.get(thread.sourceThreadId) ?? []) {
      for (const item of turn.items) {
        const collaboration = item.collaboration;
        // Requested identity is topology-coupled only for an explicit spawn
        // operation. Messaging/follow-up/wait receiver metadata is useful as
        // an interaction record, but cannot assert that a target was spawned
        // with the requested model or effort.
        if (collaboration && isSpawnOperation(collaboration.operation)) {
          const values = valuesFromParts({ provider: collaboration.requestedProvider, model: collaboration.requestedModel, reasoningEffort: collaboration.requestedReasoningEffort });
          if (values.provider || values.model || values.effort) {
            for (const receiver of collaboration.receiverIds ?? []) {
              // Receiver ids are source-thread ids, never public Agent Farm
              // ids. Keep this mapping single-authority so a crafted public
              // id cannot smuggle identity evidence across source graphs.
              const target = publicBySource.get(receiver);
              if (!target) continue;
              const previous = requestedByAgent.get(target) ?? { provider: null, model: null, effort: null };
              requestedByAgent.set(target, mergeIdentity(previous, values));
              requestedEvidenceSourceByAgent.set(target, "collab.spawn");
              if (isCodexAutoReviewModel(collaboration.requestedModel)) autoReviewAgentIds.add(target);
            }
          }
        }
        if (item.effectiveSettings) {
          observed = mergeIdentity(observed, valuesFromParts(item.effectiveSettings));
          observedEvidenceSourceByAgent.set(agentId, "reconciliation");
          if (isCodexAutoReviewModel(item.effectiveSettings.model)) autoReviewAgentIds.add(agentId);
        }
        if (item.modelRerouted?.toModel) {
          observed = mergeIdentity(observed, { provider: null, model: canonicalCodexModel(item.modelRerouted.toModel), effort: null });
          observedEvidenceSourceByAgent.set(agentId, "reconciliation");
          if (isCodexAutoReviewModel(item.modelRerouted.toModel)) autoReviewAgentIds.add(agentId);
        }
      }
    }
    // A rollout's model_provider and ordered turn-context records are stronger
    // identity evidence than an arbitrary sanitized item. Applying them after
    // app-server item evidence makes the latest non-null rollout value win,
    // while retaining A -> B -> A drift in the evidence history itself.
    const rollout = read.rolloutIdentity.get(thread.sourceThreadId);
    if (rollout !== undefined) {
      if (rollout.autoReview) autoReviewAgentIds.add(agentId);
      let rolloutObserved = valuesFromParts({ provider: rollout.modelProvider });
      for (const history of rollout.observedHistory) {
        rolloutObserved = mergeIdentity(rolloutObserved, valuesFromParts(history));
      }
      if (rolloutObserved.provider !== null || rolloutObserved.model !== null || rolloutObserved.effort !== null) {
        observed = mergeIdentity(observed, rolloutObserved);
        observedEvidenceSourceByAgent.set(agentId, "codex.rollout.turn-context");
      }
    }
    requestedByAgent.set(agentId, requestedByAgent.get(agentId) ?? requested);
    observedByAgent.set(agentId, observed);
  }

  // A rollout spawn record belongs to its parent rollout, while the child
  // thread's structural task name belongs to the graph. Join them only when
  // both sides are unique. Repeated task names/spawn records are intentionally
  // ambiguous and therefore leave the existing collaboration evidence intact.
  const childrenByParent = cursorMapToChildren(selectedWithReadMetadata);
  for (const parent of selectedWithReadMetadata) {
    const rollout = read.rolloutIdentity.get(parent.sourceThreadId);
    if (rollout === undefined || rollout.requestedSpawns.length === 0) continue;
    const directChildren = childrenByParent.get(parent.sourceThreadId) ?? [];
    const childrenByTask = new Map<string, SafeThread[]>();
    for (const child of directChildren) {
      if (child.agentTaskName === undefined) continue;
      const list = childrenByTask.get(child.agentTaskName) ?? [];
      list.push(child);
      childrenByTask.set(child.agentTaskName, list);
    }
    const spawnsByTask = new Map<string, SafeRolloutRequestedSpawn[]>();
    for (const spawn of rollout.requestedSpawns) {
      if (spawn.taskName === undefined) continue;
      const list = spawnsByTask.get(spawn.taskName) ?? [];
      list.push(spawn);
      spawnsByTask.set(spawn.taskName, list);
    }
    for (const [taskName, children] of childrenByTask) {
      const spawns = spawnsByTask.get(taskName);
      if (children.length !== 1 || spawns === undefined || spawns.length !== 1) continue;
      const child = children[0];
      const spawn = spawns[0];
      if (child === undefined || spawn === undefined) continue;
      const childAgentId = publicBySource.get(child.sourceThreadId);
      if (childAgentId === undefined) continue;
      const values = valuesFromParts({ model: spawn.model, reasoningEffort: spawn.reasoningEffort });
      if (values.provider === null && values.model === null && values.effort === null) continue;
      const prior = requestedByAgent.get(childAgentId) ?? { provider: null, model: null, effort: null };
      requestedByAgent.set(childAgentId, mergeIdentity(prior, values));
      requestedEvidenceSourceByAgent.set(childAgentId, "codex.rollout.spawn");
      if (spawn.autoReview) autoReviewAgentIds.add(childAgentId);
    }
  }

  const agents: AgentPlan[] = selectedWithReadMetadata.map((thread) => {
    const agentId = publicBySource.get(thread.sourceThreadId) as string;
    const requested = requestedByAgent.get(agentId) ?? { provider: null, model: null, effort: null };
    const observed = observedByAgent.get(agentId) ?? { provider: null, model: null, effort: null };
    const rollout = read.rolloutIdentity.get(thread.sourceThreadId);
    const autoReview = autoReviewAgentIds.has(agentId) || isCodexAutoReviewModel(thread.agentTaskName) || isCodexAutoReviewModel(thread.agentNickname);
    return {
      sourceThreadId: thread.sourceThreadId,
      parentSourceThreadId: thread.parentThreadId ?? null,
      agentId,
      thread,
      requested,
      observed,
      verificationState: verifyIdentity(requested, observed),
      requestedEvidenceSource: requestedEvidenceSourceByAgent.get(agentId) ?? "unknown",
      observedEvidenceSource: observedEvidenceSourceByAgent.get(agentId) ?? "reconciliation",
      isRoot: thread.sourceThreadId === options.binding.sourceRootId,
      displayName: autoReview ? CODEX_AUTO_REVIEW_DISPLAY_NAME : thread.agentTaskName ?? thread.agentNickname ?? null,
      role: autoReview ? "reviewer" : thread.sourceThreadId === options.binding.sourceRootId ? "root" : thread.agentRole ?? null,
      ...(rollout?.usage === undefined ? {} : { usage: rollout.usage }),
      ...(rollout?.usageSegments === undefined ? {} : { usageSegments: rollout.usageSegments }),
    };
  });
  const existingUsageBySource = new Map(existingAgents.filter((agent) => agent.sourceThreadId).map((agent) => [agent.sourceThreadId as string, agent.usage]));
  const staleSourceThreadIds = existingAgents
    .filter((agent) => (agent.sourceAdapter === sourceAdapter || agent.sourceAdapter === null) && agent.sourceThreadId && !publicBySource.has(agent.sourceThreadId))
    .map((agent) => agent.sourceThreadId as string)
    .sort();
  // Runtime reconciliation supplies its own bounded opaque revision. Do not
  // eagerly serialize the combined fleet's local usage evidence in that path:
  // each agent event is independently bounded, while several valid 1,024-
  // segment agents can legitimately exceed the generic aggregate hash cap.
  const reconciliationRevision = options.reconciliationId ?? sha256({
    threads: selectedWithReadMetadata,
    agents: agents.map((agent) => ({
      sourceThreadId: agent.sourceThreadId,
      parentSourceThreadId: agent.parentSourceThreadId,
      status: agent.thread.status,
      role: agent.role,
      name: agent.displayName,
      agentPath: agent.thread.agentPath ?? null,
      requested: agent.requested,
      observed: agent.observed,
      verificationState: agent.verificationState,
      usage: agent.usage === undefined ? existingUsageBySource.get(agent.sourceThreadId) ?? null : agent.usage,
      usageSegments: agent.usageSegments ?? null,
    })),
    staleSourceThreadIds,
  });
  return {
    threads: selectedWithReadMetadata,
    readThreads: read.readThreads,
    reads: selectedReads,
    rolloutIdentity: read.rolloutIdentity,
    listPages,
    readPages: read.pages,
    turnCount: read.turns,
    itemCount: read.items,
    sourceAdapter,
    connectionEpoch: epoch,
    scope,
    agents,
    publicBySource,
    requestedByAgent,
    observedByAgent,
    reconciliationRevision,
  };
}

function changedAgent(current: AgentRecord | undefined, next: AgentPlan, sourceAdapter: string): boolean {
  if (!current) return true;
  return stableJson({
    sourceAdapter: current.sourceAdapter,
    sourceThreadId: current.sourceThreadId,
    parentSourceThreadId: current.parentSourceThreadId,
    role: current.role,
    name: current.name,
    lifecycle: current.lifecycle,
    verificationState: current.verificationState,
    isRoot: current.isRoot,
    usage: current.usage,
    usageSegments: current.usageSegments,
  }) !== stableJson({
    sourceAdapter,
    sourceThreadId: next.sourceThreadId,
    parentSourceThreadId: next.parentSourceThreadId,
    role: next.role,
    name: next.displayName,
    lifecycle: next.thread.status,
    verificationState: next.verificationState,
    isRoot: next.isRoot,
    usage: next.usage === undefined ? current.usage : next.usage,
    usageSegments: next.usageSegments === undefined ? current.usageSegments : next.usageSegments,
  });
}

function agentPayload(plan: AgentPlan, sourceAdapter: string, lifecycleValue: AgentLifecycle, verification: VerificationState): Record<string, unknown> {
  const thread = plan.thread;
  return {
    agentId: plan.agentId,
    sourceAdapter,
    sourceThreadId: plan.sourceThreadId,
    ...(thread.sessionId === undefined ? {} : { sourceSessionId: thread.sessionId }),
    ...(plan.parentSourceThreadId === null ? {} : { parentSourceThreadId: plan.parentSourceThreadId }),
    ...(plan.role === null ? {} : { role: plan.role }),
    ...(plan.displayName === null ? {} : { name: plan.displayName }),
    // `nickname` is an already-supported sanitized event field. It remains
    // separate from the public/store name when a structural task name exists;
    // raw Codex `name`/`title` fields are never read here.
    ...(thread.agentNickname === undefined ? {} : { nickname: thread.agentNickname }),
    lifecycle: lifecycleValue,
    verificationState: verification,
    isRoot: plan.isRoot,
    ...(plan.usage === undefined ? {} : { usage: plan.usage }),
    ...(plan.usageSegments === undefined ? {} : { usageSegments: plan.usageSegments }),
    sourceKind: thread.sourceKind ?? "reconciliation",
    ...(thread.cliVersion === undefined ? {} : { cliVersion: thread.cliVersion }),
    ...(thread.createdAt === undefined ? {} : { createdAt: thread.createdAt }),
    ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
  };
}

function identityPayload(
  agentId: string,
  sourceThreadId: string,
  values: IdentityValues,
  kind: "requested" | "observed",
  evidenceSource: string,
): Record<string, unknown> | undefined {
  if (!values.provider && !values.model && !values.effort) return undefined;
  return {
    agentId,
    sourceThreadId,
    ...(kind === "requested" ? {
      ...(values.provider === null ? {} : { requestedProvider: values.provider }),
      ...(values.model === null ? {} : { requestedModel: values.model }),
      ...(values.effort === null ? {} : { requestedEffort: values.effort }),
    } : {
      ...(values.provider === null ? {} : { observedProvider: values.provider }),
      ...(values.model === null ? {} : { observedModel: values.model }),
      ...(values.effort === null ? {} : { observedEffort: values.effort }),
    }),
    trustClass: "reconciled",
    evidenceSource,
    values: {
      ...(values.provider === null ? {} : { provider: values.provider }),
      ...(values.model === null ? {} : { model: values.model }),
      ...(values.effort === null ? {} : { effort: values.effort }),
    },
  };
}

function eventKey(epoch: string, kind: string, id: string, revision?: unknown): string {
  const suffix = revision === undefined ? "" : `:${sha256(revision).slice(0, 40)}`;
  return `codex-reconciliation:${epoch}:${kind}:${id}${suffix}`;
}

function durableFallbackSourceIds(store: DurableStore, scope: PrincipalScope): ReadonlySet<string> {
  const latest = new Map<string, string | undefined>();
  for (const event of store.events.list(scope)) {
    if (event.eventType !== "agent.reconciled" || !event.sourceThreadId) continue;
    const sourceKind = typeof event.sanitizedPayload.sourceKind === "string" ? event.sanitizedPayload.sourceKind : undefined;
    latest.set(event.sourceThreadId, sourceKind);
  }
  return new Set([...latest].filter(([, sourceKind]) => sourceKind === "rollout-fallback").map(([sourceThreadId]) => sourceThreadId));
}

/**
 * Fetch, validate, and atomically reconcile one selected Codex source root.
 * Every potentially failing app-server operation occurs before the write
 * transaction starts, so a partial list/read can never alter the projection.
 */
export async function reconcileCodexSnapshot(options: CodexReconcilerOptions): Promise<CodexReconciliationResult> {
  assertBinding(options.binding);
  const boundSourceAdapter = (options.binding as CodexRuntimeBinding & { readonly sourceAdapter?: unknown }).sourceAdapter;
  const sourceAdapter = options.sourceAdapter ?? (typeof boundSourceAdapter === "string" ? boundSourceAdapter : "codex-app-server");
  if (!safeWord(sourceAdapter)) throw new CodexReconciliationError("INVALID_BINDING");
  if (options.reconciliationId !== undefined && !safeId(options.reconciliationId)) {
    throw new CodexReconciliationError("INVALID_BINDING");
  }
  const epoch = options.connectionEpoch ?? randomUUID();
  assertEpoch(epoch);
  const limits = resolveLimits(options.limits);
  const scope = scopeOf(options.binding);
  try {
    options.store.assertSession(scope);
  } catch {
    throw new CodexReconciliationError("SESSION_NOT_FOUND");
  }

  const listed = await collectThreads(options.client, limits);
  // Graph validation happens before any read, avoiding reads for unrelated
  // roots and ensuring orphan/cycle input cannot be partially committed.
  const initialSelected = validateGraph(listed.threads, options.binding.sourceRootId);
  const authoritativeIds = new Set(listed.threads.map((thread) => thread.sourceThreadId));
  const supplemental = new Map<string, SafeThread>();
  if (typeof options.client.discoverRolloutTopology === "function") {
    try {
      const candidates = await options.client.discoverRolloutTopology(options.binding.sourceRootId);
      for (const raw of candidates ?? []) {
        const thread = safeFallbackThread(raw);
        if (thread === undefined || authoritativeIds.has(thread.sourceThreadId) || supplemental.has(thread.sourceThreadId)) continue;
        supplemental.set(thread.sourceThreadId, thread);
      }
    } catch { /* app-server remains authoritative when fallback is unavailable */ }
  }
  // Durable fallback nodes survive a temporarily unavailable local scan. They
  // are admitted only when their stored parent chain still reaches this exact
  // selected root; authoritative app-server records always take precedence.
  const durableFallbackIds = durableFallbackSourceIds(options.store, scope);
  for (const current of options.store.agents.list(scope)) {
    if (!current.sourceThreadId || authoritativeIds.has(current.sourceThreadId) || supplemental.has(current.sourceThreadId) || current.isRoot) continue;
    if (current.sourceAdapter !== sourceAdapter || current.parentSourceThreadId === null || !durableFallbackIds.has(current.sourceThreadId)) continue;
    supplemental.set(current.sourceThreadId, {
      sourceThreadId: current.sourceThreadId,
      parentThreadId: current.parentSourceThreadId,
      status: current.lifecycle,
      ...(current.name === null ? {} : { agentTaskName: current.name }),
      sourceKind: "rollout-fallback",
    });
  }
  const merged = validateGraph([...listed.threads, ...[...supplemental.values()].sort((a, b) => a.sourceThreadId.localeCompare(b.sourceThreadId))], options.binding.sourceRootId);
  const read = await collectRead(options.client, merged, limits, new Set(supplemental.keys()));
  // Recursive children are discovered only from sanitized turn structure and
  // are then subjected to the same complete graph/session validation before
  // a plan or transaction can be created.
  const selected = validateGraph([...merged, ...read.discoveredThreads], options.binding.sourceRootId);
  const plan = buildPlan(options, sourceAdapter, epoch, selected, listed.pages, read);

  const pricingSnapshot = options.pricing?.snapshot;

  const correctedAgentIds = new Set<string>();
  const correctedEdgeIds = new Set<string>();
  let committedWatermark = 0;
  options.store.transaction(() => {
    if (pricingSnapshot !== undefined) options.store.pricingSnapshots.put({ snapshotId: pricingSnapshot.snapshotId, snapshot: pricingSnapshot });
    const ingest = (input: SanitizedEventInput): EventIngestResult => {
      const result = options.store.events.ingest(scope, input);
      if (result.outcome === "quarantined") {
        // A reconciliation conflict is never a successful partial snapshot;
        // force the outer transaction to roll back the quarantine and all
        // projection writes from this pass.
        throw new CodexReconciliationError("RECONCILIATION_WRITE_FAILED");
      }
      // EventRepository replay is intentionally a no-op for ordinary live
      // notifications. Reconciliation is authoritative, however: if a
      // snapshot returns to an earlier state (A -> B -> A), re-apply only
      // the projection-bearing agent/edge event while retaining evidence as
      // append-only history.
      if (
        result.outcome === "replayed" &&
        result.event &&
        (input.eventType === "agent.reconciled" || input.eventType === "edge.reconciled" || input.eventType === "cost.projected")
      ) {
        if (input.eventType === "edge.reconciled") {
          const payload = result.event.sanitizedPayload;
          const childAgentId = typeof payload.childAgentId === "string" ? payload.childAgentId : undefined;
          const parentAgentId = typeof payload.parentAgentId === "string" ? payload.parentAgentId : undefined;
          const currentParent = childAgentId === undefined ? null : options.store.edges.getParent(scope, childAgentId);
          if (!childAgentId || !parentAgentId || currentParent?.parentAgentId !== parentAgentId) options.store.applyEvent(result.event);
        } else {
          options.store.applyEvent(result.event);
        }
      }
      return result;
    };
    const currentAgents = options.store.agents.list(scope);
    const currentBySource = new Map(currentAgents.filter((agent) => agent.sourceThreadId).map((agent) => [agent.sourceThreadId as string, agent]));
    for (const agent of plan.agents) {
      const current = currentBySource.get(agent.sourceThreadId);
      if (changedAgent(current, agent, sourceAdapter)) correctedAgentIds.add(agent.agentId);
      const payload = agentPayload(agent, sourceAdapter, agent.thread.status, agent.verificationState);
      ingest({
        eventKey: eventKey(epoch, "agent", agent.sourceThreadId, { snapshotRevision: plan.reconciliationRevision, payload }),
        eventType: "agent.reconciled",
        connectionEpoch: epoch,
        sourceAdapter,
        sourceThreadId: agent.sourceThreadId,
        sourceSessionId: agent.thread.sessionId ?? null,
        authority: "reconciliation",
        payload,
      });
      if (pricingSnapshot !== undefined && agent.usageSegments !== undefined) {
        const unchangedPinnedEstimate = current?.cost?.status === "estimated" && current.pricingSnapshotId !== null &&
          stableJson(current.usage) === stableJson(agent.usage ?? null) &&
          stableJson(current.usageSegments) === stableJson(agent.usageSegments);
        // A completed estimate is associated with its immutable reviewed
        // snapshot. A later provider-table update may price new/changed
        // usage, but it must never silently reprice identical recorded work.
        if (unchangedPinnedEstimate) continue;
        const priced = estimateSegmentedSelfCost(agent.usageSegments.segments, agent.usageSegments.complete, pricingSnapshot);
        let cost: LocalCostEstimate;
        if (priced.status === "estimated") {
          cost = agent.usage !== undefined && agent.usage !== null
            ? { status: "estimated", currency: "USD", selfMicros: priced.selfMicros, childrenMicros: 0, totalMicros: priced.selfMicros, usage: agent.usage, pricing: pricingSnapshot }
            : { status: "unavailable", currency: "USD", reason: "usage-unavailable" };
        } else if (priced.status === "partial") {
          cost = { status: "partial", currency: "USD", knownSelfMicros: priced.knownSelfMicros, reason: priced.reason, pricing: pricingSnapshot };
        } else {
          cost = { status: "unavailable", currency: "USD", reason: priced.reason };
        }
        const costPayload = priced.status === "estimated" || priced.status === "partial"
          ? { agentId: agent.agentId, pricingSnapshotId: pricingSnapshot.snapshotId, cost }
          : { agentId: agent.agentId, pricingSnapshotId: null, cost };
        ingest({
          eventKey: eventKey(epoch, "cost", agent.sourceThreadId, { snapshotRevision: plan.reconciliationRevision, payload: costPayload }),
          eventType: "cost.projected",
          connectionEpoch: epoch,
          sourceAdapter,
          sourceThreadId: agent.sourceThreadId,
          authority: "reconciliation",
          payload: costPayload,
        });
      } else if (pricingSnapshot !== undefined && current?.cost !== null && current?.cost !== undefined) {
        // A temporarily unreadable/oversized rollout supplies no replacement
        // usage segments. Preserve the durable, pricing-pinned known subtotal;
        // absence of new evidence is not evidence that known cost disappeared.
        continue;
      }
    }

    for (const current of currentAgents) {
      if (!current.sourceThreadId || (current.sourceAdapter !== sourceAdapter && current.sourceAdapter !== null)) continue;
      if (plan.publicBySource.has(current.sourceThreadId)) continue;
      const stale: AgentPlan = {
        sourceThreadId: current.sourceThreadId,
        parentSourceThreadId: current.parentSourceThreadId,
        agentId: current.agentId,
        thread: {
          sourceThreadId: current.sourceThreadId,
          ...(current.sourceSessionId === null ? {} : { sessionId: current.sourceSessionId }),
          ...(current.parentSourceThreadId === null ? {} : { parentThreadId: current.parentSourceThreadId }),
          status: "disconnected",
          ...(current.role === null ? {} : { agentRole: current.role }),
          ...(current.name === null ? {} : { agentNickname: current.name }),
        },
        requested: { provider: null, model: null, effort: null },
        observed: { provider: null, model: null, effort: null },
        verificationState: "unverified",
        requestedEvidenceSource: "unknown",
        observedEvidenceSource: "reconciliation",
        displayName: current.name,
        role: current.role,
        // A source root omitted from a complete snapshot is stale, never the
        // selected root for this pass. Keeping its historical root bit would
        // let the stale mapping steal the session's single-root marker.
        isRoot: false,
      };
      correctedAgentIds.add(current.agentId);
      const payload = agentPayload(stale, sourceAdapter, "disconnected", "unverified");
      ingest({
        eventKey: eventKey(epoch, "disconnected", current.sourceThreadId, { snapshotRevision: plan.reconciliationRevision, payload }),
        eventType: "agent.reconciled",
        connectionEpoch: epoch,
        sourceAdapter,
        sourceThreadId: current.sourceThreadId,
        sourceSessionId: current.sourceSessionId,
        authority: "reconciliation",
        payload,
      });
    }

    for (const agent of plan.agents) {
      if (!agent.parentSourceThreadId) continue;
      const parentAgentId = plan.publicBySource.get(agent.parentSourceThreadId);
      if (!parentAgentId) throw new CodexReconciliationError("CROSS_ROOT");
      const edgeId = `edge:${parentAgentId}:${agent.agentId}`;
      correctedEdgeIds.add(edgeId);
      const payload = { edgeId, parentAgentId, childAgentId: agent.agentId, source: "codex-reconciliation" };
      ingest({
        eventKey: eventKey(epoch, "edge", edgeId, { snapshotRevision: plan.reconciliationRevision, payload }),
        eventType: "edge.reconciled",
        connectionEpoch: epoch,
        sourceAdapter,
        sourceThreadId: agent.sourceThreadId,
        authority: "reconciliation",
        payload,
      });
    }

    for (const agent of plan.agents) {
      const requested = identityPayload(agent.agentId, agent.sourceThreadId, agent.requested, "requested", agent.requestedEvidenceSource);
      if (requested) {
        ingest({
          eventKey: eventKey(epoch, "identity-requested", agent.sourceThreadId, { snapshotRevision: plan.reconciliationRevision, payload: requested }),
          eventType: "identity.requested",
          connectionEpoch: epoch,
          sourceAdapter,
          sourceThreadId: agent.sourceThreadId,
          authority: "reconciliation",
          payload: requested,
        });
      }
      const observed = identityPayload(agent.agentId, agent.sourceThreadId, agent.observed, "observed", agent.observedEvidenceSource);
      if (observed) {
        ingest({
          eventKey: eventKey(epoch, "identity-observed", agent.sourceThreadId, { snapshotRevision: plan.reconciliationRevision, payload: observed }),
          eventType: "identity.observed",
          connectionEpoch: epoch,
          sourceAdapter,
          sourceThreadId: agent.sourceThreadId,
          authority: "reconciliation",
          payload: observed,
        });
      }
    }

    const beforeSummary = options.store.readSession(scope).watermarkIngestOrdinal;
    const summaryKey = eventKey(epoch, "snapshot", options.binding.sourceRootId, plan.reconciliationRevision);
    const existingSummary = options.store.events.list(scope).find((event) => event.eventKey === summaryKey);
    const summaryPayload = existingSummary?.sanitizedPayload ?? {
      type: "snapshot.reconciled",
      snapshot: "codex-thread-read",
      watermark: beforeSummary + 1,
      correctedAgentIds: [...correctedAgentIds].sort(),
      correctedEdgeIds: [...correctedEdgeIds].sort(),
    };
    const summary = ingest({
      eventKey: summaryKey,
      eventType: "snapshot.reconciled",
      connectionEpoch: epoch,
      sourceAdapter,
      sourceThreadId: options.binding.sourceRootId,
      authority: "reconciliation",
      payload: summaryPayload,
    });
    committedWatermark = summary.watermarkIngestOrdinal;
  });

  return {
    status: "reconciled",
    sourceAdapter,
    connectionEpoch: epoch,
    reconciliationRevision: plan.reconciliationRevision,
    watermark: committedWatermark,
    correctedAgentIds: [...correctedAgentIds].sort(),
    correctedEdgeIds: [...correctedEdgeIds].sort(),
    sourceThreadIds: plan.agents.map((agent) => agent.sourceThreadId),
    listPages: plan.listPages,
    readPages: plan.readPages,
    turnCount: plan.turnCount,
    itemCount: plan.itemCount,
  };
}

/** Class form for hosts that keep a reconciler instance beside a runtime. */
export class CodexSnapshotReconciler {
  constructor(private readonly options: CodexReconcilerOptions) {}

  reconcile(): Promise<CodexReconciliationResult> {
    return reconcileCodexSnapshot(this.options);
  }
}

/** Short class alias for hosts that use the operation name as a noun. */
export class CodexReconciler extends CodexSnapshotReconciler {}

/** Alias matching the operation-oriented naming used by bridge callers. */
export const reconcileCodexThreads = reconcileCodexSnapshot;
export const reconcileCodex = reconcileCodexSnapshot;
