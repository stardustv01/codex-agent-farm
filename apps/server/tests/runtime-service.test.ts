import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InMemoryStdioTransport,
  generateStableSchemaBundle,
} from "@agent-farm/codex-bridge";
import { DurableStore } from "@agent-farm/store";

import {
  CodexRuntimeService,
  createSupportedCodexRuntimeAnchors,
  type ProductionCodexRuntimeOptions,
  type SessionsWatcherFactory,
} from "../src/runtime-service.js";
import type { CodexRuntimeBinding } from "../src/codex-runtime.js";

const schema = generateStableSchemaBundle();
const scope = { tenantId: "tenant-runtime-service", ownerId: "owner-runtime-service", agentSessionId: "session-runtime-service" } as const;
const binding: CodexRuntimeBinding = { ...scope, sourceRootId: "root-thread", status: "active" };
const adapter = {
  adapterVersion: "runtime-service-fixture-v1",
  binarySha256: "runtime-service-binary",
  schemaBundleSha256: schema.sha256,
  userAgentPrefix: "Codex Desktop/0.145.0",
} as const;

const services: CodexRuntimeService[] = [];
const stores: DurableStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (services.length > 0) await services.pop()?.stop();
  while (stores.length > 0) stores.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function processFixture(): ChildProcessWithoutNullStreams & { killCount: number } {
  const process = new EventEmitter() as EventEmitter & ChildProcessWithoutNullStreams & { killCount: number };
  process.killCount = 0;
  Object.defineProperty(process, "exitCode", { value: null, writable: true, configurable: true });
  Object.defineProperty(process, "killed", { get: () => process.killCount > 0 });
  (process as EventEmitter & { kill: () => boolean }).kill = (() => {
    process.killCount += 1;
    return true;
  }) as typeof process.kill;
  return process;
}

function semanticProjectionFingerprint(store: DurableStore): string {
  const identityByAgent = new Map<string, Record<string, string | null>>();
  const evidence = store.identityEvidence.list(scope)
    .sort((left, right) => left.observedAt - right.observedAt || left.evidenceId.localeCompare(right.evidenceId));
  for (const item of evidence) {
    const current = identityByAgent.get(item.agentId) ?? {
      requestedProvider: null,
      requestedModel: null,
      requestedEffort: null,
      observedProvider: null,
      observedModel: null,
      observedEffort: null,
    };
    if (item.requestedProvider !== null) current.requestedProvider = item.requestedProvider;
    if (item.requestedModel !== null) current.requestedModel = item.requestedModel;
    if (item.requestedEffort !== null) current.requestedEffort = item.requestedEffort;
    if (item.observedProvider !== null) current.observedProvider = item.observedProvider;
    if (item.observedModel !== null) current.observedModel = item.observedModel;
    if (item.observedEffort !== null) current.observedEffort = item.observedEffort;
    identityByAgent.set(item.agentId, current);
  }
  const agents = store.agents.list(scope).map((agent) => ({
    agentId: agent.agentId,
    name: agent.name,
    role: agent.role,
    isRoot: agent.isRoot,
    verificationState: agent.verificationState,
    ...(identityByAgent.get(agent.agentId) ?? {
      requestedProvider: null,
      requestedModel: null,
      requestedEffort: null,
      observedProvider: null,
      observedModel: null,
      observedEffort: null,
    }),
  })).sort((left, right) => left.agentId.localeCompare(right.agentId));
  const edges = store.edges.list(scope).map((edge) => ({
    parentAgentId: edge.parentAgentId,
    childAgentId: edge.childAgentId,
    state: "verified",
  })).sort((left, right) => left.parentAgentId.localeCompare(right.parentAgentId) || left.childAgentId.localeCompare(right.childAgentId));
  return createHash("sha256").update(JSON.stringify({ agents, edges }), "utf8").digest("hex");
}

function serviceFixture(
  resolveBinding: (() => CodexRuntimeBinding | null) | null = () => binding,
  overrides: Partial<ProductionCodexRuntimeOptions> = {},
): { service: CodexRuntimeService; store: DurableStore; transport: InMemoryStdioTransport; process: ReturnType<typeof processFixture>; getSpawnCount: () => number } {
  const store = new DurableStore(":memory:");
  stores.push(store);
  store.createAgentSession({
    ...scope,
    sourceAdapter: "codex-app-server",
    rootSourceThreadId: "root-thread",
    idempotencyKey: "runtime-service-session",
  });
  let spawnCount = 0;
  const process = processFixture();
  let transport!: InMemoryStdioTransport;
  transport = new InMemoryStdioTransport({
    onSend: async (line) => {
      const request = JSON.parse(line) as { id?: number; method: string; params?: { threadId?: string } };
      if (request.method === "initialize") {
        await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (fixture)" } }));
      } else if (request.method === "thread/list") {
        await transport.pushLine(JSON.stringify({ id: request.id, result: { data: [{ id: "root-thread", status: "active" }] } }));
      } else if (request.method === "thread/read") {
        await transport.pushLine(JSON.stringify({ id: request.id, result: { thread: { id: request.params?.threadId ?? "root-thread", status: "active" }, turns: [] } }));
      }
    },
  });
  const service = new CodexRuntimeService({
    store,
    executable: "/tmp/codex-runtime-service-fixture",
    binaryPath: "/tmp/codex-runtime-service-fixture",
    binarySha256: "runtime-service-binary",
    schema,
    testedAdapters: [adapter],
    ...(resolveBinding === null ? {} : { bindingResolver: resolveBinding }),
    spawn: () => {
      spawnCount += 1;
      return { process, transport };
    },
    connectionEpoch: "epoch-runtime-service",
    reconciliationIntervalMs: 60_000,
    ...overrides,
  });
  services.push(service);
  return { service, store, transport, process, getSpawnCount: () => spawnCount };
}

describe("CodexRuntimeService", () => {
  it("starts the sessions watcher only after the initial authoritative reconciliation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-runtime-watch-order-"));
    temporaryDirectories.push(directory);
    let watcherStarts = 0;
    const fixture = serviceFixture(() => binding, {
      rolloutIdentity: { sessionsRoot: directory },
      sessionsWatcherFactory: () => {
        watcherStarts += 1;
        return { close: () => undefined };
      },
      onStatusChange: (status) => {
        if (status.reconciliationState === "running") expect(watcherStarts).toBe(0);
      },
    });
    expect((await fixture.service.start()).reconciliationState).toBe("reconciled");
    await Promise.resolve();
    expect(watcherStarts).toBe(1);
  });

  it("keeps the last valid snapshot ready while a background watcher refresh is running", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-runtime-watch-readiness-"));
    temporaryDirectories.push(directory);
    let hint: (() => void) | undefined;
    let listRequests = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let refreshStarted!: () => void;
    const refreshSeen = new Promise<void>((resolve) => { refreshStarted = resolve; });
    const process = processFixture();
    let transport!: InMemoryStdioTransport;
    transport = new InMemoryStdioTransport({ onSend: async (line) => {
      const request = JSON.parse(line) as { id?: number; method: string; params?: { threadId?: string } };
      if (request.method === "initialize") {
        await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (watch readiness fixture)" } }));
      } else if (request.method === "thread/list") {
        listRequests += 1;
        if (listRequests === 3) { refreshStarted(); await refreshGate; }
        await transport.pushLine(JSON.stringify({ id: request.id, result: { data: [{ id: "root-thread", status: "active" }] } }));
      } else if (request.method === "thread/read") {
        await transport.pushLine(JSON.stringify({ id: request.id, result: { thread: { id: request.params?.threadId ?? "root-thread", status: "active" }, turns: [] } }));
      }
    } });
    const fixture = serviceFixture(() => binding, {
      rolloutIdentity: { sessionsRoot: directory },
      sessionsWatcherFactory: (_root, onHint) => {
        hint = onHint;
        return { close: () => undefined };
      },
      sessionsWatcherDebounceMs: 10,
      spawn: () => ({ process, transport }),
    });
    await fixture.service.start();
    expect(fixture.service.ready()).toBe(true);
    hint?.();
    await refreshSeen;
    expect(fixture.service.status.reconciliationState).toBe("running");
    expect(fixture.service.ready()).toBe(true);
    releaseRefresh();
    for (let attempt = 0; attempt < 50 && fixture.service.status.reconciliationState === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(fixture.service.status.reconciliationState).toBe("reconciled");
  });

  it("debounces content-free sessions-root hints and closes the watcher on stop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-runtime-watch-"));
    temporaryDirectories.push(directory);
    let hint: (() => void) | undefined;
    let watcherClosed = 0;
    const watcher: SessionsWatcherFactory = (_root, onHint) => {
      hint = onHint;
      return { close: () => { watcherClosed += 1; } };
    };
    const fixture = serviceFixture(() => binding, {
      rolloutIdentity: { sessionsRoot: directory },
      sessionsWatcherFactory: watcher,
      sessionsWatcherDebounceMs: 10,
    });
    await fixture.service.start();
    const before = fixture.store.events.list(scope).filter((event) => event.eventType === "snapshot.reconciled").length;
    hint?.(); hint?.(); hint?.();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fixture.store.events.list(scope).filter((event) => event.eventType === "snapshot.reconciled").length > before) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(fixture.store.events.list(scope).filter((event) => event.eventType === "snapshot.reconciled")).toHaveLength(before + 1);
    await fixture.service.stop();
    const stoppedAt = fixture.store.events.list(scope).length;
    hint?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.store.events.list(scope)).toHaveLength(stoppedAt);
    expect(watcherClosed).toBe(1);
  });

  it("keeps interval reconciliation available when the sessions watcher fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-runtime-watch-error-"));
    temporaryDirectories.push(directory);
    let fail: (() => void) | undefined;
    let closed = 0;
    const watcher: SessionsWatcherFactory = (_root, _hint, onError) => {
      fail = onError;
      return { close: () => { closed += 1; } };
    };
    const fixture = serviceFixture(() => binding, {
      rolloutIdentity: { sessionsRoot: directory },
      sessionsWatcherFactory: watcher,
      reconciliationIntervalMs: 20,
    });
    await fixture.service.start();
    const before = fixture.store.events.list(scope).filter((event) => event.eventType === "snapshot.reconciled").length;
    fail?.();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fixture.store.events.list(scope).filter((event) => event.eventType === "snapshot.reconciled").length > before) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(closed).toBe(1);
    expect(fixture.store.events.list(scope).filter((event) => event.eventType === "snapshot.reconciled").length).toBeGreaterThan(before);
  });

  it("closes a watcher that reports a synchronous startup error and does not accept its later hint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-runtime-watch-sync-error-"));
    temporaryDirectories.push(directory);
    let hint: (() => void) | undefined;
    let closed = 0;
    const watcher: SessionsWatcherFactory = (_root, onHint, onError) => {
      hint = onHint;
      onError();
      return { close: () => { closed += 1; } };
    };
    const fixture = serviceFixture(() => binding, {
      rolloutIdentity: { sessionsRoot: directory },
      sessionsWatcherFactory: watcher,
      reconciliationIntervalMs: 60_000,
    });
    await fixture.service.start();
    expect(closed).toBe(1);
    const before = fixture.store.events.list(scope).length;
    hint?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.store.events.list(scope)).toHaveLength(before);
  });

  it("does not start the sessions watcher while the runtime is unpaired", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-runtime-watch-unpaired-"));
    temporaryDirectories.push(directory);
    let watcherStarts = 0;
    const fixture = serviceFixture(() => null, {
      rolloutIdentity: { sessionsRoot: directory },
      sessionsWatcherFactory: () => {
        watcherStarts += 1;
        return { close: () => undefined };
      },
    });
    expect((await fixture.service.start()).state).toBe("unpaired");
    expect(watcherStarts).toBe(0);
  });

  it("coalesces a reconciliation burst into one active run and one queued rerun", async () => {
    let listRequests = 0;
    let releaseFirstList!: () => void;
    const firstListGate = new Promise<void>((resolve) => { releaseFirstList = resolve; });
    let firstListStarted!: () => void;
    const firstListSeen = new Promise<void>((resolve) => { firstListStarted = resolve; });
    let queuedRunCompleted!: () => void;
    const queuedRunSeen = new Promise<void>((resolve) => { queuedRunCompleted = resolve; });
    const process = processFixture();
    let transport!: InMemoryStdioTransport;
    transport = new InMemoryStdioTransport({ onSend: async (line) => {
      const request = JSON.parse(line) as { id?: number; method: string; params?: { threadId?: string } };
      if (request.method === "initialize") {
        await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (coalesce fixture)" } }));
        return;
      }
      if (request.method === "thread/list") {
        listRequests += 1;
        if (listRequests === 1) {
          firstListStarted();
          await firstListGate;
        } else if (listRequests === 4) {
          queuedRunCompleted();
        }
        await transport.pushLine(JSON.stringify({ id: request.id, result: { data: [{ id: "root-thread", status: "active" }] } }));
        return;
      }
      if (request.method === "thread/read") {
        await transport.pushLine(JSON.stringify({ id: request.id, result: { thread: { id: request.params?.threadId ?? "root-thread", status: "active" }, turns: [] } }));
      }
    } });
    const { service } = serviceFixture(() => binding, {
      reconcileOnConnect: false,
      spawn: () => ({ process, transport }),
    });
    expect((await service.start()).state).toBe("connected");
    const active = service.reconcileNow();
    await firstListSeen;
    const joinedA = service.reconcileNow();
    const joinedB = service.reconcileNow();
    expect(listRequests).toBe(1);
    releaseFirstList();
    await Promise.all([active, joinedA, joinedB]);
    await queuedRunSeen;
    // Each bounded snapshot reads the active and archived pages. Two calls
    // therefore prove exactly two reconciliations, not two list requests.
    expect(listRequests).toBe(4);
  });

  it("keeps internal reconciliation live when an external projection observer throws", async () => {
    const fixture = serviceFixture(() => binding, {
      onProjectionHint: () => { throw new Error("observer failure"); },
    });
    await fixture.service.start();
    const before = fixture.store.events.list(scope).filter((event) => event.eventType === "snapshot.reconciled").length;
    await fixture.transport.pushLine(JSON.stringify({
      method: "thread/status/changed",
      params: { version: 1, threadId: "root-thread", status: "idle" },
    }));
    await fixture.service.flushEvents();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = fixture.store.events.list(scope).filter((event) => event.eventType === "snapshot.reconciled").length;
      if (current > before) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(fixture.store.events.list(scope).filter((event) => event.eventType === "snapshot.reconciled").length).toBeGreaterThan(before);
  });

  it("cancels a queued rerun when stopped during the active reconciliation", async () => {
    let listRequests = 0;
    let releaseFirstList!: () => void;
    const firstListGate = new Promise<void>((resolve) => { releaseFirstList = resolve; });
    let firstListStarted!: () => void;
    const firstListSeen = new Promise<void>((resolve) => { firstListStarted = resolve; });
    const process = processFixture();
    let transport!: InMemoryStdioTransport;
    transport = new InMemoryStdioTransport({ onSend: async (line) => {
      const request = JSON.parse(line) as { id?: number; method: string; params?: { threadId?: string } };
      if (request.method === "initialize") {
        await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (stop fixture)" } }));
      } else if (request.method === "thread/list") {
        listRequests += 1;
        if (listRequests === 1) { firstListStarted(); await firstListGate; }
        await transport.pushLine(JSON.stringify({ id: request.id, result: { data: [{ id: "root-thread", status: "active" }] } }));
      } else if (request.method === "thread/read") {
        await transport.pushLine(JSON.stringify({ id: request.id, result: { thread: { id: request.params?.threadId ?? "root-thread", status: "active" }, turns: [] } }));
      }
    } });
    const { service } = serviceFixture(() => binding, { reconcileOnConnect: false, spawn: () => ({ process, transport }) });
    await service.start();
    const active = service.reconcileNow();
    await firstListSeen;
    void service.reconcileNow();
    const stopped = service.stop();
    releaseFirstList();
    await Promise.all([active, stopped]);
    expect(listRequests).toBe(2);
    expect(service.status.running).toBe(false);
  });

  it("returns the Phase-A schema-file evidence as a required adapter anchor", () => {
    const anchors = createSupportedCodexRuntimeAnchors();
    expect(Object.keys(anchors.schemaHashes)).toHaveLength(4);
    expect(anchors.testedAdapters[0]?.schemaHashes).toEqual(anchors.schemaHashes);
  });

  it("starts, gates, reconciles through the narrow snapshot facade, and stops truthfully", async () => {
    const { service, store, process } = serviceFixture();
    const status = await service.start();

    expect(status.state).toBe("connected");
    expect(status.reconciliation.state).toBe("reconciled");
    expect(status.reconciliation.lastResult?.reconciliationRevision).toContain("runtime-reconcile:");
    expect(store.agents.list(scope)).toHaveLength(1);
    expect(service.ready()).toBe(true);

    const stopped = await service.stop();
    expect(stopped.state).toBe("disconnected");
    expect(stopped.running).toBe(false);
    expect(stopped.reason).toBe("stopped");
    expect(service.ready()).toBe(false);
    expect(process.killCount).toBe(1);
  });

  it("enriches from the exact local rollout while every app-server read stays metadata-only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-runtime-local-rollout-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "rollout-2026-08-12-root-thread.jsonl"), [
      { type: "session_meta", payload: { id: "root-thread", model_provider: "openai" } },
      { type: "turn_context", payload: { turn_id: "turn-root", model_provider: "openai", model: "gpt-5.6-sol", effort: "high" } },
      { type: "response_item", payload: { type: "message", role: "assistant", text: "allowed final summary" } },
      { type: "response_item", payload: { type: "message", role: "assistant", text: "password: do-not-expose" } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    const includeTurns: Array<boolean | undefined> = [];
    const fixture = serviceFixture(() => binding, {
      rolloutIdentity: { sessionsRoot: directory },
      spawn: () => {
        const process = processFixture();
        let transport!: InMemoryStdioTransport;
        transport = new InMemoryStdioTransport({ onSend: async (line) => {
          const request = JSON.parse(line) as { id?: number; method: string; params?: { threadId?: string; includeTurns?: boolean } };
          if (request.method === "initialize") await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (fixture)" } }));
          if (request.method === "thread/list") await transport.pushLine(JSON.stringify({ id: request.id, result: { data: [{ id: "root-thread", status: "active" }] } }));
          if (request.method === "thread/read") {
            includeTurns.push(request.params?.includeTurns);
            await transport.pushLine(JSON.stringify({ id: request.id, result: { thread: { id: request.params?.threadId ?? "root-thread", status: "active" }, turns: [] } }));
          }
        } });
        return { process, transport };
      },
    });
    expect((await fixture.service.start()).reconciliationState).toBe("reconciled");
    expect(includeTurns).toEqual([false]);
    const agent = fixture.store.agents.list(scope)[0]!;
    expect(agent).toMatchObject({ verificationState: "unverified" });
    expect(fixture.store.identityEvidence.list(scope).find((item) => item.agentId === agent.agentId)).toMatchObject({ observedModel: "gpt-5.6-sol", observedEffort: "high" });
    const detail = await fixture.service.getReadOnlyClient().readRolloutLocalDetail?.("root-thread");
    expect(detail?.messages.map((message) => message.text)).toEqual(["allowed final summary"]);
    expect(JSON.stringify(detail)).not.toContain("do-not-expose");
    expect(includeTurns).toEqual([false]);
  });

  it("adds exact local rollout descendants while app-server remains metadata-only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-runtime-local-topology-"));
    temporaryDirectories.push(directory);
    const writeRollout = (id: string, parent: string, path: string): void => {
      writeFileSync(join(directory, `rollout-${id}.jsonl`), [
        { type: "session_meta", payload: { id, parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: path } } } } },
        { type: "event_msg", payload: { type: "task_completed" } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    };
    writeRollout("child-one", "root-thread", "/root/one");
    writeRollout("child-two", "child-one", "/root/one/two");
    writeRollout("child-three", "child-two", "/root/one/two/three");
    const includeTurns: Array<boolean | undefined> = [];
    const fixture = serviceFixture(() => binding, {
      rolloutIdentity: { sessionsRoot: directory },
      spawn: () => {
        const process = processFixture();
        let transport!: InMemoryStdioTransport;
        transport = new InMemoryStdioTransport({ onSend: async (line) => {
          const request = JSON.parse(line) as { id?: number; method: string; params?: { threadId?: string; includeTurns?: boolean; archived?: boolean } };
          if (request.method === "initialize") await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (topology fixture)" } }));
          if (request.method === "thread/list") await transport.pushLine(JSON.stringify({ id: request.id, result: { data: request.params?.archived === true ? [] : [{ id: "root-thread", status: "active" }] } }));
          if (request.method === "thread/read") {
            includeTurns.push(request.params?.includeTurns);
            await transport.pushLine(JSON.stringify({ id: request.id, result: { thread: { id: "root-thread", status: "active" }, turns: [] } }));
          }
        } });
        return { process, transport };
      },
    });
    expect((await fixture.service.start()).reconciliationState).toBe("reconciled");
    expect(includeTurns).toEqual([false]);
    expect(fixture.store.agents.list(scope)).toHaveLength(4);
    expect(fixture.store.edges.list(scope)).toHaveLength(3);
  });

  it("rebuilds a durable three-child projection after restart without oversized turn reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-runtime-restart-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "local.sqlite");
    const threads = [
      { id: "root-thread", status: "active", agentNickname: "Main" },
      { id: "child-one", parentThreadId: "root-thread", status: "active", agentNickname: "Atlas" },
      { id: "child-two", parentThreadId: "root-thread", status: "completed", agentNickname: "Vega" },
      { id: "child-three", parentThreadId: "root-thread", status: "idle", agentNickname: "Ceres" },
    ] as const;
    const makeService = (): { service: CodexRuntimeService; store: DurableStore; process: ReturnType<typeof processFixture> } => {
      const durable = new DurableStore(filename);
      stores.push(durable);
      durable.createAgentSession({
        ...scope,
        sourceAdapter: "codex-app-server",
        rootSourceThreadId: "root-thread",
        idempotencyKey: "runtime-restart-session",
      });
      durable.bridgeBindings.upsert(scope, {
        installationId: "installation-runtime-restart",
        sourceAdapter: "codex-app-server",
        selectedSourceRootId: "root-thread",
        credentialHash: "credential-hash-only",
        nonceHash: "nonce-hash-only",
        expiresAt: Date.now() + 60_000,
      });
      const child = processFixture();
      let transport!: InMemoryStdioTransport;
      transport = new InMemoryStdioTransport({
        onSend: async (line) => {
          const request = JSON.parse(line) as { id?: number; method: string; params?: { archived?: boolean; threadId?: string; includeTurns?: boolean } };
          if (request.method === "initialize") {
            await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (restart-fixture)" } }));
            return;
          }
          if (request.method === "thread/list") {
            await transport.pushLine(JSON.stringify({
              id: request.id,
              result: { data: request.params?.archived === true ? [] : threads },
            }));
            return;
          }
          if (request.method === "thread/read") {
            const thread = threads.find((candidate) => candidate.id === request.params?.threadId) ?? threads[0];
            // The production metadata-only facade must force includeTurns=false
            // even though the reconciler requests the richer shape.
            expect(request.params?.includeTurns).toBe(false);
            await transport.pushLine(JSON.stringify({ id: request.id, result: { thread, turns: [] } }));
          }
        },
      });
      const runtime = new CodexRuntimeService({
        store: durable,
        executable: "/tmp/codex-runtime-restart-fixture",
        binaryPath: "/tmp/codex-runtime-restart-fixture",
        binarySha256: "runtime-service-binary",
        schema,
        testedAdapters: [adapter],
        durableBinding: { scope, installationId: "installation-runtime-restart" },
        spawn: () => ({ process: child, transport }),
        connectionEpoch: `epoch-runtime-restart-${services.length}`,
        reconciliationIntervalMs: 60_000,
      });
      services.push(runtime);
      return { service: runtime, store: durable, process: child };
    };

    const first = makeService();
    const firstStatus = await first.service.start();
    expect(firstStatus.state).toBe("connected");
    expect(firstStatus.reconciliation.state).toBe("reconciled");
    expect(first.store.agents.list(scope)).toHaveLength(4);
    expect(first.store.edges.list(scope)).toHaveLength(3);
    expect(first.store.agents.list(scope).every((agent) => agent.verificationState === "unverified")).toBe(true);
    await first.service.stop();
    services.splice(services.indexOf(first.service), 1);
    stores.splice(stores.indexOf(first.store), 1);
    first.store.close();

    const second = makeService();
    const secondStatus = await second.service.start();
    expect(secondStatus.state).toBe("connected");
    expect(secondStatus.reconciliation.state).toBe("reconciled");
    expect(second.store.agents.list(scope)).toHaveLength(4);
    expect(second.store.edges.list(scope)).toHaveLength(3);
    expect(second.store.agents.list(scope).every((agent) => agent.verificationState === "unverified")).toBe(true);
    expect(second.store.rebuildSnapshot(scope).equivalentToLiveProjection).toBe(true);
  });

  it("spawns/gates while unpaired, then activates the same client after pairing", async () => {
    let paired = false;
    const fixture = serviceFixture(() => (paired ? binding : null), { reconcileOnConnect: false });

    expect((await fixture.service.start()).state).toBe("unpaired");
    expect(fixture.getSpawnCount()).toBe(1);
    expect(fixture.service.attestationReady()).toBe(true);
    paired = true;
    expect((await fixture.service.retry()).state).toBe("connected");
    expect(fixture.getSpawnCount()).toBe(1);
  });

  it("re-resolves the durable binding before retrying an already connected runtime", async () => {
    const fixture = serviceFixture(() => binding, { reconcileOnConnect: false });
    expect((await fixture.service.start()).state).toBe("connected");
    const controller = (fixture.service as unknown as {
      controller: { activateBinding: () => Promise<unknown> };
    }).controller;
    const activateBinding = vi.spyOn(controller, "activateBinding");

    expect((await fixture.service.retry()).state).toBe("connected");
    expect(activateBinding).toHaveBeenCalledOnce();
    expect(fixture.getSpawnCount()).toBe(1);
  });

  it("resolves an active binding through the durable bridge-binding repository", async () => {
    const fixture = serviceFixture(null, {
      reconcileOnConnect: false,
      durableBinding: { scope, installationId: "installation-service" },
    });
    fixture.store.bridgeBindings.upsert(scope, {
      installationId: "installation-service",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: "root-thread",
      credentialHash: "hash-only",
      expiresAt: Date.now() + 60_000,
    });

    expect((await fixture.service.start()).state).toBe("connected");
  });

  it("quarantines missing adapter anchors before a child launch", async () => {
    const fixture = serviceFixture(() => binding, {
      testedAdapters: [],
    });

    const status = await fixture.service.start();
    expect(status.state).toBe("quarantined");
    expect(status.reason).toBe("unsupported-adapter");
    expect(fixture.getSpawnCount()).toBe(0);
  });

  it("keeps connection-local lifecycle transitions distinct while replaying an exact duplicate", async () => {
    const { service, store, transport } = serviceFixture(() => binding);
    await service.start();

    const pushStatus = async (status: string): Promise<void> => {
      await transport.pushLine(JSON.stringify({
        method: "thread/status/changed",
        params: { version: 1, threadId: "root-thread", status },
      }));
      await service.flushEvents();
    };
    await pushStatus("active");
    await pushStatus("idle");
    await pushStatus("active");
    await pushStatus("active");

    const events = store.events.list(scope).filter((event) => event.eventType === "thread.status.changed");
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.sanitizedPayload.status)).toEqual(["active", "idle", "active"]);
    expect(new Set(events.map((event) => event.eventKey)).size).toBe(3);
    expect(store.agents.list(scope)[0]?.lifecycle).toBe("active");
  });

  it("reports a dropped child as disconnected and reconnects with a fresh epoch without duplicating the projection", async () => {
    const store = new DurableStore(":memory:");
    stores.push(store);
    store.createAgentSession({
      ...scope,
      sourceAdapter: "codex-app-server",
      rootSourceThreadId: "root-thread",
      idempotencyKey: "runtime-recovery-session",
    });
    const processes: Array<ReturnType<typeof processFixture>> = [];
    const transports: InMemoryStdioTransport[] = [];
    const service = new CodexRuntimeService({
      store,
      executable: "/tmp/codex-runtime-recovery-fixture",
      binaryPath: "/tmp/codex-runtime-recovery-fixture",
      binarySha256: "runtime-service-binary",
      schema,
      testedAdapters: [adapter],
      bindingResolver: () => binding,
      spawn: () => {
        const process = processFixture();
        let transport!: InMemoryStdioTransport;
        transport = new InMemoryStdioTransport({
          onSend: async (line) => {
            const request = JSON.parse(line) as { id?: number; method: string; params?: { threadId?: string } };
            if (request.method === "initialize") {
              await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (recovery fixture)" } }));
            } else if (request.method === "thread/list") {
              await transport.pushLine(JSON.stringify({ id: request.id, result: { data: [{ id: "root-thread", status: "active" }] } }));
            } else if (request.method === "thread/read") {
              await transport.pushLine(JSON.stringify({ id: request.id, result: { thread: { id: request.params?.threadId ?? "root-thread", status: "active" }, turns: [] } }));
            }
          },
        });
        processes.push(process);
        transports.push(transport);
        return { process, transport };
      },
      reconciliationIntervalMs: 60_000,
    });
    services.push(service);

    const first = await service.start();
    expect(first.state).toBe("connected");
    expect(first.reconciliationState).toBe("reconciled");
    expect(processes).toHaveLength(1);
    expect(transports).toHaveLength(1);
    const firstEpoch = first.connectionEpoch;
    const firstAgents = store.agents.list(scope);
    const firstEdges = store.edges.list(scope);
    const firstSemanticFingerprint = semanticProjectionFingerprint(store);
    expect(firstAgents).toHaveLength(1);
    expect(firstEdges).toHaveLength(0);

    await transports[0]?.fail(new Error("private dropped-transport diagnostic"));
    expect(service.state).toBe("disconnected");
    expect(service.status.reconciliationState).toBe("reconciled");
    expect(service.ready()).toBe(false);

    const recovered = await service.retry();
    expect(recovered.state).toBe("connected");
    expect(recovered.reconciliationState).toBe("reconciled");
    expect(processes).toHaveLength(2);
    expect(processes[1]).not.toBe(processes[0]);
    expect(recovered.connectionEpoch).toBeDefined();
    expect(recovered.connectionEpoch).not.toBe(firstEpoch);
    expect(store.agents.list(scope)).toHaveLength(firstAgents.length);
    expect(store.edges.list(scope)).toHaveLength(firstEdges.length);
    expect(semanticProjectionFingerprint(store)).toBe(firstSemanticFingerprint);
    const events = store.events.list(scope);
    expect(new Set(events.map((event) => event.eventKey)).size).toBe(events.length);
    expect(store.rebuildSnapshot(scope).equivalentToLiveProjection).toBe(true);
    expect(service.ready()).toBe(true);

    await service.stop();
    expect(processes[0]?.killCount).toBe(1);
    expect(processes[1]?.killCount).toBe(1);
  });
});
