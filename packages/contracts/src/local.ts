import { z } from "zod";
import { PublicAgentSchema } from "./public.js";

/** Local-only detail surfaces are deliberately separate from public-v1. */
export const LOCAL_DETAIL_SCHEMA_VERSION = "agent-farm.local-detail.v2" as const;
export const LocalDetailSchemaVersionSchema = z.literal(LOCAL_DETAIL_SCHEMA_VERSION);

const localText = (label: string, maximum: number) => z.string().max(maximum, `${label} is too long`).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  `${label} contains a control character`,
);

const localLabel = (label: string, maximum = 256) => localText(label, maximum).min(1, `${label} must not be empty`);
const nonNegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const LocalTokenUsageSchema = z.object({
  inputTokens: nonNegative,
  cachedInputTokens: nonNegative,
  cacheWriteInputTokens: nonNegative,
  outputTokens: nonNegative,
  reasoningOutputTokens: nonNegative,
  totalTokens: nonNegative,
  observedAt: z.string().datetime().optional(),
}).strict();
export type LocalTokenUsage = z.infer<typeof LocalTokenUsageSchema>;

/**
 * Per-invocation usage is local-only evidence.  It is retained separately
 * from the cumulative total so reroutes and the >272K long-context rule can
 * be priced without smearing one final model over the entire run.
 */
export const LocalUsageSegmentSchema = z.object({
  turnId: localLabel("turnId"),
  provider: localLabel("provider", 128),
  model: localLabel("model", 128),
  effort: localLabel("effort", 128),
  usage: LocalTokenUsageSchema,
}).strict();
export const LocalUsageSegmentsSchema = z.object({
  complete: z.boolean(),
  segments: z.array(LocalUsageSegmentSchema).max(1_024),
}).strict();
export type LocalUsageSegment = z.infer<typeof LocalUsageSegmentSchema>;
export type LocalUsageSegments = z.infer<typeof LocalUsageSegmentsSchema>;

export const LocalPriceRateSchema = z.object({
  inputPerMillionUsd: z.number().nonnegative().finite(),
  cachedInputPerMillionUsd: z.number().nonnegative().finite(),
  outputPerMillionUsd: z.number().nonnegative().finite(),
}).strict();
export type LocalPriceRate = z.infer<typeof LocalPriceRateSchema>;

export const LocalPricingSnapshotSchema = z.object({
  snapshotId: localLabel("snapshotId", 128),
  authority: z.literal("operator-reviewed-official"),
  sourceUrls: z.array(z.string().url().max(2_048).refine((value) => value.startsWith("https://"), "pricing sources must use HTTPS")).min(1).max(16).refine((values) => new Set(values).size === values.length, "pricing sources must be unique"),
  retrievedAt: z.string().datetime(),
  verifiedAt: z.string().datetime(),
  currency: z.literal("USD"),
  rates: z.record(localLabel("model", 128), LocalPriceRateSchema).refine((values) => Object.keys(values).length >= 1 && Object.keys(values).length <= 256, "pricing rates must be bounded"),
  standardInputMultiplier: z.literal(1),
  longContextThresholdInputTokens: z.literal(272_000),
  longContextInputMultiplier: z.number().positive().finite(),
  longContextOutputMultiplier: z.number().positive().finite(),
  cacheWriteMultiplier: z.number().positive().finite(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  note: localText("note", 1_000).optional(),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.verifiedAt) < Date.parse(value.retrievedAt)) context.addIssue({ code: "custom", path: ["verifiedAt"], message: "verifiedAt must not precede retrievedAt" });
  if (value.cacheWriteMultiplier !== 1.25) context.addIssue({ code: "custom", path: ["cacheWriteMultiplier"], message: "cache-write multiplier must be the reviewed 1.25x rule" });
});
export type LocalPricingSnapshot = z.infer<typeof LocalPricingSnapshotSchema>;

export const LocalCostEstimatedSchema = z.object({
  status: z.literal("estimated"),
  currency: z.literal("USD"),
  selfMicros: nonNegative,
  childrenMicros: nonNegative,
  totalMicros: nonNegative,
  usage: LocalTokenUsageSchema,
  pricing: LocalPricingSnapshotSchema,
}).strict();
export const LocalCostPartialSchema = z.object({
  status: z.literal("partial"),
  currency: z.literal("USD"),
  knownSelfMicros: nonNegative.optional(),
  knownChildrenMicros: nonNegative.optional(),
  reason: localText("reason", 256),
  pricing: LocalPricingSnapshotSchema.optional(),
}).strict();
export const LocalCostUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  currency: z.literal("USD"),
  reason: localText("reason", 256),
}).strict();
export const LocalCostEstimateSchema = z.discriminatedUnion("status", [
  LocalCostEstimatedSchema,
  LocalCostPartialSchema,
  LocalCostUnavailableSchema,
]);
export type LocalCostEstimate = z.infer<typeof LocalCostEstimateSchema>;

export const LocalActivityRecordSchema = z.object({
  kind: z.enum(["collaboration", "subagent_activity", "thread_settings", "model_rerouted", "lifecycle", "error", "unknown"]),
  status: localLabel("status", 64).optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: nonNegative.optional(),
  summary: localText("summary", 4_000).optional(),
  sourceItemId: localLabel("sourceItemId", 256).optional(),
}).strict();
export type LocalActivityRecord = z.infer<typeof LocalActivityRecordSchema>;

export const LocalMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool", "unknown"]),
  text: localText("text", 16_000),
  occurredAt: z.string().datetime().optional(),
}).strict();
export type LocalMessage = z.infer<typeof LocalMessageSchema>;

/** Recorded tool evidence only. This schema has no route, command, or action field. */
export const LocalToolActivitySchema = z.object({
  name: localLabel("toolName", 256),
  status: localLabel("toolStatus", 64).optional(),
  arguments: localText("toolArguments", 16_000).optional(),
  result: localText("toolResult", 16_000).optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: nonNegative.optional(),
}).strict();
export type LocalToolActivity = z.infer<typeof LocalToolActivitySchema>;

export const LocalChangedFileSchema = z.object({
  path: localLabel("path", 4_096),
  additions: nonNegative.optional(),
  deletions: nonNegative.optional(),
}).strict();
export type LocalChangedFile = z.infer<typeof LocalChangedFileSchema>;

export const LocalRolloutDetailSchema = z.object({
  schemaVersion: z.literal("agent-farm.local-rollout-detail.v2"),
  sourceThreadId: localLabel("sourceThreadId"),
  messages: z.array(LocalMessageSchema).max(1_024),
  activity: z.array(LocalActivityRecordSchema).max(1_024),
  tools: z.array(LocalToolActivitySchema).max(1_024),
  changedFiles: z.array(LocalChangedFileSchema).max(1_024),
  finalSummary: localText("finalSummary", 16_000).optional(),
}).strict();
export type LocalRolloutDetail = z.infer<typeof LocalRolloutDetailSchema>;

export const LocalAgentDetailSchema = z.object({
  schemaVersion: LocalDetailSchemaVersionSchema,
  agentSessionId: localLabel("agentSessionId"),
  agent: PublicAgentSchema,
  parent: PublicAgentSchema.nullable(),
  children: z.array(PublicAgentSchema).max(64),
  activity: z.array(LocalActivityRecordSchema).max(2_048),
  messages: z.array(LocalMessageSchema).max(2_048),
  tools: z.array(LocalToolActivitySchema).max(2_048),
  changedFiles: z.array(LocalChangedFileSchema).max(4_096),
  summary: localText("summary", 16_000).optional(),
  usage: LocalTokenUsageSchema.optional(),
  usageSegments: LocalUsageSegmentsSchema.optional(),
  cost: LocalCostEstimateSchema,
}).strict();
export type LocalAgentDetail = z.infer<typeof LocalAgentDetailSchema>;
