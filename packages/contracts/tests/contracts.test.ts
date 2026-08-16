import { describe, expect, it } from "vitest";
import {
  AgentSessionSchema,
  PublicAgentIdSchema,
  CONTRACT_VERSION,
  SanitizedEventSchema,
  canonicalCapabilities,
  canonicalProofTree,
  canonicalProofTreeEvents,
  canonicalSession,
  createProjection,
  projectEvents,
  applyEvent,
  projectionToSnapshot,
  applySnapshot,
  sanitizeEvent,
  type SanitizedEvent,
} from "../src/index.js";

const eventBase = (ordinal: number, eventId = `test:${ordinal}`) => ({
  schemaVersion: CONTRACT_VERSION,
  eventId,
  agentSessionId: canonicalSession.agentSessionId,
  connectionEpoch: canonicalSession.connection.connectionEpoch,
  ingestOrdinal: ordinal,
  observedAt: new Date(Date.parse(canonicalSession.updatedAt) + ordinal * 1000).toISOString(),
  authority: "live" as const,
  idempotencyKey: `test-key:${ordinal}`,
});

const root = (ordinal = 1): SanitizedEvent => ({
  ...eventBase(ordinal),
  type: "agent.upsert",
  agentId: "test:root",
  sourceThreadId: "test:thread:root",
  sourceKind: "root",
  role: "root",
});

describe("versioned domain schemas", () => {
  it("accepts only fixed opaque public agent digests", () => {
    expect(PublicAgentIdSchema.parse(`agent:${"a".repeat(40)}`)).toBe(`agent:${"a".repeat(40)}`);
    expect(() => PublicAgentIdSchema.parse("agent:private-root")).toThrow();
    expect(() => PublicAgentIdSchema.parse("/private/source/root")).toThrow();
  });

  it("reject unknown fields while mapping unknown enum values to Unknown", () => {
    const unknownStatus = SanitizedEventSchema.parse({
      ...eventBase(1),
      type: "thread.status.changed",
      agentId: "test:root",
      sourceThreadId: "test:thread:root",
      status: "a-status-added-by-a-new-cli",
    });
    expect(unknownStatus.type).toBe("thread.status.changed");
    expect((unknownStatus as Extract<SanitizedEvent, { type: "thread.status.changed" }>).status).toBe("unknown");
    expect(() => SanitizedEventSchema.parse({ ...root(), rawPayload: { private: true } })).toThrow();
    expect(() => AgentSessionSchema.parse({ ...canonicalSession, opaque: "not persisted" })).toThrow();
  });

  it("keeps requested identity separate from observed identity", () => {
    const events: SanitizedEvent[] = [
      root(),
      {
        ...eventBase(2),
        type: "identity.requested",
        agentId: "test:root",
        sourceThreadId: "test:thread:root",
        values: { provider: "openai", model: "requested-model", effort: "high" },
      },
      {
        ...eventBase(3),
        type: "identity.observed",
        agentId: "test:root",
        sourceThreadId: "test:thread:root",
        source: "thread.settings",
        values: { provider: "openai", model: "effective-model", effort: "high" },
      },
    ];
    const state = projectEvents(canonicalSession, events);
    expect(state.agents[0]?.requestedIdentity?.model).toBe("requested-model");
    expect(state.agents[0]?.observedIdentity?.model).toBe("effective-model");
    expect(state.agents[0]?.verification).toBe("mismatch");
  });
});

describe("deterministic projection", () => {
  it("projects the canonical proof tree and preserves recursive edges", () => {
    const state = canonicalProofTree;
    expect(state.agents).toHaveLength(4);
    expect(state.edges.filter((edge) => edge.state === "verified")).toHaveLength(3);
    expect(state.agents.find((agent) => agent.agentId === "agent:worker")?.parentAgentId).toBe("agent:planner");
    expect(state.agents.find((agent) => agent.agentId === "agent:worker")?.verification).toBe("mismatch");
    expect(state.lastIngestOrdinal).toBe(canonicalProofTreeEvents.length);
  });

  it("is independent of caller order because backend ingestOrdinal is authoritative", () => {
    const forward = projectEvents(canonicalSession, canonicalProofTreeEvents);
    const reverse = projectEvents(canonicalSession, [...canonicalProofTreeEvents].reverse());
    expect(projectionToSnapshot(forward, "same")).toEqual(projectionToSnapshot(reverse, "same"));
  });

  it("treats same-key replays as no-ops and conflicts as quarantine", () => {
    let state = createProjection(canonicalSession);
    const first = applyEvent(state, root());
    state = first.state;
    expect(first.accepted).toBe(true);
    const replay = applyEvent(state, { ...root(), eventId: "test:root-replay", ingestOrdinal: 2 });
    state = replay.state;
    expect(replay.duplicate).toBe(true);
    expect(state.agents).toHaveLength(1);
    const conflict = applyEvent(state, {
      ...root(3),
      idempotencyKey: root().idempotencyKey,
      nickname: "Different payload",
    });
    expect(conflict.accepted).toBe(false);
    expect(conflict.quarantined?.reason).toBe("idempotency-conflict");
  });
});

describe("lineage and lifecycle quarantine", () => {
  it("quarantines orphans, self-parent cycles, and cross-session edges", () => {
    const events: SanitizedEvent[] = [
      root(),
      {
        ...eventBase(2),
        type: "edge.spawn",
        edgeId: "edge:orphan",
        parentAgentId: "missing:parent",
        childAgentId: "test:root",
      },
      {
        ...eventBase(3),
        type: "edge.spawn",
        edgeId: "edge:self",
        parentAgentId: "test:root",
        childAgentId: "test:root",
      },
      {
        ...eventBase(4),
        type: "edge.spawn",
        edgeId: "edge:cross",
        parentAgentId: "test:root",
        childAgentId: "test:root",
        parentSessionId: "another-session",
      },
    ];
    const state = projectEvents(canonicalSession, events);
    expect(state.edges.map((edge) => edge.state)).toEqual(["orphan", "cycle", "cross-session"]);
    expect(state.quarantined.map((record) => record.reason)).toEqual(["orphan", "cycle", "cross-session"]);
  });

  it("keeps turn terminality local to a generation and permits a later generation", () => {
    const events: SanitizedEvent[] = [
      root(),
      {
        ...eventBase(2),
        type: "turn.started",
        agentId: "test:root",
        sourceThreadId: "test:thread:root",
        turnId: "turn:one",
      },
      {
        ...eventBase(3),
        type: "turn.completed",
        agentId: "test:root",
        sourceThreadId: "test:thread:root",
        turnId: "turn:one",
      },
      {
        ...eventBase(4),
        type: "turn.started",
        agentId: "test:root",
        sourceThreadId: "test:thread:root",
        turnId: "turn:one",
      },
    ];
    const state = projectEvents(canonicalSession, events);
    const generations = state.agents[0]?.turnGenerations ?? [];
    expect(generations.map((turn) => turn.generation)).toEqual([1, 2]);
    expect(generations[0]?.status).toBe("completed");
    expect(generations[1]?.status).toBe("started");
  });

  it("represents disconnected/unverified connection truth without terminating agents", () => {
    const events: SanitizedEvent[] = [
      root(),
      {
        ...eventBase(2),
        type: "connection.state",
        status: "disconnected",
        reason: "bridge closed",
      },
    ];
    const state = projectEvents(canonicalSession, events);
    expect(state.connection.status).toBe("disconnected");
    expect(state.session.status).toBe("disconnected");
    expect(state.agents[0]?.lifecycle).toBe("pending");
  });
});

describe("snapshot and sanitization boundaries", () => {
  it("round-trips a snapshot and never stores unknown fields", () => {
    const state = canonicalProofTree;
    const snapshot = projectionToSnapshot(state, "snapshot:test");
    const restored = applySnapshot(createProjection(canonicalSession), snapshot);
    expect(restored.agents).toEqual(state.agents);
    expect(restored.edges).toEqual(state.edges);
    expect(restored.lastIngestOrdinal).toBe(state.lastIngestOrdinal);
  });

  it("provides an explicit sanitization function for bridge boundaries", () => {
    const parsed = sanitizeEvent(root());
    expect(parsed.type).toBe("agent.upsert");
    expect("status" in parsed).toBe(false);
  });
});
