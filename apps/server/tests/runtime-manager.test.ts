import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";
import { InMemoryStdioTransport, generateStableSchemaBundle } from "@agent-farm/codex-bridge";
import { DurableStore } from "@agent-farm/store";

import { CodexRuntimeManager } from "../src/runtime-manager.js";

const schema = generateStableSchemaBundle();
const adapter = {
  adapterVersion: "runtime-manager-fixture-v1",
  binarySha256: "runtime-manager-binary",
  schemaBundleSha256: schema.sha256,
  userAgentPrefix: "Codex Desktop/0.145.0",
} as const;
const stores: DurableStore[] = [];
const managers: CodexRuntimeManager[] = [];

afterEach(async () => {
  while (managers.length) await managers.pop()?.stop();
  while (stores.length) stores.pop()?.close();
});

function processFixture(onKill: () => void = () => undefined): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & ChildProcessWithoutNullStreams;
  Object.defineProperty(child, "exitCode", { value: null, writable: true, configurable: true });
  Object.defineProperty(child, "killed", { value: false, writable: true, configurable: true });
  (child as EventEmitter & { kill: () => boolean }).kill = () => {
    onKill();
    return true;
  };
  return child;
}

describe("CodexRuntimeManager", () => {
  it("remounts only the sole active durable chat at startup", async () => {
    const store = new DurableStore(":memory:");
    stores.push(store);
    const first = { tenantId: "tenant-a", ownerId: "owner-a", agentSessionId: "session-a" } as const;
    const second = { tenantId: "tenant-b", ownerId: "owner-b", agentSessionId: "session-b" } as const;
    store.createAgentSession({ ...first, sourceAdapter: "codex-app-server" });
    store.createAgentSession({ ...second, sourceAdapter: "codex-app-server" });
    store.bridgeBindings.activateExclusive(first, { installationId: "install-multi", sourceAdapter: "codex-app-server", selectedSourceRootId: "root-a", credentialHash: "hash-a", expiresAt: Date.now() + 60_000 });
    let spawnCount = 0;
    const manager = new CodexRuntimeManager({
      installationId: "install-multi",
      executable: "/tmp/codex-runtime-manager",
      binaryPath: "/tmp/codex-runtime-manager",
      binarySha256: "runtime-manager-binary",
      schema,
      testedAdapters: [adapter],
      spawn: () => {
        spawnCount += 1;
        let transport!: InMemoryStdioTransport;
        transport = new InMemoryStdioTransport({ onSend: async (line) => {
          const request = JSON.parse(line) as { id?: number; method: string; params?: { threadId?: string } };
          if (request.method === "initialize") await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (fixture)" } }));
          if (request.method === "thread/list") await transport.pushLine(JSON.stringify({ id: request.id, result: { data: [{ id: "root-a", status: "active" }, { id: "root-b", status: "active" }] } }));
          if (request.method === "thread/read") await transport.pushLine(JSON.stringify({ id: request.id, result: { thread: { id: request.params?.threadId, status: "active" }, turns: [] } }));
        } });
        return { process: processFixture(), transport };
      },
      reconciliationIntervalMs: 60_000,
    }, store);
    managers.push(manager);
    await manager.start();
    expect(spawnCount).toBe(2); // one discovery process plus the sole active chat
    expect(manager.ready()).toBe(true);
    expect(manager.connectionStateForScope(first)).toBe("connected");
    expect(manager.connectionStateForScope(second)).toBe("unverified");
    expect(store.agents.list(first).some((agent) => agent.sourceThreadId === "root-a")).toBe(true);
    expect(store.agents.list(first).some((agent) => agent.sourceThreadId === "root-b")).toBe(false);
    expect(store.agents.list(second).some((agent) => agent.sourceThreadId === "root-a")).toBe(false);
  });

  it("stops the old worker, switches back, and never duplicates the selected worker", async () => {
    const store = new DurableStore(":memory:");
    stores.push(store);
    const first = { tenantId: "tenant-exclusive-a", ownerId: "owner-exclusive-a", agentSessionId: "session-exclusive-a" } as const;
    const second = { tenantId: "tenant-exclusive-b", ownerId: "owner-exclusive-b", agentSessionId: "session-exclusive-b" } as const;
    store.createAgentSession({ ...first, sourceAdapter: "codex-app-server" });
    store.createAgentSession({ ...second, sourceAdapter: "codex-app-server" });
    const binding = (root: string) => ({
      installationId: "install-exclusive",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: root,
      credentialHash: `hash-${root}`,
      expiresAt: Date.now() + 60_000,
    });
    store.bridgeBindings.activateExclusive(first, binding("root-a"));
    let spawnCount = 0;
    let killCount = 0;
    const manager = new CodexRuntimeManager({
      installationId: "install-exclusive",
      executable: "/tmp/codex-runtime-manager",
      binaryPath: "/tmp/codex-runtime-manager",
      binarySha256: "runtime-manager-binary",
      schema,
      testedAdapters: [adapter],
      spawn: () => {
        spawnCount += 1;
        let transport!: InMemoryStdioTransport;
        transport = new InMemoryStdioTransport({ onSend: async (line) => {
          const request = JSON.parse(line) as { id?: number; method: string; params?: { threadId?: string } };
          if (request.method === "initialize") await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (fixture)" } }));
          if (request.method === "thread/list") await transport.pushLine(JSON.stringify({ id: request.id, result: { data: [{ id: "root-a", status: "active" }, { id: "root-b", status: "active" }] } }));
          if (request.method === "thread/read") await transport.pushLine(JSON.stringify({ id: request.id, result: { thread: { id: request.params?.threadId, status: "active" }, turns: [] } }));
        } });
        return { process: processFixture(() => { killCount += 1; }), transport };
      },
      reconciliationIntervalMs: 60_000,
    }, store);
    managers.push(manager);
    await manager.start();
    expect(spawnCount).toBe(2);

    store.bridgeBindings.activateExclusive(second, binding("root-b"), {
      replaceExisting: true,
      expectedActiveBinding: { ...first, selectedSourceRootId: "root-a" },
    });
    await manager.ensureExclusivePairing({ ...second, installationId: "install-exclusive", sourceRootId: "root-b" });
    expect(spawnCount).toBe(3);
    expect(killCount).toBe(1);
    expect(manager.connectionStateForScope(first)).toBe("unverified");
    expect(manager.connectionStateForScope(second)).toBe("connected");
    expect(store.bridgeBindings.listActiveForInstallation("install-exclusive")).toEqual([
      expect.objectContaining({ ...second, selectedSourceRootId: "root-b" }),
    ]);

    store.bridgeBindings.activateExclusive(first, binding("root-a"), {
      replaceExisting: true,
      expectedActiveBinding: { ...second, selectedSourceRootId: "root-b" },
    });
    await manager.ensureExclusivePairing({ ...first, installationId: "install-exclusive", sourceRootId: "root-a" });
    expect(spawnCount).toBe(4);
    expect(killCount).toBe(2);
    expect(manager.connectionStateForScope(first)).toBe("connected");
    expect(manager.connectionStateForScope(second)).toBe("unverified");
    expect(store.bridgeBindings.listActiveForInstallation("install-exclusive")).toEqual([
      expect.objectContaining({ ...first, selectedSourceRootId: "root-a" }),
    ]);

    await manager.ensureExclusivePairing({ ...first, installationId: "install-exclusive", sourceRootId: "root-a" });
    expect(spawnCount).toBe(4);
    expect(killCount).toBe(2);
  });

  it("keeps durable chats while evicting the least-recently-used runtime worker", async () => {
    const store = new DurableStore(":memory:");
    stores.push(store);
    const first = { tenantId: "tenant-a", ownerId: "owner-a", agentSessionId: "session-a" } as const;
    const second = { tenantId: "tenant-b", ownerId: "owner-b", agentSessionId: "session-b" } as const;
    const third = { tenantId: "tenant-c", ownerId: "owner-c", agentSessionId: "session-c" } as const;
    const activate = (scope: typeof first, root: string): void => {
      store.createAgentSession({ ...scope, sourceAdapter: "codex-app-server" });
      store.bridgeBindings.activateConcurrent(scope, {
        installationId: "install-bounded",
        sourceAdapter: "codex-app-server",
        selectedSourceRootId: root,
        credentialHash: `hash-${root}`,
        expiresAt: Date.now() + 60_000,
      });
    };
    activate(first, "root-a");
    activate(second, "root-b");
    let spawnCount = 0;
    const manager = new CodexRuntimeManager({
      installationId: "install-bounded",
      executable: "/tmp/codex-runtime-manager",
      binaryPath: "/tmp/codex-runtime-manager",
      binarySha256: "runtime-manager-binary",
      schema,
      testedAdapters: [adapter],
      spawn: () => {
        spawnCount += 1;
        let transport!: InMemoryStdioTransport;
        transport = new InMemoryStdioTransport({ onSend: async (line) => {
          const request = JSON.parse(line) as { id?: number; method: string; params?: { threadId?: string } };
          if (request.method === "initialize") await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: "Codex Desktop/0.145.0 (fixture)" } }));
          if (request.method === "thread/list") await transport.pushLine(JSON.stringify({ id: request.id, result: { data: [{ id: "root-a", status: "active" }, { id: "root-b", status: "active" }, { id: "root-c", status: "active" }] } }));
          if (request.method === "thread/read") await transport.pushLine(JSON.stringify({ id: request.id, result: { thread: { id: request.params?.threadId, status: "active" }, turns: [] } }));
        } });
        return { process: processFixture(), transport };
      },
      reconciliationIntervalMs: 60_000,
    }, store, 2);
    managers.push(manager);
    await manager.start();
    expect(spawnCount).toBe(1); // ambiguous legacy bindings fail closed at startup

    // Exercise the bounded LRU directly as a defense-in-depth fallback.
    await manager.ensurePairing({ ...first, installationId: "install-bounded", sourceRootId: "root-a" });
    await manager.ensurePairing({ ...second, installationId: "install-bounded", sourceRootId: "root-b" });
    expect(spawnCount).toBe(3);

    // Touch A so B is the least-recently-used worker, then add a third durable
    // chat. B's process is released, but its binding and snapshot remain.
    await manager.ensurePairing({ ...first, installationId: "install-bounded", sourceRootId: "root-a" });
    activate(third, "root-c");
    await manager.ensurePairing({ ...third, installationId: "install-bounded", sourceRootId: "root-c" });
    expect(spawnCount).toBe(3); // the evicted worker is safely retargeted
    expect(manager.connectionStateForScope(first)).toBe("connected");
    expect(manager.connectionStateForScope(second)).toBe("unverified");
    expect(manager.connectionStateForScope(third)).toBe("connected");
    expect(store.bridgeBindings.list(second).some((binding) => binding.status === "active")).toBe(true);

    // Switching back remounts B without deleting C's independently stored
    // projection or its durable authorization.
    await manager.ensurePairing({ ...second, installationId: "install-bounded", sourceRootId: "root-b" });
    expect(spawnCount).toBe(3);
    expect(manager.connectionStateForScope(second)).toBe("connected");
    expect(manager.connectionStateForScope(third)).toBe("connected");
    expect(store.bridgeBindings.list(first).some((binding) => binding.status === "active")).toBe(true);
  });
});
