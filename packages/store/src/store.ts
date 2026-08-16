import { createHmac } from "node:crypto";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { LocalCostEstimateSchema, LocalPricingSnapshotSchema, LocalUsageSegmentsSchema, type LocalCostEstimate, type LocalPricingSnapshot, type LocalUsageSegments } from "@agent-farm/contracts";

import { migrate } from "./schema.js";
import {
  ConstraintError,
  IdempotencyConflictError,
  NotFoundError,
  ScopeError,
  StoreError,
} from "./errors.js";
import {
  bool,
  id,
  nowMillis,
  optional,
  parseJson,
  required,
  sanitizePayload,
  sha256,
  stableJson,
} from "./util.js";
import type {
  AgentEdge,
  AgentLifecycle,
  AgentRecord,
  AgentUpsertInput,
  ActiveBridgeBindingSelection,
  AppSession,
  AuditRecord,
  BridgeBinding,
  BridgeBindingInput,
  BridgeBindingStatus,
  EdgeInput,
  ReconcileEdgeInput,
  ReconcileEdgeResult,
  EventAuthority,
  EventConflict,
  EventIngestResult,
  EvidenceTrustClass,
  IdentityEvidence,
  IdentityEvidenceInput,
  IdempotencyRecord,
  McpGrantSessionBinding,
  McpGrantSessionBindingInput,
  McpGrantSessionBindingKey,
  McpGrantSessionBindingStatus,
  PrincipalScope,
  RebuiltSnapshot,
  SanitizedEvent,
  SanitizedEventInput,
  SessionCreateInput,
  SessionSnapshot,
  SessionStatus,
  SourceThreadMapping,
  VerificationState,
  TokenUsageRecord,
  PricingSnapshotInput,
  PricingSnapshotRecord,
} from "./types.js";

export interface StoreOptions {
  filename?: string;
  database?: Database.Database;
  now?: () => number;
  /** Deployment-stable key used to hash the MCP grant tuple. */
  mcpGrantDigestKey?: string;
  /** Maximum lifetime of one grant binding, measured from first creation. */
  mcpGrantBindingTtlMs?: number;
  /** Bound active mapping count; terminal rows remain revocable/auditable. */
  mcpGrantBindingMax?: number;
}

type SqlRow = Record<string, unknown>;

function assertDatabaseOwner(stat: { readonly uid: number }, filename: string): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Durable store database ${filename} is not owned by the current user`);
  }
}

function assertDatabasePathBeforeOpen(filename: string): void {
  const resolved = resolve(filename);
  if (!existsSync(resolved)) return;
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Durable store database ${filename} must be a regular file`);
  assertDatabaseOwner(stat, filename);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`Durable store database ${filename} must have mode 0600`);
}

function secureDatabasePathAfterOpen(filename: string): void {
  const resolved = resolve(filename);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Durable store database ${filename} must be a regular file`);
  assertDatabaseOwner(stat, filename);
  // A newly-created SQLite file inherits the process umask (often 0644).
  // Normalize only that newly-created owner file; pre-existing unsafe files
  // were rejected by the pre-open check above.
  if ((stat.mode & 0o777) !== 0o600) chmodSync(resolved, 0o600);
  const secure = lstatSync(resolved);
  assertDatabaseOwner(secure, filename);
  if ((secure.mode & 0o777) !== 0o600) throw new Error(`Durable store database ${filename} must have mode 0600`);
}

function scopeValues(scope: PrincipalScope): [string, string, string] {
  return [required(scope.tenantId, "tenantId"), required(scope.ownerId, "ownerId"), required(scope.agentSessionId, "agentSessionId")];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

function mapUsage(value: unknown): TokenUsageRecord | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const values = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
  if (values.some((key) => !Number.isSafeInteger(record[key]) || (record[key] as number) < 0)) return null;
  const usage = {
    inputTokens: record.inputTokens as number,
    cachedInputTokens: record.cachedInputTokens as number,
    cacheWriteInputTokens: record.cacheWriteInputTokens as number,
    outputTokens: record.outputTokens as number,
    reasoningOutputTokens: record.reasoningOutputTokens as number,
    totalTokens: record.totalTokens as number,
    ...(typeof record.observedAt === "string" ? { observedAt: record.observedAt } : {}),
  };
  if (usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens || usage.totalTokens !== usage.inputTokens + usage.outputTokens) return null;
  return usage;
}

function mapCost(value: unknown): LocalCostEstimate | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    const result = LocalCostEstimateSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function mapUsageSegments(value: unknown): LocalUsageSegments | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = LocalUsageSegmentsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Canonical content hash used by reviewed pricing artifacts and persistence.
 * The hash field is excluded so callers can construct a snapshot without
 * depending on a private repository implementation detail.
 */
export function pricingSnapshotHash(snapshot: Omit<LocalPricingSnapshot, "snapshotHash">): string {
  return sha256(snapshot);
}

function snapshotDigest(snapshot: LocalPricingSnapshot): string {
  const { snapshotHash: _ignored, ...body } = snapshot;
  return pricingSnapshotHash(body);
}

function validatePricingSnapshot(snapshot: LocalPricingSnapshot): LocalPricingSnapshot {
  const parsed = LocalPricingSnapshotSchema.parse(snapshot);
  if (snapshotDigest(parsed) !== parsed.snapshotHash) throw new ConstraintError("INVALID_INPUT", "pricing snapshot hash does not match its canonical body");
  return parsed;
}

function validUsage(value: TokenUsageRecord): boolean {
  return [value.inputTokens, value.cachedInputTokens, value.cacheWriteInputTokens, value.outputTokens, value.reasoningOutputTokens, value.totalTokens].every((item) => Number.isSafeInteger(item) && item >= 0) &&
    value.cachedInputTokens + value.cacheWriteInputTokens <= value.inputTokens &&
    value.totalTokens === value.inputTokens + value.outputTokens &&
    (value.observedAt === undefined || Number.isFinite(Date.parse(value.observedAt)));
}

/**
 * Rollout token_count values are cumulative.  A late retry/read must never
 * replace a newer observation with a lower counter.  Equality is allowed so
 * that a newer timestamp can refresh an otherwise identical snapshot.
 */
function usageIsOlder(existing: TokenUsageRecord | null | undefined, incoming: TokenUsageRecord): boolean {
  if (existing === null || existing === undefined) return false;
  const counters = [
    [incoming.inputTokens, existing.inputTokens],
    [incoming.cachedInputTokens, existing.cachedInputTokens],
    [incoming.cacheWriteInputTokens, existing.cacheWriteInputTokens],
    [incoming.outputTokens, existing.outputTokens],
    [incoming.reasoningOutputTokens, existing.reasoningOutputTokens],
    [incoming.totalTokens, existing.totalTokens],
  ] as const;
  if (counters.some(([next, prior]) => next < prior)) return true;
  if (incoming.observedAt === undefined && existing.observedAt !== undefined && counters.every(([next, prior]) => next === prior)) return true;
  if (incoming.observedAt !== undefined && existing.observedAt !== undefined && Date.parse(incoming.observedAt) < Date.parse(existing.observedAt)) return true;
  return false;
}

function mapSession(row: SqlRow): AppSession {
  return {
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    agentSessionId: String(row.agent_session_id),
    status: String(row.status) as SessionStatus,
    sourceAdapter: text(row.source_adapter),
    schemaVersion: numberValue(row.schema_version, 1),
    rootSourceThreadId: text(row.root_source_thread_id),
    rootSourceSessionId: text(row.root_source_session_id),
    watermarkIngestOrdinal: numberValue(row.watermark_ingest_ordinal),
    capabilities: parseJson<readonly string[]>(String(row.capabilities_json ?? "[]"), []),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}

function mapMapping(row: SqlRow): SourceThreadMapping {
  return {
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    agentSessionId: String(row.agent_session_id),
    sourceAdapter: String(row.source_adapter),
    sourceThreadId: String(row.source_thread_id),
    sourceSessionId: text(row.source_session_id),
    isRoot: bool(Number(row.is_root)),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}

function mapAgent(row: SqlRow): AgentRecord {
  return {
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    agentSessionId: String(row.agent_session_id),
    agentId: String(row.agent_id),
    sourceAdapter: text(row.source_adapter),
    sourceThreadId: text(row.source_thread_id),
    sourceSessionId: text(row.source_session_id),
    parentSourceThreadId: text(row.parent_source_thread_id),
    role: text(row.role),
    name: text(row.name),
    lifecycle: String(row.lifecycle) as AgentLifecycle,
    resultSummary: text(row.result_summary),
    errorSummary: text(row.error_summary),
    verificationState: String(row.verification_state) as VerificationState,
    isRoot: bool(Number(row.is_root)),
    spawnOrdinal: typeof row.spawn_ordinal === "number" ? numberValue(row.spawn_ordinal) : null,
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    usage: mapUsage(row.usage_json),
    usageSegments: mapUsageSegments(row.usage_segments_json),
    pricingSnapshotId: text(row.pricing_snapshot_id),
    cost: mapCost(row.cost_json),
    costUsageDigest: text(row.cost_usage_digest),
  };
}

function mapPricingSnapshot(row: SqlRow): PricingSnapshotRecord {
  const snapshot = LocalPricingSnapshotSchema.parse(JSON.parse(String(row.snapshot_json)));
  return {
    snapshotId: String(row.snapshot_id),
    snapshotHash: String(row.snapshot_hash),
    snapshot,
    createdAt: numberValue(row.created_at),
  };
}

function mapEdge(row: SqlRow): AgentEdge {
  return {
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    agentSessionId: String(row.agent_session_id),
    parentAgentId: String(row.parent_agent_id),
    childAgentId: String(row.child_agent_id),
    source: String(row.source),
    spawnOrdinal: typeof row.spawn_ordinal === "number" ? numberValue(row.spawn_ordinal) : null,
    createdAt: numberValue(row.created_at),
  };
}

function mapEvidence(row: SqlRow): IdentityEvidence {
  return {
    evidenceId: String(row.evidence_id),
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    agentSessionId: String(row.agent_session_id),
    agentId: String(row.agent_id),
    requestedModel: text(row.requested_model),
    requestedEffort: text(row.requested_effort),
    requestedProvider: text(row.requested_provider),
    observedModel: text(row.observed_model),
    observedEffort: text(row.observed_effort),
    observedProvider: text(row.observed_provider),
    source: String(row.source),
    observedAt: numberValue(row.observed_at),
    evidenceHash: String(row.evidence_hash),
    trustClass: String(row.trust_class) as EvidenceTrustClass,
  };
}

function mapEvent(row: SqlRow): SanitizedEvent {
  return {
    eventId: String(row.event_id),
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    agentSessionId: String(row.agent_session_id),
    connectionEpoch: String(row.connection_epoch),
    ingestOrdinal: numberValue(row.ingest_ordinal),
    eventKey: String(row.event_key),
    eventType: String(row.event_type),
    sourceAdapter: text(row.source_adapter),
    sourceThreadId: text(row.source_thread_id),
    sourceSessionId: text(row.source_session_id),
    turnId: text(row.turn_id),
    itemId: text(row.item_id),
    status: text(row.status),
    sanitizedPayloadHash: String(row.sanitized_payload_hash),
    sanitizedPayload: parseJson<Record<string, unknown>>(String(row.sanitized_payload_json), {}),
    correlationId: text(row.correlation_id),
    authority: String(row.authority) as EventAuthority,
    redactionVersion: String(row.redaction_version),
    observedAt: numberValue(row.observed_at),
    createdAt: numberValue(row.created_at),
  };
}

function mapBinding(row: SqlRow): BridgeBinding {
  return {
    bindingId: String(row.binding_id),
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    agentSessionId: String(row.agent_session_id),
    installationId: String(row.installation_id),
    sourceAdapter: String(row.source_adapter),
    selectedSourceRootId: String(row.selected_source_root_id),
    credentialHash: String(row.credential_hash),
    nonceHash: text(row.nonce_hash),
    expiresAt: numberValue(row.expires_at),
    status: String(row.status) as BridgeBindingStatus,
    createdAt: numberValue(row.created_at),
    revokedAt: typeof row.revoked_at === "number" ? row.revoked_at : null,
  };
}

function mapAudit(row: SqlRow): AuditRecord {
  return {
    auditId: String(row.audit_id),
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    agentSessionId: text(row.agent_session_id),
    action: String(row.action),
    actorType: String(row.actor_type),
    actorId: String(row.actor_id),
    metadata: parseJson<Record<string, unknown>>(String(row.metadata_json), {}),
    createdAt: numberValue(row.created_at),
  };
}

function mapMcpGrantBinding(row: SqlRow): McpGrantSessionBinding {
  return {
    grantKeyDigest: String(row.grant_key_digest),
    agentSessionId: String(row.agent_session_id),
    status: String(row.status) as McpGrantSessionBindingStatus,
    expiresAt: numberValue(row.expires_at),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    revokedAt: typeof row.revoked_at === "number" ? row.revoked_at : null,
  };
}

export class DurableStore {
  readonly db: Database.Database;
  readonly sessions: SessionRepository;
  readonly sourceMappings: SourceThreadMappingRepository;
  readonly agents: AgentRepository;
  readonly pricingSnapshots: PricingSnapshotRepository;
  readonly edges: EdgeRepository;
  readonly identityEvidence: IdentityEvidenceRepository;
  readonly events: EventRepository;
  readonly bridgeBindings: BridgeBindingRepository;
  readonly mcpGrantBindings: McpGrantSessionBindingRepository;
  readonly idempotency: IdempotencyRepository;
  readonly audit: AuditRepository;

  private readonly clock: () => number;
  private readonly mcpGrantDigestKey: string;
  private readonly mcpGrantBindingTtlMs: number;
  private readonly mcpGrantBindingMax: number;
  private transactionDepth = 0;

  constructor(options: string | StoreOptions = ":memory:") {
    const config = typeof options === "string" ? { filename: options } : options;
    const filename = config.filename ?? ":memory:";
    if (config.database === undefined && filename !== ":memory:") assertDatabasePathBeforeOpen(filename);
    const database = config.database ?? new Database(filename);
    try {
      if (config.database === undefined && filename !== ":memory:") secureDatabasePathAfterOpen(filename);
    } catch (error) {
      if (config.database === undefined) database.close();
      throw error;
    }
    this.db = database;
    this.clock = config.now ?? nowMillis;
    this.mcpGrantDigestKey = required(config.mcpGrantDigestKey ?? "agent-farm:mcp-grant-binding:v1", "mcpGrantDigestKey");
    this.mcpGrantBindingTtlMs = boundedStorePositive(config.mcpGrantBindingTtlMs ?? 24 * 60 * 60 * 1_000, "mcpGrantBindingTtlMs");
    this.mcpGrantBindingMax = boundedStorePositiveInteger(config.mcpGrantBindingMax ?? 4_096, "mcpGrantBindingMax");
    migrate(this.db);
    this.sessions = new SessionRepository(this);
    this.sourceMappings = new SourceThreadMappingRepository(this);
    this.agents = new AgentRepository(this);
    this.pricingSnapshots = new PricingSnapshotRepository(this);
    this.edges = new EdgeRepository(this);
    this.identityEvidence = new IdentityEvidenceRepository(this);
    this.events = new EventRepository(this);
    this.bridgeBindings = new BridgeBindingRepository(this);
    this.mcpGrantBindings = new McpGrantSessionBindingRepository(
      this,
      this.mcpGrantDigestKey,
      this.mcpGrantBindingTtlMs,
      this.mcpGrantBindingMax,
    );
    this.idempotency = new IdempotencyRepository(this);
    this.audit = new AuditRepository(this);
  }

  /** Compatibility alias used by application wiring. */
  get appSessions(): SessionRepository {
    return this.sessions;
  }

  get sourceThreadMappings(): SourceThreadMappingRepository {
    return this.sourceMappings;
  }

  createAgentSession(input: SessionCreateInput): AppSession {
    return this.sessions.create(input);
  }

  getAgentHierarchy(scope: PrincipalScope): SessionSnapshot {
    return this.getSnapshot(scope);
  }

  getAgentDetails(scope: PrincipalScope, agentId: string): AgentRecord {
    return this.agents.get(scope, agentId);
  }

  ingestEvent(scope: PrincipalScope, input: SanitizedEventInput): EventIngestResult {
    return this.events.ingest(scope, input);
  }

  now(): number {
    return this.clock();
  }

  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.transactionDepth += 1;
    try {
      return this.db.transaction(fn)();
    } finally {
      this.transactionDepth -= 1;
    }
  }

  close(): void {
    this.db.close();
  }

  assertSession(scope: PrincipalScope): void {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    const row = this.db
      .prepare("SELECT 1 AS present FROM app_sessions WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?")
      .get(tenantId, ownerId, agentSessionId) as SqlRow | undefined;
    if (!row) throw new NotFoundError("Agent Farm session was not found");
  }

  readSession(scope: PrincipalScope): AppSession {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    const row = this.db
      .prepare("SELECT * FROM app_sessions WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?")
      .get(tenantId, ownerId, agentSessionId) as SqlRow | undefined;
    if (!row) throw new NotFoundError("Agent Farm session was not found");
    return mapSession(row);
  }

  getSnapshot(scope: PrincipalScope): SessionSnapshot {
    const session = this.readSession(scope);
    return {
      session,
      agents: this.agents.list(scope),
      edges: this.edges.list(scope),
      identityEvidence: this.identityEvidence.list(scope),
      watermarkIngestOrdinal: session.watermarkIngestOrdinal,
    };
  }

  /**
   * Replay the append-only event stream into a deterministic projection and
   * compare it with the live rows. The live projection is never mutated by a
   * read/rebuild operation.
   */
  rebuildSnapshot(scope: PrincipalScope): RebuiltSnapshot {
    const live = this.getSnapshot(scope);
    const events = this.events.list(scope);
    if (events.length === 0) {
      return { ...live, rebuiltFromEventCount: 0, equivalentToLiveProjection: true };
    }

    const replay = new ReplayProjection(scope, live.session);
    for (const event of events) replay.apply(event);
    const rebuilt: SessionSnapshot = {
      session: live.session,
      agents: replay.agents(),
      edges: replay.edges(),
      identityEvidence: replay.evidence(),
      watermarkIngestOrdinal: live.watermarkIngestOrdinal,
    };
    // Compare per projection record rather than serializing the complete
    // fleet. Each record is strictly bounded, while several valid agents with
    // 1,024 usage segments can exceed the generic aggregate serialization cap.
    const agentSignature = (agents: readonly AgentRecord[]): string[] => agents.map((agent) => sha256(agent)).sort();
    const edgeSignature = (edges: readonly AgentEdge[]): string[] => edges.map((edge) => sha256(edge)).sort();
    const evidenceSignature = (evidence: readonly IdentityEvidence[]): string[] => evidence.map((item) => sha256(item)).sort();
    const equivalent = stableJson(rebuilt.session) === stableJson(live.session) &&
      stableJson(agentSignature(rebuilt.agents)) === stableJson(agentSignature(live.agents)) &&
      stableJson(edgeSignature(rebuilt.edges)) === stableJson(edgeSignature(live.edges)) &&
      stableJson(evidenceSignature(rebuilt.identityEvidence)) === stableJson(evidenceSignature(live.identityEvidence)) &&
      rebuilt.watermarkIngestOrdinal === live.watermarkIngestOrdinal;
    return { ...live, rebuiltFromEventCount: events.length, equivalentToLiveProjection: equivalent };
  }

  /** Name used by callers that treat rebuilding as a snapshot service. */
  rebuild(scope: PrincipalScope): RebuiltSnapshot {
    return this.rebuildSnapshot(scope);
  }

  rebuildProjection(scope: PrincipalScope): RebuiltSnapshot {
    return this.rebuildSnapshot(scope);
  }

  snapshot(scope: PrincipalScope): SessionSnapshot {
    return this.getSnapshot(scope);
  }

  deleteAgentSession(scope: PrincipalScope, actor = { actorType: "user", actorId: scope.ownerId }): boolean {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT 1 AS present FROM app_sessions WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?")
        .get(tenantId, ownerId, agentSessionId) as SqlRow | undefined;
      if (!existing) return false;

      // Preserve a deletion tombstone outside the deleted projection rows.
      this.audit.append({
        tenantId,
        ownerId,
        agentSessionId,
        action: "agent_session.deleted",
        actorType: actor.actorType,
        actorId: actor.actorId,
        metadata: { deletionScope: "agent-farm-only" },
      });
      this.db
        .prepare("DELETE FROM idempotency_records WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?")
        .run(tenantId, ownerId, agentSessionId);
      // Explicit Agent Farm session deletion is a separate lifecycle boundary
      // from MCP DELETE. Revoke every durable grant mapping that pointed at
      // this session so a later remount cannot resurrect deleted data.
      this.mcpGrantBindings.revokeForAgentSession(agentSessionId);
      this.db.prepare("INSERT INTO store_maintenance(marker) VALUES ('session-delete')").run();
      this.db
        .prepare("DELETE FROM app_sessions WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?")
        .run(tenantId, ownerId, agentSessionId);
      this.db.prepare("DELETE FROM store_maintenance WHERE marker = 'session-delete'").run();
      return true;
    });
  }

  /** Alias kept intentionally explicit about the Agent Farm-only boundary. */
  deleteSession(scope: PrincipalScope, actor?: { actorType: string; actorId: string }): boolean {
    return this.deleteAgentSession(scope, actor);
  }

  /** Internal projection application for sanitized events. */
  applyEvent(event: SanitizedEvent): void {
    const payload = event.sanitizedPayload;
    const eventType = event.eventType.toLowerCase();
    if (eventType === "thread.status.changed") {
      const agentId = typeof payload.agentId === "string" ? payload.agentId : undefined;
      if (agentId) {
        const existing = this.agents.list(eventScope(event)).find((candidate) => candidate.agentId === agentId);
        if (existing) this.agents.upsert(eventScope(event), {
          agentId,
          sourceAdapter: existing.sourceAdapter,
          sourceThreadId: existing.sourceThreadId ?? event.sourceThreadId,
          sourceSessionId: existing.sourceSessionId ?? event.sourceSessionId,
          parentSourceThreadId: existing.parentSourceThreadId,
          role: existing.role,
          name: existing.name,
          lifecycle: lifecycleOrUnknown(payload.status),
          resultSummary: existing.resultSummary,
          errorSummary: existing.errorSummary,
          verificationState: existing.verificationState,
          isRoot: existing.isRoot,
          spawnOrdinal: existing.spawnOrdinal,
          usage: existing.usage,
          createdAt: existing.createdAt,
          updatedAt: event.observedAt,
        });
      }
      return;
    }
    if (eventType === "agent.upsert" || eventType === "agent.created" || eventType === "agent.updated" || eventType === "agent.reconciled" || eventType === "cost.projected") {
      const nested = payload.agent && typeof payload.agent === "object" && !Array.isArray(payload.agent)
        ? payload.agent as Record<string, unknown>
        : payload;
      const agentId = typeof nested.agentId === "string" ? nested.agentId : event.sourceThreadId;
      if (!agentId) return;
      if (eventType === "cost.projected") {
        this.agents.upsert(eventScope(event), {
          agentId,
          ...(Object.prototype.hasOwnProperty.call(nested, "pricingSnapshotId") ? { pricingSnapshotId: stringOrNull(nested.pricingSnapshotId) } : {}),
          ...(Object.prototype.hasOwnProperty.call(nested, "cost") ? { cost: nested.cost === null ? null : mapCostFromPayload(nested.cost) } : {}),
          updatedAt: event.observedAt,
        });
        return;
      }
      this.agents.upsert({
        ...eventScope(event),
        agentId,
        sourceAdapter: stringOrNull(nested.sourceAdapter ?? event.sourceAdapter),
        sourceThreadId: stringOrNull(nested.sourceThreadId ?? event.sourceThreadId),
        sourceSessionId: stringOrNull(nested.sourceSessionId ?? event.sourceSessionId),
        parentSourceThreadId: stringOrNull(nested.parentSourceThreadId),
        role: stringOrNull(nested.role),
        name: stringOrNull(nested.name),
        lifecycle: lifecycleOrUnknown(nested.lifecycle ?? event.status),
        resultSummary: stringOrNull(nested.resultSummary ?? nested.summary),
        errorSummary: stringOrNull(nested.errorSummary ?? nested.errorCode),
        verificationState: verificationOrUnknown(nested.verificationState),
        isRoot: nested.isRoot === true,
        spawnOrdinal: event.ingestOrdinal,
        ...(Object.prototype.hasOwnProperty.call(nested, "usage")
          ? { usage: nested.usage === null ? null : parseEventUsage(nested.usage) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(nested, "usageSegments")
          ? { usageSegments: nested.usageSegments === null ? null : mapUsageSegmentsFromPayload(nested.usageSegments) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(nested, "pricingSnapshotId") ? { pricingSnapshotId: stringOrNull(nested.pricingSnapshotId) } : {}),
        ...(Object.prototype.hasOwnProperty.call(nested, "cost") ? { cost: nested.cost === null ? null : mapCostFromPayload(nested.cost) } : {}),
        createdAt: event.observedAt,
        updatedAt: event.observedAt,
      });
      return;
    }
    if (eventType === "agent.removed" || eventType === "agent.deleted") {
      const agentId = typeof payload.agentId === "string" ? payload.agentId : undefined;
      if (agentId) this.agents.remove(eventScope(event), agentId);
      return;
    }
    if (eventType === "edge.added" || eventType === "edge.created" || eventType === "edge.spawn" || eventType === "edge.reconciled" || eventType === "projection.edge") {
      const nested = payload.edge && typeof payload.edge === "object" && !Array.isArray(payload.edge)
        ? payload.edge as Record<string, unknown>
        : payload;
      const parentAgentId = typeof nested.parentAgentId === "string" ? nested.parentAgentId : undefined;
      const childAgentId = typeof nested.childAgentId === "string" ? nested.childAgentId : undefined;
      if (parentAgentId && childAgentId) {
        if (eventType === "edge.reconciled") {
          this.edges.reconcile(eventScope(event), {
            parentAgentId,
            childAgentId,
            connectionEpoch: typeof nested.connectionEpoch === "string" ? nested.connectionEpoch : event.connectionEpoch,
            source: "codex-reconciliation",
            createdAt: event.observedAt,
            sourceEventId: event.eventId,
            ingestOrdinal: event.ingestOrdinal,
          });
        } else {
          // The append-only event timestamp is the projection authority. Using
          // a fresh wall-clock value here makes the live edge differ from a
          // later replay whenever the two clock reads cross a millisecond.
          this.edges.add(eventScope(event), {
            parentAgentId,
            childAgentId,
            source: "event",
            spawnOrdinal: event.ingestOrdinal,
            createdAt: event.observedAt,
          });
        }
      }
      return;
    }
    if (eventType === "identity.evidence" || eventType === "identity.observed" || eventType === "identity.requested" || eventType === "model.rerouted") {
      const agentId = typeof payload.agentId === "string" ? payload.agentId : undefined;
      if (agentId) {
        const values = (payload.values && typeof payload.values === "object" && !Array.isArray(payload.values))
          ? payload.values as Record<string, unknown>
          : undefined;
        const reroutedValues = (payload.to && typeof payload.to === "object" && !Array.isArray(payload.to))
          ? payload.to as Record<string, unknown>
          : undefined;
        this.identityEvidence.append(eventScope(event), {
          evidenceId: event.eventId,
          agentId,
          requestedModel: stringOrNull(payload.requestedModel ?? (eventType === "identity.requested" ? values?.model : undefined)),
          requestedEffort: stringOrNull(payload.requestedEffort ?? (eventType === "identity.requested" ? values?.effort : undefined)),
          requestedProvider: stringOrNull(payload.requestedProvider ?? (eventType === "identity.requested" ? values?.provider : undefined)),
          observedModel: stringOrNull(payload.observedModel ?? payload.model ?? reroutedValues?.model ?? (eventType === "identity.observed" ? values?.model : undefined)),
          observedEffort: stringOrNull(payload.observedEffort ?? payload.effort ?? reroutedValues?.effort ?? (eventType === "identity.observed" ? values?.effort : undefined)),
          observedProvider: stringOrNull(payload.observedProvider ?? payload.provider ?? reroutedValues?.provider ?? (eventType === "identity.observed" ? values?.provider : undefined)),
          source: typeof payload.evidenceSource === "string" ? payload.evidenceSource : "event",
          observedAt: event.observedAt,
          evidenceHash: event.sanitizedPayloadHash,
          trustClass: trustOrObserved(payload.trustClass),
        });
      }
    }
  }
}

function eventScope(event: SanitizedEvent): PrincipalScope {
  return { tenantId: event.tenantId, ownerId: event.ownerId, agentSessionId: event.agentSessionId };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseEventUsage(value: unknown): TokenUsageRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const usage = {
    inputTokens: candidate.inputTokens,
    cachedInputTokens: candidate.cachedInputTokens,
    cacheWriteInputTokens: candidate.cacheWriteInputTokens,
    outputTokens: candidate.outputTokens,
    reasoningOutputTokens: candidate.reasoningOutputTokens,
    totalTokens: candidate.totalTokens,
    ...(typeof candidate.observedAt === "string" ? { observedAt: candidate.observedAt } : {}),
  } as TokenUsageRecord;
  return validUsage(usage) ? usage : null;
}

function mapCostFromPayload(value: unknown): LocalCostEstimate | null {
  const parsed = LocalCostEstimateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function mapUsageSegmentsFromPayload(value: unknown): LocalUsageSegments | null {
  const parsed = LocalUsageSegmentsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function lifecycleOrUnknown(value: unknown): AgentLifecycle {
  const values: readonly AgentLifecycle[] = ["unknown", "pending", "queued", "active", "idle", "completed", "failed", "interrupted", "disconnected"];
  return typeof value === "string" && values.includes(value as AgentLifecycle) ? value as AgentLifecycle : "unknown";
}

function verificationOrUnknown(value: unknown): VerificationState {
  return value === "verified" || value === "mismatch" ? value : "unverified";
}

function trustOrObserved(value: unknown): EvidenceTrustClass {
  return value === "requested" || value === "reconciled" ? value : "observed";
}

export class SessionRepository {
  constructor(private readonly store: DurableStore) {}

  create(input: SessionCreateInput): AppSession {
    const tenantId = required(input.tenantId, "tenantId");
    const ownerId = required(input.ownerId, "ownerId");
    const operation = "create_agent_session";
    const requestHash = sha256(input.requestPayload ?? {
      status: input.status ?? "active",
      sourceAdapter: input.sourceAdapter ?? null,
      schemaVersion: input.schemaVersion ?? 1,
      rootSourceThreadId: input.rootSourceThreadId ?? null,
      rootSourceSessionId: input.rootSourceSessionId ?? null,
      capabilities: input.capabilities ?? [],
    });

    if (input.idempotencyKey) {
      const previous = this.store.idempotency.findForOwner(tenantId, ownerId, operation, input.idempotencyKey);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new IdempotencyConflictError();
        try {
          return JSON.parse(previous.responseJson) as AppSession;
        } catch {
          throw new StoreError("CORRUPT_IDEMPOTENCY", "Stored idempotency response is invalid");
        }
      }
    }

    const agentSessionId = required(input.agentSessionId ?? id(), "agentSessionId");
    const timestamp = this.store.now();
    const session = this.store.transaction(() => {
      const existing = this.store.db
        .prepare("SELECT * FROM app_sessions WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?")
        .get(tenantId, ownerId, agentSessionId) as SqlRow | undefined;
      if (existing) throw new ConstraintError("SESSION_EXISTS", "Agent Farm session already exists");
      this.store.db.prepare(`
        INSERT INTO app_sessions
          (tenant_id, owner_id, agent_session_id, status, source_adapter, schema_version,
           root_source_thread_id, root_source_session_id, capabilities_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tenantId,
        ownerId,
        agentSessionId,
        input.status ?? "active",
        optional(input.sourceAdapter),
        input.schemaVersion ?? 1,
        optional(input.rootSourceThreadId),
        optional(input.rootSourceSessionId),
        stableJson(input.capabilities ?? []),
        timestamp,
        timestamp,
      );
      const created = this.store.readSession({ tenantId, ownerId, agentSessionId });
      if (input.rootSourceThreadId && input.sourceAdapter) {
        this.store.sourceMappings.upsert({
          tenantId,
          ownerId,
          agentSessionId,
          sourceAdapter: input.sourceAdapter,
          sourceThreadId: input.rootSourceThreadId,
          sourceSessionId: optional(input.rootSourceSessionId),
          isRoot: true,
        });
      }
      if (input.idempotencyKey) {
        this.store.idempotency.record(
          { tenantId, ownerId, agentSessionId },
          { operation, idempotencyKey: input.idempotencyKey },
          requestHash,
          created,
        );
      }
      this.store.audit.append({
        tenantId,
        ownerId,
        agentSessionId,
        action: "agent_session.created",
        actorType: "user",
        actorId: ownerId,
        metadata: { sourceAdapter: input.sourceAdapter ?? null },
      });
      return created;
    });
    return session;
  }

  get(scope: PrincipalScope): AppSession {
    return this.store.readSession(scope);
  }

  update(scope: PrincipalScope, patch: Partial<Pick<AppSession, "status" | "sourceAdapter" | "schemaVersion" | "rootSourceThreadId" | "rootSourceSessionId" | "capabilities">>): AppSession {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) { fields.push("status = ?"); values.push(patch.status); }
    if (patch.sourceAdapter !== undefined) { fields.push("source_adapter = ?"); values.push(patch.sourceAdapter); }
    if (patch.schemaVersion !== undefined) { fields.push("schema_version = ?"); values.push(patch.schemaVersion); }
    if (patch.rootSourceThreadId !== undefined) { fields.push("root_source_thread_id = ?"); values.push(patch.rootSourceThreadId); }
    if (patch.rootSourceSessionId !== undefined) { fields.push("root_source_session_id = ?"); values.push(patch.rootSourceSessionId); }
    if (patch.capabilities !== undefined) { fields.push("capabilities_json = ?"); values.push(stableJson(patch.capabilities)); }
    if (fields.length) {
      fields.push("updated_at = ?"); values.push(this.store.now());
      values.push(tenantId, ownerId, agentSessionId);
      this.store.db.prepare(`UPDATE app_sessions SET ${fields.join(", ")} WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?`).run(...values);
    }
    return this.store.readSession(scope);
  }
}

export class SourceThreadMappingRepository {
  constructor(private readonly store: DurableStore) {}

  upsert(scope: PrincipalScope, input: Omit<SourceThreadMapping, "tenantId" | "ownerId" | "agentSessionId" | "createdAt" | "updatedAt">): SourceThreadMapping;
  upsert(input: Omit<SourceThreadMapping, "createdAt" | "updatedAt">): SourceThreadMapping;
  upsert(first: PrincipalScope | Omit<SourceThreadMapping, "createdAt" | "updatedAt">, second?: Omit<SourceThreadMapping, "tenantId" | "ownerId" | "agentSessionId" | "createdAt" | "updatedAt">): SourceThreadMapping {
    const input = (second ? { ...first, ...second } : first) as Omit<SourceThreadMapping, "createdAt" | "updatedAt">;
    const [tenantId, ownerId, agentSessionId] = scopeValues(input);
    const sourceAdapter = required(input.sourceAdapter, "sourceAdapter");
    const sourceThreadId = required(input.sourceThreadId, "sourceThreadId");
    this.store.assertSession({ tenantId, ownerId, agentSessionId });
    return this.store.transaction(() => {
      const timestamp = this.store.now();
      if (input.isRoot) {
        this.store.db.prepare(`UPDATE private_source_thread_mappings SET is_root = 0, updated_at = ?
          WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?`).run(timestamp, tenantId, ownerId, agentSessionId);
      }
      this.store.db.prepare(`
        INSERT INTO private_source_thread_mappings
          (tenant_id, owner_id, agent_session_id, source_adapter, source_thread_id, source_session_id, is_root, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, owner_id, agent_session_id, source_adapter, source_thread_id)
        DO UPDATE SET source_session_id = excluded.source_session_id, is_root = excluded.is_root, updated_at = excluded.updated_at
      `).run(tenantId, ownerId, agentSessionId, sourceAdapter, sourceThreadId, optional(input.sourceSessionId), input.isRoot ? 1 : 0, timestamp, timestamp);
      if (input.isRoot) {
        this.store.sessions.update({ tenantId, ownerId, agentSessionId }, {
          rootSourceThreadId: sourceThreadId,
          rootSourceSessionId: optional(input.sourceSessionId),
        });
      }
      const row = this.store.db.prepare(`SELECT * FROM private_source_thread_mappings
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND source_adapter = ? AND source_thread_id = ?`)
        .get(tenantId, ownerId, agentSessionId, sourceAdapter, sourceThreadId) as SqlRow | undefined;
      if (!row) throw new StoreError("MAPPING_WRITE_FAILED", "Source-thread mapping was not written");
      return mapMapping(row);
    });
  }

  get(scope: PrincipalScope, sourceAdapter: string, sourceThreadId: string): SourceThreadMapping {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    const row = this.store.db.prepare(`SELECT * FROM private_source_thread_mappings
      WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND source_adapter = ? AND source_thread_id = ?`)
      .get(tenantId, ownerId, agentSessionId, required(sourceAdapter, "sourceAdapter"), required(sourceThreadId, "sourceThreadId")) as SqlRow | undefined;
    if (!row) throw new NotFoundError("Source-thread mapping was not found");
    return mapMapping(row);
  }

  list(scope: PrincipalScope): SourceThreadMapping[] {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    return (this.store.db.prepare(`SELECT * FROM private_source_thread_mappings
      WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? ORDER BY source_adapter, source_thread_id`)
      .all(tenantId, ownerId, agentSessionId) as unknown[]).map((value) => mapMapping(value as SqlRow));
  }
}

export class AgentRepository {
  constructor(private readonly store: DurableStore) {}

  upsert(scope: PrincipalScope, input: AgentUpsertInput): AgentRecord;
  upsert(input: AgentUpsertInput & PrincipalScope): AgentRecord;
  upsert(first: (AgentUpsertInput & PrincipalScope) | PrincipalScope, second?: AgentUpsertInput): AgentRecord {
    const input = second ? { ...first, ...second } as AgentUpsertInput & PrincipalScope : first as AgentUpsertInput & PrincipalScope;
    const [tenantId, ownerId, agentSessionId] = scopeValues(input);
    const agentId = required(input.agentId, "agentId");
    this.store.assertSession({ tenantId, ownerId, agentSessionId });
    return this.store.transaction(() => {
      const timestamp = this.store.now();
      const existingRow = this.store.db.prepare(`SELECT * FROM agents
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND agent_id = ?`)
        .get(tenantId, ownerId, agentSessionId, agentId) as SqlRow | undefined;
      const existing = existingRow ? mapAgent(existingRow) : undefined;
      const sourceAdapter = input.sourceAdapter !== undefined ? optional(input.sourceAdapter) : existing?.sourceAdapter ?? null;
      const sourceThreadId = input.sourceThreadId !== undefined ? optional(input.sourceThreadId) : existing?.sourceThreadId ?? null;
      const sourceSessionId = input.sourceSessionId !== undefined ? optional(input.sourceSessionId) : existing?.sourceSessionId ?? null;
      const isRoot = input.isRoot ?? existing?.isRoot ?? false;
      const persistedUsage = input.usage === undefined
        ? existing?.usage ?? null
        : input.usage === null
          ? null
          : validUsage(input.usage)
            ? usageIsOlder(existing?.usage, input.usage) ? existing?.usage ?? null : input.usage
            : (() => { throw new ConstraintError("INVALID_INPUT", "usage is invalid"); })();
      const persistedUsageSegments = input.usageSegments === undefined
        ? existing?.usageSegments ?? null
        : input.usageSegments === null
          ? null
          : (() => {
              const parsed = LocalUsageSegmentsSchema.safeParse(input.usageSegments);
              if (!parsed.success) throw new ConstraintError("INVALID_INPUT", "usage segments are invalid");
              return parsed.data;
            })();
      let pricingSnapshotId = input.pricingSnapshotId !== undefined ? optional(input.pricingSnapshotId) : existing?.pricingSnapshotId ?? null;
      let persistedCost: LocalCostEstimate | null = input.cost !== undefined ? input.cost : existing?.cost ?? null;
      const usageChanged = input.usage !== undefined && stableJson(persistedUsage) !== stableJson(existing?.usage ?? null);
      if (usageChanged && input.cost === undefined) {
        pricingSnapshotId = null;
        persistedCost = null;
      }
      if (input.usageSegments !== undefined && input.cost === undefined && stableJson(persistedUsageSegments) !== stableJson(existing?.usageSegments ?? null)) {
        pricingSnapshotId = null;
        persistedCost = null;
      }
      if (input.cost !== undefined && input.cost !== null) {
        const parsedCost = LocalCostEstimateSchema.safeParse(input.cost);
        if (!parsedCost.success || (parsedCost.data.status === "estimated" || parsedCost.data.status === "partial" && parsedCost.data.pricing !== undefined) && pricingSnapshotId === null) throw new ConstraintError("INVALID_INPUT", "priced cost requires a pinned pricing snapshot");
        if (parsedCost.success && (parsedCost.data.status === "estimated" || parsedCost.data.status === "partial" && parsedCost.data.pricing !== undefined)) {
          const snapshot = this.store.pricingSnapshots.get(pricingSnapshotId as string);
          if (stableJson(parsedCost.data.pricing) !== stableJson(snapshot.snapshot)) throw new ConstraintError("INVALID_INPUT", "cost pricing does not match pinned snapshot");
          if (parsedCost.data.status === "estimated" && (persistedUsage === null || sha256(persistedUsage) !== sha256(parsedCost.data.usage))) throw new ConstraintError("INVALID_INPUT", "cost usage does not match persisted usage");
        }
        persistedCost = parsedCost.success ? parsedCost.data : null;
      }
      if (input.cost === null) {
        persistedCost = null;
        pricingSnapshotId = null;
      }
      if (pricingSnapshotId !== null) {
        const snapshot = this.store.pricingSnapshots.get(pricingSnapshotId);
        if ((persistedCost?.status !== "estimated" && persistedCost?.status !== "partial") || stableJson(persistedCost.pricing) !== stableJson(snapshot.snapshot)) {
          throw new ConstraintError("INVALID_INPUT", "pricing snapshot pin requires a matching priced cost");
        }
      }
      const costUsageDigest = persistedCost?.status === "estimated" && persistedUsage !== null ? sha256(persistedUsage) : null;
      if (isRoot) {
        this.store.db.prepare(`UPDATE agents SET is_root = 0, updated_at = ?
          WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?`).run(timestamp, tenantId, ownerId, agentSessionId);
      }
      try {
        this.store.db.prepare(`
          INSERT INTO agents
            (tenant_id, owner_id, agent_session_id, agent_id, source_adapter, source_thread_id, source_session_id,
             parent_source_thread_id, role, name, lifecycle, result_summary, error_summary, verification_state,
             is_root, spawn_ordinal, usage_json, usage_segments_json, pricing_snapshot_id, cost_json, cost_usage_digest, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, owner_id, agent_session_id, agent_id)
          DO UPDATE SET source_adapter = excluded.source_adapter, source_thread_id = excluded.source_thread_id,
            source_session_id = excluded.source_session_id, parent_source_thread_id = excluded.parent_source_thread_id,
            role = excluded.role, name = excluded.name, lifecycle = excluded.lifecycle,
            result_summary = excluded.result_summary, error_summary = excluded.error_summary,
            verification_state = excluded.verification_state, is_root = excluded.is_root,
            spawn_ordinal = COALESCE(agents.spawn_ordinal, excluded.spawn_ordinal), usage_json = excluded.usage_json,
            usage_segments_json = excluded.usage_segments_json,
            pricing_snapshot_id = excluded.pricing_snapshot_id, cost_json = excluded.cost_json,
            cost_usage_digest = excluded.cost_usage_digest, updated_at = excluded.updated_at
        `).run(
          tenantId,
          ownerId,
          agentSessionId,
          agentId,
          sourceAdapter,
          sourceThreadId,
          sourceSessionId,
          input.parentSourceThreadId !== undefined ? optional(input.parentSourceThreadId) : existing?.parentSourceThreadId ?? null,
          input.role !== undefined ? optional(input.role) : existing?.role ?? null,
          input.name !== undefined ? optional(input.name) : existing?.name ?? null,
          input.lifecycle ?? existing?.lifecycle ?? "unknown",
          input.resultSummary !== undefined ? optional(input.resultSummary) : existing?.resultSummary ?? null,
          input.errorSummary !== undefined ? optional(input.errorSummary) : existing?.errorSummary ?? null,
          input.verificationState ?? existing?.verificationState ?? "unverified",
          isRoot ? 1 : 0,
          input.spawnOrdinal !== undefined ? input.spawnOrdinal : existing?.spawnOrdinal ?? null,
          persistedUsage === null ? null : JSON.stringify(persistedUsage),
          persistedUsageSegments === null ? null : JSON.stringify(persistedUsageSegments),
          pricingSnapshotId,
          persistedCost === null ? null : JSON.stringify(persistedCost),
          costUsageDigest,
          existing?.createdAt ?? input.createdAt ?? timestamp,
          input.updatedAt ?? timestamp,
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE")) {
          throw new ConstraintError("SOURCE_IDENTITY_CONFLICT", "Source thread identity already belongs to another agent in this session");
        }
        throw error;
      }
      if (sourceAdapter && sourceThreadId) {
        this.store.sourceMappings.upsert({
          tenantId,
          ownerId,
          agentSessionId,
          sourceAdapter,
          sourceThreadId,
          sourceSessionId,
          isRoot,
        });
      }
      const row = this.store.db.prepare(`SELECT * FROM agents
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND agent_id = ?`)
        .get(tenantId, ownerId, agentSessionId, agentId) as SqlRow | undefined;
      if (!row) throw new StoreError("AGENT_WRITE_FAILED", "Agent was not written");
      return mapAgent(row);
    });
  }

  get(scope: PrincipalScope, agentId: string): AgentRecord {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    const row = this.store.db.prepare(`SELECT * FROM agents
      WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND agent_id = ?`)
      .get(tenantId, ownerId, agentSessionId, required(agentId, "agentId")) as SqlRow | undefined;
    if (!row) throw new NotFoundError("Agent was not found");
    return mapAgent(row);
  }

  list(scope: PrincipalScope): AgentRecord[] {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    return (this.store.db.prepare(`SELECT * FROM agents WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?
      ORDER BY is_root DESC, CASE WHEN spawn_ordinal IS NULL THEN 1 ELSE 0 END ASC,
        spawn_ordinal ASC, created_at ASC, agent_id ASC`).all(tenantId, ownerId, agentSessionId) as unknown[]).map((value) => mapAgent(value as SqlRow));
  }

  remove(scope: PrincipalScope, agentId: string): boolean {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    // Evidence is append-only. A source removal therefore tombstones the
    // projection row instead of deleting the identity/evidence history.
    const result = this.store.db.prepare(`UPDATE agents SET lifecycle = 'unknown', verification_state = 'unverified', updated_at = ?
      WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND agent_id = ?`)
      .run(this.store.now(), tenantId, ownerId, agentSessionId, required(agentId, "agentId"));
    return result.changes > 0;
  }
}

export class PricingSnapshotRepository {
  constructor(private readonly store: DurableStore) {}

  put(input: PricingSnapshotInput): PricingSnapshotRecord {
    const snapshotId = required(input.snapshotId, "snapshotId");
    const snapshot = validatePricingSnapshot(input.snapshot);
    if (snapshot.snapshotId !== snapshotId) throw new ConstraintError("INVALID_INPUT", "snapshot id does not match snapshot body");
    const snapshotHash = snapshot.snapshotHash;
    return this.store.transaction(() => {
      const existing = this.store.db.prepare("SELECT * FROM pricing_snapshots WHERE snapshot_id = ?").get(snapshotId) as SqlRow | undefined;
      if (existing) {
        if (String(existing.snapshot_hash) !== snapshotHash || String(existing.snapshot_json) !== stableJson(snapshot)) throw new ConstraintError("PRICING_SNAPSHOT_CONFLICT", "pricing snapshot id is immutable");
        return mapPricingSnapshot(existing);
      }
      const hashOwner = this.store.db.prepare("SELECT snapshot_id FROM pricing_snapshots WHERE snapshot_hash = ?").get(snapshotHash) as SqlRow | undefined;
      if (hashOwner && String(hashOwner.snapshot_id) !== snapshotId) throw new ConstraintError("PRICING_SNAPSHOT_CONFLICT", "pricing snapshot hash is already bound to another id");
      this.store.db.prepare("INSERT INTO pricing_snapshots(snapshot_id, snapshot_hash, snapshot_json, created_at) VALUES (?, ?, ?, ?)")
        .run(snapshotId, snapshotHash, stableJson(snapshot), input.createdAt ?? this.store.now());
      const row = this.store.db.prepare("SELECT * FROM pricing_snapshots WHERE snapshot_id = ?").get(snapshotId) as SqlRow | undefined;
      if (!row) throw new StoreError("PRICING_SNAPSHOT_WRITE_FAILED", "pricing snapshot was not written");
      return mapPricingSnapshot(row);
    });
  }

  get(snapshotId: string): PricingSnapshotRecord {
    const row = this.store.db.prepare("SELECT * FROM pricing_snapshots WHERE snapshot_id = ?").get(required(snapshotId, "snapshotId")) as SqlRow | undefined;
    if (!row) throw new NotFoundError("Pricing snapshot was not found");
    return mapPricingSnapshot(row);
  }

  list(): PricingSnapshotRecord[] {
    return (this.store.db.prepare("SELECT * FROM pricing_snapshots ORDER BY created_at, snapshot_id").all() as unknown[]).map((row) => mapPricingSnapshot(row as SqlRow));
  }
}

export class EdgeRepository {
  constructor(private readonly store: DurableStore) {}

  add(scope: PrincipalScope, input: EdgeInput): AgentEdge {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    const parentAgentId = required(input.parentAgentId, "parentAgentId");
    const childAgentId = required(input.childAgentId, "childAgentId");
    this.store.assertSession(scope);
    return this.store.transaction(() => {
      if (parentAgentId === childAgentId) throw new ConstraintError("CYCLE_DENIED", "An agent cannot be its own parent");
      const node = (agentId: string): boolean => Boolean(this.store.db.prepare(`SELECT 1 AS present FROM agents
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND agent_id = ?`).get(tenantId, ownerId, agentSessionId, agentId));
      if (!node(parentAgentId) || !node(childAgentId)) throw new ScopeError("Both edge endpoints must belong to the same Agent Farm session");
      const existing = this.store.db.prepare(`SELECT parent_agent_id FROM agent_edges
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND child_agent_id = ?`)
        .get(tenantId, ownerId, agentSessionId, childAgentId) as SqlRow | undefined;
      if (existing && String(existing.parent_agent_id) !== parentAgentId) {
        throw new ConstraintError("PARENT_CONFLICT", "A verified child may have only one parent");
      }
      // Follow the existing parent chain while the write transaction is open.
      // Since child_agent_id is unique, this walk is deterministic and cannot
      // race another edge insertion.
      let cursor: string | undefined = parentAgentId;
      const visited = new Set<string>();
      while (cursor) {
        if (cursor === childAgentId) throw new ConstraintError("CYCLE_DENIED", "Spawn edges may not contain cycles");
        if (visited.has(cursor)) throw new ConstraintError("CYCLE_DENIED", "Existing spawn edges already contain a cycle");
        visited.add(cursor);
        const row = this.store.db.prepare(`SELECT parent_agent_id FROM agent_edges
          WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND child_agent_id = ?`)
          .get(tenantId, ownerId, agentSessionId, cursor) as SqlRow | undefined;
        cursor = row ? String(row.parent_agent_id) : undefined;
      }
      const timestamp = input.createdAt ?? this.store.now();
      try {
        this.store.db.prepare(`INSERT INTO agent_edges
          (tenant_id, owner_id, agent_session_id, parent_agent_id, child_agent_id, source, spawn_ordinal, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(tenantId, ownerId, agentSessionId, parentAgentId, childAgentId, input.source ?? "app-server", input.spawnOrdinal ?? null, timestamp);
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE")) {
          const row = this.store.db.prepare(`SELECT * FROM agent_edges WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND parent_agent_id = ? AND child_agent_id = ?`)
            .get(tenantId, ownerId, agentSessionId, parentAgentId, childAgentId) as SqlRow | undefined;
          if (row) return mapEdge(row);
          throw new ConstraintError("PARENT_CONFLICT", "A verified child may have only one parent");
        }
        throw error;
      }
      const row = this.store.db.prepare(`SELECT * FROM agent_edges WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND parent_agent_id = ? AND child_agent_id = ?`)
        .get(tenantId, ownerId, agentSessionId, parentAgentId, childAgentId) as SqlRow | undefined;
      if (!row) throw new StoreError("EDGE_WRITE_FAILED", "Agent edge was not written");
      return mapEdge(row);
    });
  }

  /**
   * Apply one authoritative Codex snapshot correction. This is deliberately
   * separate from `add`: callers cannot use it as a generic control/mutation
   * path because the source and connection epoch identify reconciliation
   * authority. The old parent is removed and the replacement is inserted in
   * the same transaction, so every validation failure rolls back the old
   * edge as well.
   */
  reconcile(scope: PrincipalScope, input: ReconcileEdgeInput): ReconcileEdgeResult {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    const parentAgentId = required(input.parentAgentId, "parentAgentId");
    const childAgentId = required(input.childAgentId, "childAgentId");
    const connectionEpoch = required(input.connectionEpoch, "connectionEpoch");
    if (input.source !== undefined && input.source !== "codex-reconciliation") {
      throw new ConstraintError("RECONCILIATION_AUTHORITY_REQUIRED", "Only codex-reconciliation may replace a parent edge");
    }
    if (input.ingestOrdinal !== undefined && (!Number.isSafeInteger(input.ingestOrdinal) || input.ingestOrdinal < 0)) {
      throw new ConstraintError("INVALID_INGEST_ORDINAL", "Reconciliation ingestOrdinal must be a non-negative safe integer");
    }
    this.store.assertSession(scope);
    return this.store.transaction(() => {
      if (parentAgentId === childAgentId) throw new ConstraintError("CYCLE_DENIED", "An agent cannot be its own parent");
      const node = (agentId: string): boolean => Boolean(this.store.db.prepare(`SELECT 1 AS present FROM agents
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND agent_id = ?`).get(tenantId, ownerId, agentSessionId, agentId));
      if (!node(parentAgentId) || !node(childAgentId)) {
        throw new ScopeError("Reconciliation endpoints must belong to the same Agent Farm session");
      }
      const existing = this.store.db.prepare(`SELECT * FROM agent_edges
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND child_agent_id = ?`)
        .get(tenantId, ownerId, agentSessionId, childAgentId) as SqlRow | undefined;
      const previousParentAgentId = existing ? String(existing.parent_agent_id) : null;
      if (previousParentAgentId === parentAgentId && existing) {
        const edge = mapEdge(existing);
        this.store.audit.append({
          tenantId,
          ownerId,
          agentSessionId,
          action: "edge.reconciled",
          actorType: "codex-reconciliation",
          actorId: connectionEpoch,
          metadata: {
            changed: false,
            parentAgentId,
            childAgentId,
            connectionEpoch,
            ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
            ...(input.ingestOrdinal === undefined ? {} : { ingestOrdinal: input.ingestOrdinal }),
          },
        });
        return { edge, changed: false, previousParentAgentId };
      }

      if (existing) {
        this.store.db.prepare(`DELETE FROM agent_edges
          WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND child_agent_id = ?`)
          .run(tenantId, ownerId, agentSessionId, childAgentId);
      }

      // Follow the parent chain after removing the old child edge. The
      // transaction guarantees that a cycle/orphan failure restores it.
      let cursor: string | undefined = parentAgentId;
      const visited = new Set<string>();
      while (cursor) {
        if (cursor === childAgentId) throw new ConstraintError("CYCLE_DENIED", "Spawn edges may not contain cycles");
        if (visited.has(cursor)) throw new ConstraintError("CYCLE_DENIED", "Existing spawn edges already contain a cycle");
        visited.add(cursor);
        const row = this.store.db.prepare(`SELECT parent_agent_id FROM agent_edges
          WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND child_agent_id = ?`)
          .get(tenantId, ownerId, agentSessionId, cursor) as SqlRow | undefined;
        cursor = row ? String(row.parent_agent_id) : undefined;
      }
      const createdAt = input.createdAt ?? this.store.now();
      this.store.db.prepare(`INSERT INTO agent_edges
        (tenant_id, owner_id, agent_session_id, parent_agent_id, child_agent_id, source, spawn_ordinal, created_at)
        VALUES (?, ?, ?, ?, ?, 'codex-reconciliation', ?, ?)`)
        .run(tenantId, ownerId, agentSessionId, parentAgentId, childAgentId, input.ingestOrdinal ?? null, createdAt);
      const row = this.store.db.prepare(`SELECT * FROM agent_edges
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND parent_agent_id = ? AND child_agent_id = ?`)
        .get(tenantId, ownerId, agentSessionId, parentAgentId, childAgentId) as SqlRow | undefined;
      if (!row) throw new StoreError("EDGE_RECONCILE_FAILED", "Reconciled edge was not written");
      const edge = mapEdge(row);
      this.store.audit.append({
        tenantId,
        ownerId,
        agentSessionId,
        action: "edge.reconciled",
        actorType: "codex-reconciliation",
        actorId: connectionEpoch,
        metadata: {
          changed: true,
          parentAgentId,
          childAgentId,
          previousParentAgentId,
          connectionEpoch,
          ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
          ...(input.ingestOrdinal === undefined ? {} : { ingestOrdinal: input.ingestOrdinal }),
        },
      });
      return { edge, changed: true, previousParentAgentId };
    });
  }

  /** Explicit alias for reconciler callers that prefer the operation name. */
  replaceParent(scope: PrincipalScope, input: ReconcileEdgeInput): ReconcileEdgeResult {
    return this.reconcile(scope, input);
  }

  reconcileParent(scope: PrincipalScope, input: ReconcileEdgeInput): ReconcileEdgeResult {
    return this.reconcile(scope, input);
  }

  list(scope: PrincipalScope): AgentEdge[] {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    return (this.store.db.prepare(`SELECT * FROM agent_edges WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?
      ORDER BY CASE WHEN spawn_ordinal IS NULL THEN 1 ELSE 0 END ASC,
        spawn_ordinal ASC, created_at ASC, parent_agent_id ASC, child_agent_id ASC`).all(tenantId, ownerId, agentSessionId) as unknown[]).map((value) => mapEdge(value as SqlRow));
  }

  getParent(scope: PrincipalScope, childAgentId: string): AgentEdge | null {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    const row = this.store.db.prepare(`SELECT * FROM agent_edges WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND child_agent_id = ?`)
      .get(tenantId, ownerId, agentSessionId, required(childAgentId, "childAgentId")) as SqlRow | undefined;
    return row ? mapEdge(row) : null;
  }
}

export class IdentityEvidenceRepository {
  constructor(private readonly store: DurableStore) {}

  append(scope: PrincipalScope, input: IdentityEvidenceInput): IdentityEvidence;
  append(input: IdentityEvidenceInput & PrincipalScope): IdentityEvidence;
  append(first: PrincipalScope | (IdentityEvidenceInput & PrincipalScope), second?: IdentityEvidenceInput): IdentityEvidence {
    const input = (second ? { ...first, ...second } : first) as IdentityEvidenceInput & PrincipalScope;
    const scope = { tenantId: input.tenantId, ownerId: input.ownerId, agentSessionId: input.agentSessionId };
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    const agentId = required(input.agentId, "agentId");
    this.store.assertSession(scope);
    this.store.agents.get(scope, agentId);
    const evidenceId = input.evidenceId ?? id();
    const observedAt = input.observedAt ?? this.store.now();
    const evidenceHash = input.evidenceHash ?? sha256({
      agentId,
      requestedModel: input.requestedModel ?? null,
      requestedEffort: input.requestedEffort ?? null,
      requestedProvider: input.requestedProvider ?? null,
      observedModel: input.observedModel ?? null,
      observedEffort: input.observedEffort ?? null,
      observedProvider: input.observedProvider ?? null,
      source: input.source,
      observedAt,
      trustClass: input.trustClass ?? "observed",
    });
    this.store.db.prepare(`INSERT INTO identity_evidence
      (evidence_id, tenant_id, owner_id, agent_session_id, agent_id, requested_model, requested_effort, requested_provider,
       observed_model, observed_effort, observed_provider, source, observed_at, evidence_hash, trust_class)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(evidenceId, tenantId, ownerId, agentSessionId, agentId, optional(input.requestedModel), optional(input.requestedEffort), optional(input.requestedProvider),
        optional(input.observedModel), optional(input.observedEffort), optional(input.observedProvider), required(input.source, "source"), observedAt, evidenceHash, input.trustClass ?? "observed");
    const row = this.store.db.prepare("SELECT * FROM identity_evidence WHERE evidence_id = ?").get(evidenceId) as SqlRow | undefined;
    if (!row) throw new StoreError("EVIDENCE_WRITE_FAILED", "Identity evidence was not written");
    return mapEvidence(row);
  }

  list(scope: PrincipalScope, agentId?: string): IdentityEvidence[] {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    const query = agentId
      ? `SELECT * FROM identity_evidence WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND agent_id = ? ORDER BY observed_at ASC, evidence_id ASC`
      : `SELECT * FROM identity_evidence WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? ORDER BY observed_at ASC, evidence_id ASC`;
    const params = agentId ? [tenantId, ownerId, agentSessionId, required(agentId, "agentId")] : [tenantId, ownerId, agentSessionId];
    return (this.store.db.prepare(query).all(...params) as unknown[]).map((value) => mapEvidence(value as SqlRow));
  }
}

export class EventRepository {
  constructor(private readonly store: DurableStore) {}

  ingest(scope: PrincipalScope, input: SanitizedEventInput): EventIngestResult {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    const eventKey = required(input.eventKey, "eventKey");
    const eventType = required(input.eventType, "eventType");
    const connectionEpoch = required(input.connectionEpoch, "connectionEpoch");
    this.store.assertSession(scope);
    const sanitizedPayload = sanitizePayload(input.payload);
    const sanitizedPayloadHash = sha256(sanitizedPayload);
    return this.store.transaction(() => {
      const current = this.store.db.prepare(`SELECT * FROM sanitized_events
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND event_key = ?`)
        .get(tenantId, ownerId, agentSessionId, eventKey) as SqlRow | undefined;
      const currentSession = this.store.readSession(scope);
      if (current) {
        const existingHash = String(current.sanitized_payload_hash);
        if (existingHash === sanitizedPayloadHash) {
          return { outcome: "replayed", event: mapEvent(current), conflict: null, watermarkIngestOrdinal: currentSession.watermarkIngestOrdinal };
        }
        const conflictId = id();
        const createdAt = this.store.now();
        this.store.db.prepare(`INSERT INTO event_quarantine
          (conflict_id, tenant_id, owner_id, agent_session_id, event_key, existing_payload_hash,
           conflicting_payload_hash, connection_epoch, payload_json, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sanitized_payload_hash_conflict', ?)`)
          .run(conflictId, tenantId, ownerId, agentSessionId, eventKey, existingHash, sanitizedPayloadHash, connectionEpoch, stableJson(sanitizedPayload), createdAt);
        const conflict: EventConflict = {
          conflictId,
          tenantId,
          ownerId,
          agentSessionId,
          eventKey,
          existingPayloadHash: existingHash,
          conflictingPayloadHash: sanitizedPayloadHash,
          connectionEpoch,
          payload: sanitizedPayload,
          reason: "sanitized_payload_hash_conflict",
          createdAt,
        };
        this.store.audit.append({
          tenantId,
          ownerId,
          agentSessionId,
          action: "event.quarantined",
          actorType: "bridge",
          actorId: connectionEpoch,
          metadata: { eventKey, reason: conflict.reason },
        });
        return { outcome: "quarantined", event: null, conflict, watermarkIngestOrdinal: currentSession.watermarkIngestOrdinal };
      }

      const ingestOrdinal = currentSession.watermarkIngestOrdinal + 1;
      const event: SanitizedEvent = {
        eventId: id(),
        tenantId,
        ownerId,
        agentSessionId,
        connectionEpoch,
        ingestOrdinal,
        eventKey,
        eventType,
        sourceAdapter: optional(input.sourceAdapter),
        sourceThreadId: optional(input.sourceThreadId),
        sourceSessionId: optional(input.sourceSessionId),
        turnId: optional(input.turnId),
        itemId: optional(input.itemId),
        status: optional(input.status),
        sanitizedPayloadHash,
        sanitizedPayload,
        correlationId: optional(input.correlationId),
        authority: input.authority ?? "notification",
        redactionVersion: input.redactionVersion ?? "v1",
        observedAt: input.observedAt ?? this.store.now(),
        createdAt: this.store.now(),
      };
      this.store.db.prepare(`INSERT INTO sanitized_events
        (event_id, tenant_id, owner_id, agent_session_id, connection_epoch, ingest_ordinal, event_key, event_type,
         source_adapter, source_thread_id, source_session_id, turn_id, item_id, status, sanitized_payload_hash,
         sanitized_payload_json, correlation_id, authority, redaction_version, observed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.eventId, tenantId, ownerId, agentSessionId, connectionEpoch, ingestOrdinal, eventKey, eventType,
          event.sourceAdapter, event.sourceThreadId, event.sourceSessionId, event.turnId, event.itemId, event.status,
          sanitizedPayloadHash, stableJson(sanitizedPayload), event.correlationId, event.authority, event.redactionVersion,
          event.observedAt, event.createdAt);
      this.store.db.prepare(`UPDATE app_sessions SET watermark_ingest_ordinal = ?, updated_at = ?
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?`).run(ingestOrdinal, event.createdAt, tenantId, ownerId, agentSessionId);
      this.store.applyEvent(event);
      return { outcome: "inserted", event, conflict: null, watermarkIngestOrdinal: ingestOrdinal };
    });
  }

  /** Alias matching ingestion terminology used by the bridge. */
  append(scope: PrincipalScope, input: SanitizedEventInput): EventIngestResult {
    return this.ingest(scope, input);
  }

  get(scope: PrincipalScope, eventId: string): SanitizedEvent {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    const row = this.store.db.prepare(`SELECT * FROM sanitized_events WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND event_id = ?`)
      .get(tenantId, ownerId, agentSessionId, required(eventId, "eventId")) as SqlRow | undefined;
    if (!row) throw new NotFoundError("Sanitized event was not found");
    return mapEvent(row);
  }

  list(scope: PrincipalScope): SanitizedEvent[] {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    return (this.store.db.prepare(`SELECT * FROM sanitized_events WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?
      ORDER BY ingest_ordinal ASC, event_id ASC`).all(tenantId, ownerId, agentSessionId) as unknown[]).map((value) => mapEvent(value as SqlRow));
  }

  conflicts(scope: PrincipalScope): EventConflict[] {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    return (this.store.db.prepare(`SELECT * FROM event_quarantine WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?
      ORDER BY created_at ASC, conflict_id ASC`).all(tenantId, ownerId, agentSessionId) as unknown[]).map((value) => {
      const row = value as SqlRow;
      return {
        conflictId: String(row.conflict_id),
        tenantId: String(row.tenant_id),
        ownerId: String(row.owner_id),
        agentSessionId: String(row.agent_session_id),
        eventKey: String(row.event_key),
        existingPayloadHash: String(row.existing_payload_hash),
        conflictingPayloadHash: String(row.conflicting_payload_hash),
        connectionEpoch: String(row.connection_epoch),
        payload: parseJson<Record<string, unknown>>(String(row.payload_json), {}),
        reason: "sanitized_payload_hash_conflict" as const,
        createdAt: numberValue(row.created_at),
      } satisfies EventConflict;
    });
  }
}

/**
 * Durable OAuth-grant to Agent Farm-session identity mapping used by MCP.
 *
 * This repository deliberately exposes only the grant tuple at its API
 * boundary and stores a keyed digest of that tuple. It has no foreign key to
 * app_sessions: closing an MCP protocol transport or deleting an Agent Farm
 * projection must not silently destroy the identity continuity record.
 */
export class McpGrantSessionBindingRepository {
  constructor(
    private readonly store: DurableStore,
    private readonly digestKey: string,
    private readonly ttlMs: number,
    private readonly maxBindings: number,
  ) {}

  get(input: McpGrantSessionBindingKey): McpGrantSessionBinding | null {
    const digest = this.digest(input);
    return this.store.transaction(() => this.readActiveOrExpire(digest));
  }

  getOrCreate(input: McpGrantSessionBindingInput): McpGrantSessionBinding | null {
    const digest = this.digest(input);
    const proposedAgentSessionId = boundedStoreId(input.proposedAgentSessionId, "proposedAgentSessionId");
    return this.store.transaction(() => {
      const now = this.store.now();
      const existing = this.readRow(digest);
      if (existing) {
        const active = this.refreshLifecycle(existing, now);
        if (!active) return null;

        // Refreshes may issue a later exp for the same stable grant. Extend
        // only within the original bounded lifetime; never revive or shorten
        // a revoked/expired mapping.
        const existingCreatedAt = numberValue(existing.created_at);
        const existingExpiresAt = numberValue(existing.expires_at);
        const requestedExpiry = boundedGrantExpiry(now, existingCreatedAt, input.expiresAt, this.ttlMs);
        const expiresAt = Math.max(existingExpiresAt, requestedExpiry);
        if (expiresAt !== existingExpiresAt) {
          this.store.db.prepare(`UPDATE mcp_grant_session_bindings
            SET expires_at = ?, updated_at = ? WHERE grant_key_digest = ? AND status = 'active'`)
            .run(expiresAt, now, digest);
        }
        const row = this.readRow(digest);
        return row && row.status === "active" ? mapMcpGrantBinding(row) : null;
      }

      // Expired rows are retained for revocation/audit semantics, but do not
      // consume the active bound. This maintenance update is inside the same
      // transaction as the insert, so two local initialize calls cannot race
      // past the bound.
      this.store.db.prepare(`UPDATE mcp_grant_session_bindings
        SET status = 'expired', updated_at = ?
        WHERE status = 'active' AND expires_at <= ?`).run(now, now);
      const activeCount = this.store.db
        .prepare("SELECT COUNT(*) AS count FROM mcp_grant_session_bindings WHERE status = 'active'")
        .get() as { count?: number } | undefined;
      if ((activeCount?.count ?? 0) >= this.maxBindings) {
        throw new ConstraintError("MCP_GRANT_BINDING_LIMIT", "MCP grant session binding limit reached");
      }

      const expiresAt = boundedGrantExpiry(now, now, input.expiresAt, this.ttlMs);
      if (expiresAt <= now) return null;
      this.store.db.prepare(`INSERT INTO mcp_grant_session_bindings
        (grant_key_digest, agent_session_id, status, expires_at, created_at, updated_at, revoked_at)
        VALUES (?, ?, 'active', ?, ?, ?, NULL)
        ON CONFLICT (grant_key_digest) DO NOTHING`)
        .run(digest, proposedAgentSessionId, expiresAt, now, now);
      const row = this.readRow(digest);
      if (!row || row.status !== "active") return null;
      return mapMcpGrantBinding(row);
    });
  }

  revoke(input: McpGrantSessionBindingKey): boolean {
    const digest = this.digest(input);
    return this.store.transaction(() => {
      const result = this.store.db.prepare(`UPDATE mcp_grant_session_bindings
        SET status = 'revoked', revoked_at = ?, updated_at = ?
        WHERE grant_key_digest = ? AND status = 'active'`).run(this.store.now(), this.store.now(), digest);
      return result.changes > 0;
    });
  }

  /** Revoke all mappings before the explicitly bound Agent Farm session is deleted. */
  revokeForAgentSession(agentSessionId: string): number {
    const normalized = boundedStoreId(agentSessionId, "agentSessionId");
    return this.store.db.prepare(`UPDATE mcp_grant_session_bindings
      SET status = 'revoked', revoked_at = ?, updated_at = ?
      WHERE agent_session_id = ? AND status = 'active'`).run(this.store.now(), this.store.now(), normalized).changes;
  }

  /** Number of retained mappings, including terminal lifecycle rows. */
  count(): number {
    const row = this.store.db.prepare("SELECT COUNT(*) AS count FROM mcp_grant_session_bindings").get() as { count?: number } | undefined;
    return row?.count ?? 0;
  }

  private digest(input: McpGrantSessionBindingKey): string {
    const value = {
      v: 1,
      ownerId: boundedStoreClaim(input.ownerId, "ownerId"),
      tenantId: boundedStoreClaim(input.tenantId, "tenantId"),
      subject: boundedStoreClaim(input.subject, "subject"),
      resource: boundedStoreClaim(input.resource, "resource"),
      grantId: boundedStoreClaim(input.grantId, "grantId"),
    };
    return createHmac("sha256", this.digestKey).update(stableJson(value), "utf8").digest("hex");
  }

  private readActiveOrExpire(digest: string): McpGrantSessionBinding | null {
    const row = this.readRow(digest);
    if (!row) return null;
    const active = this.refreshLifecycle(row, this.store.now());
    if (!active) return null;
    const current = this.readRow(digest);
    return current && current.status === "active" ? mapMcpGrantBinding(current) : null;
  }

  private readRow(digest: string): SqlRow | undefined {
    return this.store.db.prepare("SELECT * FROM mcp_grant_session_bindings WHERE grant_key_digest = ?").get(digest) as SqlRow | undefined;
  }

  private refreshLifecycle(row: SqlRow, now: number): boolean {
    if (String(row.status) !== "active") return false;
    if (numberValue(row.expires_at) > now) return true;
    this.store.db.prepare(`UPDATE mcp_grant_session_bindings
      SET status = 'expired', updated_at = ?
      WHERE grant_key_digest = ? AND status = 'active'`).run(now, String(row.grant_key_digest));
    return false;
  }
}

function boundedStoreClaim(value: string, label: string): string {
  const normalized = required(value, label);
  if (normalized.length > 256) throw new ConstraintError("INVALID_INPUT", `${label} is too long`);
  return normalized;
}

function boundedStoreId(value: string, label: string): string {
  const normalized = boundedStoreClaim(value, label);
  if (normalized.includes("\u0000")) throw new ConstraintError("INVALID_INPUT", `${label} is invalid`);
  return normalized;
}

function boundedGrantExpiry(now: number, createdAt: number, requested: number | undefined, ttlMs: number): number {
  const requestedExpiry = requested === undefined ? now + ttlMs : requested;
  if (!Number.isFinite(requestedExpiry) || requestedExpiry <= 0) {
    throw new ConstraintError("INVALID_INPUT", "MCP grant expiry is invalid");
  }
  return Math.min(requestedExpiry, createdAt + ttlMs);
}

function boundedStorePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be positive`);
  return value;
}

function boundedStorePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

export class BridgeBindingRepository {
  constructor(private readonly store: DurableStore) {}

  upsert(scope: PrincipalScope, input: BridgeBindingInput): BridgeBinding;
  upsert(input: BridgeBindingInput & PrincipalScope): BridgeBinding;
  upsert(first: PrincipalScope | (BridgeBindingInput & PrincipalScope), second?: BridgeBindingInput): BridgeBinding {
    const input = (second ? { ...first, ...second } : first) as BridgeBindingInput & PrincipalScope;
    const scope = { tenantId: input.tenantId, ownerId: input.ownerId, agentSessionId: input.agentSessionId };
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    const bindingId = input.bindingId ?? id();
    const timestamp = this.store.now();
    this.store.db.prepare(`INSERT INTO bridge_bindings
      (binding_id, tenant_id, owner_id, agent_session_id, installation_id, source_adapter, selected_source_root_id,
       credential_hash, nonce_hash, expires_at, status, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (tenant_id, owner_id, agent_session_id, installation_id, selected_source_root_id)
      DO UPDATE SET credential_hash = excluded.credential_hash, nonce_hash = excluded.nonce_hash,
        expires_at = excluded.expires_at, status = excluded.status, revoked_at = excluded.revoked_at`)
      .run(bindingId, tenantId, ownerId, agentSessionId, required(input.installationId, "installationId"), required(input.sourceAdapter, "sourceAdapter"), required(input.selectedSourceRootId, "selectedSourceRootId"), required(input.credentialHash, "credentialHash"), optional(input.nonceHash), input.expiresAt, input.status ?? "active", timestamp);
    const row = this.store.db.prepare(`SELECT * FROM bridge_bindings WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND installation_id = ? AND selected_source_root_id = ?`)
      .get(tenantId, ownerId, agentSessionId, input.installationId, input.selectedSourceRootId) as SqlRow | undefined;
    if (!row) throw new StoreError("BRIDGE_BINDING_WRITE_FAILED", "Bridge binding was not written");
    return mapBinding(row);
  }

  get(scope: PrincipalScope, bindingId: string): BridgeBinding {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    const row = this.store.db.prepare("SELECT * FROM bridge_bindings WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND binding_id = ?")
      .get(tenantId, ownerId, agentSessionId, required(bindingId, "bindingId")) as SqlRow | undefined;
    if (!row) throw new NotFoundError("Bridge binding was not found");
    return mapBinding(row);
  }

  revoke(scope: PrincipalScope, bindingId: string): boolean {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    const result = this.store.db.prepare(`UPDATE bridge_bindings SET status = 'revoked', revoked_at = ?
      WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND binding_id = ?`).run(this.store.now(), tenantId, ownerId, agentSessionId, required(bindingId, "bindingId"));
    return result.changes > 0;
  }

  /**
   * Activate one installation binding without allowing a second durable
   * owner to silently take it over. The caller can opt into replacement only
   * for an already-authorized switch; the replacement and the new binding
   * are published in this same SQLite transaction.
   */
  activateExclusive(
    scope: PrincipalScope,
    input: BridgeBindingInput,
    options: {
      readonly replaceExisting?: boolean;
      /** Exact active root that authorized a deliberate compare-and-replace. */
      readonly expectedSelectedSourceRootId?: string;
      /** Exact previous durable scope for an authorized cross-session replacement. */
      readonly expectedActiveBinding?: PrincipalScope & { readonly selectedSourceRootId: string };
    } = {},
  ): BridgeBinding {
    const trustedScope = {
      tenantId: required(scope.tenantId, "tenantId"),
      ownerId: required(scope.ownerId, "ownerId"),
      agentSessionId: required(scope.agentSessionId, "agentSessionId"),
    };
    this.store.assertSession(trustedScope);
    const installationId = required(input.installationId, "installationId");
    const sourceAdapter = required(input.sourceAdapter, "sourceAdapter");
    const selectedSourceRootId = required(input.selectedSourceRootId, "selectedSourceRootId");
    const credentialHash = required(input.credentialHash, "credentialHash");
    const nonceHash = optional(input.nonceHash);
    const now = this.store.now();
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now) {
      throw new ConstraintError("INVALID_INPUT", "Bridge binding expiry is invalid");
    }
    const replaceExisting = options.replaceExisting === true;
    const expectedBinding = options.expectedActiveBinding;
    if (replaceExisting && typeof options.expectedSelectedSourceRootId !== "string" && expectedBinding === undefined) {
      throw new ConstraintError("INVALID_INPUT", "an expected active binding is required");
    }
    const expectedScope = expectedBinding === undefined ? trustedScope : {
      tenantId: required(expectedBinding.tenantId, "expectedTenantId"),
      ownerId: required(expectedBinding.ownerId, "expectedOwnerId"),
      agentSessionId: required(expectedBinding.agentSessionId, "expectedAgentSessionId"),
    };
    const expectedSelectedSourceRootId = replaceExisting
      ? required(expectedBinding?.selectedSourceRootId ?? options.expectedSelectedSourceRootId as string, "expectedSelectedSourceRootId")
      : undefined;
    return this.store.transaction(() => {
      // Expiry is part of the claim/activation transaction so stale rows do
      // not make an installation appear occupied forever.
      this.store.db.prepare(`UPDATE bridge_bindings
        SET status = 'expired', revoked_at = ?
        WHERE installation_id = ? AND source_adapter = ? AND status = 'active' AND expires_at <= ?`)
        .run(now, installationId, sourceAdapter, now);

      const activeRows = this.store.db.prepare(`SELECT tenant_id, owner_id, agent_session_id,
          selected_source_root_id
        FROM bridge_bindings
        WHERE installation_id = ? AND source_adapter = ? AND status = 'active' AND expires_at > ?`)
        .all(installationId, sourceAdapter, now) as unknown[];
      const exactExisting = activeRows.filter((value) => {
        const row = value as SqlRow;
        return String(row.tenant_id) === expectedScope.tenantId &&
          String(row.owner_id) === expectedScope.ownerId &&
          String(row.agent_session_id) === expectedScope.agentSessionId &&
          String(row.selected_source_root_id) === expectedSelectedSourceRootId;
      });
      const conflictsWithoutReplacement = activeRows.some((value) => {
        const row = value as SqlRow;
        return String(row.tenant_id) !== trustedScope.tenantId ||
          String(row.owner_id) !== trustedScope.ownerId ||
          String(row.agent_session_id) !== trustedScope.agentSessionId ||
          String(row.selected_source_root_id) !== selectedSourceRootId;
      });
      if (!replaceExisting && conflictsWithoutReplacement) {
        throw new StoreError("BRIDGE_BINDING_CONFLICT", "The installation is already paired");
      }
      // A switch is authorized by exactly the old binding observed by the
      // server. It cannot revoke a binding installed by another session (or
      // a newer same-session switch) while attestation was in flight.
      if (replaceExisting && (activeRows.length !== 1 || exactExisting.length !== 1)) {
        throw new StoreError("BRIDGE_BINDING_CONFLICT", "The installation pairing changed");
      }
      if (replaceExisting) {
        this.store.db.prepare(`UPDATE bridge_bindings
          SET status = 'revoked', revoked_at = ?
          WHERE installation_id = ? AND source_adapter = ? AND status = 'active'
            AND tenant_id = ? AND owner_id = ? AND agent_session_id = ?
            AND selected_source_root_id = ?`)
          .run(now, installationId, sourceAdapter, expectedScope.tenantId,
            expectedScope.ownerId, expectedScope.agentSessionId, expectedSelectedSourceRootId);
      }

      const bindingId = input.bindingId ?? id();
      this.store.db.prepare(`INSERT INTO bridge_bindings
        (binding_id, tenant_id, owner_id, agent_session_id, installation_id, source_adapter, selected_source_root_id,
         credential_hash, nonce_hash, expires_at, status, created_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)
        ON CONFLICT (tenant_id, owner_id, agent_session_id, installation_id, selected_source_root_id)
        DO UPDATE SET credential_hash = excluded.credential_hash, nonce_hash = excluded.nonce_hash,
          expires_at = excluded.expires_at, status = 'active', revoked_at = NULL`)
        .run(bindingId, trustedScope.tenantId, trustedScope.ownerId, trustedScope.agentSessionId,
          installationId, sourceAdapter, selectedSourceRootId, credentialHash, nonceHash, input.expiresAt, now);
      const row = this.store.db.prepare(`SELECT * FROM bridge_bindings
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?
          AND installation_id = ? AND selected_source_root_id = ?`)
        .get(trustedScope.tenantId, trustedScope.ownerId, trustedScope.agentSessionId, installationId, selectedSourceRootId) as SqlRow | undefined;
      if (!row) throw new StoreError("BRIDGE_BINDING_WRITE_FAILED", "Bridge binding was not written");
      return mapBinding(row);
    });
  }

  /**
   * Activate one chat projection without replacing other roots owned by the
   * same local installation.  The private source root remains exclusive: an
   * already-active root can only be refreshed by its exact durable scope.
   * This legacy/safety-net counterpart to `activateExclusive` requires an
   * explicit opt-in; normal local pairing must preserve singleton activation.
   */
  activateConcurrent(scope: PrincipalScope, input: BridgeBindingInput): BridgeBinding {
    const trustedScope = {
      tenantId: required(scope.tenantId, "tenantId"),
      ownerId: required(scope.ownerId, "ownerId"),
      agentSessionId: required(scope.agentSessionId, "agentSessionId"),
    };
    this.store.assertSession(trustedScope);
    const installationId = required(input.installationId, "installationId");
    const sourceAdapter = required(input.sourceAdapter, "sourceAdapter");
    const selectedSourceRootId = required(input.selectedSourceRootId, "selectedSourceRootId");
    const credentialHash = required(input.credentialHash, "credentialHash");
    const nonceHash = optional(input.nonceHash);
    const now = this.store.now();
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now) {
      throw new ConstraintError("INVALID_INPUT", "Bridge binding expiry is invalid");
    }
    return this.store.transaction(() => {
      this.store.db.prepare(`UPDATE bridge_bindings
        SET status = 'expired', revoked_at = ?
        WHERE installation_id = ? AND source_adapter = ? AND status = 'active' AND expires_at <= ?`)
        .run(now, installationId, sourceAdapter, now);
      const conflictingOwner = this.store.db.prepare(`SELECT 1
        FROM bridge_bindings
        WHERE installation_id = ? AND source_adapter = ? AND selected_source_root_id = ?
          AND status = 'active' AND expires_at > ?
          AND (tenant_id != ? OR owner_id != ? OR agent_session_id != ?)
        LIMIT 1`).get(installationId, sourceAdapter, selectedSourceRootId, now,
          trustedScope.tenantId, trustedScope.ownerId, trustedScope.agentSessionId);
      if (conflictingOwner !== undefined) {
        throw new StoreError("BRIDGE_BINDING_CONFLICT", "The source root is already paired");
      }
      const bindingId = input.bindingId ?? id();
      this.store.db.prepare(`INSERT INTO bridge_bindings
        (binding_id, tenant_id, owner_id, agent_session_id, installation_id, source_adapter, selected_source_root_id,
         credential_hash, nonce_hash, expires_at, status, created_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)
        ON CONFLICT (tenant_id, owner_id, agent_session_id, installation_id, selected_source_root_id)
        DO UPDATE SET credential_hash = excluded.credential_hash, nonce_hash = excluded.nonce_hash,
          expires_at = excluded.expires_at, status = 'active', revoked_at = NULL`)
        .run(bindingId, trustedScope.tenantId, trustedScope.ownerId, trustedScope.agentSessionId,
          installationId, sourceAdapter, selectedSourceRootId, credentialHash, nonceHash, input.expiresAt, now);
      const row = this.store.db.prepare(`SELECT * FROM bridge_bindings
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ?
          AND installation_id = ? AND selected_source_root_id = ?`)
        .get(trustedScope.tenantId, trustedScope.ownerId, trustedScope.agentSessionId,
          installationId, selectedSourceRootId) as SqlRow | undefined;
      if (!row) throw new StoreError("BRIDGE_BINDING_WRITE_FAILED", "Bridge binding was not written");
      return mapBinding(row);
    });
  }

  /** Mark stale active rows terminal without exposing their identities. */
  expireDue(installationId: string, now = this.store.now(), sourceAdapter = "codex-app-server"): number {
    const trustedInstallationId = required(installationId, "installationId");
    if (!Number.isFinite(now) || now < 0) throw new ConstraintError("INVALID_INPUT", "Bridge binding time is invalid");
    return this.store.transaction(() => this.store.db.prepare(`UPDATE bridge_bindings
      SET status = 'expired', revoked_at = ?
      WHERE installation_id = ? AND source_adapter = ? AND status = 'active' AND expires_at <= ?`)
      .run(now, trustedInstallationId, required(sourceAdapter, "sourceAdapter"), now).changes);
  }

  /** Revoke active bindings for one authenticated durable scope. */
  revokeActive(scope: PrincipalScope, installationId: string, sourceRootId?: string, sourceAdapter = "codex-app-server"): number {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    const trustedInstallationId = required(installationId, "installationId");
    return this.store.transaction(() => {
      const args: unknown[] = [this.store.now(), tenantId, ownerId, agentSessionId, trustedInstallationId, required(sourceAdapter, "sourceAdapter")];
      const sourceClause = sourceRootId === undefined ? "" : " AND selected_source_root_id = ?";
      if (sourceRootId !== undefined) args.push(required(sourceRootId, "sourceRootId"));
      return this.store.db.prepare(`UPDATE bridge_bindings SET status = 'revoked', revoked_at = ?
        WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND installation_id = ?
          AND source_adapter = ? AND status = 'active'${sourceClause}`).run(...args).changes;
    });
  }

  list(scope: PrincipalScope): BridgeBinding[] {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    this.store.assertSession(scope);
    return (this.store.db.prepare(`SELECT * FROM bridge_bindings WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? ORDER BY created_at ASC, binding_id ASC`).all(tenantId, ownerId, agentSessionId) as unknown[]).map((value) => mapBinding(value as SqlRow));
  }

  /** Legacy unique-binding resolver retained for non-multiplexed callers. */
  resolveUniqueActive(installationId: string, now = this.store.now()): ActiveBridgeBindingSelection | null {
    const trustedInstallationId = required(installationId, "installationId");
    if (!Number.isFinite(now) || now < 0) throw new ConstraintError("INVALID_INPUT", "Bridge binding time is invalid");
    this.expireDue(trustedInstallationId, now);
    const rows = this.store.db.prepare(`SELECT b.tenant_id, b.owner_id, b.agent_session_id,
        b.installation_id, b.selected_source_root_id
      FROM bridge_bindings b
      INNER JOIN app_sessions s
        ON s.tenant_id = b.tenant_id
       AND s.owner_id = b.owner_id
       AND s.agent_session_id = b.agent_session_id
      WHERE b.installation_id = ?
        AND b.source_adapter = 'codex-app-server'
        AND b.status = 'active'
        AND b.expires_at > ?
        AND s.status = 'active'
      ORDER BY b.created_at DESC, b.binding_id DESC
      LIMIT 2`).all(trustedInstallationId, Math.floor(now)) as unknown[];
    if (rows.length !== 1) return null;
    const row = rows[0] as SqlRow;
    return {
      tenantId: String(row.tenant_id),
      ownerId: String(row.owner_id),
      agentSessionId: String(row.agent_session_id),
      installationId: String(row.installation_id),
      selectedSourceRootId: String(row.selected_source_root_id),
    };
  }

  /** Resolve every live chat projection for one installation without secrets. */
  listActiveForInstallation(installationId: string, now = this.store.now()): ActiveBridgeBindingSelection[] {
    const trustedInstallationId = required(installationId, "installationId");
    if (!Number.isFinite(now) || now < 0) throw new ConstraintError("INVALID_INPUT", "Bridge binding time is invalid");
    this.expireDue(trustedInstallationId, now);
    const rows = this.store.db.prepare(`SELECT b.tenant_id, b.owner_id, b.agent_session_id,
        b.installation_id, b.selected_source_root_id
      FROM bridge_bindings b
      INNER JOIN app_sessions s
        ON s.tenant_id = b.tenant_id
       AND s.owner_id = b.owner_id
       AND s.agent_session_id = b.agent_session_id
      WHERE b.installation_id = ?
        AND b.source_adapter = 'codex-app-server'
        AND b.status = 'active'
        AND b.expires_at > ?
        AND s.status = 'active'
      ORDER BY b.created_at DESC, b.binding_id DESC`).all(trustedInstallationId, Math.floor(now)) as unknown[];
    return rows.map((value) => {
      const row = value as SqlRow;
      return {
        tenantId: String(row.tenant_id),
        ownerId: String(row.owner_id),
        agentSessionId: String(row.agent_session_id),
        installationId: String(row.installation_id),
        selectedSourceRootId: String(row.selected_source_root_id),
      };
    });
  }
}

export class IdempotencyRepository {
  constructor(private readonly store: DurableStore) {}

  find(scope: PrincipalScope, operation: string, idempotencyKey: string): IdempotencyRecord | null {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    const row = this.store.db.prepare(`SELECT * FROM idempotency_records
      WHERE tenant_id = ? AND owner_id = ? AND agent_session_id = ? AND operation = ? AND idempotency_key = ?`)
      .get(tenantId, ownerId, agentSessionId, required(operation, "operation"), required(idempotencyKey, "idempotencyKey")) as SqlRow | undefined;
    return row ? mapIdempotency(row) : null;
  }

  findForOwner(tenantId: string, ownerId: string, operation: string, idempotencyKey: string): IdempotencyRecord | null {
    const row = this.store.db.prepare(`SELECT * FROM idempotency_records
      WHERE tenant_id = ? AND owner_id = ? AND operation = ? AND idempotency_key = ? ORDER BY created_at ASC LIMIT 1`)
      .get(required(tenantId, "tenantId"), required(ownerId, "ownerId"), required(operation, "operation"), required(idempotencyKey, "idempotencyKey")) as SqlRow | undefined;
    return row ? mapIdempotency(row) : null;
  }

  record(scope: PrincipalScope, operation: string, idempotencyKey: string, requestHash: string, response: unknown, expiresAt?: number | null): IdempotencyRecord;
  record(scope: PrincipalScope, operation: { operation: string; idempotencyKey: string }, requestHash: string, response: unknown, expiresAt?: number | null): IdempotencyRecord;
  record(scope: PrincipalScope, operationOrKey: string | { operation: string; idempotencyKey: string }, keyOrHash: string, hashOrResponse: string | unknown, responseOrExpiry?: unknown, expiresAt: number | null = null): IdempotencyRecord {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    const operation = typeof operationOrKey === "string" ? operationOrKey : operationOrKey.operation;
    const idempotencyKey = typeof operationOrKey === "string" ? keyOrHash : operationOrKey.idempotencyKey;
    const requestHash = typeof operationOrKey === "string" ? String(hashOrResponse) : keyOrHash;
    const payload = typeof operationOrKey === "string" ? responseOrExpiry : hashOrResponse;
    const effectiveExpiry = typeof operationOrKey === "string"
      ? expiresAt
      : (typeof responseOrExpiry === "number" ? responseOrExpiry : null);
    const responseJson = stableJson(payload);
    const createdAt = this.store.now();
    this.store.db.prepare(`INSERT INTO idempotency_records
      (tenant_id, owner_id, agent_session_id, operation, idempotency_key, request_hash, response_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(tenantId, ownerId, agentSessionId, required(operation, "operation"), required(idempotencyKey, "idempotencyKey"), required(requestHash, "requestHash"), responseJson, createdAt, effectiveExpiry);
    const record = this.find(scope, operation, idempotencyKey);
    if (!record) throw new StoreError("IDEMPOTENCY_WRITE_FAILED", "Idempotency record was not written");
    return record;
  }
}

function mapIdempotency(row: SqlRow): IdempotencyRecord {
  return {
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    agentSessionId: String(row.agent_session_id),
    operation: String(row.operation),
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    responseJson: String(row.response_json),
    createdAt: numberValue(row.created_at),
    expiresAt: typeof row.expires_at === "number" ? row.expires_at : null,
  };
}

export class AuditRepository {
  constructor(private readonly store: DurableStore) {}

  append(input: Omit<AuditRecord, "auditId" | "createdAt"> & { createdAt?: number }): AuditRecord {
    const auditId = id();
    const createdAt = input.createdAt ?? this.store.now();
    this.store.db.prepare(`INSERT INTO audit_records
      (audit_id, tenant_id, owner_id, agent_session_id, action, actor_type, actor_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(auditId, required(input.tenantId, "tenantId"), required(input.ownerId, "ownerId"), input.agentSessionId ?? null,
        required(input.action, "action"), required(input.actorType, "actorType"), required(input.actorId, "actorId"), stableJson(input.metadata), createdAt);
    const row = this.store.db.prepare("SELECT * FROM audit_records WHERE audit_id = ?").get(auditId) as SqlRow | undefined;
    if (!row) throw new StoreError("AUDIT_WRITE_FAILED", "Audit record was not written");
    return mapAudit(row);
  }

  list(scope: PrincipalScope): AuditRecord[] {
    const [tenantId, ownerId, agentSessionId] = scopeValues(scope);
    return (this.store.db.prepare(`SELECT * FROM audit_records WHERE tenant_id = ? AND owner_id = ?
      AND (agent_session_id = ? OR agent_session_id IS NULL) ORDER BY created_at ASC, audit_id ASC`).all(tenantId, ownerId, agentSessionId) as unknown[]).map((value) => mapAudit(value as SqlRow));
  }
}

class ReplayProjection {
  private readonly agentMap = new Map<string, AgentRecord>();
  private readonly edgeMap = new Map<string, AgentEdge>();
  private readonly evidenceMap = new Map<string, IdentityEvidence>();

  constructor(private readonly scope: PrincipalScope, private readonly session: AppSession) {}

  apply(event: SanitizedEvent): void {
    const payload = event.sanitizedPayload;
    const eventType = event.eventType.toLowerCase();
    if (eventType === "thread.status.changed") {
      const agentId = typeof payload.agentId === "string" ? payload.agentId : undefined;
      const existing = agentId === undefined ? undefined : this.agentMap.get(agentId);
      if (existing && agentId) {
        this.agentMap.set(agentId, { ...existing, lifecycle: lifecycleOrUnknown(payload.status), updatedAt: event.observedAt });
      }
      return;
    }
    if (eventType === "agent.upsert" || eventType === "agent.created" || eventType === "agent.updated" || eventType === "agent.reconciled" || eventType === "cost.projected") {
      const nested = payload.agent && typeof payload.agent === "object" && !Array.isArray(payload.agent) ? payload.agent as Record<string, unknown> : payload;
      const agentId = typeof nested.agentId === "string" ? nested.agentId : event.sourceThreadId;
      if (!agentId) return;
      const existing = this.agentMap.get(agentId);
      if (eventType === "cost.projected") {
        if (!existing) return;
        const projectedCost = nested.cost === null ? null : mapCostFromPayload(nested.cost);
        this.agentMap.set(agentId, {
          ...existing,
          pricingSnapshotId: stringOrNull(nested.pricingSnapshotId),
          cost: projectedCost,
          costUsageDigest: projectedCost?.status === "estimated" && existing.usage !== null ? sha256(existing.usage) : null,
          updatedAt: event.observedAt,
        });
        return;
      }
      const timestamp = event.observedAt;
      this.agentMap.set(agentId, {
        tenantId: this.scope.tenantId,
        ownerId: this.scope.ownerId,
        agentSessionId: this.scope.agentSessionId,
        agentId,
        sourceAdapter: stringOrNull(nested.sourceAdapter ?? event.sourceAdapter),
        sourceThreadId: stringOrNull(nested.sourceThreadId ?? event.sourceThreadId),
        sourceSessionId: stringOrNull(nested.sourceSessionId ?? event.sourceSessionId),
        parentSourceThreadId: stringOrNull(nested.parentSourceThreadId),
        role: stringOrNull(nested.role),
        name: stringOrNull(nested.name),
        lifecycle: lifecycleOrUnknown(nested.lifecycle ?? event.status),
        resultSummary: stringOrNull(nested.resultSummary ?? nested.summary),
        errorSummary: stringOrNull(nested.errorSummary ?? nested.errorCode),
        verificationState: verificationOrUnknown(nested.verificationState),
        isRoot: nested.isRoot === true,
        spawnOrdinal: existing?.spawnOrdinal ?? event.ingestOrdinal,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        usage: Object.prototype.hasOwnProperty.call(nested, "usage")
          ? (nested.usage === null ? null : (parseEventUsage(nested.usage) ?? existing?.usage ?? null))
          : existing?.usage ?? null,
        usageSegments: Object.prototype.hasOwnProperty.call(nested, "usageSegments")
          ? (nested.usageSegments === null ? null : (mapUsageSegmentsFromPayload(nested.usageSegments) ?? existing?.usageSegments ?? null))
          : existing?.usageSegments ?? null,
        pricingSnapshotId: stringOrNull(nested.pricingSnapshotId) ?? existing?.pricingSnapshotId ?? null,
        cost: nested.cost === null ? null : (mapCostFromPayload(nested.cost) ?? existing?.cost ?? null),
        costUsageDigest: stringOrNull(nested.costUsageDigest) ?? existing?.costUsageDigest ?? null,
      });
      return;
    }
    if (eventType === "agent.removed" || eventType === "agent.deleted") {
      if (typeof payload.agentId === "string") {
        this.agentMap.delete(payload.agentId);
        for (const [key, edge] of this.edgeMap) if (edge.parentAgentId === payload.agentId || edge.childAgentId === payload.agentId) this.edgeMap.delete(key);
      }
      return;
    }
    if (eventType === "edge.added" || eventType === "edge.created" || eventType === "edge.spawn" || eventType === "edge.reconciled" || eventType === "projection.edge") {
      const nested = payload.edge && typeof payload.edge === "object" && !Array.isArray(payload.edge) ? payload.edge as Record<string, unknown> : payload;
      if (typeof nested.parentAgentId === "string" && typeof nested.childAgentId === "string") {
        if (eventType === "edge.reconciled") {
          const current = [...this.edgeMap.values()].find((candidate) => candidate.childAgentId === nested.childAgentId);
          if (current?.parentAgentId === nested.parentAgentId) return;
          for (const [key, existing] of this.edgeMap) {
            if (existing.childAgentId === nested.childAgentId) this.edgeMap.delete(key);
          }
        }
        const edge: AgentEdge = { ...this.scope, parentAgentId: nested.parentAgentId, childAgentId: nested.childAgentId, source: eventType === "edge.reconciled" ? "codex-reconciliation" : "event", spawnOrdinal: event.ingestOrdinal, createdAt: event.observedAt };
        this.edgeMap.set(`${edge.parentAgentId}\u0000${edge.childAgentId}`, edge);
      }
      return;
    }
    if (eventType === "identity.evidence" || eventType === "identity.observed" || eventType === "identity.requested" || eventType === "model.rerouted") {
      if (typeof payload.agentId === "string") {
        const values = payload.values && typeof payload.values === "object" && !Array.isArray(payload.values) ? payload.values as Record<string, unknown> : undefined;
        const reroutedValues = payload.to && typeof payload.to === "object" && !Array.isArray(payload.to) ? payload.to as Record<string, unknown> : undefined;
        const evidence: IdentityEvidence = {
          evidenceId: event.eventId,
          ...this.scope,
          agentId: payload.agentId,
          requestedModel: stringOrNull(payload.requestedModel ?? (eventType === "identity.requested" ? values?.model : undefined)),
          requestedEffort: stringOrNull(payload.requestedEffort ?? (eventType === "identity.requested" ? values?.effort : undefined)),
          requestedProvider: stringOrNull(payload.requestedProvider ?? (eventType === "identity.requested" ? values?.provider : undefined)),
          observedModel: stringOrNull(payload.observedModel ?? payload.model ?? reroutedValues?.model ?? (eventType === "identity.observed" ? values?.model : undefined)),
          observedEffort: stringOrNull(payload.observedEffort ?? payload.effort ?? reroutedValues?.effort ?? (eventType === "identity.observed" ? values?.effort : undefined)),
          observedProvider: stringOrNull(payload.observedProvider ?? payload.provider ?? reroutedValues?.provider ?? (eventType === "identity.observed" ? values?.provider : undefined)),
          source: typeof payload.evidenceSource === "string" ? payload.evidenceSource : "event",
          observedAt: event.observedAt,
          evidenceHash: event.sanitizedPayloadHash,
          trustClass: trustOrObserved(payload.trustClass),
        };
        this.evidenceMap.set(evidence.evidenceId, evidence);
      }
    }
  }

  agents(): AgentRecord[] {
    return [...this.agentMap.values()].sort((a, b) => Number(b.isRoot) - Number(a.isRoot) ||
      (a.spawnOrdinal === null ? 1 : 0) - (b.spawnOrdinal === null ? 1 : 0) ||
      (a.spawnOrdinal ?? Number.MAX_SAFE_INTEGER) - (b.spawnOrdinal ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt - b.createdAt || a.agentId.localeCompare(b.agentId));
  }
  edges(): AgentEdge[] {
    return [...this.edgeMap.values()].sort((a, b) =>
      (a.spawnOrdinal === null ? 1 : 0) - (b.spawnOrdinal === null ? 1 : 0) ||
      (a.spawnOrdinal ?? Number.MAX_SAFE_INTEGER) - (b.spawnOrdinal ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt - b.createdAt || a.parentAgentId.localeCompare(b.parentAgentId) || a.childAgentId.localeCompare(b.childAgentId));
  }
  evidence(): IdentityEvidence[] {
    return [...this.evidenceMap.values()].sort((a, b) => a.observedAt - b.observedAt || a.evidenceId.localeCompare(b.evidenceId));
  }
}
