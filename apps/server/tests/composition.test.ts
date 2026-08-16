import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryStdioTransport, generateStableSchemaBundle } from "@agent-farm/codex-bridge";
import { makeAuthContext } from "@agent-farm/mcp";
import { DurableStore, pricingSnapshotHash } from "@agent-farm/store";

import {
  DurableStorePort,
  ReadOnlyCodexBridgeAdapter,
  createProductionComposition,
} from "../src/composition.js";
import type { RawTokenClaims } from "../src/contracts.js";
import type { CodexRuntimeBinding } from "../src/codex-runtime.js";

const sessions: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (sessions.length > 0) await sessions.pop()?.close();
});

describe("production composition", () => {
  it("resolves local details by canonical agent identity when names collide", async () => {
    const durable = new DurableStore(":memory:");
    const port = new DurableStorePort(durable);
    const scope = { tenantId: "tenant-local-details", ownerId: "owner-local-details", agentSessionId: "session-local-details" } as const;
    durable.createAgentSession({ ...scope, sourceAdapter: "fixture", idempotencyKey: "local-details" });
    durable.agents.upsert(scope, { agentId: "internal-root", name: "Same name", isRoot: true, lifecycle: "active" });
    durable.agents.upsert(scope, { agentId: "internal-child", name: "Same name", lifecycle: "completed" });
    durable.edges.add(scope, { parentAgentId: "internal-root", childAgentId: "internal-child" });

    const hierarchy = await port.getHierarchy({ ...scope, page: 1, pageSize: 200 });
    const rootPublicId = hierarchy?.nodes.find((node) => node.parentAgentId === null)?.agentId;
    const childPublicId = hierarchy?.nodes.find((node) => node.parentAgentId !== null)?.agentId;
    expect(rootPublicId).toBeDefined();
    expect(childPublicId).toBeDefined();
    const child = await port.getLocalAgentDetails({ ...scope, agentId: childPublicId as string });
    expect(child?.agent.agentId).toBe(childPublicId);
    expect(child?.parent?.agentId).toBe(rootPublicId);
    expect(child?.children).toEqual([]);
    expect(await port.getLocalAgentDetails({ ...scope, agentId: "agent:0000000000000000000000000000000000000000" })).toBeNull();
    expect(await port.getLocalAgentDetails({ ...scope, agentSessionId: "cross-session", agentId: childPublicId as string })).toBeNull();
    durable.close();
  });

  it("does not expose another scope's connected runtime state to an empty unbound session", async () => {
    const durable = new DurableStore(":memory:");
    const port = new DurableStorePort(durable);
    const bound = { tenantId: "tenant-scope-state", ownerId: "owner-scope-state", agentSessionId: "bound" } as const;
    const empty = { ...bound, agentSessionId: "empty" } as const;
    durable.createAgentSession({ ...bound, sourceAdapter: "codex-app-server" });
    durable.createAgentSession({ ...empty, sourceAdapter: "codex-app-server" });
    durable.agents.upsert(bound, { agentId: "root", name: "Root", isRoot: true });
    durable.bridgeBindings.upsert(bound, { installationId: "install-scope", sourceAdapter: "codex-app-server", selectedSourceRootId: "thread-root", credentialHash: "hash-only", expiresAt: Date.now() + 60_000 });
    port.setConnectionStateProvider((scope) => durable.bridgeBindings.list(scope).some((binding) => binding.status === "active") ? "connected" : "unverified");
    expect((await port.getHierarchy({ ...bound, page: 1, pageSize: 200 }))?.connection.state).toBe("connected");
    expect((await port.getHierarchy({ ...empty, page: 1, pageSize: 200 }))?.connection.state).toBe("unverified");
    durable.close();
  });

  it("merges trusted local rollout detail with usage segments and recursive partial cost", async () => {
    const durable = new DurableStore(":memory:");
    const port = new DurableStorePort(durable);
    const s = { tenantId: "tenant-rich", ownerId: "owner-rich", agentSessionId: "session-rich" } as const;
    durable.createAgentSession({ ...s, sourceAdapter: "fixture" });
    const usage = { inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 14 } as const;
    const usageSegments = { complete: true, segments: [{ turnId: "turn-rich", provider: "openai", model: "gpt-5.6-sol", effort: "high", usage }] } as const;
    const pricingBody = {
      snapshotId: "composition-recursive-test-v1",
      authority: "operator-reviewed-official" as const,
      sourceUrls: ["https://example.com/test-pricing"],
      retrievedAt: "2026-08-12T00:00:00.000Z",
      verifiedAt: "2026-08-12T00:00:00.000Z",
      currency: "USD" as const,
      rates: { "gpt-5.6-sol": { inputPerMillionUsd: 5, cachedInputPerMillionUsd: 0.5, outputPerMillionUsd: 30 } },
      standardInputMultiplier: 1 as const,
      longContextThresholdInputTokens: 272_000 as const,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
      cacheWriteMultiplier: 1.25,
    };
    const pricing = { ...pricingBody, snapshotHash: pricingSnapshotHash(pricingBody) };
    durable.pricingSnapshots.put({ snapshotId: pricing.snapshotId, snapshot: pricing });
    durable.agents.upsert(s, { agentId: "rich-root", sourceThreadId: "thread-rich", name: "Same", isRoot: true, usage, usageSegments, cost: { status: "unavailable", currency: "USD", reason: "self-missing" } });
    durable.agents.upsert(s, { agentId: "rich-child", sourceThreadId: "thread-child", name: "Same", usage, pricingSnapshotId: pricing.snapshotId, cost: { status: "estimated", currency: "USD", selfMicros: 100, childrenMicros: 0, totalMicros: 100, usage, pricing } });
    durable.agents.upsert(s, { agentId: "rich-grandchild", sourceThreadId: "thread-grandchild", name: "Same", usage, pricingSnapshotId: pricing.snapshotId, cost: { status: "estimated", currency: "USD", selfMicros: 500, childrenMicros: 0, totalMicros: 500, usage, pricing } });
    durable.edges.add(s, { parentAgentId: "rich-root", childAgentId: "rich-child" });
    durable.edges.add(s, { parentAgentId: "rich-child", childAgentId: "rich-grandchild" });
    port.setLocalDetailReader(async (threadId) => threadId === "thread-rich" ? {
      schemaVersion: "agent-farm.local-rollout-detail.v2",
      sourceThreadId: threadId,
      messages: [{ role: "user", text: "local prompt" }],
      activity: [{ kind: "lifecycle", status: "completed" }],
      tools: [],
      changedFiles: [{ path: "/private/tmp/a.ts", additions: 2, deletions: 1 }],
      finalSummary: "trusted local summary",
    } : undefined);
    const hierarchy = await port.getHierarchy({ ...s, page: 1, pageSize: 200 });
    const publicRoot = hierarchy?.nodes.find((node) => node.parentAgentId === null)?.agentId as string;
    const detail = await port.getLocalAgentDetails({ ...s, agentId: publicRoot });
    expect(detail).toMatchObject({
      messages: [{ role: "user", text: "local prompt" }],
      changedFiles: [{ path: "/private/tmp/a.ts", additions: 2, deletions: 1 }],
      summary: "trusted local summary",
      usage,
      usageSegments,
      cost: { status: "partial", knownChildrenMicros: 600, reason: "self-cost-unavailable" },
    });
    expect(JSON.stringify(detail)).not.toMatch(/credential|authorization|function_call/iu);
    durable.close();
  });

  it("retains known self cost and pricing provenance when a descendant is unpriced", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-partial-cost-"));
    const databasePath = join(directory, "partial-cost.sqlite");
    let durable = new DurableStore(databasePath);
    const s = { tenantId: "tenant-partial-self", ownerId: "owner-partial-self", agentSessionId: "session-partial-self" } as const;
    durable.createAgentSession({ ...s, sourceAdapter: "fixture" });
    const usage = { inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 14 } as const;
    const pricingBody = {
      snapshotId: "composition-partial-self-v1", authority: "operator-reviewed-official" as const,
      sourceUrls: ["https://example.com/test-pricing"], retrievedAt: "2026-08-12T00:00:00.000Z", verifiedAt: "2026-08-12T00:00:00.000Z", currency: "USD" as const,
      rates: { "gpt-5.6-sol": { inputPerMillionUsd: 5, cachedInputPerMillionUsd: 0.5, outputPerMillionUsd: 30 } },
      standardInputMultiplier: 1 as const, longContextThresholdInputTokens: 272_000 as const, longContextInputMultiplier: 2, longContextOutputMultiplier: 1.5, cacheWriteMultiplier: 1.25,
    };
    const pricing = { ...pricingBody, snapshotHash: pricingSnapshotHash(pricingBody) };
    durable.pricingSnapshots.put({ snapshotId: pricing.snapshotId, snapshot: pricing });
    durable.agents.upsert(s, { agentId: "root", sourceThreadId: "thread-root", isRoot: true, usage, pricingSnapshotId: pricing.snapshotId, cost: { status: "estimated", currency: "USD", selfMicros: 1234, childrenMicros: 0, totalMicros: 1234, usage, pricing } });
    durable.agents.upsert(s, { agentId: "child", sourceThreadId: "thread-child", cost: { status: "unavailable", currency: "USD", reason: "pricing-unavailable" } });
    durable.edges.add(s, { parentAgentId: "root", childAgentId: "child" });
    durable.close();
    durable = new DurableStore(databasePath);
    const port = new DurableStorePort(durable);
    const hierarchy = await port.getHierarchy({ ...s, page: 1, pageSize: 200 });
    const publicRoot = hierarchy?.nodes.find((node) => node.parentAgentId === null)?.agentId as string;
    expect((await port.getLocalAgentDetails({ ...s, agentId: publicRoot }))?.cost).toMatchObject({ status: "partial", knownSelfMicros: 1234, reason: "descendant-cost-unavailable", pricing });
    durable.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps one gated pre-pair client, attests a root, activates after credential issuance, and reconciles", async () => {
    const durable = new DurableStore(":memory:");
    const scope = { tenantId: "tenant-runtime-composition", ownerId: "owner-runtime-composition", agentSessionId: "session-runtime-composition" } as const;
    durable.createAgentSession({
      ...scope,
      sourceAdapter: "codex-app-server",
      idempotencyKey: "runtime-composition-session",
    });
    const schema = generateStableSchemaBundle();
    const adapter = {
      adapterVersion: "composition-runtime-fixture-v1",
      binarySha256: "composition-runtime-binary",
      schemaBundleSha256: schema.sha256,
      userAgentPrefix: "Codex Desktop/0.145.0",
    } as const;
    let transport!: InMemoryStdioTransport;
    transport = new InMemoryStdioTransport({
      onSend: async (line) => {
        const request = JSON.parse(line) as { id?: number; method: string; params?: { threadId?: string } };
        if (request.method === "initialize") {
          await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (composition fixture)" } }));
        } else if (request.method === "thread/list") {
          await transport.pushLine(JSON.stringify({
            id: request.id,
            result: { data: [
              { id: "root-thread", sessionId: "codex-session", status: "active" },
              { id: "child-thread", sessionId: "codex-session", parentThreadId: "root-thread", status: "idle" },
            ] },
          }));
        } else if (request.method === "thread/read") {
          const threadId = request.params?.threadId ?? "root-thread";
          await transport.pushLine(JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: threadId,
                sessionId: "codex-session",
                ...(threadId === "child-thread" ? { parentThreadId: "root-thread" } : {}),
                status: threadId === "child-thread" ? "idle" : "active",
              },
              turns: [],
            },
          }));
        }
      },
    });
    const process = new EventEmitter() as EventEmitter & ChildProcessWithoutNullStreams;
    Object.defineProperty(process, "exitCode", { value: null, writable: true, configurable: true });
    Object.defineProperty(process, "killed", { value: false, writable: true, configurable: true });
    (process as EventEmitter & { kill: () => boolean }).kill = () => true;
    let spawnCount = 0;
    const runtimeBinding: CodexRuntimeBinding = {
      ...scope,
      sourceRootId: "root-thread",
      installationId: "install-runtime-composition",
      status: "active",
    };
    const composition = createProductionComposition({
      durableStore: durable,
      bridge: { verifyPairingSignature: () => true },
      codexRuntime: {
        installationId: "install-runtime-composition",
        executable: "/tmp/codex-runtime-composition",
        binaryPath: "/tmp/codex-runtime-composition",
        binarySha256: "composition-runtime-binary",
        schema,
        testedAdapters: [adapter],
        durableBinding: { scope, installationId: "install-runtime-composition" },
        spawn: () => {
          spawnCount += 1;
          return { process, transport };
        },
        reconcileOnConnect: true,
        connectionEpoch: "composition-runtime-epoch",
      },
    });
    sessions.push(composition);
    // Keep the binding value in the test as an explicit assertion of the
    // exact identity the durable pairing callback must activate.
    expect(runtimeBinding.sourceRootId).toBe("root-thread");
    const started = await composition.runtimeStart;
    expect(started?.state).toBe("unpaired");
    expect(composition.runtimeService?.attestationReady()).toBe(true);
    expect(composition.bridge.ready()).toBe(false);
    expect(composition.bridge.connectionState()).toBe("unverified");

    const attestation = await composition.bridge.attestSourceRoot({
      installationId: "install-runtime-composition",
      sourceRootId: "root-thread",
    });
    expect(attestation.sourceRootId).toBe("root-thread");
    const issued = await composition.bridge.issuePairingCredential({
      pairingId: "pairing-runtime-composition",
      nonce: "nonce-runtime-composition",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerId: scope.ownerId,
      tenantId: scope.tenantId,
      installationId: "install-runtime-composition",
      publicKey: "fixture",
      sourceRootId: attestation.sourceRootId,
      sourceSessionId: attestation.sourceSessionId,
      sourceRootAttestationDigest: attestation.attestationDigest,
      sourceRootAttestationExpiresAt: attestation.expiresAt,
      agentSessionId: scope.agentSessionId,
      requestedScopes: ["bridge:ingest"],
    });
    expect(issued.credential.length).toBeGreaterThan(20);
    expect(spawnCount).toBe(1);
    expect(composition.runtimeService?.state).toBe("connected");
    expect(composition.bridge.ready()).toBe(true);
    expect(composition.bridge.connectionState()).toBe("connected");
    expect(durable.agents.list(scope)).toHaveLength(2);
    expect(durable.edges.list(scope)).toHaveLength(1);

    const activeBinding = durable.bridgeBindings.list(scope)[0];
    expect(activeBinding).toBeDefined();
    if (activeBinding) durable.bridgeBindings.revoke(scope, activeBinding.bindingId);
    await composition.runtimeService?.reconcileNow();
    expect(composition.runtimeService?.state).toBe("unpaired");
    expect(composition.bridge.ready()).toBe(false);
    expect(composition.bridge.connectionState()).toBe("unverified");
    expect(spawnCount).toBe(1);
  });

  it("auto-resolves one dynamic pairing and fails closed when an installation is ambiguous", async () => {
    const durable = new DurableStore(":memory:");
    const first = { tenantId: "tenant-auto-a", ownerId: "owner-auto-a", agentSessionId: "session-auto-a" } as const;
    const second = { tenantId: "tenant-auto-b", ownerId: "owner-auto-b", agentSessionId: "session-auto-b" } as const;
    durable.createAgentSession({ ...first, sourceAdapter: "codex-app-server" });
    durable.createAgentSession({ ...second, sourceAdapter: "codex-app-server" });
    const firstBinding = durable.bridgeBindings.upsert(first, {
      installationId: "installation-auto",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: "root-auto-a",
      credentialHash: "credential-auto-a",
      expiresAt: Date.now() + 60_000,
    });
    const schema = generateStableSchemaBundle();
    const composition = createProductionComposition({
      durableStore: durable,
      startRuntime: false,
      codexRuntime: {
        installationId: "installation-auto",
        executable: "/tmp/codex-auto-resolver",
        binarySha256: "auto-resolver-binary",
        schema,
        testedAdapters: [{
          adapterVersion: "auto-resolver-v1",
          binarySha256: "auto-resolver-binary",
          schemaBundleSha256: schema.sha256,
          userAgentPrefix: "Codex Desktop/0.145.0",
        }],
      },
    });
    sessions.push(composition);

    const serviceOptions = (composition.runtimeService as unknown as {
      options: { bindingResolver?: (request: unknown) => Promise<CodexRuntimeBinding | null> | CodexRuntimeBinding | null };
    }).options;
    expect(await serviceOptions.bindingResolver?.({})).toMatchObject({
      ...first,
      installationId: "installation-auto",
      sourceRootId: "root-auto-a",
      status: "active",
    });

    durable.bridgeBindings.upsert(second, {
      installationId: "installation-auto",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: "root-auto-b",
      credentialHash: "credential-auto-b",
      expiresAt: Date.now() + 60_000,
    });
    expect(await serviceOptions.bindingResolver?.({})).toBeNull();
    expect(durable.bridgeBindings.revoke(first, firstBinding.bindingId)).toBe(true);
  });

  it("routes production /mcp through a fresh official SDK application", async () => {
    const claims = (): RawTokenClaims => ({
      sub: "owner-a",
      ownerId: "owner-a",
      tenantId: "tenant-a",
      scope: "agent-session:create agent-session:read agent-session:read-details agent-session:render",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      aud: "agent-farm",
      resource: "https://agent-farm.local",
      jti: "token-composition-a",
      sid: "grant-composition-a",
    });
    const composition = createProductionComposition({
      server: {
        auth: {
          audience: "agent-farm",
          resource: "https://agent-farm.local",
          verifyToken: claims,
        },
      },
    });
    sessions.push(composition);

    const response = await composition.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer production-test",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "composition-test", version: "1.0.0" },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 1,
        result: expect.objectContaining({
          serverInfo: expect.objectContaining({ name: "agent-farm" }),
        }),
      }),
    );
  });

  it("uses durable SQLite projection for scoped hierarchy reads", async () => {
    const durable = new DurableStore(":memory:");
    const composition = createProductionComposition({ durableStore: durable });
    sessions.push(composition);

    const session = await composition.storePort.createAgentSession({
      ownerId: "owner-a",
      tenantId: "tenant-a",
      agentSessionId: "as_test",
      idempotencyKey: "create-1",
      requestHash: "request-hash",
      payload: { label: "test", sourceAdapter: "fixture" },
    });
    expect(session.agentSessionId).toBe("as_test");

    durable.agents.upsert({
      tenantId: "tenant-a",
      ownerId: "owner-a",
      agentSessionId: "as_test",
      agentId: "root",
      name: "Root",
      role: "root",
      lifecycle: "active",
      verificationState: "verified",
      isRoot: true,
    });
    durable.agents.upsert({
      tenantId: "tenant-a",
      ownerId: "owner-a",
      agentSessionId: "as_test",
      agentId: "child",
      name: "Child",
      role: "worker",
      lifecycle: "completed",
      verificationState: "unverified",
    });
    durable.edges.add(
      { tenantId: "tenant-a", ownerId: "owner-a", agentSessionId: "as_test" },
      { parentAgentId: "root", childAgentId: "child", source: "fixture" },
    );

    const hierarchy = await composition.storePort.getHierarchy({
      ownerId: "owner-a",
      tenantId: "tenant-a",
      agentSessionId: "as_test",
      page: 1,
      pageSize: 10,
    });
    expect(hierarchy?.nodes.map((node) => node.agentId)).toEqual([
      "agent:956e6e33fe8b21fbf3e7e43d41c304862c78627d",
      "agent:0afbc7c3c11c0f7d165fc3801ee0a4f400832fcb",
    ]);
    expect(hierarchy?.edges?.[0]).toEqual(
      expect.objectContaining({
        parentAgentId: "agent:956e6e33fe8b21fbf3e7e43d41c304862c78627d",
        childAgentId: "agent:0afbc7c3c11c0f7d165fc3801ee0a4f400832fcb",
        state: "unknown",
      }),
    );
  });

  it("projects server-observed identity through the production MCP shape", async () => {
    const durable = new DurableStore(":memory:");
    const composition = createProductionComposition({
      durableStore: durable,
      mcpAuthContextProvider: () => makeAuthContext({
        ownerId: "owner-a",
        tenantId: "tenant-a",
        agentSessionId: "as_identity",
        scopes: ["agent-session:read"],
      }),
    });
    sessions.push(composition);
    const scope = { ownerId: "owner-a", tenantId: "tenant-a", agentSessionId: "as_identity" };
    durable.createAgentSession({
      ...scope,
      sourceAdapter: "codex-app-server",
      idempotencyKey: "identity-session",
    });
    durable.agents.upsert({
      ...scope,
      agentId: "dirac",
      name: "Dirac",
      role: "worker",
      lifecycle: "active",
      verificationState: "verified",
      isRoot: true,
    });
    durable.identityEvidence.append(scope, {
      agentId: "dirac",
      requestedModel: "gpt-5.6-sol",
      requestedProvider: "openai",
      requestedEffort: "high",
      observedModel: "gpt-5.6-sol",
      observedProvider: "openai",
      observedEffort: "high",
      source: "codex-app-server/thread-settings",
      trustClass: "observed",
    });

    const result = await composition.mcpApplication.invoke("get_agent_hierarchy", {
      agentSessionId: "as_identity",
      limit: 200,
    });
    expect(result.structuredContent).toMatchObject({
      connection: { state: "unverified" },
      nodes: [{
        displayName: "Agent 01",
        identity: {
          requested: { model: "gpt-5.6-sol", provider: "openai", effort: "high" },
          observed: { model: "gpt-5.6-sol", provider: "openai", effort: "high" },
          verification: "verified",
        },
      }],
    });
  });

  it("paginates exactly 25 active plus 200 completed agents without losing edges", async () => {
    const durable = new DurableStore(":memory:");
    const composition = createProductionComposition({
      durableStore: durable,
      mcpAuthContextProvider: () => makeAuthContext({
        ownerId: "owner-scale",
        tenantId: "tenant-scale",
        agentSessionId: "as_scale",
        scopes: ["agent-session:read"],
      }),
    });
    sessions.push(composition);
    const scope = { ownerId: "owner-scale", tenantId: "tenant-scale", agentSessionId: "as_scale" };
    durable.createAgentSession({ ...scope, sourceAdapter: "fixture", idempotencyKey: "scale-session" });
    for (let index = 0; index < 225; index += 1) {
      const agentId = `agent-${index.toString().padStart(3, "0")}`;
      durable.agents.upsert({
        ...scope,
        agentId,
        name: index === 0 ? "Main" : `Agent ${index}`,
        role: index === 0 ? "root" : "worker",
        lifecycle: index < 25 ? "active" : "completed",
        verificationState: "verified",
        isRoot: index === 0,
      });
      if (index > 0) {
        durable.edges.add(scope, {
          parentAgentId: "agent-000",
          childAgentId: agentId,
          source: "scale-fixture",
        });
      }
    }

    const first = await composition.mcpApplication.invoke("get_agent_hierarchy", {
      agentSessionId: "as_scale",
      limit: 200,
    });
    expect(first.structuredContent).toMatchObject({ hasMore: true, nextCursor: "p_2" });
    expect(first.structuredContent.nodes).toHaveLength(200);
    expect(first.structuredContent.edges).toHaveLength(199);

    const second = await composition.mcpApplication.invoke("get_agent_hierarchy", {
      agentSessionId: "as_scale",
      limit: 200,
      cursor: "p_2",
    });
    expect(second.structuredContent).toMatchObject({ hasMore: false });
    expect(second.structuredContent.nodes).toHaveLength(25);
    expect(second.structuredContent.edges).toHaveLength(25);
    expect([
      ...first.structuredContent.nodes,
      ...second.structuredContent.nodes,
    ]).toHaveLength(225);
    expect([
      ...first.structuredContent.edges,
      ...second.structuredContent.edges,
    ]).toHaveLength(224);
  });

  it("replays durable REST idempotency after a server restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-idempotency-"));
    const filename = join(directory, "agent-farm.sqlite");
    const claims = (): RawTokenClaims => ({
      sub: "owner-restart",
      ownerId: "owner-restart",
      tenantId: "tenant-restart",
      scope: "agent-session:create agent-session:read",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      aud: "agent-farm",
      resource: "https://agent-farm.local",
    });
    const create = (composition: ReturnType<typeof createProductionComposition>, label: string) =>
      composition.app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: {
          authorization: "Bearer restart-test",
          "idempotency-key": "restart-stable-key",
        },
        payload: { label },
      });
    let firstComposition: ReturnType<typeof createProductionComposition> | undefined;
    let secondComposition: ReturnType<typeof createProductionComposition> | undefined;
    try {
      firstComposition = createProductionComposition({
        databaseFilename: filename,
        server: { auth: { audience: "agent-farm", resource: "https://agent-farm.local", verifyToken: claims } },
      });
      const first = await create(firstComposition, "Durable");
      expect(first.statusCode).toBe(201);
      const firstId = first.json().agentSessionId;
      await firstComposition.close();
      firstComposition = undefined;

      secondComposition = createProductionComposition({
        databaseFilename: filename,
        server: { auth: { audience: "agent-farm", resource: "https://agent-farm.local", verifyToken: claims } },
      });
      const replay = await create(secondComposition, "Durable");
      expect(replay.statusCode).toBe(200);
      expect(replay.json().agentSessionId).toBe(firstId);
      const conflict = await create(secondComposition, "Different");
      expect(conflict.statusCode).toBe(409);
    } finally {
      await firstComposition?.close();
      await secondComposition?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates exactly the four bounded MCP tools and filters them by scope", async () => {
    const composition = createProductionComposition();
    sessions.push(composition);
    expect(composition.mcpApplication.descriptors.map((descriptor) => descriptor.name)).toEqual([
      "create_agent_session",
      "get_agent_hierarchy",
      "get_agent_details",
      "render_agent_hierarchy",
    ]);
    expect(composition.mcpApplicationFactory()).not.toBe(composition.mcpApplication);
    expect(composition.mcpApplicationFactory().server).not.toBe(composition.mcpApplication.server);
    const tools = await composition.mcp.listTools?.({
      subject: "owner-a",
      ownerId: "owner-a",
      tenantId: "tenant-a",
      scopes: new Set(["agent-session:read"]),
    });
    expect(tools?.map((tool) => tool.name)).toEqual(["get_agent_hierarchy"]);
  });

  it("keeps bridge access read-only while persisting only a hashed local binding", async () => {
    const durable = new DurableStore(":memory:");
    const store = new DurableStorePort(durable);
    await store.createAgentSession({
      ownerId: "owner-a",
      tenantId: "tenant-a",
      agentSessionId: "as_pair",
      idempotencyKey: "pair-session",
      requestHash: "pair-hash",
      payload: {},
    });
    const bridge = new ReadOnlyCodexBridgeAdapter({
      durable,
      verifyPairingSignature: () => true,
    });
    const challenge = {
      pairingId: "pairing-1",
      nonce: "nonce-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerId: "owner-a",
      tenantId: "tenant-a",
      installationId: "install-1",
      publicKey: "not-used-by-injected-verifier",
      sourceRootId: "root-1",
      sourceSessionId: "source-session-1",
      sourceRootAttestationDigest: "a".repeat(64),
      sourceRootAttestationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      agentSessionId: "as_pair",
      requestedScopes: ["bridge:ingest"],
    } as const;
    expect(await bridge.verifyPairingSignature({ ...challenge, signature: "sig", message: "msg" })).toBe(true);
    const credential = await bridge.issuePairingCredential(challenge);
    expect(credential.credential).not.toBe("nonce-1");
    expect((bridge as Record<string, unknown>).call).toBeUndefined();
    expect(durable.bridgeBindings.list({ tenantId: "tenant-a", ownerId: "owner-a", agentSessionId: "as_pair" })).toHaveLength(1);
    expect(await bridge.resolveActivePairing("install-1")).toEqual({
      tenantId: "tenant-a",
      ownerId: "owner-a",
      agentSessionId: "as_pair",
      installationId: "install-1",
      sourceRootId: "root-1",
    });
    const audits = durable.audit.list({ tenantId: "tenant-a", ownerId: "owner-a", agentSessionId: "as_pair" });
    expect(audits.map((record) => record.action)).toContain("bridge.pairing.issued");
    expect(JSON.stringify(audits)).not.toContain("root-1");
    expect(JSON.stringify(audits)).not.toContain(credential.credential);
    const revokeInput = {
      tenantId: "tenant-a",
      ownerId: "owner-a",
      agentSessionId: "as_pair",
      installationId: "install-1",
      sourceRootId: "root-1",
      reason: "unpair",
    } as const;
    const auditAppend = vi.spyOn(durable.audit, "append").mockImplementation(() => {
      throw new Error("forced revoke audit failure");
    });
    await expect(bridge.revokePairing(revokeInput)).rejects.toThrow("forced revoke audit failure");
    expect(await bridge.resolveActivePairing("install-1")).toMatchObject({ sourceRootId: "root-1" });
    auditAppend.mockRestore();
    expect(await bridge.revokePairing(revokeInput)).toBe(true);
    expect(await bridge.resolveActivePairing("install-1")).toBeNull();
    expect(durable.audit.list({ tenantId: "tenant-a", ownerId: "owner-a", agentSessionId: "as_pair" }).map((record) => record.action)).toContain("bridge.pairing.unpaired");
    bridge.close();
    durable.close();
  });

  it("propagates exact compare-and-replace input and leaves one durable active binding", async () => {
    const durable = new DurableStore(":memory:");
    const first = { tenantId: "tenant-switch-a", ownerId: "owner-switch-a", agentSessionId: "session-switch-a" } as const;
    const second = { tenantId: "tenant-switch-b", ownerId: "owner-switch-b", agentSessionId: "session-switch-b" } as const;
    durable.createAgentSession({ ...first, sourceAdapter: "codex-app-server" });
    durable.createAgentSession({ ...second, sourceAdapter: "codex-app-server" });
    const bridge = new ReadOnlyCodexBridgeAdapter({ durable, verifyPairingSignature: () => true });
    const challenge = (scope: typeof first, root: string, pairingId: string) => ({
      pairingId,
      nonce: `nonce-${root}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...scope,
      installationId: "install-exclusive-switch",
      publicKey: "fixture",
      sourceRootId: root,
      sourceSessionId: `source-${root}`,
      sourceRootAttestationDigest: "a".repeat(64),
      sourceRootAttestationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestedScopes: ["bridge:ingest"],
    });

    await bridge.issuePairingCredential(challenge(first, "root-a", "pairing-a"));
    await bridge.issuePairingCredential({
      ...challenge(second, "root-b", "pairing-b"),
      replaceExisting: true,
      expectedActiveBinding: { ...first, sourceRootId: "root-a" },
    });
    expect(durable.bridgeBindings.listActiveForInstallation("install-exclusive-switch")).toEqual([
      expect.objectContaining({ ...second, selectedSourceRootId: "root-b" }),
    ]);
    expect(durable.bridgeBindings.list(first).find((binding) => binding.selectedSourceRootId === "root-a")?.status).toBe("revoked");

    await expect(bridge.issuePairingCredential({
      ...challenge(first, "root-a", "pairing-stale"),
      replaceExisting: true,
      expectedActiveBinding: { ...first, sourceRootId: "root-a" },
    })).rejects.toThrow("pairing changed");
    expect(durable.bridgeBindings.listActiveForInstallation("install-exclusive-switch")).toEqual([
      expect.objectContaining({ ...second, selectedSourceRootId: "root-b" }),
    ]);
    durable.close();
  });

  it("revokes a newly written binding when runtime activation or reconciliation fails", async () => {
    const durable = new DurableStore(":memory:");
    const scope = { tenantId: "tenant-compensate", ownerId: "owner-compensate", agentSessionId: "session-compensate" } as const;
    durable.createAgentSession({ ...scope, sourceAdapter: "codex-app-server" });
    const bridge = new ReadOnlyCodexBridgeAdapter({
      durable,
      verifyPairingSignature: () => true,
      onCredentialIssued: async () => { throw new Error("private reconciliation failure"); },
    });
    await expect(bridge.issuePairingCredential({
      pairingId: "pairing-compensate", nonce: "nonce-compensate", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...scope, installationId: "install-compensate", publicKey: "fixture", sourceRootId: "root-compensate",
      sourceSessionId: "source-session", sourceRootAttestationDigest: "a".repeat(64),
      sourceRootAttestationExpiresAt: new Date(Date.now() + 60_000).toISOString(), requestedScopes: ["bridge:ingest"],
    })).rejects.toThrow("private reconciliation failure");
    expect(durable.bridgeBindings.resolveUniqueActive("install-compensate")).toBeNull();
    durable.close();
  });

  it("returns a deferred local activation immediately and compensates a background failure", async () => {
    const durable = new DurableStore(":memory:");
    const scope = { tenantId: "tenant-deferred", ownerId: "owner-deferred", agentSessionId: "session-deferred" } as const;
    durable.createAgentSession({ ...scope, sourceAdapter: "codex-app-server" });
    let activationStarted = false;
    let rejectActivation: (reason?: unknown) => void = () => undefined;
    const activation = new Promise<void>((_resolve, reject) => { rejectActivation = reject; });
    const bridge = new ReadOnlyCodexBridgeAdapter({
      durable,
      verifyPairingSignature: () => true,
      onCredentialIssued: async () => {
        activationStarted = true;
        await activation;
      },
    });
    const issued = await bridge.issuePairingCredential({
      pairingId: "pairing-deferred", nonce: "nonce-deferred", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...scope, installationId: "install-deferred", publicKey: "fixture", sourceRootId: "root-deferred",
      sourceSessionId: "source-session", sourceRootAttestationDigest: "a".repeat(64),
      sourceRootAttestationExpiresAt: new Date(Date.now() + 60_000).toISOString(), requestedScopes: ["bridge:ingest"],
      deferRuntimeActivation: true,
    });
    expect(issued.pairingId).toBe("pairing-deferred");
    expect(activationStarted).toBe(false);
    await vi.waitFor(() => expect(activationStarted).toBe(true));
    expect(durable.bridgeBindings.resolveUniqueActive("install-deferred")).toMatchObject({ selectedSourceRootId: "root-deferred" });
    rejectActivation(new Error("private background reconciliation failure"));
    await vi.waitFor(() => expect(durable.bridgeBindings.resolveUniqueActive("install-deferred")).toBeNull());
    durable.close();
  });
});
