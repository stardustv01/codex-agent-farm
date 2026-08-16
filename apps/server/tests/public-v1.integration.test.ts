import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { makeAuthContext } from "@agent-farm/mcp";
import { DurableStore } from "@agent-farm/store";

import { createProductionComposition } from "../src/composition.js";
import type { RawTokenClaims } from "../src/contracts.js";

const scope = {
  tenantId: "tenant-public-integration",
  ownerId: "owner-public-integration",
  agentSessionId: "session-public-integration",
} as const;
const forbidden = /sourceThreadId|sourceSessionId|ownerId|tenantId|agentPath|installationId|credential|token|secret|prompt|reasoning|tool.?arg|resultSummary|errorSummary|diff/iu;

function claims(): RawTokenClaims {
  return {
    sub: scope.ownerId,
    ownerId: scope.ownerId,
    tenantId: scope.tenantId,
    scope: "agent-session:read agent-session:read-details agent-session:render",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    aud: "agent-farm",
    resource: "https://agent-farm.local",
  };
}

function assertNoForbidden(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbidden(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    expect(key).not.toMatch(forbidden);
    assertNoForbidden(item);
  }
}

function ingestFixture(store: DurableStore): void {
  store.createAgentSession({ ...scope, sourceAdapter: "fixture", idempotencyKey: "public-v1-fixture" });
  const agents = [
    ["root", null, "root", true],
    ["planner-a", "root", "planner", false],
    ["planner-b", "root", "planner", false],
    ["planner-c", "root", "planner", false],
    ["worker-a", "planner-a", "worker", false],
    ["worker-b", "planner-b", "worker", false],
    ["worker-c", "planner-c", "worker", false],
    ["review-a", "worker-a", "reviewer", false],
  ] as const;
  for (const [agentId, parentAgentId, role, isRoot] of agents) {
    store.events.ingest(scope, {
      eventKey: `agent:${agentId}`,
      eventType: "agent.upsert",
      connectionEpoch: "public-v1-epoch",
      sourceThreadId: `private-thread-${agentId}`,
      payload: {
        agentId,
        parentAgentId,
        role,
        lifecycle: agentId === "review-a" ? "completed" : "active",
        isRoot,
        name: agentId === "root" ? "Root" : `${role} ${agentId.slice(-1).toUpperCase()}`,
      },
    });
    if (parentAgentId) {
      store.events.ingest(scope, {
        eventKey: `edge:${parentAgentId}:${agentId}`,
        eventType: "edge.spawn",
        connectionEpoch: "public-v1-epoch",
        payload: { parentAgentId, childAgentId: agentId },
      });
    }
  }
}

function compositionOptions(filename: string) {
  return {
    databaseFilename: filename,
    startRuntime: false,
    bridge: { runtimeConnectionState: () => "connected" as const },
    server: {
      authService: {
        authenticateToken: async (): Promise<RawTokenClaims> => claims(),
      },
    },
    mcpAuthContextProvider: () => makeAuthContext({
      ownerId: scope.ownerId,
      tenantId: scope.tenantId,
      scopes: ["agent-session:read", "agent-session:read-details", "agent-session:render"],
      agentSessionId: scope.agentSessionId,
    }),
  } as const;
}

describe("public-v1 REST/MCP durable parity", () => {
  it("keeps hierarchy/details/render identical across restart and rebuild", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-public-v1-"));
    const filename = join(directory, "farm.sqlite");
    try {
      const firstStore = new DurableStore(filename);
      ingestFixture(firstStore);
      expect(firstStore.rebuildSnapshot(scope).equivalentToLiveProjection).toBe(true);
      firstStore.close();

      const first = createProductionComposition(compositionOptions(filename));
      const rest = await first.app.inject({
        method: "GET",
        url: `/api/v1/sessions/${scope.agentSessionId}/hierarchy?page=1&pageSize=200`,
        headers: { authorization: "Bearer public-v1" },
      });
      expect(rest.statusCode).toBe(200);
      const restPage = rest.json();
      const mcpPage = (await first.mcpApplication.invoke("get_agent_hierarchy", { limit: 200 })).structuredContent;
      expect(restPage).toEqual(mcpPage);
      expect(restPage.nodes).toHaveLength(8);
      expect(restPage.nodes.map((node: { agentId: string }) => node.agentId).every((id: string) => /^agent:[A-Za-z0-9_-]{8,80}$/u.test(id))).toBe(true);
      expect(restPage.nodes[0].displayName).toBe("Agent 01");
      expect(restPage.nodes.slice(1).map((node: { displayName: string }) => node.displayName)).toEqual([
        "planner A", "worker A", "reviewer A", "planner B", "worker B", "planner C", "worker C",
      ]);
      const agentId = restPage.nodes[0].agentId as string;
      const detailsRest = await first.app.inject({
        method: "GET",
        url: `/api/v1/sessions/${scope.agentSessionId}/agents/${encodeURIComponent(agentId)}`,
        headers: { authorization: "Bearer public-v1" },
      });
      const detailsMcp = (await first.mcpApplication.invoke("get_agent_details", { agentId })).structuredContent;
      expect(detailsRest.statusCode).toBe(200);
      expect(detailsRest.json()).toEqual(detailsMcp);
      const render = (await first.mcpApplication.invoke("render_agent_hierarchy", { mode: "fullscreen" })).structuredContent;
      expect(render.schemaVersion).toBe("agent-farm.public.v1");
      expect(render.nodes).toHaveLength(8);
      assertNoForbidden(restPage);
      assertNoForbidden(detailsMcp);
      assertNoForbidden(render);
      await first.close();

      const reopened = createProductionComposition(compositionOptions(filename));
      const restart = await reopened.app.inject({
        method: "GET",
        url: `/api/v1/sessions/${scope.agentSessionId}/hierarchy?page=1&pageSize=200`,
        headers: { authorization: "Bearer public-v1" },
      });
      expect(restart.statusCode).toBe(200);
      expect(restart.json()).toEqual(restPage);
      expect(reopened.store.rebuildSnapshot(scope).equivalentToLiveProjection).toBe(true);
      await reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("paginates 225 public agents with no duplicates and marks disconnected/error states safely", async () => {
    const store = new DurableStore();
    store.createAgentSession({ ...scope, sourceAdapter: "scale", idempotencyKey: "scale-public-v1" });
    store.agents.upsert(scope, { agentId: "root", role: "root", lifecycle: "active", isRoot: true, spawnOrdinal: 0, verificationState: "verified", name: "Root" });
    for (let index = 1; index < 225; index += 1) {
      const agentId = `agent-${index.toString().padStart(3, "0")}`;
      store.agents.upsert(scope, { agentId, role: "worker", lifecycle: index % 5 === 0 ? "completed" : "active", spawnOrdinal: index, verificationState: "verified", name: `Worker ${index}` });
      store.edges.add(scope, { parentAgentId: "root", childAgentId: agentId, spawnOrdinal: index });
    }
    const composition = createProductionComposition({
      durableStore: store,
      startRuntime: false,
      bridge: { runtimeConnectionState: () => "disconnected" as const },
      mcpAuthContextProvider: () => makeAuthContext({ ownerId: scope.ownerId, tenantId: scope.tenantId, scopes: ["agent-session:read"], agentSessionId: scope.agentSessionId }),
    });
    // Runtime connection state is scope-owned: a projection only receives the
    // bridge state when that durable session has an active binding.
    store.bridgeBindings.upsert(scope, {
      installationId: "scale-public-v1-installation",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: "scale-public-v1-root",
      credentialHash: "fixture-hash-only",
      expiresAt: Date.now() + 60_000,
    });
    const first = (await composition.mcpApplication.invoke("get_agent_hierarchy", { limit: 200 })).structuredContent;
    const second = (await composition.mcpApplication.invoke("get_agent_hierarchy", { limit: 200, cursor: "p_2" })).structuredContent;
    expect(first.snapshotState).toBe("disconnected");
    expect(first.nodes).toHaveLength(200);
    expect(second.nodes).toHaveLength(25);
    const ids = [...first.nodes, ...second.nodes].map((node: { agentId: string }) => node.agentId);
    expect(new Set(ids).size).toBe(225);
    expect(first.edges.length + second.edges.length).toBe(224);
    assertNoForbidden(first);
    assertNoForbidden(second);
    await composition.close();
  });
});
