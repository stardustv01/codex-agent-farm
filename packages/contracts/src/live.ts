import { z } from "zod";

/** Content-free, session-scoped signal for authoritative hierarchy refresh. */
export const HIERARCHY_REVISION_SCHEMA_VERSION = "agent-farm.hierarchy-revision.v1" as const;

export const HierarchyRevisionSchema = z.object({
  schemaVersion: z.literal(HIERARCHY_REVISION_SCHEMA_VERSION),
  agentSessionId: z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type HierarchyRevision = z.infer<typeof HierarchyRevisionSchema>;
