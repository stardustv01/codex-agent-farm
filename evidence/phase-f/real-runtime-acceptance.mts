import { generateKeyPairSync, sign } from "node:crypto";

import { PHASE_A_BINARY_SHA256 } from "../../packages/codex-bridge/src/index.ts";
// Use the same built package boundary as the production composition so error
// classes retain identity across the durable port's replay handling.
import { DurableStore } from "../../packages/store/dist/index.js";

import { createProductionComposition } from "../../apps/server/src/composition.ts";
import { reconcileCodexSnapshot } from "../../apps/server/src/codex-reconciler.ts";
import type { RawTokenClaims } from "../../apps/server/src/contracts.ts";
import { createSupportedCodexRuntimeAnchors } from "../../apps/server/src/runtime-service.ts";

const binaryPath = process.env.AGENT_FARM_CODEX_BIN ?? "/Users/praveengupta/.local/bin/codex";
const sessionsRoot = process.env.AGENT_FARM_CODEX_SESSIONS_ROOT ?? "/Users/praveengupta/.codex/sessions";
const sourceRootId = process.env.AGENT_FARM_SOURCE_ROOT_ID;
if (typeof sourceRootId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(sourceRootId)) {
  throw new Error("AGENT_FARM_SOURCE_ROOT_ID is required and must be an opaque source identifier");
}
const installationId = "agent-farm-real-codex-0.145.0";
const ownerId = "agent-farm-real-owner";
const tenantId = "agent-farm-real-tenant";
const resource = "https://agent-farm.local";
const grantId = "agent-farm-real-grant";
const bearer = "real-acceptance-token";

const claims: RawTokenClaims = {
  sub: ownerId,
  ownerId,
  tenantId,
  scope: "agent-session:create agent-session:read agent-session:read-details agent-session:render bridge:pair",
  exp: Math.floor(Date.now() / 1_000) + 3_600,
  aud: "agent-farm",
  resource,
  sid: grantId,
  jti: "real-acceptance-jti",
};

const durable = new DurableStore(":memory:");
const composition = createProductionComposition({
  durableStore: durable,
  expectedResource: resource,
  codexRuntime: {
    executable: binaryPath,
    args: ["app-server", "--stdio"],
    binaryPath,
    binarySha256: PHASE_A_BINARY_SHA256,
    installationId,
    ...createSupportedCodexRuntimeAnchors(),
    maxLineBytes: 8 * 1_048_576,
    rolloutIdentity: { sessionsRoot },
    reconciliationIntervalMs: 60_000,
    reconcilerLimits: { listPageSize: 20 },
  },
  server: {
    auth: {
      requireJti: true,
      audience: "agent-farm",
      resource,
      verifyToken: () => claims,
    },
  },
});

function expectStatus(actual: number, expected: number, label: string, body: string): void {
  if (actual !== expected) throw new Error(`${label} returned ${actual}: ${body.slice(0, 300)}`);
}

function assertNoPrivateSourceData(label: string, body: string): void {
  const forbidden = [
    sourceRootId,
    "sourceThreadId",
    "sourceRootId",
    "sourceSessionId",
    "ownerId",
    "tenantId",
    "privatePrompt",
    "promptText",
  ];
  for (const value of forbidden) {
    if (body.includes(value)) throw new Error(`${label} exposed a private source identifier or field`);
  }
}

try {
  const started = await composition.runtimeStart;
  if (started?.state !== "unpaired" || !composition.runtimeService?.attestationReady()) {
    throw new Error(`real runtime did not reach accepted pre-pair state (${started?.state ?? "missing"})`);
  }
  const create = await composition.app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { authorization: `Bearer ${bearer}`, "idempotency-key": "real-runtime-session" },
    payload: { label: "Real recursive hierarchy" },
  });
  expectStatus(create.statusCode, 201, "session create", create.body);
  const agentSessionId = create.json<{ agentSessionId: string }>().agentSessionId;
  const scope = { tenantId, ownerId, agentSessionId };

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  try {
    await composition.bridge.attestSourceRoot({ installationId, sourceRootId });
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    throw new Error(`direct source-root attestation failed (${code})`);
  }
  const challengeResponse = await composition.app.inject({
    method: "POST",
    url: "/api/v1/bridge/pairing/challenge",
    headers: { authorization: `Bearer ${bearer}` },
    payload: { installationId, publicKey: publicKeyPem, sourceRootId, agentSessionId },
  });
  expectStatus(challengeResponse.statusCode, 201, "pairing challenge", challengeResponse.body);
  const challenge = challengeResponse.json<{
    pairingId: string;
    nonce: string;
    message: string;
  }>();
  const signature = sign(null, Buffer.from(challenge.message, "utf8"), privateKey).toString("base64url");
  const complete = await composition.app.inject({
    method: "POST",
    url: "/api/v1/bridge/pairing/complete",
    headers: { authorization: `Bearer ${bearer}` },
    payload: {
      pairingId: challenge.pairingId,
      nonce: challenge.nonce,
      installationId,
      sourceRootId,
      agentSessionId,
      signature,
    },
  });
  expectStatus(complete.statusCode, 201, "pairing complete", complete.body);
  const reconciliation = await composition.runtimeService?.reconcileNow();
  if (composition.runtimeService?.state !== "connected") throw new Error("real runtime did not activate the durable binding");
  if (composition.runtimeService.status.reconciliationState !== "reconciled") {
    let listCalls = 0;
    let listReturns = 0;
    let listError = "none";
    let readCalls = 0;
    let directCode = "unknown";
    let directSite = "unknown";
    try {
      await reconcileCodexSnapshot({
        client: {
          listThreads: async (params) => {
            listCalls += 1;
            try {
              const value = await composition.bridge.listThreads(params);
              listReturns += 1;
              return value;
            } catch (error: unknown) {
              const safeName = error instanceof Error ? error.name : "unknown";
              const safeCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
              listError = `${safeName}:${safeCode}`;
              throw error;
            }
          },
          readThread: async (params) => {
            readCalls += 1;
            return composition.bridge.readThread(params);
          },
        },
        store: durable,
        binding: { ...scope, sourceRootId, installationId, status: "active" },
        connectionEpoch: "real-diagnostic",
        limits: { listPageSize: 20 },
      });
    } catch (error: unknown) {
      directCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
      const stack = error instanceof Error ? error.stack ?? "" : "";
      directSite = stack.match(/codex-reconciler\.ts:\d+:\d+/u)?.[0] ?? "unknown";
    }
    throw new Error(`real reconciliation failed: ${JSON.stringify({
      status: composition.runtimeService.status.reconciliation,
      directCode,
      directSite,
      listCalls,
      listReturns,
      listError,
      readCalls,
    })}`);
  }

  const agents = durable.agents.list(scope);
  const edges = durable.edges.list(scope);
  const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
  const rootAgents = agents.filter((agent) => agent.isRoot);
  if (rootAgents.length !== 1 || rootAgents[0] === undefined) {
    throw new Error("real runtime projection did not contain exactly one main agent");
  }
  const rootAgent = rootAgents[0];
  const requireUniqueChild = (parentAgentId: string, name: string) => {
    const childIds = edges
      .filter((edge) => edge.parentAgentId === parentAgentId)
      .map((edge) => edge.childAgentId);
    const matches = agents.filter((agent) => childIds.includes(agent.agentId) && agent.name?.toLowerCase() === name);
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new Error(`real runtime projection did not contain exactly one direct ${name} child`);
    }
    return matches[0];
  };
  const diracAgent = requireUniqueChild(rootAgent.agentId, "dirac");
  const rheaAgent = requireUniqueChild(diracAgent.agentId, "rhea");
  const kuhnAgent = requireUniqueChild(diracAgent.agentId, "kuhn");
  const noetherAgent = requireUniqueChild(rheaAgent.agentId, "noether");
  const requiredAgents = new Map([
    ["dirac", diracAgent],
    ["rhea", rheaAgent],
    ["kuhn", kuhnAgent],
    ["noether", noetherAgent],
  ] as const);
  const expectedNames = ["dirac", "rhea", "kuhn", "noether"] as const;
  const requiredEdgePairs = [
    [rootAgent.agentId, diracAgent.agentId],
    [diracAgent.agentId, rheaAgent.agentId],
    [diracAgent.agentId, kuhnAgent.agentId],
    [rheaAgent.agentId, noetherAgent.agentId],
  ] as const;
  const assertRequiredPublicEdges = (label: string, values: readonly unknown[]): void => {
    for (const [parentAgentId, childAgentId] of requiredEdgePairs) {
      const present = values.some((candidate) => {
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
        const edge = candidate as Record<string, unknown>;
        return edge.parentAgentId === parentAgentId && edge.childAgentId === childAgentId;
      });
      if (!present) throw new Error(`${label} omitted a required recursive edge`);
    }
  };

  const httpHierarchy = await composition.app.inject({
    method: "GET",
    url: `/api/v1/sessions/${agentSessionId}/hierarchy?page=1&pageSize=200`,
    headers: { authorization: `Bearer ${bearer}` },
  });
  expectStatus(httpHierarchy.statusCode, 200, "HTTP hierarchy", httpHierarchy.body);
  assertNoPrivateSourceData("HTTP hierarchy", httpHierarchy.body);
  const httpBody = httpHierarchy.json<{ nodes?: unknown[]; edges?: unknown[] }>();
  if (!Array.isArray(httpBody.nodes) || httpBody.nodes.length !== agents.length || !Array.isArray(httpBody.edges) || httpBody.edges.length !== edges.length) {
    throw new Error("HTTP hierarchy did not return the complete real projection");
  }
  assertRequiredPublicEdges("HTTP hierarchy", httpBody.edges);

  durable.mcpGrantBindings.getOrCreate({
    ownerId,
    tenantId,
    subject: ownerId,
    resource: `${resource}/`,
    grantId,
    proposedAgentSessionId: agentSessionId,
  });
  const initialize = await composition.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "real-acceptance", version: "1" } },
    },
  });
  expectStatus(initialize.statusCode, 200, "MCP initialize", initialize.body);
  const mcpSessionId = initialize.headers["mcp-session-id"];
  if (typeof mcpSessionId !== "string") throw new Error("MCP initialize omitted its protocol session ID");
  const callTool = (id: number, name: string, args: Record<string, unknown>) => composition.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": mcpSessionId,
    },
    payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
  });
  const provision = await callTool(2, "create_agent_session", { idempotencyKey: "real-runtime-mcp-provision" });
  expectStatus(provision.statusCode, 200, "MCP provision", provision.body);
  const provisionBody = provision.json<{
    error?: unknown;
    result?: { isError?: boolean; structuredContent?: { agentSessionId?: string } };
  }>();
  if (
    provisionBody.error !== undefined ||
    provisionBody.result?.isError === true ||
    provisionBody.result?.structuredContent?.agentSessionId !== agentSessionId
  ) {
    const rpcError = typeof provisionBody.error === "object" && provisionBody.error !== null && !Array.isArray(provisionBody.error)
      ? provisionBody.error as Record<string, unknown>
      : {};
    const structuredContent = provisionBody.result?.structuredContent;
    const contentText = Array.isArray((provisionBody.result as { content?: unknown } | undefined)?.content)
      ? ((provisionBody.result as { content: Array<{ text?: unknown }> }).content)
          .map((entry) => typeof entry?.text === "string" ? entry.text : "")
          .join(" ")
      : "";
    const errorClass = /idempotenc/iu.test(contentText) ? "idempotency"
      : /already exists|session_exists/iu.test(contentText) ? "session-exists"
      : /authoriz|forbidden|scope/iu.test(contentText) ? "authorization"
      : /valid|zod|expected|schema/iu.test(contentText) ? "validation"
      : /not found/iu.test(contentText) ? "not-found"
      : "unknown";
    const diagnostic = {
      topLevelKeys: Object.keys(provisionBody).sort(),
      rpcErrorCode: typeof rpcError.code === "number" || typeof rpcError.code === "string" ? rpcError.code : null,
      resultKeys: provisionBody.result === undefined ? [] : Object.keys(provisionBody.result).sort(),
      isError: provisionBody.result?.isError === true,
      errorClass,
      contentLength: contentText.length,
      structuredKeys: structuredContent === undefined ? [] : Object.keys(structuredContent).sort(),
    };
    throw new Error(`MCP create_agent_session did not provision the grant-bound Agent Farm session: ${JSON.stringify(diagnostic)}`);
  }
  assertNoPrivateSourceData("MCP provision", provision.body);
  const hierarchy = await callTool(3, "get_agent_hierarchy", { limit: 200 });
  expectStatus(hierarchy.statusCode, 200, "MCP hierarchy", hierarchy.body);
  assertNoPrivateSourceData("MCP hierarchy", hierarchy.body);
  const hierarchyBody = hierarchy.json<{ result?: { structuredContent?: { agentSessionId?: string; connectionState?: string; agents?: unknown[]; edges?: unknown[] } } }>();
  const structured = hierarchyBody.result?.structuredContent;
  if (
    structured?.agentSessionId !== agentSessionId ||
    structured.connectionState !== "connected" ||
    !Array.isArray(structured.agents) ||
    structured.agents.length !== agents.length ||
    !Array.isArray(structured.edges) ||
    structured.edges.length !== edges.length
  ) {
    throw new Error("official MCP read did not return the connected real projection");
  }
  assertRequiredPublicEdges("MCP hierarchy", structured.edges);

  const evidence = durable.identityEvidence.list(scope);
  const latestIdentity = (agentId: string) => {
    const relevant = evidence.filter((item) => item.agentId === agentId);
    const latest = (key: "requestedModel" | "requestedEffort" | "requestedProvider" | "observedModel" | "observedEffort" | "observedProvider") => {
      for (let index = relevant.length - 1; index >= 0; index -= 1) {
        const value = relevant[index]?.[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
      return null;
    };
    return {
      requestedModel: latest("requestedModel"),
      requestedEffort: latest("requestedEffort"),
      requestedProvider: latest("requestedProvider"),
      observedModel: latest("observedModel"),
      observedEffort: latest("observedEffort"),
      observedProvider: latest("observedProvider"),
      evidenceSources: [...new Set(relevant.map((item) => item.source))].sort(),
    };
  };
  const publicBranch = expectedNames.map((name) => {
    const agent = requiredAgents.get(name)!;
    const identity = latestIdentity(agent.agentId);
    const parentEdge = edges.find((edge) => edge.childAgentId === agent.agentId);
    return {
      name: agent.name,
      role: agent.role,
      lifecycle: agent.lifecycle,
      parent: parentEdge ? byId.get(parentEdge.parentAgentId)?.name ?? "main" : "main",
      requestedModel: identity.requestedModel,
      requestedEffort: identity.requestedEffort,
      observedModel: identity.observedModel,
      observedEffort: identity.observedEffort,
      observedProvider: identity.observedProvider,
      verificationState: agent.verificationState,
      evidenceSources: identity.evidenceSources,
    };
  });
  const expectedIdentity = {
    dirac: { requestedModel: "gpt-5.6-sol", requestedEffort: "high", observedModel: "gpt-5.6-sol", observedEffort: "high", observedProvider: "openai", verificationState: "verified" },
    rhea: { requestedModel: "gpt-5.6-luna", requestedEffort: "max", observedModel: "gpt-5.6-luna", observedEffort: "max", observedProvider: "openai", verificationState: "verified" },
    kuhn: { requestedModel: "gpt-5.6-sol", requestedEffort: "medium", observedModel: "gpt-5.6-sol", observedEffort: "medium", observedProvider: "openai", verificationState: "verified" },
    noether: { requestedModel: "gpt-5.6-sol", requestedEffort: "low", observedModel: "gpt-5.6-sol", observedEffort: "low", observedProvider: "openai", verificationState: "verified" },
  } as const;
  for (const branch of publicBranch) {
    const name = branch.name?.toLowerCase() as keyof typeof expectedIdentity;
    const expected = expectedIdentity[name];
    if (!expected || Object.entries(expected).some(([key, value]) => branch[key as keyof typeof branch] !== value)) {
      const actual = {
        requestedModel: branch.requestedModel,
        requestedEffort: branch.requestedEffort,
        observedModel: branch.observedModel,
        observedEffort: branch.observedEffort,
        observedProvider: branch.observedProvider,
        verificationState: branch.verificationState,
        evidenceSources: branch.evidenceSources,
      };
      throw new Error(`real runtime identity mismatch for ${name || "unknown"}: ${JSON.stringify({ expected, actual })}`);
    }
  }
  const rootValues = latestIdentity(rootAgent.agentId);
  const rootIdentity = {
    observedModel: rootValues.observedModel,
    observedEffort: rootValues.observedEffort,
    observedProvider: rootValues.observedProvider,
    verificationState: rootAgent.verificationState,
    evidenceSources: rootValues.evidenceSources,
  };
  if (rootIdentity.observedModel === null || rootIdentity.observedEffort === null || rootIdentity.observedProvider !== "openai" || rootIdentity.verificationState !== "unverified") {
    throw new Error(`real runtime main-agent observed identity is incorrect: ${JSON.stringify(rootIdentity)}`);
  }

  const assertPublicIdentitySurface = (label: string, values: readonly unknown[]): void => {
    for (const [name, expected] of Object.entries(expectedIdentity)) {
      const expectedAgentId = requiredAgents.get(name)?.agentId;
      const record = values.find((candidate) => typeof candidate === "object" && candidate !== null && "agentId" in candidate && (candidate as { agentId?: unknown }).agentId === expectedAgentId) as Record<string, unknown> | undefined;
      const nestedIdentity = record !== undefined && typeof record.identity === "object" && record.identity !== null && !Array.isArray(record.identity) ? record.identity as Record<string, unknown> : {};
      const actual = record === undefined ? null : {
          requestedModel: record.requestedModel ?? nestedIdentity.requestedModel ?? null,
          observedModel: record.observedModel ?? nestedIdentity.observedModel ?? null,
          requestedReasoningEffort: record.requestedReasoningEffort ?? nestedIdentity.requestedReasoningEffort ?? null,
          observedReasoningEffort: record.observedReasoningEffort ?? nestedIdentity.observedReasoningEffort ?? null,
          observedProvider: record.observedProvider ?? nestedIdentity.observedProvider ?? null,
          verificationState: record.verificationState ?? record.verification ?? nestedIdentity.verificationStatus ?? null,
          identityType: typeof record.identity,
          keys: Object.keys(record).sort(),
      };
      if (!actual || actual.requestedModel !== expected.requestedModel || actual.observedModel !== expected.observedModel || actual.requestedReasoningEffort !== expected.requestedEffort || actual.observedReasoningEffort !== expected.observedEffort || actual.observedProvider !== expected.observedProvider || actual.verificationState !== expected.verificationState) {
        throw new Error(`${label} identity projection mismatch for ${name}: ${JSON.stringify({ expected, actual })}`);
      }
    }
  };
  assertPublicIdentitySurface("HTTP", httpBody.nodes);
  assertPublicIdentitySurface("MCP", structured.agents);
  process.stdout.write(`${JSON.stringify({
    result: "PASS",
    runtimeState: composition.runtimeService.state,
    reconciliationState: composition.runtimeService.status.reconciliationState,
    projectedAgentCount: agents.length,
    projectedEdgeCount: edges.length,
    sourceListPages: reconciliation?.listPages ?? null,
    sourceThreadCount: reconciliation?.sourceThreadIds.length ?? null,
    requiredBranchAgentCount: 5,
    mcpProvisioned: true,
    mcpAgentCount: structured.agents.length,
    mcpEdgeCount: structured.edges.length,
    rootIdentity,
    requiredBranch: publicBranch,
  }, null, 2)}\n`);
} finally {
  await composition.close();
}
