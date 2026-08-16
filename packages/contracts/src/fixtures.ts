import {
  CONTRACT_VERSION,
  type AgentSession,
  type Capabilities,
  type ConnectionState,
  type SanitizedEvent,
  type Snapshot,
} from "./schemas.js";
import { projectEvents, projectionToSnapshot } from "./projection.js";

export const FIXTURE_SESSION_ID = "session:proof-tree";
export const FIXTURE_CONNECTION_EPOCH = "epoch:proof-tree:a";
export const FIXTURE_TIME = "2026-08-09T12:00:00.000Z";

export const canonicalCapabilities: Capabilities = {
  schemaVersion: CONTRACT_VERSION,
  adapterVersion: "codex-0.145.0-stable",
  protocolVersion: "v2",
  methods: ["initialize", "initialized", "thread/list", "thread/read", "model/list"],
  canListThreads: true,
  canReadThreads: true,
  canListModels: true,
  verified: true,
  schemaBundleHash: "schema-fixture-hash",
  binaryHash: "binary-fixture-hash",
  reportedUserAgent: "codex-cli/0.145.0",
  checkedAt: FIXTURE_TIME,
};

export const canonicalConnection: ConnectionState = {
  schemaVersion: CONTRACT_VERSION,
  status: "connected",
  connectionEpoch: FIXTURE_CONNECTION_EPOCH,
  capabilities: canonicalCapabilities,
  connectedAt: FIXTURE_TIME,
  lastIngestOrdinal: 0,
  verified: true,
  updatedAt: FIXTURE_TIME,
};

export const canonicalSession: AgentSession = {
  schemaVersion: CONTRACT_VERSION,
  agentSessionId: FIXTURE_SESSION_ID,
  status: "active",
  sourceAdapter: "codex-app-server-v2",
  selectedSourceRoot: "/selected/root",
  rootSourceThreadId: "thread:root",
  ownerId: "owner:fixture",
  tenantId: "tenant:fixture",
  watermark: 0,
  connection: canonicalConnection,
  capabilities: canonicalCapabilities,
  createdAt: FIXTURE_TIME,
  updatedAt: FIXTURE_TIME,
};

function base<T extends SanitizedEvent["type"]>(
  eventId: string,
  ingestOrdinal: number,
  type: T,
): Pick<SanitizedEvent, "schemaVersion" | "eventId" | "agentSessionId" | "connectionEpoch" | "ingestOrdinal" | "observedAt" | "authority" | "idempotencyKey"> & { type: T } {
  return {
    schemaVersion: CONTRACT_VERSION,
    eventId,
    agentSessionId: FIXTURE_SESSION_ID,
    connectionEpoch: FIXTURE_CONNECTION_EPOCH,
    ingestOrdinal,
    observedAt: new Date(Date.parse(FIXTURE_TIME) + ingestOrdinal * 1_000).toISOString(),
    authority: "live",
    idempotencyKey: `fixture:${ingestOrdinal}`,
    type,
  };
}

/** A small, canonical recursive tree used by backend, UI, and acceptance tests. */
export const canonicalProofTreeEvents: SanitizedEvent[] = [
  {
    ...base("evt:root", 1, "agent.upsert"),
    agentId: "agent:root",
    sourceThreadId: "thread:root",
    sourceKind: "root",
    role: "root",
    nickname: "Root",
    lifecycle: "active",
  },
  {
    ...base("evt:planner", 2, "agent.upsert"),
    agentId: "agent:planner",
    sourceThreadId: "thread:planner",
    sourceKind: "thread_spawn",
    role: "planner",
    nickname: "Planner",
    parentAgentId: "agent:root",
    lifecycle: "active",
  },
  {
    ...base("evt:edge-root-planner", 3, "edge.spawn"),
    edgeId: "edge:root-planner",
    parentAgentId: "agent:root",
    childAgentId: "agent:planner",
  },
  {
    ...base("evt:worker", 4, "agent.upsert"),
    agentId: "agent:worker",
    sourceThreadId: "thread:worker",
    sourceKind: "thread_spawn",
    role: "worker",
    nickname: "Worker",
    parentAgentId: "agent:planner",
    lifecycle: "active",
  },
  {
    ...base("evt:edge-planner-worker", 5, "edge.spawn"),
    edgeId: "edge:planner-worker",
    parentAgentId: "agent:planner",
    childAgentId: "agent:worker",
  },
  {
    ...base("evt:reviewer", 6, "agent.upsert"),
    agentId: "agent:reviewer",
    sourceThreadId: "thread:reviewer",
    sourceKind: "thread_spawn",
    role: "reviewer",
    nickname: "Reviewer",
    parentAgentId: "agent:planner",
    lifecycle: "idle",
  },
  {
    ...base("evt:edge-planner-reviewer", 7, "edge.spawn"),
    edgeId: "edge:planner-reviewer",
    parentAgentId: "agent:planner",
    childAgentId: "agent:reviewer",
  },
  {
    ...base("evt:req-worker", 8, "identity.requested"),
    agentId: "agent:worker",
    sourceThreadId: "thread:worker",
    values: { provider: "openai", model: "gpt-5.6-luna", effort: "high" },
    sourceOperationId: "collab:worker",
  },
  {
    ...base("evt:obs-worker", 9, "identity.observed"),
    agentId: "agent:worker",
    sourceThreadId: "thread:worker",
    source: "thread.settings",
    values: { provider: "openai", model: "gpt-5.6-luna", effort: "high" },
  },
  {
    ...base("evt:turn-start-worker", 10, "turn.started"),
    agentId: "agent:worker",
    sourceThreadId: "thread:worker",
    turnId: "turn:worker:1",
  },
  {
    ...base("evt:reroute-worker", 11, "model.rerouted"),
    agentId: "agent:worker",
    sourceThreadId: "thread:worker",
    turnId: "turn:worker:1",
    from: { provider: "openai", model: "gpt-5.6-luna", effort: "high" },
    to: { provider: "openai", model: "gpt-5.6-sol", effort: "high" },
  },
  {
    ...base("evt:turn-complete-worker", 12, "turn.completed"),
    agentId: "agent:worker",
    sourceThreadId: "thread:worker",
    turnId: "turn:worker:1",
    durationMs: 1_800,
  },
];

export const canonicalProofTree = projectEvents(canonicalSession, canonicalProofTreeEvents);
export const canonicalProofTreeSnapshot: Snapshot = projectionToSnapshot(canonicalProofTree, "snapshot:proof-tree");

/** Compatibility aliases for consumers that use an uppercase fixture name. */
export const CANONICAL_PROOF_TREE_EVENTS = canonicalProofTreeEvents;
export const CANONICAL_PROOF_TREE = canonicalProofTree;
export const PROOF_TREE_FIXTURE = {
  session: canonicalSession,
  events: canonicalProofTreeEvents,
  projection: canonicalProofTree,
  snapshot: canonicalProofTreeSnapshot,
} as const;
