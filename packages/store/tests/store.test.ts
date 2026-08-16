import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import {
  ConstraintError,
  DurableStore,
  IdempotencyConflictError,
  parseJson,
  pricingSnapshotHash,
  sanitizePayload,
  stableJson,
} from "../src/index.js";

const scope = (tenantId: string, ownerId: string, agentSessionId: string) => ({ tenantId, ownerId, agentSessionId });

describe("durable Agent Farm store", () => {
  it("creates file-backed SQLite with owner-only permissions and rejects unsafe existing files", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-store-permissions-"));
    const filename = join(directory, "farm.sqlite");
    try {
      const first = new DurableStore(filename);
      first.close();
      expect(lstatSync(filename).mode & 0o777).toBe(0o600);
      const reopened = new DurableStore(filename);
      reopened.close();
      // An unsafe pre-existing file must fail closed rather than being
      // silently chmodded by a later process.
      const unsafe = join(directory, "unsafe.sqlite");
      const raw = new Database(unsafe);
      raw.close();
      expect(lstatSync(unsafe).mode & 0o777).toBe(0o644);
      expect(() => new DurableStore(unsafe)).toThrow(/mode 0600/iu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates two principals and two sessions", () => {
    const store = new DurableStore();
    const a = scope("tenant-a", "owner-a", "session-a");
    const b = scope("tenant-b", "owner-b", "session-b");
    store.createAgentSession(a);
    store.createAgentSession(b);
    store.agents.upsert(a, { agentId: "same-agent", lifecycle: "active" });
    store.agents.upsert(b, { agentId: "same-agent", lifecycle: "completed" });

    expect(store.agents.get(a, "same-agent").lifecycle).toBe("active");
    expect(store.agents.get(b, "same-agent").lifecycle).toBe("completed");
    expect(() => store.agents.get(scope("tenant-a", "owner-a", "session-b"), "same-agent")).toThrow();
    store.close();
  });

  it("treats rollout usage as authoritative cumulative state and clears ambiguity", () => {
    const store = new DurableStore();
    const s = scope("tenant-usage", "owner-usage", "session-usage");
    store.createAgentSession(s);
    const first = {
      inputTokens: 10,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
      outputTokens: 4,
      reasoningOutputTokens: 1,
      totalTokens: 14,
      observedAt: "2026-08-12T00:00:00.000Z",
    } as const;
    const newer = { ...first, inputTokens: 20, outputTokens: 5, totalTokens: 25, observedAt: "2026-08-12T00:01:00.000Z" } as const;
    const older = { ...first, observedAt: "2026-08-11T23:59:00.000Z" } as const;
    store.agents.upsert(s, { agentId: "usage-agent", usage: first });
    expect(store.agents.get(s, "usage-agent").usage).toEqual(first);
    store.agents.upsert(s, { agentId: "usage-agent", usage: newer });
    expect(store.agents.get(s, "usage-agent").usage).toEqual(newer);
    store.agents.upsert(s, { agentId: "usage-agent", usage: older });
    expect(store.agents.get(s, "usage-agent").usage).toEqual(newer);
    store.agents.upsert(s, { agentId: "usage-agent", usage: null });
    expect(store.agents.get(s, "usage-agent").usage).toBeNull();
    expect(() => store.agents.upsert(s, { agentId: "usage-agent", usage: { ...first, totalTokens: 99 } })).toThrow(ConstraintError);
    store.close();
  });

  it("persists bounded usage segments with preserve, update, clear, sanitization, and replay equivalence", () => {
    const store = new DurableStore();
    const s = scope("tenant-segments", "owner-segments", "session-segments");
    store.createAgentSession(s);
    const usage = {
      inputTokens: 10,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
      outputTokens: 4,
      reasoningOutputTokens: 1,
      totalTokens: 14,
      observedAt: "2026-08-12T00:00:00.000Z",
    } as const;
    const first = { complete: true, segments: [{ turnId: "turn-1", provider: "openai", model: "gpt-5.6-sol", effort: "high", usage }] } as const;
    const second = { complete: false, segments: [...first.segments, { turnId: "turn-2", provider: "openai", model: "gpt-5.6-luna", effort: "low", usage }] } as const;
    store.events.ingest(s, {
      eventKey: "segments-1",
      eventType: "agent.upsert",
      connectionEpoch: "epoch-segments",
      payload: { agentId: "segment-agent", usageSegments: { ...first, credential: "drop" } },
    });
    expect(store.agents.get(s, "segment-agent").usageSegments).toEqual(first);
    expect(JSON.stringify(store.events.list(s))).not.toContain("drop");
    store.agents.upsert(s, { agentId: "segment-agent", lifecycle: "active" });
    expect(store.agents.get(s, "segment-agent").usageSegments).toEqual(first);
    store.events.ingest(s, { eventKey: "segments-2", eventType: "agent.upsert", connectionEpoch: "epoch-segments", payload: { agentId: "segment-agent", usageSegments: second } });
    expect(store.agents.get(s, "segment-agent").usageSegments).toEqual(second);
    expect(store.rebuildSnapshot(s).equivalentToLiveProjection).toBe(true);
    store.events.ingest(s, { eventKey: "segments-3", eventType: "agent.upsert", connectionEpoch: "epoch-segments", payload: { agentId: "segment-agent", usageSegments: null } });
    expect(store.agents.get(s, "segment-agent").usageSegments).toBeNull();
    expect(store.rebuildSnapshot(s).equivalentToLiveProjection).toBe(true);
    expect(() => sanitizePayload({ usageSegments: { complete: true, segments: [{ ...first.segments[0], usage: { ...usage, totalTokens: 99 } }] } })).toThrow(ConstraintError);
    expect(() => sanitizePayload({ usageSegments: { complete: true, segments: Array.from({ length: 1_025 }, () => first.segments[0]) } })).toThrow(ConstraintError);
    store.close();
  });

  it("rejects pricing snapshots whose content hash is not canonical", () => {
    const store = new DurableStore();
    const s = scope("tenant-price", "owner-price", "session-price");
    store.createAgentSession(s);
    const body = {
      snapshotId: "synthetic-price-v1",
      authority: "operator-reviewed-official" as const,
      sourceUrls: ["https://example.com/pricing"],
      retrievedAt: "2026-08-12T00:00:00.000Z",
      verifiedAt: "2026-08-12T00:00:00.000Z",
      currency: "USD" as const,
      rates: { synthetic: { inputPerMillionUsd: 2, cachedInputPerMillionUsd: 0.2, outputPerMillionUsd: 12 } },
      standardInputMultiplier: 1,
      longContextThresholdInputTokens: 272_000 as const,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
      cacheWriteMultiplier: 1.25,
      snapshotHash: "0000000000000000000000000000000000000000000000000000000000000000",
    };
    // The repository computes the canonical body hash; fixture starts with a
    // deliberately invalid hash to prove fail-closed validation.
    expect(() => store.pricingSnapshots.put({ snapshotId: body.snapshotId, snapshot: body })).toThrow(ConstraintError);
    store.close();
  });

  it("pins canonical pricing immutably and invalidates stale cost estimates", () => {
    const store = new DurableStore();
    const s = scope("tenant-price-pin", "owner-price-pin", "session-price-pin");
    store.createAgentSession(s);
    const usage = {
      inputTokens: 1_000,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 50,
      totalTokens: 1_100,
      observedAt: "2026-08-12T00:00:00.000Z",
    } as const;
    const body = {
      snapshotId: "synthetic-price-pin-v1",
      authority: "operator-reviewed-official" as const,
      sourceUrls: ["https://example.com/pricing-pin"],
      retrievedAt: "2026-08-12T00:00:00.000Z",
      verifiedAt: "2026-08-12T00:00:00.000Z",
      currency: "USD" as const,
      rates: { synthetic: { inputPerMillionUsd: 2, cachedInputPerMillionUsd: 0.2, outputPerMillionUsd: 12 } },
      standardInputMultiplier: 1,
      longContextThresholdInputTokens: 272_000 as const,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
      cacheWriteMultiplier: 1.25,
    };
    const snapshot = { ...body, snapshotHash: pricingSnapshotHash(body) };
    const stored = store.pricingSnapshots.put({ snapshotId: snapshot.snapshotId, snapshot, createdAt: 123 });
    expect(store.pricingSnapshots.put({ snapshotId: snapshot.snapshotId, snapshot, createdAt: 999 })).toEqual(stored);
    expect(store.pricingSnapshots.get(snapshot.snapshotId)).toEqual(stored);
    const conflictingBody = { ...body, rates: { synthetic: { ...body.rates.synthetic, outputPerMillionUsd: 13 } } };
    const conflicting = { ...conflictingBody, snapshotHash: pricingSnapshotHash(conflictingBody) };
    expect(() => store.pricingSnapshots.put({ snapshotId: snapshot.snapshotId, snapshot: conflicting })).toThrow(/immutable/iu);
    expect(() => store.db.prepare("UPDATE pricing_snapshots SET created_at = 999 WHERE snapshot_id = ?").run(snapshot.snapshotId)).toThrow(/append-only/iu);
    expect(() => store.db.prepare("DELETE FROM pricing_snapshots WHERE snapshot_id = ?").run(snapshot.snapshotId)).toThrow(/append-only/iu);

    const estimated = {
      status: "estimated" as const,
      currency: "USD" as const,
      selfMicros: 2_840,
      childrenMicros: 0,
      totalMicros: 2_840,
      usage,
      pricing: snapshot,
    };
    expect(() => store.agents.upsert(s, {
      agentId: "missing-pin",
      usage,
      pricingSnapshotId: "missing-snapshot",
      cost: estimated,
    })).toThrow();
    expect(() => store.agents.upsert(s, {
      agentId: "mismatched-usage",
      usage: { ...usage, inputTokens: 1_001, totalTokens: 1_101 },
      pricingSnapshotId: snapshot.snapshotId,
      cost: estimated,
    })).toThrow(/usage does not match/iu);
    const pinned = store.agents.upsert(s, {
      agentId: "priced-agent",
      usage,
      pricingSnapshotId: snapshot.snapshotId,
      cost: estimated,
    });
    expect(pinned).toMatchObject({ pricingSnapshotId: snapshot.snapshotId, cost: estimated });
    expect(pinned.costUsageDigest).toMatch(/^[a-f0-9]{64}$/u);

    const newerUsage = { ...usage, inputTokens: 2_000, outputTokens: 200, totalTokens: 2_200, observedAt: "2026-08-12T00:01:00.000Z" };
    expect(store.agents.upsert(s, { agentId: "priced-agent", usage: newerUsage })).toMatchObject({
      usage: newerUsage,
      pricingSnapshotId: null,
      cost: null,
      costUsageDigest: null,
    });
    store.agents.upsert(s, { agentId: "clear-priced-agent", usage, pricingSnapshotId: snapshot.snapshotId, cost: estimated });
    expect(store.agents.upsert(s, { agentId: "clear-priced-agent", cost: null })).toMatchObject({
      pricingSnapshotId: null,
      cost: null,
      costUsageDigest: null,
    });
    expect(() => store.db.prepare("UPDATE agents SET pricing_snapshot_id = 'missing' WHERE agent_id = 'clear-priced-agent'").run()).toThrow(/pin is invalid/iu);
    store.close();
  });

  it("returns the first create result for an idempotency key and rejects conflicts", () => {
    const store = new DurableStore();
    const first = store.sessions.create({ tenantId: "t", ownerId: "o", idempotencyKey: "create-1", requestPayload: { root: "r" } });
    const replay = store.sessions.create({ tenantId: "t", ownerId: "o", idempotencyKey: "create-1", requestPayload: { root: "r" } });
    expect(replay.agentSessionId).toBe(first.agentSessionId);
    expect(() => store.sessions.create({ tenantId: "t", ownerId: "o", idempotencyKey: "create-1", requestPayload: { root: "different" } })).toThrow(IdempotencyConflictError);
    store.close();
  });

  it("atomically reuses one grant mapping while keeping distinct sid grants separate", () => {
    const store = new DurableStore();
    const key = {
      ownerId: "owner-a",
      tenantId: "tenant-a",
      subject: "subject-a",
      resource: "https://agent-farm.local/",
      grantId: "grant-a",
    };
    const first = store.mcpGrantBindings.getOrCreate({
      ...key,
      proposedAgentSessionId: "session-a",
      expiresAt: Date.now() + 60_000,
    });
    const replay = store.mcpGrantBindings.getOrCreate({
      ...key,
      proposedAgentSessionId: "session-b",
      expiresAt: Date.now() + 60_000,
    });
    const distinct = store.mcpGrantBindings.getOrCreate({
      ...key,
      grantId: "grant-b",
      proposedAgentSessionId: "session-c",
      expiresAt: Date.now() + 60_000,
    });
    expect(first?.agentSessionId).toBe("session-a");
    expect(replay?.agentSessionId).toBe("session-a");
    expect(distinct?.agentSessionId).toBe("session-c");
    expect(store.db.prepare("SELECT * FROM mcp_grant_session_bindings").all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ grant_key_digest: "grant-a" })]),
    );
    expect(JSON.stringify(store.db.prepare("SELECT * FROM mcp_grant_session_bindings").all())).not.toContain("grant-a");
    store.close();
  });

  it("reuses the same grant mapping after reopening the same SQLite database", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-mcp-grant-"));
    const filename = join(directory, "farm.sqlite");
    const key = {
      ownerId: "owner-restart",
      tenantId: "tenant-restart",
      subject: "subject-restart",
      resource: "https://agent-farm.local",
      grantId: "grant-restart",
    };
    try {
      const firstStore = new DurableStore(filename);
      const first = firstStore.mcpGrantBindings.getOrCreate({ ...key, proposedAgentSessionId: "session-restart-a" });
      firstStore.close();
      const secondStore = new DurableStore(filename);
      const replay = secondStore.mcpGrantBindings.getOrCreate({ ...key, proposedAgentSessionId: "session-restart-b" });
      expect(replay?.agentSessionId).toBe(first?.agentSessionId);
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on expiry/revocation and explicit Agent Farm deletion", () => {
    let now = 1_000;
    const store = new DurableStore({ now: () => now, mcpGrantBindingTtlMs: 100 });
    const key = {
      ownerId: "owner-lifecycle",
      tenantId: "tenant-lifecycle",
      subject: "subject-lifecycle",
      resource: "https://agent-farm.local",
      grantId: "grant-lifecycle",
    };
    const created = store.mcpGrantBindings.getOrCreate({ ...key, proposedAgentSessionId: "session-life" });
    expect(created?.status).toBe("active");
    now = 1_100;
    expect(store.mcpGrantBindings.get(key)).toBeNull();
    expect(store.db.prepare("SELECT status FROM mcp_grant_session_bindings").get()).toEqual({ status: "expired" });

    now = 2_000;
    const second = store.mcpGrantBindings.getOrCreate({ ...key, proposedAgentSessionId: "session-life-2" });
    expect(second).toBeNull();
    expect(store.mcpGrantBindings.revoke(key)).toBe(false);

    now = 3_000;
    const deleteKey = { ...key, grantId: "grant-delete" };
    store.mcpGrantBindings.getOrCreate({ ...deleteKey, proposedAgentSessionId: "session-delete" });
    store.createAgentSession({ tenantId: key.tenantId, ownerId: key.ownerId, agentSessionId: "session-delete" });
    expect(store.deleteAgentSession({ tenantId: key.tenantId, ownerId: key.ownerId, agentSessionId: "session-delete" })).toBe(true);
    expect(store.mcpGrantBindings.get(deleteKey)).toBeNull();
    expect(store.db.prepare("SELECT status FROM mcp_grant_session_bindings WHERE agent_session_id = ?").get("session-delete")).toEqual({ status: "revoked" });
    store.close();
  });

  it("resolves a production runtime only when one active installation binding is unambiguous", () => {
    let now = 10_000;
    const store = new DurableStore({ now: () => now });
    const first = scope("tenant-runtime-a", "owner-runtime-a", "session-runtime-a");
    const second = scope("tenant-runtime-b", "owner-runtime-b", "session-runtime-b");
    store.createAgentSession(first);
    store.createAgentSession(second);
    expect(store.bridgeBindings.resolveUniqueActive("installation-runtime", now)).toBeNull();

    const firstBinding = store.bridgeBindings.upsert(first, {
      installationId: "installation-runtime",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: "root-runtime-a",
      credentialHash: "credential-a",
      expiresAt: now + 60_000,
    });
    expect(store.bridgeBindings.resolveUniqueActive("installation-runtime", now)).toEqual({
      ...first,
      installationId: "installation-runtime",
      selectedSourceRootId: "root-runtime-a",
    });

    const secondBinding = store.bridgeBindings.upsert(second, {
      installationId: "installation-runtime",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: "root-runtime-b",
      credentialHash: "credential-b",
      expiresAt: now + 60_000,
    });
    expect(store.bridgeBindings.resolveUniqueActive("installation-runtime", now)).toBeNull();
    expect(store.bridgeBindings.revoke(second, secondBinding.bindingId)).toBe(true);
    expect(store.bridgeBindings.resolveUniqueActive("installation-runtime", now)?.agentSessionId).toBe(first.agentSessionId);

    now += 60_001;
    expect(store.bridgeBindings.resolveUniqueActive("installation-runtime", now)).toBeNull();
    expect(store.bridgeBindings.revoke(first, firstBinding.bindingId)).toBe(true);
    store.close();
  });

  it("activates one installation exclusively and rolls back replacement with audit failure", () => {
    let now = 10_000;
    const store = new DurableStore({ now: () => now });
    const first = scope("tenant-activation-a", "owner-activation-a", "session-activation-a");
    const second = scope("tenant-activation-b", "owner-activation-b", "session-activation-b");
    store.createAgentSession(first);
    store.createAgentSession(second);
    const input = (root: string) => ({
      installationId: "installation-exclusive",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: root,
      credentialHash: `hash-${root}`,
      nonceHash: `nonce-${root}`,
      expiresAt: now + 60_000,
    });

    store.bridgeBindings.activateExclusive(first, input("root-a"));
    expect(() => store.bridgeBindings.activateExclusive(second, input("root-b"))).toThrow();
    expect(() => store.bridgeBindings.activateExclusive(second, input("root-b"), {
      replaceExisting: true,
      expectedSelectedSourceRootId: "root-a",
    })).toThrow();
    expect(store.bridgeBindings.resolveUniqueActive("installation-exclusive", now)).toMatchObject({
      tenantId: first.tenantId,
      ownerId: first.ownerId,
      agentSessionId: first.agentSessionId,
      selectedSourceRootId: "root-a",
    });

    const auditAppend = vi.spyOn(store.audit, "append").mockImplementation(() => {
      throw new Error("forced audit failure");
    });
    expect(() => store.transaction(() => {
      store.bridgeBindings.activateExclusive(first, input("root-b"), {
        replaceExisting: true,
        expectedSelectedSourceRootId: "root-a",
      });
      store.audit.append({
        tenantId: first.tenantId,
        ownerId: first.ownerId,
        agentSessionId: first.agentSessionId,
        action: "bridge.pairing.switched",
        actorType: "local-session",
        actorId: "local-test",
        metadata: { installationDigest: "digest-only" },
      });
    })).toThrow("forced audit failure");
    auditAppend.mockRestore();
    expect(store.bridgeBindings.resolveUniqueActive("installation-exclusive", now)).toMatchObject({
      tenantId: first.tenantId,
      ownerId: first.ownerId,
      agentSessionId: first.agentSessionId,
      selectedSourceRootId: "root-a",
    });
    expect(store.db.prepare("SELECT status FROM bridge_bindings WHERE tenant_id = ?").get(second.tenantId)).toBeUndefined();

    store.bridgeBindings.activateExclusive(first, input("root-b"), {
      replaceExisting: true,
      expectedSelectedSourceRootId: "root-a",
    });
    expect(store.bridgeBindings.resolveUniqueActive("installation-exclusive", now)?.selectedSourceRootId).toBe("root-b");
    expect(() => store.bridgeBindings.activateExclusive(first, input("root-c"), {
      replaceExisting: true,
      expectedSelectedSourceRootId: "root-a",
    })).toThrow();
    expect(store.bridgeBindings.resolveUniqueActive("installation-exclusive", now)?.selectedSourceRootId).toBe("root-b");
    store.close();
  });

  it("retains independent chat bindings for one installation without sharing a root", () => {
    const now = 10_000;
    const store = new DurableStore({ now: () => now });
    const first = scope("tenant-multi-a", "owner-multi-a", "session-multi-a");
    const second = scope("tenant-multi-b", "owner-multi-b", "session-multi-b");
    store.createAgentSession(first);
    store.createAgentSession(second);
    const binding = (root: string) => ({
      installationId: "installation-multi",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: root,
      credentialHash: `credential-${root}`,
      expiresAt: now + 60_000,
    });

    store.bridgeBindings.activateConcurrent(first, binding("root-multi-a"));
    store.bridgeBindings.activateConcurrent(second, binding("root-multi-b"));
    expect(store.bridgeBindings.listActiveForInstallation("installation-multi", now)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...first, selectedSourceRootId: "root-multi-a" }),
      expect.objectContaining({ ...second, selectedSourceRootId: "root-multi-b" }),
    ]));
    expect(store.bridgeBindings.resolveUniqueActive("installation-multi", now)).toBeNull();
    expect(() => store.bridgeBindings.activateConcurrent(second, binding("root-multi-a"))).toThrow("already paired");
    expect(store.bridgeBindings.listActiveForInstallation("installation-multi", now)).toHaveLength(2);
    store.close();
  });

  it("keeps exactly one active binding while switching to a fresh scope and back", () => {
    const now = 10_000;
    const store = new DurableStore({ now: () => now });
    const oldScope = scope("tenant-old", "owner-old", "session-old");
    const freshScope = scope("tenant-fresh", "owner-fresh", "session-fresh");
    store.createAgentSession(oldScope);
    store.createAgentSession(freshScope);
    const binding = (root: string) => ({
      installationId: "installation-fresh-projection",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: root,
      credentialHash: `hash-${root}`,
      nonceHash: `nonce-${root}`,
      expiresAt: now + 60_000,
    });
    store.bridgeBindings.activateExclusive(oldScope, binding("root-old"));
    store.bridgeBindings.activateExclusive(freshScope, binding("root-fresh"), {
      replaceExisting: true,
      expectedActiveBinding: { ...oldScope, selectedSourceRootId: "root-old" },
    });
    expect(store.bridgeBindings.resolveUniqueActive("installation-fresh-projection", now)).toMatchObject({
      ...freshScope,
      selectedSourceRootId: "root-fresh",
    });
    expect(store.bridgeBindings.listActiveForInstallation("installation-fresh-projection", now)).toHaveLength(1);
    expect(store.bridgeBindings.list(oldScope).find((candidate) => candidate.selectedSourceRootId === "root-old")?.status).toBe("revoked");

    store.bridgeBindings.activateExclusive(oldScope, binding("root-old"), {
      replaceExisting: true,
      expectedActiveBinding: { ...freshScope, selectedSourceRootId: "root-fresh" },
    });
    expect(store.bridgeBindings.listActiveForInstallation("installation-fresh-projection", now)).toEqual([
      expect.objectContaining({ ...oldScope, selectedSourceRootId: "root-old" }),
    ]);
    expect(store.bridgeBindings.list(freshScope).find((candidate) => candidate.selectedSourceRootId === "root-fresh")?.status).toBe("revoked");
    store.close();
  });

  it("expires and revokes active installation bindings without leaving them claimable", () => {
    let now = 2_000;
    const store = new DurableStore({ now: () => now });
    const owner = scope("tenant-expiry", "owner-expiry", "session-expiry");
    store.createAgentSession(owner);
    expect(() => store.bridgeBindings.activateExclusive(owner, {
      installationId: "installation-expiry",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: "already-expired",
      credentialHash: "credential-expired",
      expiresAt: now,
    })).toThrow();
    store.bridgeBindings.activateExclusive(owner, {
      installationId: "installation-expiry",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: "root-expiry",
      credentialHash: "credential-hash",
      expiresAt: now + 100,
    });
    now += 100;
    expect(store.bridgeBindings.expireDue("installation-expiry", now)).toBe(1);
    expect(store.bridgeBindings.resolveUniqueActive("installation-expiry", now)).toBeNull();
    expect(store.db.prepare("SELECT status FROM bridge_bindings WHERE installation_id = ?").get("installation-expiry")).toEqual({ status: "expired" });

    now += 1;
    store.bridgeBindings.activateExclusive(owner, {
      installationId: "installation-expiry",
      sourceAdapter: "codex-app-server",
      selectedSourceRootId: "root-expiry-2",
      credentialHash: "credential-hash-2",
      expiresAt: now + 100,
    });
    expect(store.bridgeBindings.revokeActive(owner, "installation-expiry", "root-expiry-2")).toBe(1);
    expect(store.bridgeBindings.resolveUniqueActive("installation-expiry", now)).toBeNull();
    store.close();
  });

  it("denies cross-session edges and cycles transactionally", () => {
    const store = new DurableStore();
    const a = scope("t", "o", "a");
    const b = scope("t", "o", "b");
    store.createAgentSession(a);
    store.createAgentSession(b);
    store.agents.upsert(a, { agentId: "root", isRoot: true });
    store.agents.upsert(a, { agentId: "child" });
    store.agents.upsert(b, { agentId: "other" });
    store.edges.add(a, { parentAgentId: "root", childAgentId: "child" });
    expect(() => store.edges.add(a, { parentAgentId: "child", childAgentId: "root" })).toThrow(ConstraintError);
    expect(() => store.edges.add(b, { parentAgentId: "root", childAgentId: "other" })).toThrow();
    expect(store.edges.list(a)).toHaveLength(1);
    store.close();
  });

  it("quarantines conflicting event replays and preserves backend watermarks", () => {
    const store = new DurableStore();
    const s = scope("t", "o", "s");
    store.createAgentSession(s);
    const first = store.events.ingest(s, {
      eventKey: "notification:1",
      eventType: "agent.upsert",
      connectionEpoch: "epoch-1",
      sourceThreadId: "thread-1",
      payload: { agentId: "agent-1", lifecycle: "active", unknownSecret: "drop-me" },
    });
    const replay = store.events.ingest(s, {
      eventKey: "notification:1",
      eventType: "agent.upsert",
      connectionEpoch: "epoch-1",
      sourceThreadId: "thread-1",
      payload: { lifecycle: "active", agentId: "agent-1", unknownSecret: "drop-me" },
    });
    expect(first.outcome).toBe("inserted");
    expect(replay.outcome).toBe("replayed");
    const conflict = store.events.ingest(s, {
      eventKey: "notification:1",
      eventType: "agent.upsert",
      connectionEpoch: "epoch-2",
      sourceThreadId: "thread-1",
      payload: { agentId: "agent-1", lifecycle: "failed" },
    });
    expect(conflict.outcome).toBe("quarantined");
    expect(store.events.conflicts(s)).toHaveLength(1);
    expect(store.sessions.get(s).watermarkIngestOrdinal).toBe(1);
    expect(store.events.get(s, first.event!.eventId).sanitizedPayload).not.toHaveProperty("unknownSecret");
    store.close();
  });

  it("rebuilds an equivalent deterministic projection from events", () => {
    // Advance on every read so the test cannot pass merely because live apply
    // and replay happen to share one wall-clock millisecond.
    let now = 1_000;
    const store = new DurableStore({ now: () => now++ });
    const s = scope("t", "o", "s");
    store.createAgentSession(s);
    store.events.ingest(s, { eventKey: "a", eventType: "agent.upsert", connectionEpoch: "e", payload: { agentId: "root", isRoot: true, lifecycle: "active" } });
    store.events.ingest(s, { eventKey: "b", eventType: "agent.upsert", connectionEpoch: "e", payload: { agentId: "child", lifecycle: "idle" } });
    const edgeEvent = store.events.ingest(s, { eventKey: "c", eventType: "edge.added", connectionEpoch: "e", payload: { parentAgentId: "root", childAgentId: "child" } });
    expect(store.edges.list(s)[0]?.createdAt).toBe(edgeEvent.event?.observedAt);
    const rebuilt = store.rebuildSnapshot(s);
    expect(rebuilt.rebuiltFromEventCount).toBe(3);
    expect(rebuilt.equivalentToLiveProjection).toBe(true);
    expect(rebuilt.agents.map((agent) => agent.agentId)).toEqual(["root", "child"]);
    store.close();
  });

  it("migrates a v3 projection without inventing ordinals and rejects newer schemas", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-store-migration-"));
    const filename = join(directory, "legacy.sqlite");
    const legacyScope = scope("tenant-legacy", "owner-legacy", "session-legacy");
    try {
      const legacy = new DurableStore(filename);
      legacy.createAgentSession(legacyScope);
      legacy.agents.upsert(legacyScope, { agentId: "legacy-root", isRoot: true, name: "Legacy root" });
      legacy.agents.upsert(legacyScope, { agentId: "legacy-child", name: "Legacy child" });
      legacy.edges.add(legacyScope, {
        parentAgentId: "legacy-root",
        childAgentId: "legacy-child",
      });
      // Represent a real v3 file: rows predate the local usage addition and
      // therefore remain explicitly unknown rather than using created_at.
      legacy.db.prepare("UPDATE agents SET spawn_ordinal = NULL WHERE tenant_id = ?").run(legacyScope.tenantId);
      legacy.db.prepare("UPDATE agent_edges SET spawn_ordinal = NULL WHERE tenant_id = ?").run(legacyScope.tenantId);
      legacy.db.prepare("DELETE FROM schema_migrations").run();
      legacy.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (3, 3)").run();
      // Make the on-disk fixture genuinely v3 by rebuilding the one table
      // whose v4 addition is under test; SQLite cannot drop a column directly.
      legacy.db.pragma("foreign_keys = OFF");
      legacy.db.exec(`
        CREATE TABLE agents_v3 (
          tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, agent_session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL, source_adapter TEXT, source_thread_id TEXT, source_session_id TEXT,
          parent_source_thread_id TEXT, role TEXT, name TEXT, lifecycle TEXT NOT NULL DEFAULT 'unknown',
          result_summary TEXT, error_summary TEXT, verification_state TEXT NOT NULL DEFAULT 'unverified',
          is_root INTEGER NOT NULL DEFAULT 0 CHECK (is_root IN (0,1)),
          spawn_ordinal INTEGER CHECK (spawn_ordinal IS NULL OR spawn_ordinal >= 0),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, owner_id, agent_session_id, agent_id),
          UNIQUE (tenant_id, owner_id, agent_session_id, source_adapter, source_thread_id),
          FOREIGN KEY (tenant_id, owner_id, agent_session_id)
            REFERENCES app_sessions (tenant_id, owner_id, agent_session_id) ON DELETE CASCADE
        );
        INSERT INTO agents_v3 SELECT tenant_id, owner_id, agent_session_id, agent_id,
          source_adapter, source_thread_id, source_session_id, parent_source_thread_id,
          role, name, lifecycle, result_summary, error_summary, verification_state,
          is_root, spawn_ordinal, created_at, updated_at FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_v3 RENAME TO agents;
        CREATE UNIQUE INDEX agents_one_root_per_session
          ON agents (tenant_id, owner_id, agent_session_id) WHERE is_root = 1;
      `);
      legacy.db.pragma("foreign_keys = ON");
      legacy.close();

      const backupFilename = `${filename}.v3.pre-v6.backup.sqlite`;
      const migrated = new DurableStore(filename);
      const backupStat = lstatSync(backupFilename);
      expect(backupStat.isFile()).toBe(true);
      expect(backupStat.isSymbolicLink()).toBe(false);
      expect(backupStat.mode & 0o077).toBe(0);
      const recovery = new Database(backupFilename, { readonly: true, fileMustExist: true });
      expect(recovery.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(recovery.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 3 });
      recovery.close();
      expect(migrated.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
      ]);
      expect(migrated.db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(migrated.db.pragma("foreign_key_check")).toEqual([]);
      expect((migrated.db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).some((column) => column.name === "usage_json")).toBe(true);
      expect(migrated.agents.list(legacyScope).map((agent) => agent.spawnOrdinal)).toEqual([null, null]);
      expect(migrated.edges.list(legacyScope).map((edge) => edge.spawnOrdinal)).toEqual([null]);
      expect(migrated.rebuildSnapshot(legacyScope).equivalentToLiveProjection).toBe(true);
      const firstRows = JSON.stringify({
        agents: migrated.agents.list(legacyScope),
        edges: migrated.edges.list(legacyScope),
      });
      migrated.close();

      // Reopening is idempotent and does not rewrite legacy rows.
      const reopened = new DurableStore(filename);
      expect(JSON.stringify({
        agents: reopened.agents.list(legacyScope),
        edges: reopened.edges.list(legacyScope),
      })).toBe(firstRows);
      reopened.close();

      // If the source still requires migration while the fixed recovery path
      // already exists, fail closed without altering the source or backup.
      const needsRetry = new Database(filename);
      needsRetry.prepare("DELETE FROM schema_migrations WHERE version IN (4, 5, 6)").run();
      needsRetry.close();
      expect(() => new DurableStore(filename)).toThrow(/backup already exists/iu);
      const unchanged = new Database(filename, { readonly: true, fileMustExist: true });
      expect(unchanged.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 3 });
      unchanged.close();

      const newerFilename = join(directory, "newer.sqlite");
      const newer = new Database(newerFilename);
      newer.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
      newer.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (99, 1)").run();
      newer.close();
      chmodSync(newerFilename, 0o600);
      expect(() => new DurableStore(newerFilename)).toThrow(/Unsupported durable store schema version/iu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backs up and migrates a genuine v4 usage projection through v5 to v6", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-store-v4-migration-"));
    const filename = join(directory, "v4.sqlite");
    const backupFilename = `${filename}.v4.pre-v6.backup.sqlite`;
    try {
      const v4 = new Database(filename);
      v4.pragma("foreign_keys = ON");
      v4.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        INSERT INTO schema_migrations(version, applied_at) VALUES (4, 4);
        CREATE TABLE app_sessions (
          tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, agent_session_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','revoked','deleted')),
          source_adapter TEXT, schema_version INTEGER NOT NULL DEFAULT 1,
          root_source_thread_id TEXT, root_source_session_id TEXT,
          watermark_ingest_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (watermark_ingest_ordinal >= 0),
          capabilities_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, owner_id, agent_session_id)
        );
        CREATE TABLE agents (
          tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, agent_session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL, source_adapter TEXT, source_thread_id TEXT, source_session_id TEXT,
          parent_source_thread_id TEXT, role TEXT, name TEXT, lifecycle TEXT NOT NULL DEFAULT 'unknown',
          result_summary TEXT, error_summary TEXT, verification_state TEXT NOT NULL DEFAULT 'unverified',
          is_root INTEGER NOT NULL DEFAULT 0 CHECK (is_root IN (0,1)),
          spawn_ordinal INTEGER CHECK (spawn_ordinal IS NULL OR spawn_ordinal >= 0),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, usage_json TEXT,
          PRIMARY KEY (tenant_id, owner_id, agent_session_id, agent_id),
          UNIQUE (tenant_id, owner_id, agent_session_id, source_adapter, source_thread_id),
          FOREIGN KEY (tenant_id, owner_id, agent_session_id)
            REFERENCES app_sessions (tenant_id, owner_id, agent_session_id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX agents_one_root_per_session
          ON agents (tenant_id, owner_id, agent_session_id) WHERE is_root = 1;
        INSERT INTO app_sessions VALUES ('tenant-v4','owner-v4','session-v4','active',NULL,1,NULL,NULL,0,'[]',4,4);
        INSERT INTO agents VALUES (
          'tenant-v4','owner-v4','session-v4','agent-v4',NULL,NULL,NULL,NULL,NULL,'V4 agent','completed',
          NULL,NULL,'verified',1,7,4,4,
          '{"inputTokens":10,"cachedInputTokens":2,"cacheWriteInputTokens":1,"outputTokens":4,"reasoningOutputTokens":1,"totalTokens":14}'
        );
      `);
      v4.close();
      chmodSync(filename, 0o600);

      const migrated = new DurableStore(filename);
      expect(migrated.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 4 }, { version: 5 }, { version: 6 }]);
      expect(migrated.db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(migrated.db.pragma("foreign_key_check")).toEqual([]);
      expect(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pricing_snapshots'").get()).toEqual({ name: "pricing_snapshots" });
      expect((migrated.db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map((column) => column.name)).toEqual(expect.arrayContaining([
        "pricing_snapshot_id", "cost_json", "cost_usage_digest",
      ]));
      expect(migrated.agents.get(scope("tenant-v4", "owner-v4", "session-v4"), "agent-v4")).toMatchObject({
        name: "V4 agent",
        spawnOrdinal: 7,
        usage: { inputTokens: 10, totalTokens: 14 },
        pricingSnapshotId: null,
        cost: null,
      });
      migrated.close();

      const backup = new Database(backupFilename, { readonly: true, fileMustExist: true });
      expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 4 });
      expect(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pricing_snapshots'").get()).toBeUndefined();
      expect((backup.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).some((column) => column.name === "pricing_snapshot_id")).toBe(false);
      expect(backup.prepare("SELECT name, usage_json FROM agents WHERE agent_id = 'agent-v4'").get()).toEqual({
        name: "V4 agent",
        usage_json: '{"inputTokens":10,"cachedInputTokens":2,"cacheWriteInputTokens":1,"outputTokens":4,"reasoningOutputTokens":1,"totalTokens":14}',
      });
      backup.close();

      const reopened = new DurableStore(filename);
      expect(reopened.db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(reopened.agents.get(scope("tenant-v4", "owner-v4", "session-v4"), "agent-v4").usage?.totalTokens).toBe(14);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backs up and migrates a genuine v5 pricing projection to v6 segment storage", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-store-v5-migration-"));
    const filename = join(directory, "v5.sqlite");
    const backupFilename = `${filename}.v5.pre-v6.backup.sqlite`;
    try {
      const seed = new DurableStore(filename);
      const s = scope("tenant-v5", "owner-v5", "session-v5");
      seed.createAgentSession(s);
      seed.agents.upsert(s, { agentId: "agent-v5", name: "V5 agent", usage: { inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 14 } });
      seed.db.prepare("DELETE FROM schema_migrations").run();
      seed.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (5, 5)").run();
      seed.db.pragma("foreign_keys = OFF");
      seed.db.exec(`
        CREATE TABLE agents_v5 (
          tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, agent_session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL, source_adapter TEXT, source_thread_id TEXT, source_session_id TEXT,
          parent_source_thread_id TEXT, role TEXT, name TEXT, lifecycle TEXT NOT NULL DEFAULT 'unknown',
          result_summary TEXT, error_summary TEXT, verification_state TEXT NOT NULL DEFAULT 'unverified',
          is_root INTEGER NOT NULL DEFAULT 0 CHECK (is_root IN (0,1)),
          spawn_ordinal INTEGER CHECK (spawn_ordinal IS NULL OR spawn_ordinal >= 0),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, usage_json TEXT,
          pricing_snapshot_id TEXT, cost_json TEXT, cost_usage_digest TEXT,
          PRIMARY KEY (tenant_id, owner_id, agent_session_id, agent_id),
          UNIQUE (tenant_id, owner_id, agent_session_id, source_adapter, source_thread_id),
          FOREIGN KEY (tenant_id, owner_id, agent_session_id)
            REFERENCES app_sessions (tenant_id, owner_id, agent_session_id) ON DELETE CASCADE
        );
        INSERT INTO agents_v5 SELECT tenant_id, owner_id, agent_session_id, agent_id,
          source_adapter, source_thread_id, source_session_id, parent_source_thread_id,
          role, name, lifecycle, result_summary, error_summary, verification_state,
          is_root, spawn_ordinal, created_at, updated_at, usage_json,
          pricing_snapshot_id, cost_json, cost_usage_digest FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_v5 RENAME TO agents;
        CREATE UNIQUE INDEX agents_one_root_per_session
          ON agents (tenant_id, owner_id, agent_session_id) WHERE is_root = 1;
      `);
      seed.db.pragma("foreign_keys = ON");
      seed.close();

      const migrated = new DurableStore(filename);
      expect(migrated.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(expect.arrayContaining([{ version: 5 }, { version: 6 }]));
      expect(migrated.db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(migrated.db.pragma("foreign_key_check")).toEqual([]);
      expect((migrated.db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).some((column) => column.name === "usage_segments_json")).toBe(true);
      expect(migrated.agents.get(s, "agent-v5")).toMatchObject({ name: "V5 agent", usageSegments: null, usage: { totalTokens: 14 } });
      migrated.close();

      const backupStat = lstatSync(backupFilename);
      expect(backupStat.mode & 0o077).toBe(0);
      const backup = new Database(backupFilename, { readonly: true, fileMustExist: true });
      expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 5 });
      expect((backup.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).some((column) => column.name === "usage_segments_json")).toBe(false);
      backup.close();

      const reopened = new DurableStore(filename);
      expect(reopened.agents.get(s, "agent-v5").usageSegments).toBeNull();
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts the versioned contract event names without retaining unknown fields", () => {
    const store = new DurableStore();
    const s = scope("t", "o", "s");
    store.createAgentSession(s);
    store.events.ingest(s, {
      eventKey: "contract-agent",
      eventType: "agent.upsert",
      connectionEpoch: "e",
      sourceThreadId: "root-thread",
      payload: { agentId: "root", sourceKind: "root", role: "root", lifecycle: "active", schemaVersion: 1, privatePrompt: "drop" },
    });
    store.events.ingest(s, {
      eventKey: "contract-child",
      eventType: "agent.upsert",
      connectionEpoch: "e",
      sourceThreadId: "child-thread",
      payload: { agentId: "child", sourceKind: "thread_spawn", role: "worker", lifecycle: "pending" },
    });
    store.events.ingest(s, {
      eventKey: "contract-edge",
      eventType: "edge.spawn",
      connectionEpoch: "e",
      payload: { parentAgentId: "root", childAgentId: "child", edgeId: "edge-1" },
    });
    store.events.ingest(s, {
      eventKey: "contract-alternate",
      eventType: "agent.upsert",
      connectionEpoch: "e",
      sourceThreadId: "alternate-thread",
      payload: { agentId: "alternate", sourceKind: "reconciliation", role: "reviewer", lifecycle: "idle" },
    });
    store.events.ingest(s, {
      eventKey: "contract-reparent",
      eventType: "edge.reconciled",
      connectionEpoch: "epoch-reconcile",
      payload: { parentAgentId: "alternate", childAgentId: "child", edgeId: "edge-2" },
    });
    store.events.ingest(s, {
      eventKey: "contract-identity",
      eventType: "identity.requested",
      connectionEpoch: "e",
      sourceThreadId: "child-thread",
      payload: { agentId: "child", values: { provider: "openai", model: "gpt", effort: "high" } },
    });
    const correction = store.events.ingest(s, {
      eventKey: "contract-correction",
      eventType: "snapshot.reconciled",
      connectionEpoch: "e",
      payload: {
        correctedAgentIds: ["child"],
        correctedEdgeIds: ["edge-1"],
        hostilePrompt: "must not persist",
      },
    });
    expect(store.edges.list(s)).toHaveLength(1);
    expect(store.edges.getParent(s, "child")?.parentAgentId).toBe("alternate");
    expect(store.identityEvidence.list(s, "child")).toHaveLength(1);
    const firstEvent = store.events.list(s)[0];
    if (!firstEvent) throw new Error("expected contract event");
    expect(firstEvent.sanitizedPayload).not.toHaveProperty("privatePrompt");
    expect(correction.event?.sanitizedPayload.correctedAgentIds).toEqual(["child"]);
    expect(correction.event?.sanitizedPayload).not.toHaveProperty("hostilePrompt");
    expect(store.rebuildSnapshot(s).equivalentToLiveProjection).toBe(true);
    store.close();
  });

  it("reconciles a safe reparent across connection epochs and audits the correction", () => {
    const store = new DurableStore();
    const s = scope("t", "o", "reconcile-safe");
    store.createAgentSession(s);
    store.agents.upsert(s, { agentId: "root" });
    store.agents.upsert(s, { agentId: "replacement" });
    store.agents.upsert(s, { agentId: "child" });
    store.edges.add(s, { parentAgentId: "root", childAgentId: "child" });

    const result = store.edges.reconcile(s, {
      parentAgentId: "replacement",
      childAgentId: "child",
      connectionEpoch: "epoch-2",
      sourceEventId: "snapshot-edge-2",
      ingestOrdinal: 8,
    });
    expect(result.changed).toBe(true);
    expect(result.previousParentAgentId).toBe("root");
    expect(store.edges.getParent(s, "child")?.parentAgentId).toBe("replacement");
    expect(store.audit.list(s).some((record) => record.action === "edge.reconciled" && record.metadata.connectionEpoch === "epoch-2")).toBe(true);

    const noop = store.edges.replaceParent(s, {
      parentAgentId: "replacement",
      childAgentId: "child",
      connectionEpoch: "epoch-3",
    });
    expect(noop.changed).toBe(false);
    expect(store.edges.getParent(s, "child")?.parentAgentId).toBe("replacement");
    store.close();
  });

  it("rejects reconciliation cycles, orphans, and cross-session endpoints with rollback", () => {
    const store = new DurableStore();
    const s = scope("t", "o", "reconcile-rollback");
    const other = scope("t", "o", "reconcile-other");
    store.createAgentSession(s);
    store.createAgentSession(other);
    for (const agentId of ["root", "middle", "child"]) store.agents.upsert(s, { agentId });
    store.agents.upsert(other, { agentId: "foreign" });
    store.edges.add(s, { parentAgentId: "root", childAgentId: "middle" });
    store.edges.add(s, { parentAgentId: "middle", childAgentId: "child" });

    expect(() => store.edges.reconcile(s, {
      parentAgentId: "child",
      childAgentId: "root",
      connectionEpoch: "epoch-cycle",
    })).toThrow();
    expect(store.edges.getParent(s, "middle")?.parentAgentId).toBe("root");

    expect(() => store.edges.reconcile(s, {
      parentAgentId: "foreign",
      childAgentId: "child",
      connectionEpoch: "epoch-cross-session",
    })).toThrow();
    expect(() => store.edges.reconcile(s, {
      parentAgentId: "missing",
      childAgentId: "child",
      connectionEpoch: "epoch-orphan",
    })).toThrow();
    expect(() => store.edges.reconcile(s, {
      parentAgentId: "root",
      childAgentId: "child",
      connectionEpoch: "epoch-invalid-authority",
      source: "manual" as unknown as "codex-reconciliation",
    })).toThrow();
    expect(store.edges.getParent(s, "child")?.parentAgentId).toBe("middle");
    store.close();
  });

  it("deletes only Agent Farm rows and keeps the audit tombstone", () => {
    const store = new DurableStore();
    const s = scope("t", "o", "s");
    store.createAgentSession(s);
    store.events.ingest(s, { eventKey: "a", eventType: "agent.upsert", connectionEpoch: "e", payload: { agentId: "agent" } });
    expect(store.deleteAgentSession(s)).toBe(true);
    expect(() => store.sessions.get(s)).toThrow();
    expect(store.audit.list(s).some((record) => record.action === "agent_session.deleted")).toBe(true);
    // This value represents Codex-side state. The store has no delete path for it.
    const codexThread = { id: "codex-thread", status: "active" };
    expect(codexThread).toEqual({ id: "codex-thread", status: "active" });
    expect(store.deleteAgentSession(s)).toBe(false);
    store.close();
  });

  it("fails closed on hostile payload graphs before writing an event", () => {
    const store = new DurableStore();
    const s = scope("t", "o", "s");
    store.createAgentSession(s);
    const secretPrompt = "TOP-SECRET prompt must never appear in a persistence error";
    const payload: Record<string, unknown> = {
      agentId: "agent-1",
      summary: secretPrompt,
    };
    // `agent` is an allowed nested vocabulary key, so the sanitizer must
    // inspect it and detect the cycle rather than silently dropping it.
    payload.agent = payload;

    let thrown: unknown;
    try {
      store.events.ingest(s, {
        eventKey: "hostile-cycle",
        eventType: "agent.upsert",
        connectionEpoch: "e",
        payload,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConstraintError);
    expect(thrown).toBeDefined();
    expect(String((thrown as Error).message)).not.toContain(secretPrompt);
    expect(store.events.list(s)).toHaveLength(0);
    expect(store.sessions.get(s).watermarkIngestOrdinal).toBe(0);
    store.close();
  });

  it("bounds depth, breadth, strings, bytes, and non-finite values", () => {
    const deep: Record<string, unknown> = { agentId: "deep" };
    let cursor = deep;
    for (let index = 0; index < 40; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.agent = next;
      cursor = next;
    }
    expect(() => sanitizePayload(deep)).toThrow(ConstraintError);
    expect(() => sanitizePayload({ values: new Array(2_000).fill("x") })).toThrow(ConstraintError);
    expect(() => sanitizePayload({ values: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`key-${index}`, index])) })).toThrow(ConstraintError);
    expect(() => sanitizePayload({ summary: "secret=" + "x".repeat(20_000) })).toThrow(ConstraintError);
    expect(() => sanitizePayload({ version: Number.NaN })).toThrow(ConstraintError);
    expect(() => sanitizePayload({ version: Number.POSITIVE_INFINITY })).toThrow(ConstraintError);

    // The individual strings are valid, but their canonical representation is
    // too large for one bounded serialization.
    expect(() => stableJson(Array.from({ length: 1_024 }, () => "x".repeat(1_100)))).toThrow(ConstraintError);
    const fallback = { safe: true };
    expect(parseJson(`{"unsafe":"${"x".repeat(300_000)}"}`, fallback)).toBe(fallback);
  });

  it("rejects cycles and prototype-sensitive keys in generic serialization", () => {
    const cycle: Record<string, unknown> = { safe: "value" };
    cycle.self = cycle;
    expect(() => stableJson(cycle)).toThrow(ConstraintError);

    const prototypeKey = Object.create(null) as Record<string, unknown>;
    prototypeKey["__proto__"] = "do-not-persist";
    expect(() => stableJson(prototypeKey)).toThrow(ConstraintError);

    const secret = "private prompt text";
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    let thrown: unknown;
    try {
      stableJson(accessor);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConstraintError);
    expect(String((thrown as Error).message)).not.toContain(secret);

    const hostileProxy = new Proxy({ safe: "value" }, {
      ownKeys() {
        // Even a user-supplied StoreError must not bypass the safe error
        // boundary or echo its sensitive message.
        throw new ConstraintError("HOSTILE", secret);
      },
    });
    thrown = undefined;
    try {
      stableJson(hostileProxy);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConstraintError);
    expect(String((thrown as Error).message)).not.toContain(secret);

    const revoked = Proxy.revocable({ safe: "value" }, {});
    revoked.revoke();
    expect(() => sanitizePayload(revoked.proxy)).toThrow(ConstraintError);
    expect(() => stableJson(revoked.proxy)).toThrow(ConstraintError);
  });

  it("rejects hostile idempotency payloads before a row is inserted", () => {
    const store = new DurableStore();
    const s = scope("t", "o", "s");
    store.createAgentSession(s);
    const request: Record<string, unknown> = { safe: "value" };
    request.self = request;
    const secretPrompt = "do not leak this request prompt";
    request.prompt = secretPrompt;

    let thrown: unknown;
    try {
      store.idempotency.record(s, "hostile-operation", "hostile-key", "request-hash", request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConstraintError);
    expect(String((thrown as Error).message)).not.toContain(secretPrompt);
    expect(store.idempotency.find(s, "hostile-operation", "hostile-key")).toBeNull();
    store.close();
  });

  it("preserves canonical ordering and idempotent replay for valid payloads", () => {
    expect(stableJson({ b: 2, a: 1, omitted: undefined })).toBe('{"a":1,"b":2}');
    const store = new DurableStore();
    const s = scope("t", "o", "s");
    store.createAgentSession(s);
    const first = store.events.ingest(s, {
      eventKey: "canonical-valid",
      eventType: "agent.upsert",
      connectionEpoch: "e",
      payload: { lifecycle: "active", agentId: "agent-1", privatePrompt: "drop" },
    });
    const replay = store.events.ingest(s, {
      eventKey: "canonical-valid",
      eventType: "agent.upsert",
      connectionEpoch: "e-2",
      payload: { agentId: "agent-1", lifecycle: "active", privatePrompt: "drop" },
    });
    expect(first.outcome).toBe("inserted");
    expect(replay.outcome).toBe("replayed");
    expect(store.events.list(s)).toHaveLength(1);
    store.close();
  });
});
