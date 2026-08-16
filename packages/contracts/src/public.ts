import { z } from "zod";

/**
 * The browser/MCP surface is deliberately a different contract from the
 * durable projection.  The durable projection contains source-thread,
 * session, tenant, and reconciliation details that are useful to the server
 * but are never a public hierarchy field.
 */
export const PUBLIC_CONTRACT_VERSION = 1 as const;
export const PUBLIC_SCHEMA_VERSION = "agent-farm.public.v1" as const;

const boundedId = (label: string) =>
  z.string().trim().min(1, `${label} must not be empty`).max(256).refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    `${label} contains a control character`,
  );

const boundedText = (label: string, maximum = 160) =>
  z.string().trim().min(1, `${label} must not be empty`).max(maximum).refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    `${label} contains a control character`,
  );

export const PublicSchemaVersionSchema = z.literal(PUBLIC_SCHEMA_VERSION);
export const PublicAgentIdSchema = z.string().regex(/^agent:[a-f0-9]{40}$/u, "agentId must be an opaque public digest");
export const PublicEdgeIdSchema = z.string().regex(/^edge:[a-f0-9]{40}$/u, "edgeId must be an opaque public digest");
export const PublicMilestoneIdSchema = z.string().regex(
  /^milestone:(?:connection:)?[a-f0-9]{64}$/u,
  "milestoneId must be an opaque public digest",
);
export const PublicTimestampSchema = z.string().trim().max(64).refine(
  (value) => !Number.isNaN(Date.parse(value)),
  "invalid timestamp",
);

export const PublicLifecycleSchema = z.enum([
  "pending",
  "active",
  "idle",
  "completed",
  "failed",
  "interrupted",
  "disconnected",
  "unknown",
]);
export type PublicLifecycle = z.infer<typeof PublicLifecycleSchema>;

export const PublicActivityLabelSchema = z.enum([
  "queued",
  "working",
  "waiting",
  "returned",
  "failed",
  "interrupted",
  "disconnected",
  "unverified",
  "unknown",
]);
export type PublicActivityLabel = z.infer<typeof PublicActivityLabelSchema>;

export const PublicFailureCategorySchema = z.enum([
  "bridge",
  "timeout",
  "cancelled",
  "authorization",
  "validation",
  "runtime",
  "unknown",
]);
export type PublicFailureCategory = z.infer<typeof PublicFailureCategorySchema>;

export const PublicRoleSchema = z.enum([
  "root",
  "planner",
  "worker",
  "reviewer",
  "subagent",
  "unknown",
]);

export const PublicVerificationSchema = z.enum([
  "verified",
  "unverified",
  "mismatch",
  "unknown",
]);

export const PublicTrustSchema = z.enum([
  "requested",
  "observed",
  "reconciled",
  "unknown",
]);

export const PublicEvidenceSourceSchema = z.enum([
  "collab.spawn",
  "thread.settings",
  "model.rerouted",
  "thread.list",
  "thread.read",
  "reconciliation",
  "unknown",
]);

export const PublicIdentityValueSchema = z
  .object({
    model: boundedText("model", 128).optional(),
    provider: boundedText("provider", 128).optional(),
    effort: boundedText("effort", 64).optional(),
    source: PublicEvidenceSourceSchema.optional(),
    trust: PublicTrustSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.model !== undefined || value.provider !== undefined || value.effort !== undefined,
    "identity value must contain model, provider, or effort",
  );

export const PublicIdentityEvidenceSchema = z
  .object({
    requested: PublicIdentityValueSchema.nullable(),
    observed: PublicIdentityValueSchema.nullable(),
    verification: PublicVerificationSchema,
  })
  .strict();

export const PublicTaskStateSchema = z
  .object({
    lifecycle: PublicLifecycleSchema,
    activityLabel: PublicActivityLabelSchema,
    failureCategory: PublicFailureCategorySchema.optional(),
    startedAt: PublicTimestampSchema.optional(),
    completedAt: PublicTimestampSchema.optional(),
    returnedAt: PublicTimestampSchema.optional(),
    lastActivityAt: PublicTimestampSchema.optional(),
  })
  .strict();

export const PublicClusterSchema = z
  .object({
    state: z.enum(["active", "completed", "failed", "disconnected", "unknown"]),
  })
  .strict();

export const PublicAgentSchema = z
  .object({
    schemaVersion: PublicSchemaVersionSchema,
    agentId: PublicAgentIdSchema,
    parentAgentId: PublicAgentIdSchema.nullable(),
    childIds: z.array(PublicAgentIdSchema).max(2_000),
    displayName: boundedText("displayName", 160),
    role: PublicRoleSchema,
    lifecycle: PublicLifecycleSchema,
    taskState: PublicTaskStateSchema,
    identity: PublicIdentityEvidenceSchema,
    directChildCount: z.number().int().nonnegative().max(100_000),
    descendantCount: z.number().int().nonnegative().max(100_000),
    spawnAt: PublicTimestampSchema.optional(),
    cluster: PublicClusterSchema,
  })
  .strict();
export type PublicAgent = z.infer<typeof PublicAgentSchema>;

export const PublicEdgeStateSchema = z.enum([
  "verified",
  "pending",
  "orphan",
  "cycle",
  "duplicate-parent",
  "unknown",
]);

export const PublicEdgeSchema = z
  .object({
    schemaVersion: PublicSchemaVersionSchema,
    edgeId: PublicEdgeIdSchema,
    parentAgentId: PublicAgentIdSchema,
    childAgentId: PublicAgentIdSchema,
    state: PublicEdgeStateSchema,
  })
  .strict();
export type PublicEdge = z.infer<typeof PublicEdgeSchema>;

export const PublicConnectionStateSchema = z.enum([
  "connected",
  "reconnecting",
  "stale",
  "disconnected",
  "error",
  "unverified",
  "unknown",
]);
export type PublicConnectionState = z.infer<typeof PublicConnectionStateSchema>;

export const PublicSnapshotStateSchema = z.enum([
  "complete",
  "partial",
  "stale",
  "disconnected",
  "error",
  "unknown",
]);
export type PublicSnapshotState = z.infer<typeof PublicSnapshotStateSchema>;

export const PublicReasonCodeSchema = z.enum([
  "missing-evidence",
  "projection-lag",
  "pagination-bounded",
  "legacy-projection",
  "bridge-unavailable",
  "source-disconnected",
  "reconnecting",
  "unknown",
]);
export type PublicReasonCode = z.infer<typeof PublicReasonCodeSchema>;

export const PublicConnectionSchema = z
  .object({
    state: PublicConnectionStateSchema,
    reason: PublicReasonCodeSchema.optional(),
    updatedAt: PublicTimestampSchema.optional(),
  })
  .strict();
export type PublicConnection = z.infer<typeof PublicConnectionSchema>;

export const PublicCountsSchema = z
  .object({
    total: z.number().int().nonnegative().max(100_000),
    active: z.number().int().nonnegative().max(100_000),
    completed: z.number().int().nonnegative().max(100_000),
    failed: z.number().int().nonnegative().max(100_000),
    disconnected: z.number().int().nonnegative().max(100_000),
    unverified: z.number().int().nonnegative().max(100_000),
  })
  .strict();
export type PublicCounts = z.infer<typeof PublicCountsSchema>;

export const PublicStoryKindSchema = z.enum([
  "spawned",
  "working",
  "returned",
  "failed",
  "interrupted",
  "disconnected",
  "reconnected",
  "partial",
]);
export type PublicStoryKind = z.infer<typeof PublicStoryKindSchema>;

export const PublicStoryMilestoneSchema = z
  .object({
    schemaVersion: PublicSchemaVersionSchema,
    milestoneId: PublicMilestoneIdSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    kind: PublicStoryKindSchema,
    agentId: PublicAgentIdSchema.nullable(),
    occurredAt: PublicTimestampSchema,
  })
  .strict();
export type PublicStoryMilestone = z.infer<typeof PublicStoryMilestoneSchema>;

export const PublicHierarchyPageSchema = z
  .object({
    schemaVersion: PublicSchemaVersionSchema,
    agentSessionId: boundedId("agentSessionId"),
    watermark: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    generatedAt: PublicTimestampSchema,
    snapshotState: PublicSnapshotStateSchema,
    partialReason: PublicReasonCodeSchema.optional(),
    connection: PublicConnectionSchema,
    rootAgentId: PublicAgentIdSchema.nullable(),
    nodes: z.array(PublicAgentSchema).max(200),
    edges: z.array(PublicEdgeSchema).max(400),
    total: z.number().int().nonnegative().max(100_000),
    page: z.number().int().positive().max(100_000),
    pageSize: z.number().int().positive().max(200),
    hasMore: z.boolean(),
    nextCursor: z.string().regex(/^p_[1-9][0-9]*$/u, "invalid public cursor").nullable(),
    counts: PublicCountsSchema,
    storyMilestones: z.array(PublicStoryMilestoneSchema).max(256),
  })
  .strict();
export type PublicHierarchyPage = z.infer<typeof PublicHierarchyPageSchema>;

export const PublicAgentDetailsSchema = z
  .object({
    schemaVersion: PublicSchemaVersionSchema,
    agentSessionId: boundedId("agentSessionId"),
    connection: PublicConnectionSchema,
    agent: PublicAgentSchema,
    parent: PublicAgentSchema.nullable(),
    children: z.array(PublicAgentSchema).max(64),
    storyMilestones: z.array(PublicStoryMilestoneSchema).max(64),
  })
  .strict();
export type PublicAgentDetails = z.infer<typeof PublicAgentDetailsSchema>;
