import { describe, expect, it } from "vitest";
import {
  AGENT_FARM_SCOPES,
  AGENT_HIERARCHY_RESOURCE_URI,
  AuthorizationError,
  createMcpApplication,
  getToolDescriptors,
  makeAuthContext,
} from "../src/index.js";
import type { AgentFarmMcpBackend } from "../src/types.js";

const context = makeAuthContext({
  ownerId: "owner-a",
  tenantId: "tenant-a",
  scopes: Object.values(AGENT_FARM_SCOPES),
  agentSessionId: "session-a",
});

const rootId = `agent:${"a".repeat(40)}`;
const childId = `agent:${"b".repeat(40)}`;
const publicNode = (agentId: string, parentAgentId: string | null, displayName: string, lifecycle: "active" | "completed") => ({
  schemaVersion: "agent-farm.public.v1" as const,
  agentId,
  parentAgentId,
  childIds: agentId === rootId ? [childId] : [],
  displayName,
  role: parentAgentId === null ? "root" as const : "worker" as const,
  lifecycle,
  taskState: { lifecycle, activityLabel: lifecycle === "active" ? "working" as const : "returned" as const },
  identity: { requested: null, observed: null, verification: "unverified" as const },
  directChildCount: agentId === rootId ? 1 : 0,
  descendantCount: agentId === rootId ? 1 : 0,
  cluster: { state: lifecycle },
});

const hierarchy = () => ({
  schemaVersion: "agent-farm.public.v1" as const,
  agentSessionId: "session-a",
  watermark: 7,
  generatedAt: "2026-08-09T00:00:00.000Z",
  snapshotState: "complete" as const,
  connection: { state: "connected" as const },
  rootAgentId: rootId,
  nodes: [publicNode(rootId, null, "Root", "active"), publicNode(childId, rootId, "Child", "completed")],
  edges: [{
    schemaVersion: "agent-farm.public.v1" as const,
    edgeId: `edge:${"c".repeat(40)}`,
    parentAgentId: rootId,
    childAgentId: childId,
    state: "verified" as const,
  }],
  total: 2,
  page: 1,
  pageSize: 200,
  hasMore: false,
  nextCursor: null,
  counts: { total: 2, active: 1, completed: 1, failed: 0, disconnected: 0, unverified: 2 },
  storyMilestones: [],
});

function backend(overrides: Partial<AgentFarmMcpBackend> = {}): AgentFarmMcpBackend {
  return {
    createAgentSession: () => ({
      agentSessionId: "session-a",
      status: "created",
      createdAt: "2026-08-09T00:00:00.000Z",
    }),
    getAgentHierarchy: hierarchy,
    getAgentDetails: () => ({
      schemaVersion: "agent-farm.public.v1",
      agentSessionId: "session-a",
      connection: { state: "connected" },
      agent: publicNode(rootId, null, "Root", "active"),
      parent: null,
      children: [],
      storyMilestones: [],
    }),
    ...overrides,
  };
}

describe("MCP application contract", () => {
  it("publishes exactly the four V1 descriptors with per-tool scopes", () => {
    const descriptors = getToolDescriptors();
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      "create_agent_session",
      "get_agent_hierarchy",
      "get_agent_details",
      "render_agent_hierarchy",
    ]);
    expect(descriptors[0]?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const descriptor of descriptors) {
      expect(descriptor._meta.securitySchemes).toEqual([
        { type: "oauth2", scopes: [descriptor.scope] },
      ]);
    }
    expect(descriptors.find((descriptor) => descriptor.name === "render_agent_hierarchy")?._meta).toMatchObject({
      ui: { resourceUri: AGENT_HIERARCHY_RESOURCE_URI },
    });
    expect(descriptors.filter((descriptor) => descriptor._meta.ui !== undefined)).toHaveLength(1);
  });

  it("does not discover an unregistered control route", () => {
    const names = getToolDescriptors().map((descriptor) => descriptor.name);
    expect(names).not.toContain(["control", "agent"].join("_"));
  });

  it("derives owner and session from verified context, rejecting forged body selectors", async () => {
    const calls: unknown[] = [];
    const app = createMcpApplication({
      backend: backend({
        getAgentHierarchy: (request) => {
          calls.push(request);
          return backend().getAgentHierarchy(request);
        },
      }),
      authContextProvider: () => context,
    });

    await expect(
      app.invoke("get_agent_hierarchy", {
        agentSessionId: "session-forged",
        ownerId: "owner-forged",
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);

    await app.invoke("get_agent_hierarchy", { agentSessionId: "session-a" });
    expect(calls[0]).toMatchObject({
      ownerId: "owner-a",
      tenantId: "tenant-a",
      agentSessionId: "session-a",
    });
  });

  it("denies a tool when the per-tool OAuth scope is absent", async () => {
    const app = createMcpApplication({
      backend: backend(),
      authContextProvider: () =>
        makeAuthContext({
          ownerId: "owner-a",
          tenantId: "tenant-a",
          scopes: [AGENT_FARM_SCOPES.read],
          agentSessionId: "session-a",
        }),
    });
    await expect(app.invoke("get_agent_details", { agentId: rootId })).rejects.toMatchObject<AuthorizationError>({
      code: "insufficient_scope",
      requiredScopes: [AGENT_FARM_SCOPES.readDetails],
    });
  });

  it("rejects legacy hierarchy shapes and raw detail selectors instead of remapping them", async () => {
    const app = createMcpApplication({
      backend: backend({ getAgentHierarchy: () => ({ agentSessionId: "session-a", agents: [{ id: "private-root" }] }) }),
      authContextProvider: () => context,
    });
    await expect(app.invoke("get_agent_hierarchy", {})).rejects.toBeInstanceOf(Error);
    await expect(app.invoke("get_agent_details", { agentId: "private-root" })).rejects.toBeInstanceOf(Error);
  });

  it("exposes bounded inline summary and fullscreen presentation metadata", async () => {
    const app = createMcpApplication({
      backend: backend(),
      authContextProvider: () => context,
    });
    const inline = await app.invoke("render_agent_hierarchy", { mode: "inline" });
    expect(inline.structuredContent.mode).toBe("inline");
    expect(inline._meta).toMatchObject({
      ui: {
        resourceUri: AGENT_HIERARCHY_RESOURCE_URI,
        mode: "inline",
        presentationMode: "inline-summary",
        supportsFullscreen: true,
      },
    });
    const fullscreen = await app.invoke("render_agent_hierarchy", { mode: "fullscreen" });
    expect(fullscreen.structuredContent.mode).toBe("fullscreen");
    expect(fullscreen._meta).toMatchObject({
      ui: { mode: "fullscreen", presentationMode: "fullscreen-tree" },
    });
  });

  it("keeps create idempotent and rejects same-key payload conflicts", async () => {
    let creates = 0;
    const app = createMcpApplication({
      backend: backend({
        createAgentSession: () => {
          creates += 1;
          return {
            agentSessionId: "session-a",
            status: "created",
            createdAt: "2026-08-09T00:00:00.000Z",
          };
        },
      }),
      authContextProvider: () => context,
    });
    await app.invoke("create_agent_session", { idempotencyKey: "same-key", label: "A" });
    await app.invoke("create_agent_session", { idempotencyKey: "same-key", label: "A" });
    expect(creates).toBe(1);
    await expect(
      app.invoke("create_agent_session", { idempotencyKey: "same-key", label: "B" }),
    ).rejects.toThrow(/Idempotency key/iu);
  });
});
