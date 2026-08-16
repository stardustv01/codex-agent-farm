import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  InMemoryStdioTransport,
  PHASE_A_SCHEMA_HASHES,
  generateStableSchemaBundle,
  type NormalizedEvent,
  type TestedAdapter,
} from "@agent-farm/codex-bridge";
import { DurableStore } from "@agent-farm/store";

import {
  CodexRuntimeController,
  sanitizeNormalizedEvent,
  type CodexRuntimeBinding,
  type CodexRuntimeSpawnedAppServer,
} from "../src/codex-runtime.js";

const schema = generateStableSchemaBundle();
const scope = { tenantId: "tenant-a", ownerId: "owner-a", agentSessionId: "as-runtime" } as const;
const binding: CodexRuntimeBinding = { ...scope, sourceRootId: "root-thread" };
const testAdapter = {
  adapterVersion: "test-adapter-v1",
  binarySha256: "binary-hash",
  schemaBundleSha256: schema.sha256,
  userAgentPrefix: "Codex Desktop/0.145.0",
} as const;

const stores: DurableStore[] = [];
const controllers: CodexRuntimeController[] = [];

afterEach(async () => {
  while (controllers.length > 0) await controllers.pop()?.close();
  while (stores.length > 0) stores.pop()?.close();
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

function fixture(options: {
  bindingResolver?: () => CodexRuntimeBinding | null;
  sourceThreadAllowed?: (value: CodexRuntimeBinding, sourceThreadId: string) => boolean | Promise<boolean>;
  testedAdapters?: readonly TestedAdapter[];
  schemaHashes?: Readonly<Record<string, string>>;
} = {}): {
  controller: CodexRuntimeController;
  store: DurableStore;
  transport: InMemoryStdioTransport;
  process: ReturnType<typeof processFixture>;
  spawned: CodexRuntimeSpawnedAppServer;
} {
  const store = new DurableStore(":memory:");
  stores.push(store);
  store.createAgentSession({ ...scope, sourceAdapter: "codex-app-server", idempotencyKey: "runtime-session" });
  let transport!: InMemoryStdioTransport;
  transport = new InMemoryStdioTransport({
    onSend: async (line) => {
      const request = JSON.parse(line) as { id?: number; method: string };
      if (request.method === "initialize") {
        await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (fixture)" } }));
      }
    },
  });
  const process = processFixture();
  const spawned = { process, transport };
  const controller = new CodexRuntimeController({
    store,
    executable: "/tmp/codex-fixture",
    binaryPath: "/tmp/codex-fixture",
    binarySha256: "binary-hash",
    schema,
    ...(options.schemaHashes === undefined ? {} : { schemaHashes: options.schemaHashes }),
    testedAdapters: options.testedAdapters ?? [testAdapter],
    bindingResolver: options.bindingResolver ?? (() => binding),
    ...(options.sourceThreadAllowed === undefined ? {} : { sourceThreadAllowed: options.sourceThreadAllowed }),
    spawn: () => spawned,
    connectionEpoch: "epoch-runtime-test",
  });
  controllers.push(controller);
  return { controller, store, transport, process, spawned };
}

function notification(event: "turn/started" | "turn/completed", status: string): string {
  return JSON.stringify({
    method: event,
    params: {
      version: 1,
      threadId: "root-thread",
      turnId: "turn-1",
      status,
      observedAt: "2026-08-09T00:00:00.000Z",
      prompt: "private prompt must never be persisted",
    },
  });
}

describe("CodexRuntimeController", () => {
  it("spawns and gates before pairing while keeping ingestion unpaired", async () => {
    let paired = false;
    const fixtureValue = fixture({ bindingResolver: () => (paired ? binding : null) });
    const { controller, transport } = fixtureValue;
    const status = await controller.connect();
    expect(status.state).toBe("unpaired");
    expect(status.status).toBe("unpaired");
    expect(controller.ready()).toBe(false);
    expect(transport.sentLines.map((line) => JSON.parse(line).method)).toEqual(["initialize", "initialized"]);
    expect(controller.attestationReady()).toBe(true);
    paired = true;
    const activated = await controller.activateBinding();
    expect(activated.state).toBe("connected");
    expect(controller.ready()).toBe(true);
  });

  it("fingerprints, gates, and connects only an explicitly tested adapter", async () => {
    const { controller, transport } = fixture();
    const status = await controller.connect();
    expect(status.state).toBe("connected");
    expect(status.gate).toEqual(expect.objectContaining({ status: "accepted", adapterVersion: "test-adapter-v1" }));
    expect(status.fingerprint?.binarySha256).toBe("binary-hash");
    expect(transport.sentLines.map((line) => JSON.parse(line).method)).toEqual(["initialize", "initialized"]);
  });

  it("passes configured schema-file hashes through the runtime controller gate", async () => {
    const fixtureValue = fixture({
      schemaHashes: PHASE_A_SCHEMA_HASHES,
      testedAdapters: [{ ...testAdapter, schemaHashes: PHASE_A_SCHEMA_HASHES }],
    });
    const status = await fixtureValue.controller.connect();
    expect(status.state).toBe("connected");
    expect(status.fingerprint?.schemaHashes).toEqual(PHASE_A_SCHEMA_HASHES);
  });

  it("quarantines an untested adapter and does not send initialized", async () => {
    const { controller, transport, process } = fixture({ testedAdapters: [] });
    const status = await controller.connect();
    expect(status.state).toBe("quarantined");
    expect(status.reason).toBe("adapter-quarantined");
    expect(status.gate).toEqual(expect.objectContaining({ status: "quarantined" }));
    expect(transport.sentLines.map((line) => JSON.parse(line).method)).toEqual(["initialize"]);
    expect(process.killCount).toBe(1);
  });

  it("ingests normalized events through the public store API, replays idempotently, and drops private fields", async () => {
    const { controller, transport, store } = fixture();
    await controller.connect();
    await transport.pushLine(notification("turn/completed", "completed"));
    await controller.flushEvents();
    await transport.pushLine(notification("turn/completed", "completed"));
    await controller.flushEvents();

    const events = store.events.list(scope);
    expect(events).toHaveLength(1);
    expect(events[0]?.connectionEpoch).toBe("epoch-runtime-test");
    expect(events[0]?.ingestOrdinal).toBe(1);
    expect(events[0]?.sanitizedPayload).not.toHaveProperty("prompt");
    expect(controller.status.lastIngestOutcome).toBe("replayed");
  });

  it("quarantines same-key payload conflicts instead of overwriting the append-only event", async () => {
    const { controller, transport, store } = fixture();
    await controller.connect();
    const collab = (operation: string): string => JSON.stringify({
      method: "collabAgentToolCall",
      params: {
        version: 1,
        threadId: "root-thread",
        turnId: "turn-1",
        observedAt: "2026-08-09T00:00:00.000Z",
        operation,
        senderId: "root-thread",
        receiverIds: ["child-thread"],
      },
    });
    await transport.pushLine(collab("spawn_agent"));
    await controller.flushEvents();
    await transport.pushLine(collab("different_operation"));
    await controller.flushEvents();
    expect(store.events.list(scope)).toHaveLength(1);
    expect(store.events.conflicts(scope)).toHaveLength(1);
    expect(controller.status.lastIngestOutcome).toBe("quarantined");
  });

  it("fails closed for an unrelated source thread and permits a resolver-approved descendant", async () => {
    const allowed = new Set(["child-thread"]);
    const { controller, transport, store } = fixture({
      sourceThreadAllowed: (_value, sourceThreadId) => allowed.has(sourceThreadId),
    });
    await controller.connect();
    const unrelated = notification("turn/started", "started").replace("root-thread", "unrelated-thread");
    await transport.pushLine(unrelated);
    await controller.flushEvents();
    expect(store.events.list(scope)).toHaveLength(0);
    const child = notification("turn/started", "started").replace("root-thread", "child-thread");
    await transport.pushLine(child);
    await controller.flushEvents();
    expect(store.events.list(scope)).toHaveLength(1);
  });

  it("reports disconnect and stops ingestion after the child transport exits", async () => {
    const { controller, transport, process, store } = fixture();
    await controller.connect();
    process.emit("exit", 1, null);
    expect(controller.state).toBe("disconnected");
    await transport.pushLine(notification("turn/started", "started"));
    await controller.flushEvents();
    expect(store.events.list(scope)).toHaveLength(0);
  });

  it("reports a stdio transport failure even when the child has not emitted exit", async () => {
    const { controller, transport, store } = fixture();
    await controller.connect();
    await transport.fail(new Error("private transport diagnostic"));
    expect(controller.state).toBe("disconnected");
    await transport.pushLine(notification("turn/started", "started"));
    await controller.flushEvents();
    expect(store.events.list(scope)).toHaveLength(0);
  });

  it("stops immediately and becomes unpaired when the binding is revoked", async () => {
    let resolveCount = 0;
    const { controller, transport, store } = fixture({
      bindingResolver: () => {
        resolveCount += 1;
        return resolveCount === 1 ? binding : null;
      },
    });
    await controller.connect();
    await transport.pushLine(notification("turn/started", "started"));
    await controller.flushEvents();
    expect(controller.state).toBe("unpaired");
    expect(controller.status.reason).toBe("binding-revoked");
    expect(store.events.list(scope)).toHaveLength(0);
  });

  it("copies only the versioned normalized event surface", () => {
    const event = {
      version: 1,
      kind: "collaboration.observed",
      sourceThreadId: "root-thread",
      collaboration: {
        operation: "spawn_agent",
        senderId: "root-thread",
        receiverIds: ["child-thread"],
        prompt: "private",
      },
      prompt: "private",
    } as unknown as NormalizedEvent;
    const safe = sanitizeNormalizedEvent(event);
    expect(safe).toEqual(expect.objectContaining({ version: 1, kind: "collaboration.observed" }));
    expect(safe).not.toHaveProperty("prompt");
    expect(safe.collaboration).not.toHaveProperty("prompt");
  });

  it("keeps only validated structural subagent path metadata", () => {
    const event = {
      version: 1,
      kind: "subagent.activity",
      sourceThreadId: "root-thread",
      subagentActivity: {
        sourceThreadId: "child-thread",
        parentThreadId: "root-thread",
        agentPath: "/root/dirac/rhea",
        agentTaskName: "rhea",
        prompt: "private prompt",
        path: "/private/not-a-task-path",
      },
    } as unknown as NormalizedEvent;
    const safe = sanitizeNormalizedEvent(event);
    expect(safe.subagentActivity).toEqual(expect.objectContaining({
      sourceThreadId: "child-thread",
      parentThreadId: "root-thread",
      agentPath: "/root/dirac/rhea",
      agentTaskName: "rhea",
    }));
    expect(safe.subagentActivity).not.toHaveProperty("prompt");
    expect(safe.subagentActivity).not.toHaveProperty("path");

    const malformed = sanitizeNormalizedEvent({
      version: 1,
      kind: "subagent.activity",
      sourceThreadId: "root-thread",
      subagentActivity: {
        agentPath: "/tmp/private",
        agentTaskName: "private",
        prompt: "private prompt",
      },
    } as unknown as NormalizedEvent);
    expect(malformed.subagentActivity ?? {}).not.toHaveProperty("agentPath");
    expect(malformed.subagentActivity ?? {}).not.toHaveProperty("agentTaskName");
  });

  it("exposes rollout identity only through the narrow read-only facades", async () => {
    const fixtureValue = fixture();
    await fixtureValue.controller.connect();
    const readOnly = fixtureValue.controller.getReadOnlyClient();
    expect(typeof readOnly.readRolloutIdentity).toBe("function");
    const snapshot = fixtureValue.controller.getSnapshotClient() as {
      readRolloutIdentity?: (threadId: string) => Promise<unknown>;
      call?: unknown;
    } | undefined;
    expect(typeof snapshot?.readRolloutIdentity).toBe("function");
    const metadataOnly = fixtureValue.controller.getSnapshotClient({ metadataOnly: true });
    expect(metadataOnly).toBeDefined();
    expect(metadataOnly).not.toHaveProperty("readRolloutIdentity");
    expect(readOnly).not.toHaveProperty("call");
    expect(snapshot).not.toHaveProperty("call");
  });
});
