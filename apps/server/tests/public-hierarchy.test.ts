import { describe, expect, it } from "vitest";

import { DurableStore, type SessionSnapshot } from "@agent-farm/store";
import { projectPublicHierarchy } from "../src/public-hierarchy.js";

const scope = { tenantId: "tenant:g5", ownerId: "owner:g5", agentSessionId: "session:g5" };

function storeWithSession(): DurableStore {
  const store = new DurableStore({ now: () => 1_700_000_000_000 });
  store.createAgentSession(scope);
  return store;
}

function ingest(store: DurableStore, eventKey: string, eventType: string, payload: Record<string, unknown>, sourceThreadId?: string, observedAt = 1_700_000_000_000) {
  return store.events.ingest(scope, {
    eventKey,
    eventType,
    connectionEpoch: "epoch:g5",
    ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
    payload,
    observedAt,
  });
}

describe("public hierarchy projection", () => {
  it("serializes only strict safe fields and derives structural story milestones", () => {
    const store = storeWithSession();
    ingest(store, "root", "agent.upsert", {
      agentId: "agent:root-public",
      lifecycle: "active",
      role: "root",
      isRoot: true,
      name: "/private/prompt=do-not-show",
      resultSummary: "arbitrary result must not cross the boundary",
      errorSummary: "secret token",
    }, "thread:private-root", 1_700_000_000_001);
    ingest(store, "turn", "turn.started", { agentId: "agent:root-public", sourceThreadId: "thread:private-root" }, "thread:private-root", 1_700_000_000_002);
    ingest(store, "returned", "turn.completed", { agentId: "agent:root-public", sourceThreadId: "thread:private-root" }, "thread:private-root", 1_700_000_000_003);
    const snapshot = store.getSnapshot(scope);
    const result = projectPublicHierarchy({ snapshot, events: store.events.list(scope), page: 1, pageSize: 200 });
    expect(result.page.snapshotState).toBe("partial");
    expect(result.page.nodes[0]?.displayName).toBe("Agent 01");
    expect(result.page.nodes[0]?.agentId).not.toBe("agent:root-public");
    expect(result.details("agent:root-public")).toBeNull();
    expect(result.page.nodes[0]?.taskState.activityLabel).toBe("working");
    expect(result.page.storyMilestones.map((item) => item.kind)).toEqual(["spawned", "working", "returned"]);
    const serialized = JSON.stringify(result.page);
    expect(serialized).not.toContain("sourceThreadId");
    expect(serialized).not.toContain("private-root");
    expect(serialized).not.toContain("arbitrary result");
    expect(serialized).not.toContain("secret token");
    store.close();
  });

  it("rejects sibling private identifiers and unsafe or disjoint identity evidence", () => {
    const store = storeWithSession();
    store.agents.upsert(scope, {
      agentId: "private-agent-alpha",
      sourceThreadId: "private-thread-alpha",
      isRoot: true,
      lifecycle: "active",
      name: "Alpha",
      spawnOrdinal: 1,
    });
    store.agents.upsert(scope, {
      agentId: "private-agent-beta",
      sourceThreadId: "private-thread-beta",
      lifecycle: "active",
      name: "Echo private-thread-alpha",
      spawnOrdinal: 2,
    });
    store.identityEvidence.append(scope, {
      agentId: "private-agent-beta",
      requestedModel: "gpt-safe",
      requestedProvider: null,
      requestedEffort: null,
      observedModel: null,
      observedProvider: "openai",
      observedEffort: null,
      source: "thread.settings",
      trustClass: "observed",
    });
    store.identityEvidence.append(scope, {
      agentId: "private-agent-alpha",
      requestedModel: null,
      requestedProvider: null,
      requestedEffort: null,
      observedModel: "/private/model-token",
      observedProvider: null,
      observedEffort: null,
      source: "thread.settings",
      trustClass: "observed",
    });
    const page = projectPublicHierarchy({ snapshot: store.getSnapshot(scope), events: [], page: 1, pageSize: 200 }).page;
    expect(page.nodes.find((node) => node.agentId !== page.rootAgentId)?.displayName).toBe("Agent 02");
    expect(page.nodes.find((node) => node.agentId !== page.rootAgentId)?.identity.verification).toBe("unverified");
    expect(page.nodes.find((node) => node.agentId === page.rootAgentId)?.identity.observed).toBeNull();
    expect(JSON.stringify(page)).not.toContain("private-thread-alpha");
    expect(JSON.stringify(page)).not.toContain("private/model-token");
    store.close();
  });

  it("verifies exactly the requested identity dimensions while retaining additional observed evidence", () => {
    const store = storeWithSession();
    store.agents.upsert(scope, {
      agentId: "agent:identity-subset",
      sourceThreadId: "thread:identity-subset",
      isRoot: true,
      lifecycle: "active",
      spawnOrdinal: 1,
    });
    store.identityEvidence.append(scope, {
      agentId: "agent:identity-subset",
      requestedModel: "gpt-5.6-luna",
      requestedProvider: null,
      requestedEffort: "max",
      observedModel: null,
      observedProvider: null,
      observedEffort: null,
      source: "collaboration.spawn",
      trustClass: "requested",
    });
    store.identityEvidence.append(scope, {
      agentId: "agent:identity-subset",
      requestedModel: null,
      requestedProvider: null,
      requestedEffort: null,
      observedModel: "gpt-5.6-luna",
      observedProvider: "openai",
      observedEffort: "max",
      source: "codex.rollout.turn-context",
      trustClass: "observed",
    });
    const page = projectPublicHierarchy({ snapshot: store.getSnapshot(scope), events: [], page: 1, pageSize: 200 }).page;
    expect(page.nodes[0]?.identity).toMatchObject({
      requested: { model: "gpt-5.6-luna", effort: "max" },
      observed: { model: "gpt-5.6-luna", provider: "openai", effort: "max" },
      verification: "verified",
    });
    store.close();
  });

  it("fails duplicate-parent and cyclic topology closed independent of edge input order", () => {
    const store = storeWithSession();
    for (const [index, agentId] of ["root", "a", "b", "p", "q"].entries()) {
      store.agents.upsert(scope, { agentId, isRoot: agentId === "root", lifecycle: "active", spawnOrdinal: index + 1 });
    }
    const base = store.getSnapshot(scope);
    const edge = (parentAgentId: string, childAgentId: string, spawnOrdinal: number) => ({
      ...scope,
      parentAgentId,
      childAgentId,
      source: "event",
      spawnOrdinal,
      createdAt: 1_700_000_000_000 + spawnOrdinal,
    });
    const edges = [edge("a", "b", 1), edge("b", "a", 2), edge("root", "q", 3), edge("p", "q", 4)];
    const first = projectPublicHierarchy({ snapshot: { ...base, edges }, events: [], page: 1, pageSize: 200 }).page;
    const reverse = projectPublicHierarchy({ snapshot: { ...base, edges: [...edges].reverse() }, events: [], page: 1, pageSize: 200 }).page;
    expect(reverse).toEqual(first);
    expect(first.edges.filter((item) => item.state === "cycle")).toHaveLength(2);
    expect(first.edges.filter((item) => item.state === "duplicate-parent")).toHaveLength(2);
    expect(first.nodes.every((node) => node.parentAgentId === null)).toBe(true);
    store.close();
  });

  it("keeps three primary branches and depth-three descendants in deterministic order", () => {
    const store = storeWithSession();
    const add = (id: string, ordinal: number, parentAgentId?: string, isRoot = false, displayName = id.replace("agent:", "")) => {
      ingest(store, `${id}:upsert`, "agent.upsert", {
        agentId: id,
        lifecycle: "active",
        role: isRoot ? "root" : "worker",
        isRoot,
        name: displayName,
      }, `thread:${id}`, 1_700_000_000_000 + ordinal);
      if (parentAgentId !== undefined) ingest(store, `${id}:edge`, "edge.spawn", { parentAgentId, childAgentId: id }, `thread:${id}`, 1_700_000_000_000 + ordinal + 100);
    };
    add("agent:main-g5", 1, undefined, true, "Main G5");
    add("agent:primary-a", 2, "agent:main-g5", false, "Primary A");
    add("agent:primary-b", 3, "agent:main-g5", false, "Primary B");
    add("agent:primary-c", 4, "agent:main-g5", false, "Primary C");
    add("agent:a-child", 5, "agent:primary-a", false, "A Child");
    add("agent:a-grandchild", 6, "agent:a-child", false, "A Grandchild");
    add("agent:b-child", 7, "agent:primary-b", false, "B Child");
    add("agent:c-child", 8, "agent:primary-c", false, "C Child");
    const snapshot = store.getSnapshot(scope);
    const result = projectPublicHierarchy({ snapshot, events: store.events.list(scope), page: 1, pageSize: 200 });
    expect(result.page.nodes.map((node) => node.displayName)).toEqual([
      "Main G5",
      "Primary A",
      "A Child",
      "A Grandchild",
      "Primary B",
      "B Child",
      "Primary C",
      "C Child",
    ]);
    expect(result.page.nodes.find((node) => node.displayName === "Primary A")?.descendantCount).toBe(2);
    expect(result.page.nodes.find((node) => node.displayName === "Main G5")?.directChildCount).toBe(3);
    const repeat = projectPublicHierarchy({ snapshot, events: store.events.list(scope), page: 1, pageSize: 200 });
    expect(repeat.page).toEqual(result.page);
    store.close();
  });

  it("marks legacy rows partial and rejects invalid edge topology without false verification", () => {
    const store = storeWithSession();
    store.agents.upsert(scope, { agentId: "legacy-root", isRoot: true, lifecycle: "completed", name: "Legacy Root" });
    store.agents.upsert(scope, { agentId: "legacy-child", lifecycle: "active", name: "Legacy Child" });
    const base = store.getSnapshot(scope);
    const invalid = {
      ...base,
      edges: [
        ...base.edges,
        {
          tenantId: scope.tenantId,
          ownerId: scope.ownerId,
          agentSessionId: scope.agentSessionId,
          parentAgentId: "legacy-root",
          childAgentId: "missing-child",
          source: "unknown",
          spawnOrdinal: null,
          createdAt: 1_700_000_000_004,
        },
      ],
    } satisfies SessionSnapshot;
    const result = projectPublicHierarchy({ snapshot: invalid, events: [] , page: 1, pageSize: 200 });
    expect(result.page.snapshotState).toBe("partial");
    expect(result.page.partialReason).toBe("legacy-projection");
    expect(result.page.edges.some((edge) => edge.state !== "verified")).toBe(false);
    expect(projectPublicHierarchy({ snapshot: invalid, events: [], page: 1, pageSize: 200 }).page).toEqual(result.page);
    store.close();
  });
});
