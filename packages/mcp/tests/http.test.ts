import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_FARM_MCP_TOOL_NAMES,
  createMcpApplication,
  createMcpHttpSessionManager,
  handleMcpHttpRequest,
  type McpAuthInfo,
  type McpGrantSessionBindingKey,
  type McpGrantSessionBindingRecord,
  type McpGrantSessionBindingRequest,
  type McpGrantSessionBindingStore,
  type McpHttpSessionManager,
  type McpHttpSessionManagerOptions,
} from "../src/index.js";

type Token = "token-a" | "token-a-refresh" | "token-a-alt" | "token-b";

function makeAuth(token: Token): McpAuthInfo {
  const samePrincipal = token !== "token-b";
  const owner = samePrincipal ? "owner-a" : "owner-b";
  const tenant = samePrincipal ? "tenant-a" : "tenant-b";
  return {
    token,
    clientId: owner,
    scopes: [
      "agent-session:create",
      "agent-session:read",
      "agent-session:read-details",
      "agent-session:render",
    ],
    resource: new URL("https://agent-farm.local"),
    extra: {
      ownerId: owner,
      tenantId: tenant,
      sub: owner,
      sid: token === "token-a-alt" ? "grant-a-alt" : samePrincipal ? "grant-a" : "grant-b",
      jti: token,
    },
  };
}

class FakeGrantSessionBindingStore implements McpGrantSessionBindingStore {
  readonly records = new Map<string, McpGrantSessionBindingRecord>();
  now = Date.now;

  getOrCreate(input: McpGrantSessionBindingRequest): McpGrantSessionBindingRecord | null {
    const key = this.key(input);
    const previous = this.records.get(key);
    if (previous !== undefined) {
      if (previous.status !== "active" || previous.expiresAt <= this.now()) return null;
      return previous;
    }
    const record: McpGrantSessionBindingRecord = {
      agentSessionId: input.proposedAgentSessionId,
      status: "active",
      expiresAt: input.expiresAt ?? this.now() + 60 * 60 * 1_000,
    };
    this.records.set(key, record);
    return record;
  }

  get(input: McpGrantSessionBindingKey): McpGrantSessionBindingRecord | null {
    const record = this.records.get(this.key(input));
    if (record === undefined || record.status !== "active" || record.expiresAt <= this.now()) return null;
    return record;
  }

  revoke(input: McpGrantSessionBindingKey): void {
    const key = this.key(input);
    const record = this.records.get(key);
    if (record !== undefined) this.records.set(key, { ...record, status: "revoked" });
  }

  private key(input: McpGrantSessionBindingKey): string {
    return [input.ownerId, input.tenantId, input.subject, input.resource, input.grantId].join("\u001f");
  }
}

function makeApplication() {
  const createdSessions = new Set<string>();
  return createMcpApplication({
    backend: {
      createAgentSession: (request) => {
        createdSessions.add(request.agentSessionId);
        return {
          agentSessionId: request.agentSessionId,
          status: "ready",
          createdAt: new Date(0).toISOString(),
        };
      },
      getAgentHierarchy: (request) => {
        if (!createdSessions.has(request.agentSessionId)) throw new Error("session is not provisioned");
        return {
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
        };
      },
      getAgentDetails: (request) => {
        if (!createdSessions.has(request.agentSessionId)) throw new Error("session is not provisioned");
        const agent = {
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
        };
        return {
          schemaVersion: "agent-farm.public.v1",
          agentSessionId: request.agentSessionId,
          connection: { state: "connected" },
          agent,
          parent: null,
          children: [],
          storyMilestones: [],
        };
      },
    },
  });
}

const servers = new Set<ReturnType<typeof createServer>>();
const managers = new Set<McpHttpSessionManager>();

afterEach(async () => {
  for (const manager of managers) await manager.cleanup();
  managers.clear();
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.clear();
});

async function start(options: {
  readonly managerOptions?: Omit<McpHttpSessionManagerOptions, "applicationFactory">;
  readonly auth?: (token: Token) => McpAuthInfo;
} = {}): Promise<{ readonly port: number; readonly manager: McpHttpSessionManager }> {
  const manager = createMcpHttpSessionManager({
    applicationFactory: makeApplication,
    ...(options.managerOptions ?? {}),
  });
  managers.add(manager);
  const auth = options.auth ?? makeAuth;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const withAuth = request as IncomingMessage & { auth?: McpAuthInfo };
    if (request.headers.authorization !== undefined) {
      const token = request.headers.authorization === "Bearer token-a-refresh"
        ? "token-a-refresh"
        : request.headers.authorization === "Bearer token-a-alt"
          ? "token-a-alt"
          : request.headers.authorization === "Bearer token-b" ? "token-b" : "token-a";
      withAuth.auth = auth(token);
    }
    await handleMcpHttpRequest(withAuth, response, undefined, { sessionManager: manager, enableJsonResponse: true });
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return { port: address.port, manager };
}

async function http(
  port: number,
  method: "GET" | "POST" | "DELETE",
  body: unknown,
  options: { readonly token?: Token; readonly sessionId?: string; readonly accept?: string; readonly omitAuth?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: options.accept ?? "application/json, text/event-stream",
  };
  if (!options.omitAuth) headers.authorization = `Bearer ${options.token ?? "token-a"}`;
  if (method === "POST") headers["content-type"] = "application/json";
  if (options.sessionId !== undefined) headers["mcp-session-id"] = options.sessionId;
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function initialize(port: number, token: Token = "token-a") {
  const response = await http(port, "POST", {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }, { token });
  return { response, body: await response.json() as any, sessionId: response.headers.get("mcp-session-id") as string };
}

describe("MCP stateful Streamable HTTP adapter", () => {
  it("initializes a stateful transport and preserves exactly four tools", async () => {
    const { port } = await start();
    const init = await initialize(port);
    expect(init.response.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("agent-farm");
    expect(init.sessionId).toEqual(expect.any(String));
    const list = await http(port, "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, { sessionId: init.sessionId });
    expect(list.status).toBe(200);
    expect((await list.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(AGENT_FARM_MCP_TOOL_NAMES);
  });

  it("carries the manager-generated Agent Farm session from create to hierarchy", async () => {
    const { port } = await start();
    const init = await initialize(port);
    const beforeCreate = await http(port, "POST", {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "get_agent_hierarchy", arguments: {} },
    }, { sessionId: init.sessionId });
    expect(beforeCreate.status).toBe(200);
    const beforeBody = await beforeCreate.json() as any;
    expect(beforeBody.result?.structuredContent?.agentSessionId).toBeUndefined();
    const create = await http(port, "POST", {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "create_agent_session", arguments: { idempotencyKey: "key-a" } },
    }, { sessionId: init.sessionId });
    expect(create.status).toBe(200);
    const created = (await create.json()).result.structuredContent.agentSessionId as string;
    const hierarchy = await http(port, "POST", {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "get_agent_hierarchy", arguments: {} },
    }, { sessionId: init.sessionId });
    expect(hierarchy.status).toBe(200);
    expect((await hierarchy.json()).result.structuredContent.agentSessionId).toBe(created);
    const render = await http(port, "POST", {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "render_agent_hierarchy", arguments: { mode: "inline" } },
    }, { sessionId: init.sessionId });
    expect(render.status).toBe(200);
    expect((await render.json()).result.structuredContent.agentSessionId).toBe(created);
  });

  it("isolates two simultaneous sessions for same-owner distinct OAuth grants", async () => {
    const { port } = await start();
    const [one, two] = await Promise.all([initialize(port, "token-a"), initialize(port, "token-a-alt")]);
    expect(one.sessionId).not.toBe(two.sessionId);
    const [first, second] = await Promise.all([
      http(port, "POST", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_agent_session", arguments: { idempotencyKey: "same" } } }, { sessionId: one.sessionId }),
      http(port, "POST", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "create_agent_session", arguments: { idempotencyKey: "same" } } }, { sessionId: two.sessionId, token: "token-a-alt" }),
    ]);
    expect((await first.json()).result.structuredContent.agentSessionId).not.toBe((await second.json()).result.structuredContent.agentSessionId);
  });

  it("isolates simultaneous independent principals and keeps cross-principal IDs non-enumerating", async () => {
    const { port } = await start();
    const [ownerA, ownerB] = await Promise.all([
      initialize(port, "token-a"),
      initialize(port, "token-b"),
    ]);
    expect(ownerA.sessionId).not.toBe(ownerB.sessionId);

    const [createdA, createdB] = await Promise.all([
      http(port, "POST", {
        jsonrpc: "2.0", id: 41, method: "tools/call",
        params: { name: "create_agent_session", arguments: { idempotencyKey: "principal-a" } },
      }, { sessionId: ownerA.sessionId, token: "token-a" }),
      http(port, "POST", {
        jsonrpc: "2.0", id: 42, method: "tools/call",
        params: { name: "create_agent_session", arguments: { idempotencyKey: "principal-b" } },
      }, { sessionId: ownerB.sessionId, token: "token-b" }),
    ]);
    expect(createdA.status).toBe(200);
    expect(createdB.status).toBe(200);
    const [createdBodyA, createdBodyB] = await Promise.all([createdA.json(), createdB.json()]) as any[];
    const agentSessionA = createdBodyA.result.structuredContent.agentSessionId as string;
    const agentSessionB = createdBodyB.result.structuredContent.agentSessionId as string;
    expect(agentSessionA).not.toBe(agentSessionB);

    const [crossA, crossB, unknownA, unknownB] = await Promise.all([
      http(port, "POST", { jsonrpc: "2.0", id: 43, method: "tools/list" }, {
        sessionId: ownerA.sessionId, token: "token-b",
      }),
      http(port, "POST", { jsonrpc: "2.0", id: 44, method: "tools/list" }, {
        sessionId: ownerB.sessionId, token: "token-a",
      }),
      http(port, "POST", { jsonrpc: "2.0", id: 45, method: "tools/list" }, {
        sessionId: "opaque-unknown-a", token: "token-a",
      }),
      http(port, "POST", { jsonrpc: "2.0", id: 46, method: "tools/list" }, {
        sessionId: "opaque-unknown-b", token: "token-b",
      }),
    ]);
    expect(crossA.status).toBe(404);
    expect(crossB.status).toBe(404);
    expect(unknownA.status).toBe(404);
    expect(unknownB.status).toBe(404);
    const [crossBodyA, crossBodyB, unknownBodyA, unknownBodyB] = await Promise.all([
      crossA.text(),
      crossB.text(),
      unknownA.text(),
      unknownB.text(),
    ]);
    expect(crossBodyA).toBe(crossBodyB);
    expect(crossBodyA).toBe(unknownBodyA);
    expect(unknownBodyA).toBe(unknownBodyB);
    expect(crossBodyA).not.toContain(agentSessionA);
    expect(crossBodyA).not.toContain(agentSessionB);
  });

  it("reuses one durable Agent Farm session for simultaneous remounts and rotated jti", async () => {
    const bindingStore = new FakeGrantSessionBindingStore();
    const first = await start({ managerOptions: { grantSessionBindingStore: bindingStore } });
    const [one, two] = await Promise.all([
      initialize(first.port, "token-a"),
      initialize(first.port, "token-a-refresh"),
    ]);
    expect(one.sessionId).not.toBe(two.sessionId);
    const create = async (sessionId: string, id: number) => http(first.port, "POST", {
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "create_agent_session", arguments: { idempotencyKey: `grant-${id}` } },
    }, { sessionId });
    const firstCreate = await create(one.sessionId, 20);
    const secondCreate = await create(two.sessionId, 21);
    expect(firstCreate.status).toBe(200);
    expect(secondCreate.status).toBe(200);
    const firstAgentSession = (await firstCreate.json()).result.structuredContent.agentSessionId;
    const secondAgentSession = (await secondCreate.json()).result.structuredContent.agentSessionId;
    expect(secondAgentSession).toBe(firstAgentSession);

    await first.manager.cleanup();
    const second = await start({ managerOptions: { grantSessionBindingStore: bindingStore } });
    const remount = await initialize(second.port, "token-a-refresh");
    const replay = await http(second.port, "POST", {
      jsonrpc: "2.0", id: 22, method: "tools/call",
      params: { name: "create_agent_session", arguments: { idempotencyKey: "grant-20" } },
    }, { sessionId: remount.sessionId });
    expect(replay.status).toBe(200);
    expect((await replay.json()).result.structuredContent.agentSessionId).toBe(firstAgentSession);
  });

  it("keeps grants non-enumerable and fails closed after revocation or expiry", async () => {
    let now = 10_000;
    const bindingStore = new FakeGrantSessionBindingStore();
    bindingStore.now = () => now;
    const { port } = await start({ managerOptions: { grantSessionBindingStore: bindingStore } });
    const init = await initialize(port, "token-a");
    const missingGrant = await http(port, "POST", { jsonrpc: "2.0", id: 30, method: "tools/list" }, {
      token: "token-a-alt", sessionId: init.sessionId,
    });
    expect(missingGrant.status).toBe(404);
    bindingStore.revoke({ ownerId: "owner-a", tenantId: "tenant-a", subject: "owner-a", resource: "https://agent-farm.local/", grantId: "grant-a" });
    const revoked = await http(port, "POST", { jsonrpc: "2.0", id: 31, method: "tools/list" }, { sessionId: init.sessionId });
    expect(revoked.status).toBe(404);

    const second = await initialize(port, "token-a-alt");
    now += 60 * 60 * 1_000 + 1;
    const expired = await http(port, "POST", { jsonrpc: "2.0", id: 32, method: "tools/list" }, { sessionId: second.sessionId, token: "token-a-alt" });
    expect(expired.status).toBe(404);
  });

  it("allows a verified refresh jti for the same principal but rejects another owner", async () => {
    const { port } = await start();
    const init = await initialize(port);
    const refresh = await http(port, "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, { token: "token-a-refresh", sessionId: init.sessionId });
    expect(refresh.status).toBe(200);
    const cross = await http(port, "POST", { jsonrpc: "2.0", id: 3, method: "tools/list" }, { token: "token-b", sessionId: init.sessionId });
    expect(cross.status).toBe(404);
  });

  it("rejects a second OAuth grant for the same owner and tenant", async () => {
    const { port } = await start();
    const init = await initialize(port, "token-a");
    const secondGrant = await http(port, "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, {
      token: "token-a-alt", sessionId: init.sessionId,
    });
    expect(secondGrant.status).toBe(404);
  });

  it("rejects cross-token/unknown reuse without enumeration", async () => {
    const { port } = await start();
    const init = await initialize(port);
    const cross = await http(port, "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, { token: "token-b", sessionId: init.sessionId });
    const unknown = await http(port, "POST", { jsonrpc: "2.0", id: 3, method: "tools/list" }, { sessionId: "opaque-unknown" });
    expect(cross.status).toBe(404);
    expect(unknown.status).toBe(404);
    const crossBody = await cross.text();
    const unknownBody = await unknown.text();
    expect(crossBody).toBe(unknownBody);
    const missing = await http(port, "POST", { jsonrpc: "2.0", id: 4, method: "tools/list" }, {
      sessionId: init.sessionId, omitAuth: true,
    });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(unknownBody);
  });

  it("closes/removes a session on DELETE", async () => {
    const { port } = await start();
    const init = await initialize(port);
    expect((await http(port, "DELETE", undefined, { sessionId: init.sessionId })).status).toBe(200);
    expect((await http(port, "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, { sessionId: init.sessionId })).status).toBe(404);
  });

  it("expires idle sessions and evicts oldest at the bound", async () => {
    let now = 1_000;
    const { port } = await start({ managerOptions: { sessionTtlMs: 100, maxSessions: 1, now: () => now } });
    const first = await initialize(port);
    now += 10;
    const second = await initialize(port);
    expect((await http(port, "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, { sessionId: first.sessionId })).status).toBe(404);
    now += 100;
    expect((await http(port, "POST", { jsonrpc: "2.0", id: 3, method: "tools/list" }, { sessionId: second.sessionId })).status).toBe(404);
  });

  it("canonicalizes equivalent resource URLs", async () => {
    let calls = 0;
    const { port } = await start({ auth: (token) => {
      calls += 1;
      return { ...makeAuth(token), resource: calls === 1 ? new URL("https://AGENT-FARM.local/#hash") : new URL("https://agent-farm.local/") };
    } });
    const init = await initialize(port);
    expect((await http(port, "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, { sessionId: init.sessionId })).status).toBe(200);
  });

  it("delegates GET negotiation to the SDK after binding", async () => {
    const { port } = await start();
    const init = await initialize(port);
    expect((await http(port, "GET", undefined, { sessionId: init.sessionId, accept: "application/json" })).status).toBe(406);
  });
});
