import { EventEmitter } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  AppServerClient,
  InMemoryStdioTransport,
  generateStableSchemaBundle,
} from "@agent-farm/codex-bridge";
import { DurableStore } from "@agent-farm/store";

import { createProductionComposition } from "../src/composition.js";
import type { RawTokenClaims } from "../src/contracts.js";

const RESOURCE = "https://agent-farm.local";
const RESOURCE_KEY = `${RESOURCE}/`;
const INSTALLATION_ID = "production-entrypoint-installation";
const EPOCH = "production-entrypoint-epoch";

const compositions: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (compositions.length > 0) await compositions.pop()?.close();
});

function fakeProcess(): ChildProcessWithoutNullStreams & { readonly killCount: number } {
  const process = new EventEmitter() as EventEmitter &
    ChildProcessWithoutNullStreams & { killCount: number };
  let kills = 0;
  Object.defineProperty(process, "exitCode", { value: null, writable: true, configurable: true });
  Object.defineProperty(process, "killed", { get: () => kills > 0 });
  Object.defineProperty(process, "killCount", { get: () => kills });
  (process as EventEmitter & { kill: () => boolean }).kill = () => {
    kills += 1;
    return true;
  };
  return process;
}

function claimsFor(token: string): RawTokenClaims {
  return {
    sub: "owner-entrypoint",
    ownerId: "owner-entrypoint",
    tenantId: "tenant-entrypoint",
    scope: [
      "agent-session:create",
      "agent-session:read",
      "agent-session:read-details",
      "agent-session:render",
      "bridge:pair",
    ].join(" "),
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    aud: "agent-farm",
    resource: RESOURCE,
    sid: "grant-entrypoint",
    // Refresh rotates jti; the durable MCP mapping must remain grant-bound.
    jti: token === "mcp-refresh-token" ? "jti-entrypoint-2" : "jti-entrypoint-1",
  };
}

async function mcpPost(
  app: ReturnType<typeof createProductionComposition>["app"],
  token: string,
  body: Record<string, unknown>,
  sessionId?: string,
) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    payload: body,
  });
}

describe("production composition entrypoint", () => {
  it("proves one gated runtime through signed pairing, HTTP/MCP projections, and revocation", async () => {
    const durable = new DurableStore(":memory:");
    const scope = {
      tenantId: "tenant-entrypoint",
      ownerId: "owner-entrypoint",
      agentSessionId: "session-entrypoint",
    } as const;
    const otherScope = {
      tenantId: "tenant-private",
      ownerId: "owner-private",
      agentSessionId: "session-private",
    } as const;
    durable.createAgentSession({
      ...scope,
      sourceAdapter: "codex-app-server",
      idempotencyKey: "entrypoint-session",
    });
    durable.createAgentSession({
      ...otherScope,
      sourceAdapter: "fixture-private",
      idempotencyKey: "private-session",
    });
    durable.agents.upsert({
      ...otherScope,
      agentId: "private-agent",
      name: "Private agent must not leak",
      role: "private",
      lifecycle: "active",
      verificationState: "unverified",
      isRoot: true,
    });

    const grantBinding = durable.mcpGrantBindings.getOrCreate({
      ownerId: scope.ownerId,
      tenantId: scope.tenantId,
      subject: scope.ownerId,
      resource: RESOURCE_KEY,
      grantId: "grant-entrypoint",
      proposedAgentSessionId: scope.agentSessionId,
      expiresAt: Date.now() + 60 * 60 * 1_000,
    });
    expect(grantBinding?.agentSessionId).toBe(scope.agentSessionId);

    const schema = generateStableSchemaBundle();
    const adapter = {
      adapterVersion: "production-entrypoint-fixture-v1",
      binarySha256: "production-entrypoint-binary",
      schemaBundleSha256: schema.sha256,
      userAgentPrefix: "Codex Desktop/0.145.0",
    } as const;
    const process = fakeProcess();
    let transport!: InMemoryStdioTransport;
    let spawnCount = 0;
    let transportCount = 0;
    let clientCount = 0;
    let initializeCount = 0;

    const threads = [
      {
        id: "root-thread",
        sessionId: "codex-entrypoint-session",
        status: "active",
        role: "root",
        modelProvider: "openai",
        // This field is deliberately not in the bridge's sanitized surface.
        prompt: "PRIVATE_PROMPT_MUST_NEVER_LEAK",
      },
      {
        id: "child-thread",
        sessionId: "codex-entrypoint-session",
        parentThreadId: "root-thread",
        status: "completed",
        role: "worker",
        modelProvider: "openai",
        privatePrompt: "PRIVATE_CHILD_PROMPT_MUST_NEVER_LEAK",
      },
    ];
    transport = new InMemoryStdioTransport({
      onSend: async (line) => {
        const request = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: { threadId?: string };
        };
        if (request.method === "initialize") {
          initializeCount += 1;
          await transport.pushLine(JSON.stringify({
            id: request.id,
            result: { userAgent: "Codex Desktop/0.145.0 (production-entrypoint fixture)" },
          }));
          return;
        }
        if (request.method === "thread/list") {
          await transport.pushLine(JSON.stringify({ id: request.id, result: { data: threads } }));
          return;
        }
        if (request.method === "thread/read") {
          const threadId = request.params?.threadId ?? "root-thread";
          const thread = threads.find((candidate) => candidate.id === threadId);
          if (thread === undefined) {
            await transport.pushLine(JSON.stringify({
              id: request.id,
              error: { code: "not_found", message: "thread not found" },
            }));
            return;
          }
          await transport.pushLine(JSON.stringify({
            id: request.id,
            result: {
              thread,
              turns: [{
                id: "private-turn",
                status: "completed",
                items: [{ prompt: "PRIVATE_TURN_PROMPT_MUST_NEVER_LEAK" }],
              }],
            },
          }));
        }
      },
    });
    const keyPair = generateKeyPairSync("ed25519");
    const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

    const composition = createProductionComposition({
      durableStore: durable,
      codexRuntime: {
        installationId: INSTALLATION_ID,
        executable: "/tmp/codex-production-entrypoint",
        binaryPath: "/tmp/codex-production-entrypoint",
        binarySha256: "production-entrypoint-binary",
        schema,
        testedAdapters: [adapter],
        durableBinding: { scope, installationId: INSTALLATION_ID },
        connectionEpoch: EPOCH,
        spawn: () => {
          spawnCount += 1;
          transportCount += 1;
          return { process, transport };
        },
        clientFactory: (lineTransport, clientOptions) => {
          clientCount += 1;
          return new AppServerClient(lineTransport, clientOptions);
        },
        reconcileOnConnect: true,
      },
      server: {
        auth: {
          audience: "agent-farm",
          resource: RESOURCE,
          verifyToken: (token) => claimsFor(token),
        },
      },
    });
    compositions.push(composition);

    const started = await composition.runtimeStart;
    expect(started?.state).toBe("unpaired");
    expect(composition.runtimeService?.attestationReady()).toBe(true);
    expect(composition.runtimeService?.ready()).toBe(false);
    expect(composition.bridge.connectionState()).toBe("unverified");
    expect(spawnCount).toBe(1);
    expect(transportCount).toBe(1);
    expect(clientCount).toBe(1);
    expect(initializeCount).toBe(1);
    const epochBeforePairing = composition.runtimeService?.status.connectionEpoch;
    expect(epochBeforePairing).toBe(EPOCH);
    expect(process.killCount).toBe(0);

    const challengeResponse = await composition.app.inject({
      method: "POST",
      url: "/api/v1/bridge/pairing/challenge",
      headers: {
        authorization: "Bearer pairing-token",
        "content-type": "application/json",
      },
      payload: {
        installationId: INSTALLATION_ID,
        publicKey,
        sourceRootId: "root-thread",
        agentSessionId: scope.agentSessionId,
        requestedScopes: ["bridge:ingest"],
      },
    });
    expect(challengeResponse.statusCode).toBe(201);
    const challenge = challengeResponse.json() as {
      pairingId: string;
      nonce: string;
      message: string;
      expiresAt: string;
    };
    expect(challenge.pairingId).toEqual(expect.any(String));
    expect(challenge.message).toContain("agent-farm-pairing-v1:");
    expect(challenge.message).not.toContain("PRIVATE_PROMPT");

    const signature = sign(null, Buffer.from(challenge.message, "utf8"), keyPair.privateKey)
      .toString("base64url");
    const completeResponse = await composition.app.inject({
      method: "POST",
      url: "/api/v1/bridge/pairing/complete",
      headers: {
        authorization: "Bearer pairing-token",
        "content-type": "application/json",
      },
      payload: {
        pairingId: challenge.pairingId,
        nonce: challenge.nonce,
        signature,
        installationId: INSTALLATION_ID,
        sourceRootId: "root-thread",
        agentSessionId: scope.agentSessionId,
      },
    });
    expect(completeResponse.statusCode).toBe(201);
    expect(completeResponse.json().agentSessionId).toBe(scope.agentSessionId);

    expect(composition.runtimeService?.state).toBe("connected");
    expect(composition.runtimeService?.ready()).toBe(true);
    expect(composition.bridge.ready()).toBe(true);
    expect(composition.bridge.connectionState()).toBe("connected");
    expect(composition.runtimeService?.status.connectionEpoch).toBe(epochBeforePairing);
    expect(spawnCount).toBe(1);
    expect(transportCount).toBe(1);
    expect(clientCount).toBe(1);
    expect(initializeCount).toBe(1);
    expect(process.killCount).toBe(0);
    expect((await composition.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);

    const projectedAgents = durable.agents.list(scope);
    expect(projectedAgents).toHaveLength(2);
    expect(durable.edges.list(scope)).toHaveLength(1);
    const rootAgent = projectedAgents.find((agent) => agent.sourceThreadId === "root-thread");
    expect(rootAgent).toBeDefined();
    if (!rootAgent) throw new Error("root agent projection missing");

    const hierarchyResponse = await composition.app.inject({
      method: "GET",
      url: `/api/v1/sessions/${scope.agentSessionId}/hierarchy?page=1&pageSize=20`,
      headers: { authorization: "Bearer pairing-token" },
    });
    expect(hierarchyResponse.statusCode).toBe(200);
    const hierarchyBody = hierarchyResponse.json() as {
      agentSessionId: string;
      nodes: readonly unknown[];
      edges: readonly unknown[];
    };
    expect(hierarchyBody.agentSessionId).toBe(scope.agentSessionId);
    expect(hierarchyBody.nodes).toHaveLength(2);
    expect(hierarchyBody.edges).toHaveLength(1);
    expect(hierarchyResponse.body).not.toContain("PRIVATE_PROMPT");
    expect(hierarchyResponse.body).not.toContain("privatePrompt");
    expect(hierarchyResponse.body).not.toContain("sourceThreadId");
    expect(hierarchyResponse.body).not.toContain("ownerId");
    expect(hierarchyResponse.body).not.toContain("tenantId");

    const crossResponse = await composition.app.inject({
      method: "GET",
      url: `/api/v1/sessions/${otherScope.agentSessionId}/hierarchy`,
      headers: { authorization: "Bearer pairing-token" },
    });
    expect(crossResponse.statusCode).toBe(404);
    expect(crossResponse.body).not.toContain("private-agent");
    expect(crossResponse.body).not.toContain("PRIVATE");

    const initializeResponse = await mcpPost(composition.app, "mcp-token", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "production-entrypoint-test", version: "1" },
      },
    });
    expect(initializeResponse.statusCode).toBe(200);
    const mcpSessionId = initializeResponse.headers["mcp-session-id"];
    expect(mcpSessionId).toEqual(expect.any(String));

    const toolsListResponse = await mcpPost(composition.app, "mcp-token", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }, mcpSessionId as string);
    expect(toolsListResponse.statusCode).toBe(200);
    expect(toolsListResponse.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "create_agent_session",
      "get_agent_hierarchy",
      "get_agent_details",
      "render_agent_hierarchy",
    ]);

    const createResponse = await mcpPost(composition.app, "mcp-token", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "create_agent_session",
        arguments: { idempotencyKey: "mcp-entrypoint" },
      },
    }, mcpSessionId as string);
    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json().result.structuredContent.agentSessionId).toBe(scope.agentSessionId);

    const mcpHierarchyResponse = await mcpPost(composition.app, "mcp-token", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_agent_hierarchy", arguments: {} },
    }, mcpSessionId as string);
    expect(mcpHierarchyResponse.statusCode).toBe(200);
    const mcpHierarchy = mcpHierarchyResponse.json().result.structuredContent as {
      agentSessionId: string;
      nodes: readonly unknown[];
      edges: readonly unknown[];
    };
    expect(mcpHierarchy.agentSessionId).toBe(scope.agentSessionId);
    expect(mcpHierarchy.nodes).toHaveLength(2);
    expect(mcpHierarchy.edges).toHaveLength(1);
    expect(mcpHierarchyResponse.body).not.toContain("PRIVATE_PROMPT");
    expect(mcpHierarchyResponse.body).not.toContain("sourceThreadId");
    expect(mcpHierarchyResponse.body).not.toContain("ownerId");
    expect(mcpHierarchyResponse.body).not.toContain("tenantId");

    const detailsResponse = await mcpPost(composition.app, "mcp-token", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "get_agent_details",
        arguments: { agentId: rootAgent.agentId },
      },
    }, mcpSessionId as string);
    expect(detailsResponse.statusCode).toBe(200);
    expect(detailsResponse.body).not.toContain("PRIVATE_PROMPT");
    expect(detailsResponse.body).not.toContain("sourceThreadId");

    const mcpCrossResponse = await mcpPost(composition.app, "mcp-token", {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "get_agent_hierarchy",
        arguments: { agentSessionId: otherScope.agentSessionId },
      },
    }, mcpSessionId as string);
    expect(mcpCrossResponse.statusCode).toBe(200);
    expect(mcpCrossResponse.body).not.toContain("private-agent");
    expect(mcpCrossResponse.body).not.toContain("PRIVATE");

    // A refresh rotates jti but keeps the same OAuth sid. A new protocol
    // transport must therefore resolve the already-precreated AF session.
    const refreshedInitialize = await mcpPost(composition.app, "mcp-refresh-token", {
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "production-entrypoint-refresh", version: "1" },
      },
    });
    expect(refreshedInitialize.statusCode).toBe(200);
    const refreshedMcpSessionId = refreshedInitialize.headers["mcp-session-id"];
    expect(refreshedMcpSessionId).toEqual(expect.any(String));
    const refreshedHierarchy = await mcpPost(composition.app, "mcp-refresh-token", {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "get_agent_hierarchy", arguments: {} },
    }, refreshedMcpSessionId as string);
    expect(refreshedHierarchy.statusCode).toBe(200);
    expect(refreshedHierarchy.json().result.structuredContent.agentSessionId).toBe(scope.agentSessionId);
    expect(durable.mcpGrantBindings.count()).toBe(1);

    const binding = durable.bridgeBindings.list(scope)[0];
    expect(binding?.status).toBe("active");
    if (!binding) throw new Error("pairing did not create a durable bridge binding");
    expect(durable.bridgeBindings.revoke(scope, binding.bindingId)).toBe(true);
    await composition.runtimeService?.reconcileNow();
    expect(composition.runtimeService?.state).toBe("unpaired");
    expect(composition.runtimeService?.ready()).toBe(false);
    expect(composition.bridge.ready()).toBe(false);
    expect(composition.bridge.connectionState()).toBe("unverified");
    expect(composition.runtimeService?.status.connectionEpoch).toBe(epochBeforePairing);
    expect(spawnCount).toBe(1);
    expect(transportCount).toBe(1);
    expect(clientCount).toBe(1);
    expect(initializeCount).toBe(1);
    expect(process.killCount).toBe(0);
    expect((await composition.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
  });
});
