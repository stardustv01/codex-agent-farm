import { afterEach, describe, expect, it } from "vitest";

import { createMcpApplication } from "@agent-farm/mcp";

import { createApp, type RawTokenClaims } from "../src/index.js";

const future = Math.floor(Date.now() / 1_000) + 3_600;
const tokenClaims: RawTokenClaims = {
  sub: "owner-a",
  ownerId: "owner-a",
  tenantId: "tenant-a",
  scope: "agent-session:create agent-session:read agent-session:read-details agent-session:render",
  exp: future,
  aud: "agent-farm",
  resource: "https://agent-farm.local",
  sid: "grant-a",
  jti: "token-a",
};

const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

function appForMcp() {
  const app = createApp({
    auth: {
      audience: "agent-farm",
      resource: "https://agent-farm.local",
      verifyToken: () => tokenClaims,
    },
    mcpApplicationFactory: () =>
      createMcpApplication({
        expectedResource: "https://agent-farm.local",
        backend: {
          createAgentSession: (request) => ({
            agentSessionId: request.agentSessionId,
            status: "ready",
            createdAt: new Date(0).toISOString(),
          }),
          getAgentHierarchy: (request) => ({
            schemaVersion: "agent-farm.public.v1",
            agentSessionId: request.agentSessionId,
            watermark: 0,
            generatedAt: new Date(0).toISOString(),
            snapshotState: "complete",
            connection: { state: "connected" },
            rootAgentId: null,
            nodes: [],
            edges: [],
            total: 0,
            page: 1,
            pageSize: 200,
            hasMore: false,
            nextCursor: null,
            counts: { total: 0, active: 0, completed: 0, failed: 0, disconnected: 0, unverified: 0 },
            storyMilestones: [],
          }),
          getAgentDetails: (request) => ({
            schemaVersion: "agent-farm.public.v1",
            agentSessionId: request.agentSessionId,
            connection: { state: "connected" },
            agent: {
              schemaVersion: "agent-farm.public.v1",
              agentId: request.agentId,
              parentAgentId: null,
              childIds: [],
              displayName: "Agent A",
              role: "root",
              lifecycle: "idle",
              taskState: { lifecycle: "idle", activityLabel: "unverified" },
              identity: { requested: null, observed: null, verification: "unverified" },
              directChildCount: 0,
              descendantCount: 0,
              cluster: { state: "active" },
            },
            parent: null,
            children: [],
            storyMilestones: [],
          }),
        },
      }),
  });
  apps.push(app);
  return app;
}

async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function post(url: string, body: unknown, sessionId?: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify(body),
  });
}

describe("real MCP stateful Streamable HTTP route", () => {
  it("initializes one official SDK application and exposes exactly four tools", async () => {
    const url = await listen(appForMcp());
    const initialize = await post(url, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(initialize.status).toBe(200);
    expect((await initialize.json()).result.serverInfo.name).toBe("agent-farm");
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toEqual(expect.any(String));
    const list = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId as string);
    expect(list.status).toBe(200);
    expect((await list.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "create_agent_session", "get_agent_hierarchy", "get_agent_details", "render_agent_hierarchy",
    ]);
  });

  it("passes verified identity and manager-generated session through tool execution", async () => {
    const url = await listen(appForMcp());
    const initialize = await post(url, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    const sessionId = initialize.headers.get("mcp-session-id") as string;
    const create = await post(url, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "create_agent_session", arguments: { idempotencyKey: "key-a" } },
    }, sessionId);
    expect(create.status).toBe(200);
    const created = (await create.json()).result.structuredContent.agentSessionId as string;
    const hierarchy = await post(url, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "get_agent_hierarchy", arguments: {} },
    }, sessionId);
    expect((await hierarchy.json()).result.structuredContent.agentSessionId).toBe(created);
  });

  it("uses SDK GET/DELETE behavior with the bound MCP session", async () => {
    const url = await listen(appForMcp());
    const initialize = await post(url, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    const sessionId = initialize.headers.get("mcp-session-id") as string;
    const get = await fetch(url, { headers: { authorization: "Bearer test-token", accept: "application/json", "mcp-session-id": sessionId } });
    expect(get.status).toBe(406);
    const del = await fetch(url, { method: "DELETE", headers: { authorization: "Bearer test-token", "mcp-session-id": sessionId } });
    expect(del.status).toBe(200);
    const after = await post(url, { jsonrpc: "2.0", id: 4, method: "tools/list" }, sessionId);
    expect(after.status).toBe(404);
  });
});
