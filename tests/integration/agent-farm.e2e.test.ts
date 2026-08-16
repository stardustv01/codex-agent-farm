import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentSessionSchema,
  CONTRACT_VERSION,
  canonicalCapabilities,
  projectEvents,
  projectionToSnapshot,
  sanitizeEvent,
  type AgentSession,
  type SanitizedEvent,
} from "../../packages/contracts/src/index.ts";
import {
  AGENT_FARM_SCOPES,
  createMcpApplication,
  makeAuthContext,
  type AgentFarmMcpBackend,
} from "../../packages/mcp/src/index.ts";
import {
  DurableStore,
  NotFoundError,
  type AppSession,
  type PrincipalScope,
} from "../../packages/store/src/index.ts";
import {
  createApp,
  type AgentDetails,
  type AgentSessionRecord,
  type AuthService,
  type CreateAgentSessionInput,
  type HierarchyPage,
  type RawTokenClaims,
  type SessionScope,
  type StorePort as ServerStorePort,
} from "../../apps/server/src/index.ts";
import { projectPublicHierarchy, publicAgentId } from "../../apps/server/src/public-hierarchy.ts";

const NOW = "2026-08-09T12:00:00.000Z";
const OWNER_A = "owner:alpha";
const TENANT_A = "tenant:one";
const SESSION_A = "session:alpha";
const OWNER_B = "owner:beta";
const TENANT_B = "tenant:two";
const SESSION_B = "session:beta";
const EPOCH_A = "epoch:alpha:1";
const EPOCH_RECONNECTED = "epoch:alpha:2";

type EventType = SanitizedEvent["type"];

function scope(tenantId: string, ownerId: string, agentSessionId: string): PrincipalScope {
  return { tenantId, ownerId, agentSessionId };
}

function createSession(store: DurableStore, value: PrincipalScope, sourceThreadId = `thread:${value.agentSessionId}`): AppSession {
  return store.sessions.create({
    ...value,
    sourceAdapter: "codex-app-server-v2",
    rootSourceThreadId: sourceThreadId,
    rootSourceSessionId: `source:${value.agentSessionId}`,
    capabilities: ["thread/list", "thread/read", "model/list"],
  });
}

function contractSession(value: PrincipalScope, epoch = EPOCH_A): AgentSession {
  return AgentSessionSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    agentSessionId: value.agentSessionId,
    status: "active",
    sourceAdapter: "codex-app-server-v2",
    selectedSourceRoot: `/selected/${value.agentSessionId}`,
    rootSourceThreadId: `thread:${value.agentSessionId}:root`,
    ownerId: value.ownerId,
    tenantId: value.tenantId,
    watermark: 0,
    connection: {
      schemaVersion: CONTRACT_VERSION,
      status: "connected",
      connectionEpoch: epoch,
      capabilities: {
        ...canonicalCapabilities,
        checkedAt: NOW,
      },
      lastIngestOrdinal: 0,
      verified: true,
      updatedAt: NOW,
    },
    capabilities: {
      ...canonicalCapabilities,
      checkedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function eventBase(
  value: PrincipalScope,
  eventId: string,
  ingestOrdinal: number,
  type: EventType,
  epoch = EPOCH_A,
): Pick<SanitizedEvent, "schemaVersion" | "eventId" | "agentSessionId" | "connectionEpoch" | "ingestOrdinal" | "observedAt" | "authority" | "idempotencyKey" | "type"> {
  return {
    schemaVersion: CONTRACT_VERSION,
    eventId,
    agentSessionId: value.agentSessionId,
    connectionEpoch: epoch,
    ingestOrdinal,
    observedAt: new Date(Date.parse(NOW) + ingestOrdinal * 1_000).toISOString(),
    authority: "live",
    idempotencyKey: `idempotency:${value.agentSessionId}:${eventId}`,
    type,
  } as Pick<SanitizedEvent, "schemaVersion" | "eventId" | "agentSessionId" | "connectionEpoch" | "ingestOrdinal" | "observedAt" | "authority" | "idempotencyKey" | "type">;
}

function canonicalDiracEvents(value: PrincipalScope): SanitizedEvent[] {
  const agents = [
    ["agent:dirac", "thread:dirac", "Dirac", "root", undefined, "active"],
    ["agent:rhea", "thread:rhea", "Rhea", "planner", "agent:dirac", "active"],
    ["agent:kuhn", "thread:kuhn", "Kuhn", "worker", "agent:rhea", "active"],
    ["agent:noether", "thread:noether", "Noether", "reviewer", "agent:kuhn", "completed"],
  ] as const;
  const events: SanitizedEvent[] = [];
  let ordinal = 1;
  for (const [agentId, sourceThreadId, nickname, role, parentAgentId, lifecycle] of agents) {
    events.push(
      sanitizeEvent({
        ...eventBase(value, `evt:${agentId}:upsert`, ordinal++, "agent.upsert"),
        agentId,
        sourceThreadId,
        sourceKind: agentId === "agent:dirac" ? "root" : "thread_spawn",
        role,
        nickname,
        ...(parentAgentId === undefined ? {} : { parentAgentId }),
        lifecycle,
      }),
    );
    if (parentAgentId !== undefined) {
      events.push(
        sanitizeEvent({
          ...eventBase(value, `evt:${agentId}:edge`, ordinal++, "edge.spawn"),
          edgeId: `edge:${parentAgentId}:${agentId}`,
          parentAgentId,
          childAgentId: agentId,
        }),
      );
    }
  }
  events.push(
    sanitizeEvent({
      ...eventBase(value, "evt:kuhn:identity-requested", ordinal++, "identity.requested"),
      agentId: "agent:kuhn",
      sourceThreadId: "thread:kuhn",
      values: { provider: "openai", model: "gpt-5.6-luna", effort: "max" },
      sourceOperationId: "collab:kuhn",
    }),
    sanitizeEvent({
      ...eventBase(value, "evt:kuhn:identity-observed", ordinal++, "identity.observed"),
      agentId: "agent:kuhn",
      sourceThreadId: "thread:kuhn",
      source: "thread.settings",
      values: { provider: "openai", model: "gpt-5.6-sol", effort: "high" },
    }),
    sanitizeEvent({
      ...eventBase(value, "evt:noether:identity-requested", ordinal++, "identity.requested"),
      agentId: "agent:noether",
      sourceThreadId: "thread:noether",
      values: { provider: "openai", model: "gpt-5.6-luna", effort: "max" },
      sourceOperationId: "collab:noether",
    }),
    sanitizeEvent({
      ...eventBase(value, "evt:noether:identity-observed", ordinal++, "identity.observed"),
      agentId: "agent:noether",
      sourceThreadId: "thread:noether",
      source: "thread.settings",
      values: { provider: "openai", model: "gpt-5.6-luna", effort: "max" },
    }),
  );
  return events;
}

function ingestContractEvent(store: DurableStore, value: PrincipalScope, event: SanitizedEvent): ReturnType<DurableStore["events"]["ingest"]> {
  return store.events.ingest(value, {
    eventKey: event.eventId,
    eventType: event.type,
    connectionEpoch: event.connectionEpoch,
    sourceAdapter: "codex-app-server-v2",
    sourceThreadId: "sourceThreadId" in event ? event.sourceThreadId : null,
    turnId: "turnId" in event ? event.turnId : null,
    authority: event.authority === "reconciliation" ? "reconciliation" : "notification",
    observedAt: Date.parse(event.observedAt),
    payload: event,
  });
}

class DurableServerStore implements ServerStorePort {
  constructor(private readonly store: DurableStore) {}

  ready(): boolean {
    return true;
  }

  async createAgentSession(input: CreateAgentSessionInput): Promise<AgentSessionRecord> {
    const session = this.store.sessions.create({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      agentSessionId: input.agentSessionId,
      idempotencyKey: input.idempotencyKey,
      requestPayload: input.payload,
      sourceAdapter: input.payload.sourceAdapter,
      capabilities: input.payload.capabilities,
    });
    return this.toSessionRecord(session);
  }

  async getAgentSession(value: SessionScope): Promise<AgentSessionRecord | null> {
    try {
      return this.toSessionRecord(this.store.sessions.get(value));
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async getHierarchy(value: SessionScope & { page: number; pageSize: number }): Promise<HierarchyPage | null> {
    const snapshot = this.readSnapshot(value);
    if (!snapshot) return null;
    return projectPublicHierarchy({
      snapshot,
      events: this.store.events.list(value),
      page: value.page,
      pageSize: value.pageSize,
      connectionState: "connected",
    }).page as unknown as HierarchyPage;
  }

  async getAgentDetails(value: SessionScope & { agentId: string }): Promise<AgentDetails | null> {
    const snapshot = this.readSnapshot(value);
    if (!snapshot) return null;
    return projectPublicHierarchy({
      snapshot,
      events: this.store.events.list(value),
      page: 1,
      pageSize: 200,
      connectionState: "connected",
    }).details(value.agentId) as unknown as AgentDetails | null;
  }

  private readSnapshot(value: SessionScope): ReturnType<DurableStore["getSnapshot"]> | null {
    try {
      return this.store.getSnapshot(value);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  private toSessionRecord(session: AppSession): AgentSessionRecord {
    return {
      agentSessionId: session.agentSessionId,
      ownerId: session.ownerId,
      tenantId: session.tenantId,
      status: session.status,
      sourceAdapter: session.sourceAdapter ?? undefined,
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
      watermark: session.watermarkIngestOrdinal,
      capabilities: session.capabilities,
    };
  }
}

function mcpBackend(store: DurableStore): AgentFarmMcpBackend {
  return {
    createAgentSession: ({ ownerId, tenantId, idempotencyKey, label }) => {
      const session = store.sessions.create({
        ownerId,
        tenantId,
        idempotencyKey,
        requestPayload: { label: label ?? null },
      });
      return {
        agentSessionId: session.agentSessionId,
        status: "created",
        createdAt: new Date(session.createdAt).toISOString(),
      };
    },
    getAgentHierarchy: ({ ownerId, tenantId, agentSessionId }) => {
      const adapter = new DurableServerStore(store);
      return adapter.getHierarchy({ ownerId, tenantId, agentSessionId, page: 1, pageSize: 200 });
    },
    getAgentDetails: ({ ownerId, tenantId, agentSessionId, agentId }) => {
      const adapter = new DurableServerStore(store);
      return adapter.getAgentDetails({ ownerId, tenantId, agentSessionId, agentId });
    },
    renderAgentHierarchy: ({ ownerId, tenantId, agentSessionId }) => {
      const adapter = new DurableServerStore(store);
      return adapter.getHierarchy({ ownerId, tenantId, agentSessionId, page: 1, pageSize: 200 });
    },
  };
}

function tokenAuth(tokens: Record<string, RawTokenClaims>): AuthService {
  return {
    authenticateToken: async (token) => tokens[token] ?? (() => { throw new Error("invalid token"); })(),
  };
}

function tokenClaims(ownerId: string, tenantId: string, sessionId?: string, scopes = [
  "agent-session:create",
  "agent-session:read",
  "agent-session:read-details",
  "agent-session:render",
]): RawTokenClaims {
  return {
    sub: ownerId,
    ownerId,
    tenantId,
    scope: scopes.join(" "),
    exp: Math.floor(Date.now() / 1000) + 3_600,
    ...(sessionId === undefined ? {} : { agentSessionId: sessionId }),
  };
}

test("contracts project the canonical recursive Dirac/Rhea/Kuhn/Noether tree and preserve identity mismatch", () => {
  const value = scope(TENANT_A, OWNER_A, SESSION_A);
  const events = canonicalDiracEvents(value);
  const projection = projectEvents(contractSession(value), events);
  const snapshot = projectionToSnapshot(projection, "snapshot:dirac");
  const byName = new Map(snapshot.agents.map((agent) => [agent.nickname, agent]));
  assert.equal(snapshot.agents.length, 4);
  assert.equal(snapshot.edges.filter((edge) => edge.state === "verified").length, 3);
  assert.equal(byName.get("Dirac")?.parentAgentId, undefined);
  assert.equal(byName.get("Rhea")?.parentAgentId, "agent:dirac");
  assert.equal(byName.get("Kuhn")?.parentAgentId, "agent:rhea");
  assert.equal(byName.get("Noether")?.parentAgentId, "agent:kuhn");
  assert.equal(byName.get("Kuhn")?.verification, "mismatch");
  assert.deepEqual(byName.get("Kuhn")?.requestedIdentity, { provider: "openai", model: "gpt-5.6-luna", effort: "max" });
  assert.deepEqual(byName.get("Kuhn")?.observedIdentity, { provider: "openai", model: "gpt-5.6-sol", effort: "high" });
  assert.equal(byName.get("Noether")?.verification, "verified");
});

test("DurableStore enforces owner/tenant/session isolation and keeps private source identity out of the public scope", () => {
  const store = new DurableStore();
  const first = scope(TENANT_A, OWNER_A, SESSION_A);
  const second = scope(TENANT_B, OWNER_B, SESSION_B);
  createSession(store, first);
  createSession(store, second);
  for (const event of canonicalDiracEvents(first).slice(0, 7)) ingestContractEvent(store, first, event);
  assert.equal(store.getSnapshot(first).agents.length, 4);
  assert.equal(store.getSnapshot(second).agents.length, 0);
  assert.throws(() => store.getSnapshot({ tenantId: TENANT_B, ownerId: OWNER_B, agentSessionId: SESSION_A }), NotFoundError);
  assert.throws(() => store.getSnapshot({ tenantId: TENANT_A, ownerId: OWNER_A, agentSessionId: SESSION_B }), NotFoundError);
  store.close();
});

test("DurableStore reconnect/replay is idempotent, conflicts quarantine, and rebuild is deterministic", () => {
  const store = new DurableStore();
  const value = scope(TENANT_A, OWNER_A, SESSION_A);
  createSession(store, value);
  const first = canonicalDiracEvents(value)[0]!;
  const inserted = ingestContractEvent(store, value, first);
  assert.equal(inserted.outcome, "inserted");
  const replay = ingestContractEvent(store, value, first);
  assert.equal(replay.outcome, "replayed");
  const reconnectEvent = sanitizeEvent({
    ...eventBase(value, "evt:dirac:reconnect", 2, "connection.state", EPOCH_RECONNECTED),
    status: "connected",
    capabilities: contractSession(value, EPOCH_RECONNECTED).capabilities,
  });
  const reconnected = ingestContractEvent(store, value, reconnectEvent);
  assert.equal(reconnected.outcome, "inserted");
  const conflict = store.events.ingest(value, {
    eventKey: first.eventId,
    eventType: first.type,
    connectionEpoch: EPOCH_RECONNECTED,
    payload: { ...first, nickname: "forged" },
  });
  assert.equal(conflict.outcome, "quarantined");
  assert.equal(store.events.list(value).length, 2);
  assert.equal(store.events.conflicts(value).length, 1);
  const rebuilt = store.rebuildSnapshot(value);
  assert.equal(rebuilt.rebuiltFromEventCount, 2);
  assert.equal(rebuilt.equivalentToLiveProjection, true);
  store.close();
});

test("MCP app is real, session-bound, and read-only: hierarchy/details/render work while control routes are absent", async () => {
  const store = new DurableStore();
  const value = scope(TENANT_A, OWNER_A, SESSION_A);
  createSession(store, value);
  for (const event of canonicalDiracEvents(value)) ingestContractEvent(store, value, event);
  const app = createMcpApplication({
    backend: mcpBackend(store),
    authContextProvider: () => makeAuthContext({
      ownerId: OWNER_A,
      tenantId: TENANT_A,
      scopes: Object.values(AGENT_FARM_SCOPES),
      agentSessionId: SESSION_A,
    }),
  });
  const hierarchy = await app.invoke("get_agent_hierarchy", {});
  assert.equal(hierarchy.structuredContent.agentSessionId, SESSION_A);
  assert.equal((hierarchy.structuredContent.counts as { total: number }).total, 4);
  const kuhnPublicId = publicAgentId("agent:kuhn");
  const details = await app.invoke("get_agent_details", { agentId: kuhnPublicId });
  assert.equal((details.structuredContent.agent as { agentId: string }).agentId, kuhnPublicId);
  const render = await app.invoke("render_agent_hierarchy", { mode: "fullscreen" });
  assert.equal(render.structuredContent.mode, "fullscreen");
  await assert.rejects(() => app.invoke("get_agent_hierarchy", { agentSessionId: SESSION_B }), /not authorized|session/i);
  assert.deepEqual(app.descriptors.map((descriptor) => descriptor.name), [
    "create_agent_session",
    "get_agent_hierarchy",
    "get_agent_details",
    "render_agent_hierarchy",
  ]);
  assert.equal(app.descriptors.some((descriptor) => /control|interrupt|steer|stop/iu.test(descriptor.name)), false);
  store.close();
});

test("Fastify server routes use authenticated owner/tenant scope, idempotency, and non-enumerating isolation", async () => {
  const store = new DurableStore();
  const first = scope(TENANT_A, OWNER_A, SESSION_A);
  const second = scope(TENANT_B, OWNER_B, SESSION_B);
  createSession(store, first);
  createSession(store, second);
  for (const event of canonicalDiracEvents(first)) ingestContractEvent(store, first, event);
  const app = createApp({
    store: new DurableServerStore(store),
    authService: tokenAuth({
      "token-a": tokenClaims(OWNER_A, TENANT_A),
      "token-b": tokenClaims(OWNER_B, TENANT_B),
    }),
  });
  await app.ready();
  const allowed = await app.inject({
    method: "GET",
    url: `/api/v1/sessions/${SESSION_A}/hierarchy?page=1&pageSize=20`,
    headers: { authorization: "Bearer token-a" },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal((allowed.json() as { nodes: unknown[] }).nodes.length, 4);
  const toolsList = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: "Bearer token-a" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(toolsList.statusCode, 200);
  assert.deepEqual(
    (toolsList.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name),
    ["create_agent_session", "get_agent_hierarchy", "get_agent_details", "render_agent_hierarchy"],
  );
  const controlCall = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: "Bearer token-a" },
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "interrupt_agent", arguments: { agentSessionId: SESSION_A } },
    },
  });
  assert.equal(controlCall.statusCode, 200);
  assert.equal((controlCall.json() as { error: { code: number } }).error.code, -32601);
  const forbidden = await app.inject({
    method: "GET",
    url: `/api/v1/sessions/${SESSION_A}/hierarchy`,
    headers: { authorization: "Bearer token-b" },
  });
  assert.equal(forbidden.statusCode, 404);
  const missingToken = await app.inject({ method: "GET", url: `/api/v1/sessions/${SESSION_A}/hierarchy` });
  assert.equal(missingToken.statusCode, 401);
  const duplicateCreate = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { authorization: "Bearer token-a", "idempotency-key": "integration-session-create" },
    payload: { label: "integration" },
  });
  assert.equal(duplicateCreate.statusCode, 201);
  const replayCreate = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { authorization: "Bearer token-a", "idempotency-key": "integration-session-create" },
    payload: { label: "integration" },
  });
  assert.equal(replayCreate.statusCode, 200);
  assert.equal((replayCreate.json() as { agentSessionId: string }).agentSessionId, (duplicateCreate.json() as { agentSessionId: string }).agentSessionId);
  const conflictCreate = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { authorization: "Bearer token-a", "idempotency-key": "integration-session-create" },
    payload: { label: "different" },
  });
  assert.equal(conflictCreate.statusCode, 409);
  await app.close();
  store.close();
});

test("DurableStore sustains 25 active plus 200 completed agents and maintains scoped counts", () => {
  const store = new DurableStore();
  const value = scope(TENANT_A, OWNER_A, SESSION_A);
  createSession(store, value);
  const root = sanitizeEvent({
    ...eventBase(value, "scale:root", 1, "agent.upsert"),
    agentId: "agent:dirac",
    sourceThreadId: "thread:dirac",
    sourceKind: "root",
    role: "root",
    nickname: "Dirac",
    lifecycle: "active",
  });
  ingestContractEvent(store, value, root);
  let ordinal = 2;
  // The root is one of the 25 active agents: 24 active children + root.
  for (let index = 0; index < 24; index += 1) {
    const agentId = `agent:active:${index.toString().padStart(2, "0")}`;
    ingestContractEvent(store, value, sanitizeEvent({
      ...eventBase(value, `scale:${agentId}`, ordinal++, "agent.upsert"),
      agentId,
      sourceThreadId: `thread:${agentId}`,
      sourceKind: "thread_spawn",
      role: "worker",
      nickname: `Active ${index + 1}`,
      parentAgentId: "agent:dirac",
      lifecycle: "active",
    }));
  }
  for (let index = 0; index < 200; index += 1) {
    const agentId = `agent:completed:${index.toString().padStart(3, "0")}`;
    ingestContractEvent(store, value, sanitizeEvent({
      ...eventBase(value, `scale:${agentId}`, ordinal++, "agent.upsert"),
      agentId,
      sourceThreadId: `thread:${agentId}`,
      sourceKind: "thread_spawn",
      role: "worker",
      nickname: `Completed ${index + 1}`,
      parentAgentId: "agent:dirac",
      lifecycle: "completed",
    }));
  }
  const snapshot = store.getSnapshot(value);
  assert.equal(snapshot.agents.length, 225);
  assert.equal(snapshot.agents.filter((agent) => agent.lifecycle === "active").length, 25);
  assert.equal(snapshot.agents.filter((agent) => agent.lifecycle === "completed").length, 200);
  assert.equal(snapshot.watermarkIngestOrdinal, 225);
  assert.equal(store.rebuildSnapshot(value).equivalentToLiveProjection, true);
  store.close();
});
