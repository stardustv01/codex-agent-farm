import { z } from "zod";
import {
  PublicAgentDetailsSchema,
  PublicAgentIdSchema,
  PublicAgentSchema,
  PublicConnectionStateSchema,
  PublicConnectionSchema,
  PublicCountsSchema,
  PublicEdgeSchema,
  PublicHierarchyPageSchema,
  PublicIdentityEvidenceSchema,
  PublicSchemaVersionSchema,
  PublicStoryMilestoneSchema,
} from "@agent-farm/contracts";

export const MAX_TEXT_LENGTH = 512;
export const MAX_ID_LENGTH = 256;
export const MAX_AGENTS = 200;
export const MAX_EDGES = 200;
export const MAX_DETAILS_ITEMS = 32;
export const MAX_INLINE_PREVIEW = 8;

export const TOOL_NAMES = [
  "create_agent_session",
  "get_agent_hierarchy",
  "get_agent_details",
  "render_agent_hierarchy",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const boundedId = z.string().trim().min(1).max(MAX_ID_LENGTH);
const boundedText = z.string().trim().max(MAX_TEXT_LENGTH);
const boundedTimestamp = z.string().trim().max(64);
const nullableId = boundedId.nullable();
const nullableTimestamp = boundedTimestamp.nullable();

export const CreateAgentSessionInputSchema = z
  .object({
    idempotencyKey: boundedId,
    label: boundedText.optional(),
  })
  .strict();

export const SessionHintSchema = z
  .object({
    /** A selector hint only; authorization always supplies the effective session. */
    agentSessionId: boundedId.optional(),
  })
  .strict();

export const GetAgentHierarchyInputSchema = z
  .object({
    agentSessionId: boundedId.optional(),
    cursor: boundedId.optional(),
    limit: z.number().int().min(1).max(MAX_AGENTS).optional(),
  })
  .strict();

export const GetAgentDetailsInputSchema = z
  .object({
    agentSessionId: boundedId.optional(),
    agentId: PublicAgentIdSchema,
  })
  .strict();

export const RenderAgentHierarchyInputSchema = z
  .object({
    agentSessionId: boundedId.optional(),
    branchAgentId: PublicAgentIdSchema.optional(),
    mode: z.enum(["inline", "fullscreen", "standalone"]).default("inline"),
  })
  .strict();

/** MCP is a transport for the exact public-v1 hierarchy, not a second mapper. */
export const PublicContractVersionSchema = PublicSchemaVersionSchema;
export const AgentIdentitySchema = PublicIdentityEvidenceSchema;
export const AgentOutputSchema = PublicAgentSchema;
export const AgentEdgeOutputSchema = PublicEdgeSchema;
export const ConnectionStateSchema = PublicConnectionStateSchema;
export const CountsSchema = PublicCountsSchema;

export const CreateAgentSessionOutputSchema = z
  .object({
    agentSessionId: boundedId,
    status: z.enum(["created", "active", "ready", "unknown"]),
    createdAt: boundedTimestamp,
  })
  .strict();

export const HierarchyOutputSchema = PublicHierarchyPageSchema;
export const DetailsOutputSchema = PublicAgentDetailsSchema;

export const InlineSummarySchema = z
  .object({
    mode: z.literal("inline"),
    counts: CountsSchema,
    // Inline rendering carries the exact public-v1 connection contract. Do
    // not silently narrow away its bounded reason/timestamp fields or reject
    // a hierarchy that already passed PublicHierarchyPageSchema.
    connection: PublicConnectionSchema,
    branchPreview: z.array(AgentOutputSchema).max(MAX_INLINE_PREVIEW),
    canExpand: z.boolean(),
  })
  .strict();

export const RenderOutputSchema = z
  .object({
    schemaVersion: PublicContractVersionSchema,
    agentSessionId: boundedId,
    watermark: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    generatedAt: boundedTimestamp,
    snapshotState: z.enum(["complete", "partial", "stale", "disconnected", "error", "unknown"]),
    partialReason: boundedText.optional(),
    connection: PublicConnectionSchema,
    mode: z.enum(["inline", "fullscreen", "standalone"]),
    rootAgentId: nullableId,
    counts: CountsSchema,
    inlineSummary: InlineSummarySchema.nullable(),
    branchPreview: z.array(AgentOutputSchema).max(MAX_INLINE_PREVIEW),
    nodes: z.array(AgentOutputSchema).max(MAX_AGENTS),
    edges: z.array(AgentEdgeOutputSchema).max(MAX_EDGES),
    total: z.number().int().nonnegative().max(100_000),
    page: z.number().int().positive().max(100_000),
    pageSize: z.number().int().positive().max(MAX_AGENTS),
    nextCursor: boundedId.nullable(),
    hasMore: z.boolean(),
    storyMilestones: z.array(PublicStoryMilestoneSchema).max(256),
  })
  .strict();

export type CreateAgentSessionInput = z.infer<typeof CreateAgentSessionInputSchema>;
export type GetAgentHierarchyInput = z.infer<typeof GetAgentHierarchyInputSchema>;
export type GetAgentDetailsInput = z.infer<typeof GetAgentDetailsInputSchema>;
export type RenderAgentHierarchyInput = z.infer<typeof RenderAgentHierarchyInputSchema>;
export type AgentOutput = z.infer<typeof AgentOutputSchema>;
export type AgentEdgeOutput = z.infer<typeof AgentEdgeOutputSchema>;
export type Counts = z.infer<typeof CountsSchema>;
export type CreateAgentSessionOutput = z.infer<typeof CreateAgentSessionOutputSchema>;
export type HierarchyOutput = z.infer<typeof HierarchyOutputSchema>;
export type DetailsOutput = z.infer<typeof DetailsOutputSchema>;
export type InlineSummary = z.infer<typeof InlineSummarySchema>;
export type RenderOutput = z.infer<typeof RenderOutputSchema>;

export interface AgentFarmMcpBackend {
  createAgentSession(
    request: {
      readonly ownerId: string;
      readonly tenantId: string;
      /** Reserved by the authorization server and bound to this token. */
      readonly agentSessionId: string;
      readonly idempotencyKey: string;
      readonly label?: string;
    },
  ): Promise<unknown> | unknown;
  getAgentHierarchy(
    request: {
      readonly ownerId: string;
      readonly tenantId: string;
      readonly agentSessionId: string;
      readonly cursor?: string;
      readonly limit: number;
    },
  ): Promise<unknown> | unknown;
  getAgentDetails(
    request: {
      readonly ownerId: string;
      readonly tenantId: string;
      readonly agentSessionId: string;
      readonly agentId: string;
    },
  ): Promise<unknown> | unknown;
  renderAgentHierarchy?(
    request: {
      readonly ownerId: string;
      readonly tenantId: string;
      readonly agentSessionId: string;
      readonly branchAgentId?: string;
      readonly mode: "inline" | "fullscreen" | "standalone";
    },
  ): Promise<unknown> | unknown;
}

export interface UiResourceConfig {
  readonly resourceUri?: string;
  readonly html?: string;
  readonly connectDomains?: readonly string[];
  readonly resourceDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
}
