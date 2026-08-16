/**
 * Storage types deliberately use plain, serialisable values.  The contracts
 * package owns the wire schemas; this package owns the durable representation
 * and does not persist protocol objects or raw app-server payloads.
 */

export type SessionStatus = "active" | "paused" | "revoked" | "deleted";
export type AgentLifecycle =
  | "unknown"
  | "pending"
  | "queued"
  | "active"
  | "idle"
  | "completed"
  | "failed"
  | "interrupted"
  | "disconnected";
export type VerificationState = "unverified" | "verified" | "mismatch";
export type EvidenceTrustClass = "requested" | "observed" | "reconciled";
export type BridgeBindingStatus = "active" | "revoked" | "expired";
export type McpGrantSessionBindingStatus = "active" | "revoked" | "expired";
export type EventAuthority = "notification" | "snapshot" | "reconciliation" | "system";

import type { LocalCostEstimate, LocalPricingSnapshot, LocalUsageSegments } from "@agent-farm/contracts";

export interface PrincipalScope {
  tenantId: string;
  ownerId: string;
  agentSessionId: string;
}

export interface SessionCreateInput {
  tenantId: string;
  ownerId: string;
  agentSessionId?: string;
  status?: SessionStatus;
  sourceAdapter?: string;
  schemaVersion?: number;
  rootSourceThreadId?: string;
  rootSourceSessionId?: string;
  capabilities?: readonly string[];
  idempotencyKey?: string;
  /** Optional operation payload used to detect idempotency-key conflicts. */
  requestPayload?: unknown;
}

export interface AppSession {
  tenantId: string;
  ownerId: string;
  agentSessionId: string;
  status: SessionStatus;
  sourceAdapter: string | null;
  schemaVersion: number;
  rootSourceThreadId: string | null;
  rootSourceSessionId: string | null;
  watermarkIngestOrdinal: number;
  capabilities: readonly string[];
  createdAt: number;
  updatedAt: number;
}

export interface SourceThreadMapping {
  tenantId: string;
  ownerId: string;
  agentSessionId: string;
  sourceAdapter: string;
  sourceThreadId: string;
  sourceSessionId: string | null;
  isRoot: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRecord {
  tenantId: string;
  ownerId: string;
  agentSessionId: string;
  agentId: string;
  sourceAdapter: string | null;
  sourceThreadId: string | null;
  sourceSessionId: string | null;
  parentSourceThreadId: string | null;
  role: string | null;
  name: string | null;
  lifecycle: AgentLifecycle;
  resultSummary: string | null;
  errorSummary: string | null;
  verificationState: VerificationState;
  isRoot: boolean;
  /** Event-backed spawn ordinal used for deterministic sibling ordering. */
  spawnOrdinal: number | null;
  createdAt: number;
  updatedAt: number;
  /** Latest monotonic cumulative usage read from the local rollout. */
  usage: TokenUsageRecord | null;
  /** Per-invocation usage segments; null means no trusted segment evidence. */
  usageSegments: LocalUsageSegments | null;
  /** Immutable reviewed pricing snapshot used by a completed estimate. */
  pricingSnapshotId: string | null;
  /** Validated local-only cost result; null means no pinned estimate exists. */
  cost: LocalCostEstimate | null;
  costUsageDigest: string | null;
}

export interface TokenUsageRecord {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  observedAt?: string;
}

export interface AgentUpsertInput {
  agentId: string;
  sourceAdapter?: string | null;
  sourceThreadId?: string | null;
  sourceSessionId?: string | null;
  parentSourceThreadId?: string | null;
  role?: string | null;
  name?: string | null;
  lifecycle?: AgentLifecycle;
  resultSummary?: string | null;
  errorSummary?: string | null;
  verificationState?: VerificationState;
  isRoot?: boolean;
  spawnOrdinal?: number | null;
  createdAt?: number;
  updatedAt?: number;
  usage?: TokenUsageRecord | null;
  usageSegments?: LocalUsageSegments | null;
  pricingSnapshotId?: string | null;
  cost?: LocalCostEstimate | null;
  costUsageDigest?: string | null;
}

export interface PricingSnapshotRecord {
  snapshotId: string;
  snapshotHash: string;
  snapshot: LocalPricingSnapshot;
  createdAt: number;
}

export interface PricingSnapshotInput {
  snapshotId: string;
  snapshot: LocalPricingSnapshot;
  createdAt?: number;
}

export interface AgentEdge {
  tenantId: string;
  ownerId: string;
  agentSessionId: string;
  parentAgentId: string;
  childAgentId: string;
  source: string;
  /** Event-backed edge ordinal; null is retained for legacy rows. */
  spawnOrdinal: number | null;
  createdAt: number;
}

export interface EdgeInput {
  parentAgentId: string;
  childAgentId: string;
  source?: string;
  spawnOrdinal?: number | null;
  createdAt?: number;
}

/**
 * A reconciliation observation is intentionally a separate input type. It is
 * not a general-purpose control/mutation request: the authority and source
 * are fixed to the authenticated Codex reconciliation path, and the epoch is
 * retained in the audit record for replay/debugging.
 */
export interface ReconcileEdgeInput {
  parentAgentId: string;
  childAgentId: string;
  connectionEpoch: string;
  source?: "codex-reconciliation";
  createdAt?: number;
  sourceEventId?: string;
  ingestOrdinal?: number;
}

export interface ReconcileEdgeResult {
  edge: AgentEdge;
  changed: boolean;
  previousParentAgentId: string | null;
}

export interface IdentityEvidence {
  evidenceId: string;
  tenantId: string;
  ownerId: string;
  agentSessionId: string;
  agentId: string;
  requestedModel: string | null;
  requestedEffort: string | null;
  requestedProvider: string | null;
  observedModel: string | null;
  observedEffort: string | null;
  observedProvider: string | null;
  source: string;
  observedAt: number;
  evidenceHash: string;
  trustClass: EvidenceTrustClass;
}

export interface IdentityEvidenceInput {
  evidenceId?: string;
  agentId: string;
  requestedModel?: string | null;
  requestedEffort?: string | null;
  requestedProvider?: string | null;
  observedModel?: string | null;
  observedEffort?: string | null;
  observedProvider?: string | null;
  source: string;
  observedAt?: number;
  evidenceHash?: string;
  trustClass?: EvidenceTrustClass;
}

export interface SanitizedEventInput {
  eventKey: string;
  eventType: string;
  connectionEpoch: string;
  sourceAdapter?: string | null;
  sourceThreadId?: string | null;
  sourceSessionId?: string | null;
  turnId?: string | null;
  itemId?: string | null;
  status?: string | null;
  payload: unknown;
  correlationId?: string | null;
  authority?: EventAuthority;
  redactionVersion?: string;
  observedAt?: number;
}

export interface SanitizedEvent {
  eventId: string;
  tenantId: string;
  ownerId: string;
  agentSessionId: string;
  connectionEpoch: string;
  ingestOrdinal: number;
  eventKey: string;
  eventType: string;
  sourceAdapter: string | null;
  sourceThreadId: string | null;
  sourceSessionId: string | null;
  turnId: string | null;
  itemId: string | null;
  status: string | null;
  sanitizedPayloadHash: string;
  sanitizedPayload: Record<string, unknown>;
  correlationId: string | null;
  authority: EventAuthority;
  redactionVersion: string;
  observedAt: number;
  createdAt: number;
}

export interface EventConflict {
  conflictId: string;
  tenantId: string;
  ownerId: string;
  agentSessionId: string;
  eventKey: string;
  existingPayloadHash: string;
  conflictingPayloadHash: string;
  connectionEpoch: string;
  payload: Record<string, unknown>;
  reason: "sanitized_payload_hash_conflict";
  createdAt: number;
}

export interface EventIngestResult {
  outcome: "inserted" | "replayed" | "quarantined";
  event: SanitizedEvent | null;
  conflict: EventConflict | null;
  watermarkIngestOrdinal: number;
}

export interface BridgeBinding {
  bindingId: string;
  tenantId: string;
  ownerId: string;
  agentSessionId: string;
  installationId: string;
  sourceAdapter: string;
  selectedSourceRootId: string;
  credentialHash: string;
  nonceHash: string | null;
  expiresAt: number;
  status: BridgeBindingStatus;
  createdAt: number;
  revokedAt: number | null;
}

export interface BridgeBindingInput {
  bindingId?: string;
  installationId: string;
  sourceAdapter: string;
  selectedSourceRootId: string;
  credentialHash: string;
  nonceHash?: string | null;
  expiresAt: number;
  status?: BridgeBindingStatus;
}

/**
 * Minimal internal identity needed to attach one local Codex runtime.
 * Credential and nonce hashes are intentionally excluded from this resolver
 * result so deployment wiring cannot accidentally expose them.
 */
export interface ActiveBridgeBindingSelection extends PrincipalScope {
  installationId: string;
  selectedSourceRootId: string;
}

/**
 * Refresh-stable OAuth grant identity used to keep an MCP remount on the same
 * Agent Farm session.  The durable repository hashes this tuple before it
 * reaches SQLite; no raw bearer, JWT ID, or grant ID is persisted.
 */
export interface McpGrantSessionBindingKey {
  ownerId: string;
  tenantId: string;
  subject: string;
  resource: string;
  grantId: string;
}

export interface McpGrantSessionBindingInput extends McpGrantSessionBindingKey {
  /** Candidate generated by the application. A concurrent winner may differ. */
  proposedAgentSessionId: string;
  /** Verified token expiration in milliseconds, when available. */
  expiresAt?: number;
}

export interface McpGrantSessionBinding {
  /** Keyed SHA-256 digest; this is the only durable representation of the grant tuple. */
  grantKeyDigest: string;
  agentSessionId: string;
  status: McpGrantSessionBindingStatus;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export interface IdempotencyRecord {
  tenantId: string;
  ownerId: string;
  agentSessionId: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  responseJson: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface AuditRecord {
  auditId: string;
  tenantId: string;
  ownerId: string;
  agentSessionId: string | null;
  action: string;
  actorType: string;
  actorId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface SessionSnapshot {
  session: AppSession;
  agents: AgentRecord[];
  edges: AgentEdge[];
  identityEvidence: IdentityEvidence[];
  watermarkIngestOrdinal: number;
}

export interface RebuiltSnapshot extends SessionSnapshot {
  rebuiltFromEventCount: number;
  equivalentToLiveProjection: boolean;
}
