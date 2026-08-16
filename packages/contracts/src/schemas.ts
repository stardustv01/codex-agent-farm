import { z } from "zod";

/**
 * The contracts package intentionally has one small, explicit schema version.
 * A version is part of every persisted record so that a future adapter cannot
 * silently reinterpret an old event.
 */
export const CONTRACT_VERSION = 1 as const;
export const ContractVersionSchema = z.literal(CONTRACT_VERSION);
export type ContractVersion = z.infer<typeof ContractVersionSchema>;

const id = (label: string) =>
  z.string().trim().min(1, `${label} must not be empty`).max(256);

export const AgentIdSchema = id("agentId");
export type AgentId = z.infer<typeof AgentIdSchema>;
export const AgentSessionIdSchema = id("agentSessionId");
export type AgentSessionId = z.infer<typeof AgentSessionIdSchema>;
export const SourceThreadIdSchema = id("sourceThreadId");
export type SourceThreadId = z.infer<typeof SourceThreadIdSchema>;
export const TurnIdSchema = id("turnId");
export type TurnId = z.infer<typeof TurnIdSchema>;
export const ConnectionEpochSchema = id("connectionEpoch");
export type ConnectionEpoch = z.infer<typeof ConnectionEpochSchema>;
export const IngestOrdinalSchema = z.number().int().nonnegative();
export type IngestOrdinal = z.infer<typeof IngestOrdinalSchema>;

/** Timestamps are persisted as UTC ISO strings, never Date objects. */
export const TimestampSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
export type Timestamp = z.infer<typeof TimestampSchema>;

const unknownableEnum = <T extends readonly [string, ...string[]]>(
  values: T,
) => z.enum(values).catch("unknown" as T[number]);

export const SessionStatusSchema = unknownableEnum([
  "active",
  "disconnected",
  "unverified",
  "revoked",
  "deleted",
  "unknown",
] as const);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const AgentLifecycleSchema = unknownableEnum([
  "pending",
  "active",
  "idle",
  "completed",
  "failed",
  "interrupted",
  "disconnected",
  "unknown",
] as const);
export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;

export const VerificationStateSchema = unknownableEnum([
  "verified",
  "unverified",
  "mismatch",
  "quarantined",
  "unknown",
] as const);
export type VerificationState = z.infer<typeof VerificationStateSchema>;

export const ConnectionStatusSchema = unknownableEnum([
  "connecting",
  "connected",
  "degraded",
  "disconnected",
  "unverified",
  "incompatible",
  "revoked",
  "unknown",
] as const);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const EdgeStateSchema = unknownableEnum([
  "verified",
  "pending",
  "orphan",
  "cycle",
  "cross-session",
  "duplicate-parent",
  "quarantined",
  "unknown",
] as const);
export type EdgeState = z.infer<typeof EdgeStateSchema>;

export const TrustClassSchema = unknownableEnum([
  "requested",
  "runtime",
  "reconciled",
  "unverified",
  "unknown",
] as const);
export type TrustClass = z.infer<typeof TrustClassSchema>;

export const EvidenceSourceSchema = unknownableEnum([
  "collab.spawn",
  "thread.settings",
  "model.rerouted",
  "thread.list",
  "thread.read",
  "reconciliation",
  "unknown",
] as const);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const ConnectionMethodSchema = unknownableEnum([
  "initialize",
  "initialized",
  "thread/list",
  "thread/read",
  "model/list",
  "unknown",
] as const);
export type ConnectionMethod = z.infer<typeof ConnectionMethodSchema>;

export const SourceKindSchema = unknownableEnum([
  "root",
  "thread_spawn",
  "thread_fork",
  "reconciliation",
  "unknown",
] as const);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const AgentRoleSchema = unknownableEnum([
  "root",
  "planner",
  "worker",
  "reviewer",
  "subagent",
  "unknown",
] as const);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const TurnStatusSchema = unknownableEnum([
  "started",
  "active",
  "completed",
  "failed",
  "interrupted",
  "unknown",
] as const);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const QuarantineReasonSchema = unknownableEnum([
  "invalid-schema",
  "idempotency-conflict",
  "cross-session",
  "self-parent",
  "cycle",
  "orphan",
  "duplicate-parent",
  "out-of-order",
  "unknown",
] as const);
export type QuarantineReason = z.infer<typeof QuarantineReasonSchema>;

export const AuthoritySchema = unknownableEnum([
  "live",
  "reconciliation",
  "corrected",
  "unknown",
] as const);
export type Authority = z.infer<typeof AuthoritySchema>;

export const IdentityValuesSchema = z
  .object({
    provider: id("provider").optional(),
    model: id("model").optional(),
    effort: id("effort").optional(),
  })
  .strict()
  .refine(
    (values) => values.provider !== undefined || values.model !== undefined || values.effort !== undefined,
    "identity evidence must include at least one value",
  );
export type IdentityValues = z.infer<typeof IdentityValuesSchema>;

export const IdentityEvidenceSchema = z
  .object({
    schemaVersion: ContractVersionSchema,
    evidenceId: id("evidenceId"),
    agentSessionId: AgentSessionIdSchema,
    agentId: AgentIdSchema,
    sourceThreadId: SourceThreadIdSchema,
    kind: z.enum(["requested", "observed"]),
    source: EvidenceSourceSchema,
    trustClass: TrustClassSchema,
    values: IdentityValuesSchema,
    turnId: TurnIdSchema.optional(),
    previousValues: IdentityValuesSchema.optional(),
    observedAt: TimestampSchema,
    connectionEpoch: ConnectionEpochSchema,
    ingestOrdinal: IngestOrdinalSchema,
    evidenceHash: id("evidenceHash").optional(),
  })
  .strict();
export type IdentityEvidence = z.infer<typeof IdentityEvidenceSchema>;

export const TurnGenerationSchema = z
  .object({
    schemaVersion: ContractVersionSchema,
    generation: z.number().int().positive(),
    sourceThreadId: SourceThreadIdSchema,
    turnId: TurnIdSchema,
    status: TurnStatusSchema,
    startedAt: TimestampSchema,
    endedAt: TimestampSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
    errorCode: id("errorCode").optional(),
    connectionEpoch: ConnectionEpochSchema,
    startIngestOrdinal: IngestOrdinalSchema,
    endIngestOrdinal: IngestOrdinalSchema.optional(),
  })
  .strict();
export type TurnGeneration = z.infer<typeof TurnGenerationSchema>;

export const AgentSchema = z
  .object({
    schemaVersion: ContractVersionSchema,
    agentId: AgentIdSchema,
    agentSessionId: AgentSessionIdSchema,
    sourceThreadId: SourceThreadIdSchema,
    parentAgentId: AgentIdSchema.optional(),
    forkedFromAgentId: AgentIdSchema.optional(),
    sourceKind: SourceKindSchema,
    nickname: id("nickname").optional(),
    role: AgentRoleSchema,
    lifecycle: AgentLifecycleSchema,
    verification: VerificationStateSchema,
    requestedIdentity: IdentityValuesSchema.optional(),
    observedIdentity: IdentityValuesSchema.optional(),
    identityEvidenceIds: z.array(id("identityEvidenceId")).max(1024),
    turnGenerations: z.array(TurnGenerationSchema).max(4096),
    currentTurnId: TurnIdSchema.optional(),
    currentTurnGeneration: z.number().int().positive().optional(),
    resultSummary: z.string().max(4000).optional(),
    errorCode: id("errorCode").optional(),
    cliVersion: id("cliVersion").optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    endedAt: TimestampSchema.optional(),
  })
  .strict();
export type Agent = z.infer<typeof AgentSchema>;

export const AgentEdgeSchema = z
  .object({
    schemaVersion: ContractVersionSchema,
    edgeId: id("edgeId"),
    agentSessionId: AgentSessionIdSchema,
    parentAgentId: AgentIdSchema,
    childAgentId: AgentIdSchema,
    state: EdgeStateSchema,
    reason: QuarantineReasonSchema.optional(),
    sourceEventId: id("sourceEventId").optional(),
    sourceOperationId: id("sourceOperationId").optional(),
    connectionEpoch: ConnectionEpochSchema,
    ingestOrdinal: IngestOrdinalSchema,
    observedAt: TimestampSchema,
  })
  .strict();
export type AgentEdge = z.infer<typeof AgentEdgeSchema>;

export const CapabilitiesSchema = z
  .object({
    schemaVersion: ContractVersionSchema,
    adapterVersion: id("adapterVersion"),
    protocolVersion: id("protocolVersion").optional(),
    methods: z.array(ConnectionMethodSchema).max(64),
    canListThreads: z.boolean(),
    canReadThreads: z.boolean(),
    canListModels: z.boolean(),
    verified: z.boolean(),
    schemaBundleHash: id("schemaBundleHash").optional(),
    binaryHash: id("binaryHash").optional(),
    reportedUserAgent: id("reportedUserAgent").optional(),
    checkedAt: TimestampSchema,
  })
  .strict()
  .refine(
    (capabilities) => !capabilities.verified || !capabilities.methods.includes("unknown"),
    "capabilities with unknown methods cannot be marked verified",
  );
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const ConnectionStateSchema = z
  .object({
    schemaVersion: ContractVersionSchema,
    status: ConnectionStatusSchema,
    connectionEpoch: ConnectionEpochSchema,
    capabilities: CapabilitiesSchema,
    connectedAt: TimestampSchema.optional(),
    disconnectedAt: TimestampSchema.optional(),
    lastIngestOrdinal: IngestOrdinalSchema.optional(),
    reason: id("reason").optional(),
    verified: z.boolean(),
    updatedAt: TimestampSchema,
  })
  .strict()
  .refine(
    (connection) => connection.verified || connection.status !== "connected",
    "a connected connection with unverified capabilities must be marked unverified",
  );
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const AgentSessionSchema = z
  .object({
    schemaVersion: ContractVersionSchema,
    agentSessionId: AgentSessionIdSchema,
    status: SessionStatusSchema,
    sourceAdapter: id("sourceAdapter"),
    selectedSourceRoot: id("selectedSourceRoot").optional(),
    rootAgentId: AgentIdSchema.optional(),
    rootSourceThreadId: SourceThreadIdSchema.optional(),
    ownerId: id("ownerId").optional(),
    tenantId: id("tenantId").optional(),
    watermark: IngestOrdinalSchema,
    connection: ConnectionStateSchema,
    capabilities: CapabilitiesSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const QuarantinedRecordSchema = z
  .object({
    schemaVersion: ContractVersionSchema,
    quarantineId: id("quarantineId"),
    agentSessionId: AgentSessionIdSchema,
    eventId: id("eventId").optional(),
    reason: QuarantineReasonSchema,
    detail: id("detail").optional(),
    connectionEpoch: ConnectionEpochSchema,
    ingestOrdinal: IngestOrdinalSchema,
    observedAt: TimestampSchema,
  })
  .strict();
export type QuarantinedRecord = z.infer<typeof QuarantinedRecordSchema>;

export const EventEnvelopeSchema = z
  .object({
    schemaVersion: ContractVersionSchema,
    eventId: id("eventId"),
    agentSessionId: AgentSessionIdSchema,
    connectionEpoch: ConnectionEpochSchema,
    ingestOrdinal: IngestOrdinalSchema,
    observedAt: TimestampSchema,
    authority: AuthoritySchema,
    idempotencyKey: id("idempotencyKey"),
    sanitizedPayloadHash: id("sanitizedPayloadHash").optional(),
  })
  .strict();
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

const event = <T extends z.ZodRawShape>(shape: T) =>
  EventEnvelopeSchema.extend(shape).strict();

export const AgentUpsertEventSchema = event({
  type: z.literal("agent.upsert"),
  agentId: AgentIdSchema,
  sourceThreadId: SourceThreadIdSchema,
  sourceKind: SourceKindSchema,
  role: AgentRoleSchema,
  nickname: id("nickname").optional(),
  parentAgentId: AgentIdSchema.optional(),
  parentSourceThreadId: SourceThreadIdSchema.optional(),
  forkedFromAgentId: AgentIdSchema.optional(),
  lifecycle: AgentLifecycleSchema.optional(),
  cliVersion: id("cliVersion").optional(),
});

export const SpawnRequestedEventSchema = event({
  type: z.literal("identity.requested"),
  agentId: AgentIdSchema,
  sourceThreadId: SourceThreadIdSchema,
  values: IdentityValuesSchema,
  sourceOperationId: id("sourceOperationId").optional(),
  turnId: TurnIdSchema.optional(),
});

export const IdentityObservedEventSchema = event({
  type: z.literal("identity.observed"),
  agentId: AgentIdSchema,
  sourceThreadId: SourceThreadIdSchema,
  source: EvidenceSourceSchema,
  values: IdentityValuesSchema,
  turnId: TurnIdSchema.optional(),
});

export const SpawnEdgeEventSchema = event({
  type: z.literal("edge.spawn"),
  edgeId: id("edgeId"),
  parentAgentId: AgentIdSchema,
  childAgentId: AgentIdSchema,
  parentSessionId: AgentSessionIdSchema.optional(),
  childSessionId: AgentSessionIdSchema.optional(),
  sourceOperationId: id("sourceOperationId").optional(),
});

export const TurnStartedEventSchema = event({
  type: z.literal("turn.started"),
  agentId: AgentIdSchema,
  sourceThreadId: SourceThreadIdSchema,
  turnId: TurnIdSchema,
});

export const TurnTerminalEventSchema = event({
  type: z.enum(["turn.completed", "turn.failed", "turn.interrupted"]),
  agentId: AgentIdSchema,
  sourceThreadId: SourceThreadIdSchema,
  turnId: TurnIdSchema,
  durationMs: z.number().int().nonnegative().optional(),
  errorCode: id("errorCode").optional(),
});

export const ThreadStatusChangedEventSchema = event({
  type: z.literal("thread.status.changed"),
  agentId: AgentIdSchema,
  sourceThreadId: SourceThreadIdSchema,
  status: AgentLifecycleSchema,
});

export const ModelReroutedEventSchema = event({
  type: z.literal("model.rerouted"),
  agentId: AgentIdSchema,
  sourceThreadId: SourceThreadIdSchema,
  from: IdentityValuesSchema,
  to: IdentityValuesSchema,
  turnId: TurnIdSchema.optional(),
});

export const ConnectionStateEventSchema = event({
  type: z.literal("connection.state"),
  status: ConnectionStatusSchema,
  reason: id("reason").optional(),
  capabilities: CapabilitiesSchema.optional(),
});

export const SnapshotReconciledEventSchema = event({
  type: z.literal("snapshot.reconciled"),
  snapshotWatermark: IngestOrdinalSchema,
  correctedAgentIds: z.array(AgentIdSchema).max(4096),
  correctedEdgeIds: z.array(id("edgeId")).max(4096),
});

export const SanitizedEventSchema = z.discriminatedUnion("type", [
  AgentUpsertEventSchema,
  SpawnRequestedEventSchema,
  IdentityObservedEventSchema,
  SpawnEdgeEventSchema,
  TurnStartedEventSchema,
  TurnTerminalEventSchema,
  ThreadStatusChangedEventSchema,
  ModelReroutedEventSchema,
  ConnectionStateEventSchema,
  SnapshotReconciledEventSchema,
]);
export type SanitizedEvent = z.infer<typeof SanitizedEventSchema>;

export const SnapshotSchema = z
  .object({
    schemaVersion: ContractVersionSchema,
    snapshotId: id("snapshotId"),
    agentSessionId: AgentSessionIdSchema,
    watermark: IngestOrdinalSchema,
    generatedAt: TimestampSchema,
    session: AgentSessionSchema,
    agents: z.array(AgentSchema).max(100_000),
    edges: z.array(AgentEdgeSchema).max(100_000),
    identityEvidence: z.array(IdentityEvidenceSchema).max(100_000),
    connection: ConnectionStateSchema,
    capabilities: CapabilitiesSchema,
    quarantined: z.array(QuarantinedRecordSchema).max(100_000),
  })
  .strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

// Friendly aliases keep the domain nouns discoverable to API consumers.
export const SessionSchema = AgentSessionSchema;
export type Session = AgentSession;
export const AgentFarmSessionSchema = AgentSessionSchema;
export type AgentFarmSession = AgentSession;
export const AgentNodeSchema = AgentSchema;
export type AgentNode = Agent;
export const EdgeSchema = AgentEdgeSchema;
export type Edge = AgentEdge;
export const AgentHierarchyEdgeSchema = AgentEdgeSchema;
export type AgentHierarchyEdge = AgentEdge;
export const CapabilitySchema = CapabilitiesSchema;
export type Capability = Capabilities;
export const SanitizedEventRecordSchema = SanitizedEventSchema;
export type SanitizedEventRecord = SanitizedEvent;
export const AgentFarmSnapshotSchema = SnapshotSchema;
export type AgentFarmSnapshot = Snapshot;
export const EventSchema = SanitizedEventSchema;
export type Event = SanitizedEvent;
