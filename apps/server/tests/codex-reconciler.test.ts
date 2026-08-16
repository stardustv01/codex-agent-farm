import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DurableStore, pricingSnapshotHash } from "@agent-farm/store";
import type { RolloutIdentityEvidence } from "@agent-farm/codex-bridge";

import {
  CodexReconciliationError,
  reconcileCodexSnapshot,
  type CodexSnapshotClient,
} from "../src/codex-reconciler.js";
import { REVIEWED_OPENAI_PRICING_SNAPSHOT, reviewedPricingProvider } from "../src/pricing.js";
import { projectPublicHierarchy } from "../src/public-hierarchy.js";

const scope = { tenantId: "tenant-reconcile", ownerId: "owner-reconcile", agentSessionId: "session-reconcile" } as const;
const binding = { ...scope, sourceRootId: "thread:dirac", status: "active" as const };
const stores: DurableStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function store(): DurableStore {
  const value = new DurableStore(":memory:");
  value.createAgentSession({ ...scope, sourceAdapter: "codex-app-server" });
  stores.push(value);
  return value;
}

function fileStore(): { store: DurableStore; filename: string } {
  const directory = mkdtempSync(join(tmpdir(), "agent-farm-fallback-replay-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "agent-farm.sqlite");
  const value = new DurableStore(filename);
  value.createAgentSession({ ...scope, sourceAdapter: "codex-app-server" });
  stores.push(value);
  return { store: value, filename };
}

function closeTracked(value: DurableStore): void {
  const index = stores.indexOf(value);
  if (index >= 0) stores.splice(index, 1);
  value.close();
}

type FixtureThread = {
  id: string;
  sessionId?: string;
  parentThreadId?: string;
  forkedFromId?: string;
  status?: string;
  agentNickname?: string;
  agentRole?: string;
  agentPath?: string;
  agentTaskName?: string;
};

type FixtureRead = {
  thread: FixtureThread;
  turns?: readonly unknown[];
  nextCursor?: string;
};

function fixtureClient(threads: readonly FixtureThread[], reads: ReadonlyMap<string, ReadonlyArray<FixtureRead>> = new Map()): CodexSnapshotClient {
  return {
    async listThreads(params) {
      if (params?.archived === true) return { threads: [] };
      const cursor = typeof params?.cursor === "string" ? params.cursor : undefined;
      return cursor === undefined ? { threads } : { threads: [] };
    },
    async readThread(params) {
      const id = String(params.threadId);
      const pages = reads.get(id) ?? [{ thread: threads.find((value) => value.id === id) as FixtureThread, turns: [] }];
      const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
      if (cursor === undefined) return pages[0];
      return pages.find((page) => page.nextCursor === undefined) ?? pages[0];
    },
  };
}

const canonicalThreads: readonly FixtureThread[] = [
  { id: "thread:dirac", status: "active", agentNickname: "Dirac", agentRole: "root" },
  { id: "thread:rhea", parentThreadId: "thread:dirac", status: "idle", agentNickname: "Rhea", agentRole: "planner" },
  { id: "thread:kuhn", parentThreadId: "thread:rhea", status: "completed", agentNickname: "Kuhn", agentRole: "worker" },
  { id: "thread:noether", parentThreadId: "thread:kuhn", status: "completed", agentNickname: "Noether", agentRole: "reviewer" },
];

const canonicalReads = new Map<string, ReadonlyArray<FixtureRead>>([
  ["thread:dirac", [{ thread: canonicalThreads[0]!, turns: [{ id: "turn:d", items: [{ id: "item:r", type: "collaboration", collaboration: { operation: "spawnAgent", receiverIds: ["thread:rhea"], requestedModel: "gpt-5.6-luna", requestedReasoningEffort: "max" }, prompt: "private" }] }] }]],
  ["thread:rhea", [{ thread: canonicalThreads[1]!, turns: [{ id: "turn:r", items: [{ id: "item:k", type: "collaboration", collaboration: { operation: "spawnAgent", receiverIds: ["thread:kuhn"], requestedModel: "gpt-5.6-luna", requestedReasoningEffort: "max" } }] }] }]],
  ["thread:kuhn", [{ thread: canonicalThreads[2]!, turns: [{ id: "turn:k", items: [{ id: "item:settings", type: "thread_settings", effectiveSettings: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" }, prompt: "private" }, { id: "item:n", type: "collaboration", collaboration: { operation: "spawnAgent", receiverIds: ["thread:noether"], requestedModel: "gpt-5.6-luna", requestedReasoningEffort: "max" } }] }] }]],
  ["thread:noether", [{ thread: canonicalThreads[3]!, turns: [{ id: "turn:n", items: [{ id: "item:settings", type: "thread_settings", effectiveSettings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max" } }] }] }]],
]);

describe("Codex snapshot reconciler", () => {
  it("reconciles the canonical Dirac/Rhea/Kuhn/Noether hierarchy and identity evidence", async () => {
    const durable = store();
    const result = await reconcileCodexSnapshot({
      client: fixtureClient(canonicalThreads, canonicalReads),
      store: durable,
      binding,
      connectionEpoch: "epoch:canonical",
    });

    const snapshot = durable.getSnapshot(scope);
    expect(snapshot.agents).toHaveLength(4);
    expect(snapshot.edges).toHaveLength(3);
    expect(snapshot.agents.find((agent) => agent.name === "Dirac")?.isRoot).toBe(true);
    expect(snapshot.agents.find((agent) => agent.name === "Kuhn")?.verificationState).toBe("mismatch");
    expect(snapshot.agents.find((agent) => agent.name === "Noether")?.verificationState).toBe("verified");
    expect(snapshot.identityEvidence.filter((evidence) => evidence.agentId === snapshot.agents.find((agent) => agent.name === "Kuhn")?.agentId)).toHaveLength(2);
    expect(result.watermark).toBe(snapshot.watermarkIngestOrdinal);
    expect(durable.events.list(scope).every((event) => event.authority === "reconciliation")).toBe(true);
    expect(durable.events.list(scope).some((event) => JSON.stringify(event.sanitizedPayload).includes("private"))).toBe(false);
  });

  it("reconciles rollout requested/observed identity for the exact recursive hierarchy", async () => {
    const durable = store();
    const mainBinding = { ...binding, sourceRootId: "thread:main" };
    const threads: readonly FixtureThread[] = [
      { id: "thread:main", status: "active", agentTaskName: "main", agentNickname: "Main" },
      { id: "thread:dirac", parentThreadId: "thread:main", status: "active", agentTaskName: "dirac", agentNickname: "Dirac" },
      { id: "thread:rhea", parentThreadId: "thread:dirac", status: "idle", agentTaskName: "rhea", agentNickname: "Rhea" },
      { id: "thread:kuhn", parentThreadId: "thread:dirac", status: "completed", agentTaskName: "kuhn", agentNickname: "Kuhn" },
      { id: "thread:noether", parentThreadId: "thread:rhea", status: "completed", agentTaskName: "noether", agentNickname: "Noether" },
    ];
    const reads = new Map<string, ReadonlyArray<FixtureRead>>(threads.map((thread) => [thread.id, [{ thread, turns: [] }]]));
    const identity = (sourceThreadId: string, model: string, effort: string, requestedSpawns: RolloutIdentityEvidence["requestedSpawns"] = []): RolloutIdentityEvidence => ({
      sourceThreadId,
      modelProvider: "openai",
      observedHistory: [{ model, effort }],
      requestedSpawns,
    });
    const evidence = new Map<string, RolloutIdentityEvidence>([
      ["thread:main", identity("thread:main", "gpt-5.6-luna", "max", [{ taskName: "dirac", model: "gpt-5.6-sol", reasoningEffort: "high" }])],
      // Dirac's own rollout turns are sol/high; any inherited root context is
      // intentionally excluded from this own-thread evidence fixture.
      ["thread:dirac", identity("thread:dirac", "gpt-5.6-sol", "high", [
        { taskName: "rhea", model: "gpt-5.6-luna", reasoningEffort: "max" },
        { taskName: "kuhn", model: "gpt-5.6-sol", reasoningEffort: "medium" },
      ])],
      ["thread:rhea", identity("thread:rhea", "gpt-5.6-luna", "max", [{ taskName: "noether", model: "gpt-5.6-sol", reasoningEffort: "low" }])],
      ["thread:kuhn", identity("thread:kuhn", "gpt-5.6-sol", "medium")],
      ["thread:noether", identity("thread:noether", "gpt-5.6-sol", "low")],
    ]);
    const calls: string[] = [];
    const client: CodexSnapshotClient = {
      ...fixtureClient(threads, reads),
      async readRolloutIdentity(threadId) {
        calls.push(threadId);
        return evidence.get(threadId);
      },
    };

    await reconcileCodexSnapshot({ client, store: durable, binding: mainBinding, connectionEpoch: "epoch:rollout-exact" });

    const snapshot = durable.getSnapshot(scope);
    expect(calls).toHaveLength(threads.length);
    expect(new Set(calls)).toHaveLength(threads.length);
    const agents = new Map(snapshot.agents.map((agent) => [agent.sourceThreadId, agent]));
    expect(agents.get("thread:main")?.verificationState).toBe("unverified");
    expect(agents.get("thread:dirac")?.verificationState).toBe("verified");
    expect(agents.get("thread:rhea")?.verificationState).toBe("verified");
    expect(agents.get("thread:kuhn")?.verificationState).toBe("verified");
    expect(agents.get("thread:noether")?.verificationState).toBe("verified");

    const identityByAgent = new Map<string, typeof snapshot.identityEvidence>();
    for (const agent of snapshot.agents) {
      identityByAgent.set(agent.sourceThreadId, snapshot.identityEvidence.filter((item) => item.agentId === agent.agentId));
    }
    const diracEvidence = identityByAgent.get("thread:dirac") ?? [];
    expect(diracEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedModel: "gpt-5.6-sol", requestedEffort: "high", source: "codex.rollout.spawn" }),
      expect.objectContaining({ observedModel: "gpt-5.6-sol", observedEffort: "high", observedProvider: "openai", source: "codex.rollout.turn-context" }),
    ]));
    expect(identityByAgent.get("thread:rhea")).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedModel: "gpt-5.6-luna", requestedEffort: "max", source: "codex.rollout.spawn" }),
      expect.objectContaining({ observedModel: "gpt-5.6-luna", observedEffort: "max", source: "codex.rollout.turn-context" }),
    ]));
    expect(identityByAgent.get("thread:kuhn")).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedModel: "gpt-5.6-sol", requestedEffort: "medium", source: "codex.rollout.spawn" }),
      expect.objectContaining({ observedModel: "gpt-5.6-sol", observedEffort: "medium", source: "codex.rollout.turn-context" }),
    ]));
    expect(identityByAgent.get("thread:noether")).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedModel: "gpt-5.6-sol", requestedEffort: "low", source: "codex.rollout.spawn" }),
      expect.objectContaining({ observedModel: "gpt-5.6-sol", observedEffort: "low", source: "codex.rollout.turn-context" }),
    ]));
    const mainEvidence = identityByAgent.get("thread:main") ?? [];
    expect(mainEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ observedModel: "gpt-5.6-luna", observedEffort: "max", observedProvider: "openai", source: "codex.rollout.turn-context" }),
    ]));
    expect(mainEvidence.every((item) => item.requestedModel === null && item.requestedEffort === null && item.requestedProvider === null)).toBe(true);
    const serialized = JSON.stringify(durable.events.list(scope).map((event) => event.sanitizedPayload));
    expect(serialized).not.toContain("/private/rollouts");
    expect(serialized).not.toContain("secret rollout prompt");
  });

  it("preserves usage when rollout evidence is omitted, clears explicit ambiguity, and accepts newer cumulative totals", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:usage", status: "active", agentTaskName: "usage" };
    const usage = {
      inputTokens: 10,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
      outputTokens: 4,
      reasoningOutputTokens: 1,
      totalTokens: 14,
      observedAt: "2026-08-12T00:00:00.000Z",
    } as const;
    const usageWithUnknown = { ...usage, credential: "must-not-persist" };
    let evidence: RolloutIdentityEvidence | undefined = {
      sourceThreadId: root.id,
      observedHistory: [],
      requestedSpawns: [],
      usage: usageWithUnknown,
    };
    const client: CodexSnapshotClient = {
      ...fixtureClient([root]),
      async readRolloutIdentity() { return evidence; },
    };
    const first = await reconcileCodexSnapshot({ client, store: durable, binding: { ...binding, sourceRootId: root.id }, connectionEpoch: "epoch:usage-1" });
    const agentId = durable.agents.list(scope)[0]!.agentId;
    expect(durable.agents.get(scope, agentId).usage).toEqual(usage);
    const firstUsagePayload = durable.events.list(scope)
      .find((event) => event.eventType === "agent.reconciled")?.sanitizedPayload.usage;
    expect(firstUsagePayload).toEqual(usage);
    expect(JSON.stringify(durable.events.list(scope))).not.toContain("must-not-persist");

    evidence = undefined;
    const preserved = await reconcileCodexSnapshot({ client, store: durable, binding: { ...binding, sourceRootId: root.id }, connectionEpoch: "epoch:usage-2" });
    expect(durable.agents.get(scope, agentId).usage).toEqual(usage);
    expect(preserved.correctedAgentIds).not.toContain(agentId);

    evidence = { sourceThreadId: root.id, observedHistory: [], requestedSpawns: [], usageAmbiguous: true };
    const cleared = await reconcileCodexSnapshot({ client, store: durable, binding: { ...binding, sourceRootId: root.id }, connectionEpoch: "epoch:usage-3" });
    expect(cleared.correctedAgentIds).toContain(agentId);
    expect(durable.agents.get(scope, agentId).usage).toBeNull();

    const newer = { ...usage, inputTokens: 20, outputTokens: 5, totalTokens: 25, observedAt: "2026-08-12T00:01:00.000Z" } as const;
    evidence = { sourceThreadId: root.id, observedHistory: [], requestedSpawns: [], usage: newer };
    const updated = await reconcileCodexSnapshot({ client, store: durable, binding: { ...binding, sourceRootId: root.id }, connectionEpoch: "epoch:usage-4" });
    expect(durable.agents.get(scope, agentId).usage).toEqual(newer);
    expect(updated.correctedAgentIds).toContain(agentId);
    const replayed = await reconcileCodexSnapshot({ client, store: durable, binding: { ...binding, sourceRootId: root.id }, connectionEpoch: "epoch:usage-4" });
    expect(replayed.correctedAgentIds).not.toContain(agentId);
    expect(durable.agents.get(scope, agentId).usage).toEqual(newer);
    const rebuilt = durable.rebuildSnapshot(scope);
    expect(rebuilt.equivalentToLiveProjection).toBe(true);
    expect(rebuilt.agents.find((agent) => agent.agentId === agentId)?.usage).toEqual(newer);
    expect(first.correctedAgentIds).toContain(agentId);
  });

  it("atomically pins reviewed pricing for complete or known-partial segments and replays cost projection", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:priced", status: "completed", agentTaskName: "priced" };
    const usage = { inputTokens: 1_000, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1_100, observedAt: "2026-08-12T00:00:00.000Z" } as const;
    let complete = true;
    const client: CodexSnapshotClient = {
      ...fixtureClient([root]),
      async readRolloutIdentity() {
        return {
          sourceThreadId: root.id,
          modelProvider: "openai",
          observedHistory: [{ model: "gpt-5.6-sol", effort: "high" }],
          requestedSpawns: [],
          usage,
          usageSegments: [{ turnId: "turn-priced", provider: "openai", model: "gpt-5.6-sol", effort: "high", usage }],
          usageSegmentsComplete: complete,
        };
      },
    };
    const options = { client, store: durable, binding: { ...binding, sourceRootId: root.id }, connectionEpoch: "epoch-priced", pricing: reviewedPricingProvider() } as const;
    await reconcileCodexSnapshot(options);
    const agent = durable.agents.list(scope)[0]!;
    expect(agent.pricingSnapshotId).toBe(REVIEWED_OPENAI_PRICING_SNAPSHOT.snapshotId);
    expect(agent.cost).toMatchObject({ status: "estimated", selfMicros: 7_100, totalMicros: 7_100 });
    expect(durable.events.list(scope).filter((event) => event.eventType === "cost.projected")).toHaveLength(1);
    expect(durable.rebuildSnapshot(scope).equivalentToLiveProjection).toBe(true);
    const changedPricing = {
      ...REVIEWED_OPENAI_PRICING_SNAPSHOT,
      snapshotId: "future-reviewed-pricing",
      rates: { ...REVIEWED_OPENAI_PRICING_SNAPSHOT.rates, "gpt-5.6-sol": { inputPerMillionUsd: 50, cachedInputPerMillionUsd: 5, outputPerMillionUsd: 300 } },
    };
    const { snapshotHash: _oldHash, ...changedPricingBody } = changedPricing;
    await reconcileCodexSnapshot({ ...options, pricing: reviewedPricingProvider({ ...changedPricingBody, snapshotHash: pricingSnapshotHash(changedPricingBody) }) });
    expect(durable.events.list(scope).filter((event) => event.eventType === "cost.projected")).toHaveLength(1);
    expect(durable.agents.get(scope, agent.agentId)).toMatchObject({ pricingSnapshotId: REVIEWED_OPENAI_PRICING_SNAPSHOT.snapshotId, cost: { status: "estimated", selfMicros: 7_100 } });

    complete = false;
    await reconcileCodexSnapshot({ ...options, connectionEpoch: "epoch-priced-incomplete" });
    expect(durable.agents.get(scope, agent.agentId)).toMatchObject({ pricingSnapshotId: REVIEWED_OPENAI_PRICING_SNAPSHOT.snapshotId, cost: { status: "partial", knownSelfMicros: 7_100, reason: "usage-segments-incomplete", pricing: { snapshotId: REVIEWED_OPENAI_PRICING_SNAPSHOT.snapshotId } } });
    expect(durable.rebuildSnapshot(scope).equivalentToLiveProjection).toBe(true);
  });

  it("names and prices Codex Auto-review as GPT-5.6 Luna", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:auto-review", status: "completed", agentTaskName: "auto_review_internal" };
    const usage = { inputTokens: 1_000, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1_100 } as const;
    const client: CodexSnapshotClient = {
      ...fixtureClient([root]),
      async readRolloutIdentity() {
        return {
          sourceThreadId: root.id,
          modelProvider: "openai",
          observedHistory: [{ model: "codex-auto-review", effort: "low" }],
          requestedSpawns: [],
          usage,
          usageSegments: [{ turnId: "turn:auto-review", provider: "openai", model: "codex-auto-review", effort: "low", usage }],
          usageSegmentsComplete: true,
        };
      },
    };

    await reconcileCodexSnapshot({
      client,
      store: durable,
      binding: { ...binding, sourceRootId: root.id },
      connectionEpoch: "epoch:auto-review",
      pricing: reviewedPricingProvider(),
    });

    const snapshot = durable.getSnapshot(scope);
    const agent = snapshot.agents[0]!;
    expect(agent).toMatchObject({ name: "Codex Auto-review", role: "reviewer" });
    expect(agent.usageSegments?.segments[0]?.model).toBe("gpt-5.6-luna");
    expect(agent.cost).toMatchObject({ status: "estimated", selfMicros: 284, totalMicros: 284 });
    expect(snapshot.identityEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: agent.agentId, observedModel: "gpt-5.6-luna", observedProvider: "openai", observedEffort: "low" }),
    ]));
    const page = projectPublicHierarchy({ snapshot, events: durable.events.list(scope), page: 1, pageSize: 200 });
    expect(page.page.nodes[0]).toMatchObject({ displayName: "Codex Auto-review", role: "reviewer" });
    expect(page.page.nodes[0]?.identity.observed?.model).toBe("gpt-5.6-luna");
  });

  it("retains observed identity when incomplete telemetry has no attributable segments", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:identity-incomplete", status: "active", agentTaskName: "identity-incomplete" };
    const client: CodexSnapshotClient = {
      ...fixtureClient([root]),
      async readRolloutIdentity() {
        return {
          sourceThreadId: root.id,
          modelProvider: "openai",
          observedHistory: [{ model: "gpt-5.6-sol", effort: "medium" }],
          requestedSpawns: [],
          usageSegmentsComplete: false,
        };
      },
    };
    await reconcileCodexSnapshot({ client, store: durable, binding: { ...binding, sourceRootId: root.id }, connectionEpoch: "epoch:identity-incomplete", pricing: reviewedPricingProvider() });
    const snapshot = durable.getSnapshot(scope);
    const agent = snapshot.agents[0]!;
    expect(snapshot.identityEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: agent.agentId, observedProvider: "openai", observedModel: "gpt-5.6-sol", observedEffort: "medium", source: "codex.rollout.turn-context" }),
    ]));
    expect(agent.usageSegments).toEqual({ complete: false, segments: [] });
    expect(agent.cost).toMatchObject({ status: "unavailable", reason: "usage-segments-incomplete" });
  });

  it("preserves a pricing-pinned partial cost when a later refresh omits usage segments", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:cost-retention", status: "active", agentTaskName: "cost_retention" };
    const usage = { inputTokens: 1_000, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1_100 } as const;
    let evidence: RolloutIdentityEvidence | undefined = {
      sourceThreadId: root.id,
      modelProvider: "openai",
      observedHistory: [{ model: "gpt-5.6-sol", effort: "high" }],
      requestedSpawns: [],
      usage,
      usageSegments: [{ turnId: "turn:cost-retention", provider: "openai", model: "gpt-5.6-sol", effort: "high", usage }],
      usageSegmentsComplete: false,
    };
    const client: CodexSnapshotClient = {
      ...fixtureClient([root]),
      async readRolloutIdentity() { return evidence; },
    };
    const options = { client, store: durable, binding: { ...binding, sourceRootId: root.id }, pricing: reviewedPricingProvider() } as const;
    await reconcileCodexSnapshot({ ...options, connectionEpoch: "epoch:cost-known" });
    const agent = durable.agents.list(scope)[0]!;
    expect(agent.cost).toMatchObject({ status: "partial", knownSelfMicros: 7_100, pricing: { snapshotId: REVIEWED_OPENAI_PRICING_SNAPSHOT.snapshotId } });
    const projectedBefore = durable.events.list(scope).filter((event) => event.eventType === "cost.projected").length;

    evidence = undefined;
    await reconcileCodexSnapshot({ ...options, connectionEpoch: "epoch:cost-evidence-absent" });
    expect(durable.agents.get(scope, agent.agentId)).toMatchObject({
      pricingSnapshotId: REVIEWED_OPENAI_PRICING_SNAPSHOT.snapshotId,
      cost: { status: "partial", knownSelfMicros: 7_100, pricing: { snapshotId: REVIEWED_OPENAI_PRICING_SNAPSHOT.snapshotId } },
    });
    expect(durable.events.list(scope).filter((event) => event.eventType === "cost.projected")).toHaveLength(projectedBefore);
    expect(durable.rebuildSnapshot(scope).equivalentToLiveProjection).toBe(true);
  });

  it("does not retain ephemeral active state across an unknown refresh and lets explicit status win", async () => {
    const durable = store();
    let status = "active";
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [{ id: "thread:lifecycle-retention", status }] };
      },
      async readThread() { return { thread: { id: "thread:lifecycle-retention", status }, turns: [] }; },
    };
    const lifecycleBinding = { ...binding, sourceRootId: "thread:lifecycle-retention" };
    await reconcileCodexSnapshot({ client, store: durable, binding: lifecycleBinding, connectionEpoch: "epoch:lifecycle-active" });
    expect(durable.agents.list(scope)[0]?.lifecycle).toBe("active");
    expect(durable.agents.list(scope)[0]?.role).toBe("root");

    status = "unknown";
    await reconcileCodexSnapshot({ client, store: durable, binding: lifecycleBinding, connectionEpoch: "epoch:lifecycle-unknown" });
    expect(durable.agents.list(scope)[0]?.lifecycle).toBe("unknown");

    status = "idle";
    await reconcileCodexSnapshot({ client, store: durable, binding: lifecycleBinding, connectionEpoch: "epoch:lifecycle-idle" });
    expect(durable.agents.list(scope)[0]?.lifecycle).toBe("idle");
  });

  it("retains a terminal lifecycle across an unknown refresh", async () => {
    const durable = store();
    let status = "completed";
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [{ id: "thread:terminal-retention", status }] };
      },
      async readThread() { return { thread: { id: "thread:terminal-retention", status }, turns: [] }; },
    };
    const lifecycleBinding = { ...binding, sourceRootId: "thread:terminal-retention" };
    await reconcileCodexSnapshot({ client, store: durable, binding: lifecycleBinding, connectionEpoch: "epoch:lifecycle-completed" });
    expect(durable.agents.list(scope)[0]?.lifecycle).toBe("completed");

    status = "unknown";
    await reconcileCodexSnapshot({ client, store: durable, binding: lifecycleBinding, connectionEpoch: "epoch:lifecycle-terminal-unknown" });
    expect(durable.agents.list(scope)[0]?.lifecycle).toBe("completed");
  });

  it("refreshes an existing topology when 1024 bounded incomplete segments and identity arrive later", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:late-enrichment", status: "active", agentTaskName: "late-enrichment" };
    const usage = { inputTokens: 1_000, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1_100 } as const;
    let enriched = false;
    const client: CodexSnapshotClient = {
      ...fixtureClient([root]),
      async readRolloutIdentity() {
        if (!enriched) return undefined;
        return {
          sourceThreadId: root.id,
          modelProvider: "openai",
          observedHistory: [{ model: "gpt-5.6-sol", effort: "medium" }],
          requestedSpawns: [],
          usageSegments: Array.from({ length: 1_024 }, (_, index) => ({ turnId: `turn-${index}`, provider: "openai", model: "gpt-5.6-sol", effort: "medium", usage })),
          usageSegmentsComplete: false,
        };
      },
    };
    const options = { client, store: durable, binding: { ...binding, sourceRootId: root.id }, pricing: reviewedPricingProvider() } as const;
    await reconcileCodexSnapshot({ ...options, connectionEpoch: "epoch:late-initial" });
    expect(durable.agents.list(scope)).toHaveLength(1);
    expect(durable.identityEvidence.list(scope)).toHaveLength(0);

    enriched = true;
    await reconcileCodexSnapshot({ ...options, connectionEpoch: "epoch:late-enriched" });
    const snapshot = durable.getSnapshot(scope);
    const agent = snapshot.agents[0]!;
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.edges).toHaveLength(0);
    expect(agent.usageSegments).toMatchObject({ complete: false });
    expect(agent.usageSegments?.segments).toHaveLength(1_024);
    expect(agent.cost).toMatchObject({ status: "partial", knownSelfMicros: 7_270_400, reason: "usage-segments-incomplete", pricing: { snapshotId: REVIEWED_OPENAI_PRICING_SNAPSHOT.snapshotId } });
    expect(snapshot.identityEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: agent.agentId, observedProvider: "openai", observedModel: "gpt-5.6-sol", observedEffort: "medium" }),
    ]));
    expect(durable.rebuildSnapshot(scope).equivalentToLiveProjection).toBe(true);
  });

  it("uses a supplied bounded revision without hashing an oversized multi-agent segment aggregate", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:bounded-revision", status: "active", agentTaskName: "bounded-revision" };
    const children = Array.from({ length: 4 }, (_, index): FixtureThread => ({ id: `thread:bounded-child-${index}`, parentThreadId: root.id, status: "active", agentTaskName: `bounded_child_${index}` }));
    const usage = { inputTokens: 1_000, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1_100 } as const;
    const client: CodexSnapshotClient = {
      ...fixtureClient([root, ...children]),
      async readRolloutIdentity(threadId) {
        return {
          sourceThreadId: threadId,
          modelProvider: "openai",
          observedHistory: [{ model: "gpt-5.6-sol", effort: "medium" }],
          requestedSpawns: [],
          usageSegments: Array.from({ length: 1_024 }, (_, index) => ({ turnId: `turn-${index}`, provider: "openai", model: "gpt-5.6-sol", effort: "medium", usage })),
          usageSegmentsComplete: false,
        };
      },
    };
    await reconcileCodexSnapshot({ client, store: durable, binding: { ...binding, sourceRootId: root.id }, connectionEpoch: "epoch:bounded-revision", reconciliationId: "runtime-reconcile:bounded", pricing: reviewedPricingProvider() });
    const snapshot = durable.getSnapshot(scope);
    expect(snapshot.agents).toHaveLength(5);
    expect(snapshot.edges).toHaveLength(4);
    expect(snapshot.agents.every((agent) => agent.usageSegments?.segments.length === 1_024)).toBe(true);
    expect(durable.rebuildSnapshot(scope).equivalentToLiveProjection).toBe(true);
  });

  it("uses the latest non-null rollout value in A-B-A order and preserves no raw fields", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:dirac", status: "active", agentTaskName: "dirac" };
    const evidence = {
      sourceThreadId: root.id,
      modelProvider: "openai",
      observedHistory: [
        { model: "gpt-5.6-sol", effort: "high" },
        { model: "gpt-5.6-luna", effort: "max" },
        { model: "gpt-5.6-sol", effort: "low" },
      ],
      requestedSpawns: [],
      rolloutPath: "/private/rollouts/secret.jsonl",
      prompt: "secret rollout prompt",
    } as RolloutIdentityEvidence & { readonly rolloutPath: string; readonly prompt: string };
    const calls: string[] = [];
    const client: CodexSnapshotClient = {
      ...fixtureClient([root]),
      async readRolloutIdentity(threadId) {
        calls.push(threadId);
        return evidence;
      },
    };
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:rollout-drift" });
    const snapshot = durable.getSnapshot(scope);
    expect(calls).toEqual([root.id]);
    const agent = snapshot.agents.find((candidate) => candidate.sourceThreadId === root.id)!;
    expect(agent.verificationState).toBe("unverified");
    expect(snapshot.identityEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ observedModel: "gpt-5.6-sol", observedEffort: "low", observedProvider: "openai", source: "codex.rollout.turn-context" }),
    ]));
    const serialized = JSON.stringify(durable.events.list(scope).map((event) => event.sanitizedPayload));
    expect(serialized).not.toContain("rolloutPath");
    expect(serialized).not.toContain("secret rollout prompt");
  });

  it("keeps topology and unverified identity when rollout evidence is unavailable or throws", async () => {
    const durable = store();
    const threads: readonly FixtureThread[] = [
      { id: "thread:dirac", status: "active", agentTaskName: "dirac" },
      { id: "thread:rhea", parentThreadId: "thread:dirac", status: "idle", agentTaskName: "rhea" },
    ];
    const calls: string[] = [];
    const client: CodexSnapshotClient = {
      ...fixtureClient(threads),
      async readRolloutIdentity(threadId) {
        calls.push(threadId);
        if (threadId === "thread:rhea") throw new Error("private parser diagnostic");
        return undefined;
      },
    };
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:rollout-unavailable" });
    expect(calls).toHaveLength(threads.length);
    expect(new Set(calls)).toHaveLength(threads.length);
    expect(durable.agents.list(scope)).toHaveLength(threads.length);
    expect(durable.agents.list(scope).every((agent) => agent.verificationState === "unverified")).toBe(true);
    expect(durable.edges.list(scope)).toHaveLength(1);
    expect(JSON.stringify(durable.events.list(scope).map((event) => event.sanitizedPayload))).not.toContain("private parser diagnostic");
  });

  it("does not apply repeated or duplicate direct-child task names", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:dirac", status: "active", agentTaskName: "dirac" };
    const first: FixtureThread = { id: "thread:rhea-a", parentThreadId: root.id, status: "idle", agentTaskName: "rhea" };
    const second: FixtureThread = { id: "thread:rhea-b", parentThreadId: root.id, status: "idle", agentTaskName: "rhea" };
    const evidence = new Map<string, RolloutIdentityEvidence>([[root.id, {
      sourceThreadId: root.id,
      observedHistory: [],
      requestedSpawns: [
        { taskName: "rhea", model: "gpt-5.6-luna", reasoningEffort: "max" },
        { taskName: "rhea", model: "gpt-5.6-sol", reasoningEffort: "high" },
      ],
    }]]);
    const calls: string[] = [];
    const client: CodexSnapshotClient = {
      ...fixtureClient([root, first, second]),
      async readRolloutIdentity(threadId) {
        calls.push(threadId);
        return evidence.get(threadId);
      },
    };
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:rollout-ambiguous" });
    expect(calls).toHaveLength(3);
    expect(durable.agents.list(scope)).toHaveLength(3);
    expect(durable.agents.list(scope).filter((agent) => agent.sourceThreadId !== root.id).every((agent) => agent.verificationState === "unverified")).toBe(true);
    expect(durable.events.list(scope).filter((event) => event.eventType === "identity.requested")).toHaveLength(0);
  });

  it("uses structural agent paths for recursive task names without trusting raw title/name fields", async () => {
    const durable = store();
    const pathThreads: readonly FixtureThread[] = [
      { id: "thread:dirac", status: "active", agentPath: "/root/dirac", agentTaskName: "dirac", agentNickname: "Dirac", agentRole: "root" },
      { id: "thread:rhea", parentThreadId: "thread:dirac", status: "idle", agentPath: "/root/dirac/rhea", agentTaskName: "rhea", agentNickname: "Rhea", agentRole: "planner" },
      { id: "thread:kuhn", parentThreadId: "thread:rhea", status: "completed", agentPath: "/root/dirac/rhea/kuhn", agentTaskName: "kuhn", agentNickname: "Kuhn", agentRole: "worker" },
      { id: "thread:noether", parentThreadId: "thread:kuhn", status: "completed", agentPath: "/root/dirac/rhea/kuhn/noether", agentTaskName: "noether", agentNickname: "Noether", agentRole: "reviewer" },
    ];
    const pathReads = new Map<string, ReadonlyArray<FixtureRead>>(
      pathThreads.map((thread) => [thread.id, [{ thread, turns: canonicalReads.get(thread.id)?.[0]?.turns ?? [] }]]),
    );
    await reconcileCodexSnapshot({ client: fixtureClient(pathThreads, pathReads), store: durable, binding, connectionEpoch: "epoch:path-hierarchy" });

    const snapshot = durable.getSnapshot(scope);
    expect(new Set(snapshot.agents.map((agent) => agent.name))).toEqual(new Set(["dirac", "rhea", "kuhn", "noether"]));
    expect(snapshot.agents.find((agent) => agent.name === "rhea")?.parentSourceThreadId).toBe("thread:dirac");
    const rheaEvent = durable.events.list(scope).find((event) => event.eventType === "agent.reconciled" && event.sourceThreadId === "thread:rhea");
    expect(rheaEvent?.sanitizedPayload).toMatchObject({ name: "rhea", nickname: "Rhea" });
    expect(JSON.stringify(rheaEvent?.sanitizedPayload)).not.toContain("title");
  });

  it("includes completed archived descendants while keeping the root query non-archived", async () => {
    const durable = store();
    const calls: Array<Record<string, unknown>> = [];
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        calls.push(params as Record<string, unknown>);
        if (params?.archived === true) return { threads: canonicalThreads.slice(1) };
        return { threads: canonicalThreads.slice(0, 1) };
      },
      async readThread(params) {
        const thread = canonicalThreads.find((value) => value.id === params.threadId);
        return { thread, turns: canonicalReads.get(String(params.threadId))?.[0]?.turns ?? [] };
      },
    };

    const result = await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:archived-descendants" });
    expect(result.listPages).toBe(2);
    expect(durable.agents.list(scope).map((agent) => agent.sourceThreadId)).toEqual(expect.arrayContaining([
      "thread:dirac",
      "thread:rhea",
      "thread:kuhn",
      "thread:noether",
    ]));
    expect(durable.agents.list(scope)).toHaveLength(4);
    expect(calls.map((params) => params.archived)).toEqual([false, true]);
    expect(calls.every((params) => params.useStateDbOnly === false)).toBe(true);
  });

  it("derives nested parents from forkedFromId and rejects conflicting lineage without writes", async () => {
    const durable = store();
    const forkedThreads: readonly FixtureThread[] = [
      { id: "thread:dirac", status: "active", agentNickname: "Dirac", agentRole: "root" },
      { id: "thread:rhea", forkedFromId: "thread:dirac", status: "idle", agentNickname: "Rhea", agentRole: "planner" },
      { id: "thread:kuhn", forkedFromId: "thread:rhea", status: "completed", agentNickname: "Kuhn", agentRole: "worker" },
    ];
    await reconcileCodexSnapshot({ client: fixtureClient(forkedThreads), store: durable, binding, connectionEpoch: "epoch:forked-lineage" });
    const bySource = new Map(durable.agents.list(scope).map((agent) => [agent.sourceThreadId, agent.agentId]));
    const rhea = bySource.get("thread:rhea")!;
    const kuhn = bySource.get("thread:kuhn")!;
    const dirac = bySource.get("thread:dirac")!;
    expect(durable.edges.getParent(scope, rhea)?.parentAgentId).toBe(dirac);
    expect(durable.edges.getParent(scope, kuhn)?.parentAgentId).toBe(rhea);
    const beforeAgents = durable.agents.list(scope);
    const beforeEvents = durable.events.list(scope);

    const conflicting = fixtureClient([
      forkedThreads[0]!,
      { ...forkedThreads[1]!, parentThreadId: "thread:dirac", forkedFromId: "thread:other" },
      forkedThreads[2]!,
    ]);
    await expect(reconcileCodexSnapshot({ client: conflicting, store: durable, binding, connectionEpoch: "epoch:forked-conflict" })).rejects.toMatchObject({ code: "INVALID_PAGE" });
    expect(durable.agents.list(scope)).toEqual(beforeAgents);
    expect(durable.events.list(scope)).toEqual(beforeEvents);
  });

  it("fetches bounded list/read pages and keeps source-to-agent ids stable during recovery", async () => {
    const durable = store();
    const listCalls: Array<Record<string, unknown> | undefined> = [];
    const pageThreads = [
      { threads: canonicalThreads.slice(0, 2), nextCursor: "page-2" },
      { threads: canonicalThreads.slice(2) },
    ];
    let recovery = false;
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        listCalls.push(params as Record<string, unknown> | undefined);
        if (params?.archived === true) return { threads: [] };
        const index = typeof params?.cursor === "string" ? 1 : 0;
        return recovery ? { threads: canonicalThreads.slice(0, 3) } : pageThreads[index];
      },
      async readThread(params) {
        const id = String(params.threadId);
        const thread = canonicalThreads.find((value) => value.id === id)!;
        return { thread, turns: [] };
      },
    };
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:first" });
    const first = new Map(durable.agents.list(scope).map((agent) => [agent.sourceThreadId, agent.agentId]));
    recovery = true;
    const second = await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:recovery" });
    const agents = new Map(durable.agents.list(scope).map((agent) => [agent.sourceThreadId, agent]));
    expect(first.get("thread:rhea")).toBe(agents.get("thread:rhea")?.agentId);
    expect(agents.get("thread:noether")?.lifecycle).toBe("disconnected");
    expect(agents.get("thread:noether")?.verificationState).toBe("unverified");
    expect(second.listPages).toBe(2);
    expect(listCalls[1]?.cursor).toBe("page-2");
    expect(listCalls[0]?.useStateDbOnly).toBe(false);
    expect(listCalls[0]?.sourceKinds).toEqual([
      "cli",
      "vscode",
      "exec",
      "appServer",
      "subAgent",
      "subAgentReview",
      "subAgentCompact",
      "subAgentThreadSpawn",
      "subAgentOther",
    ]);
    expect(Object.isFrozen(listCalls[0]?.sourceKinds)).toBe(true);
  });

  it("supplements three missing rollout descendants, preserves them on fallback absence, and converges to app-server authority", async () => {
    const opened = fileStore();
    let durable = opened.store;
    const root: FixtureThread = { id: "thread:dirac", status: "active", agentNickname: "Dirac", agentRole: "root" };
    const fallback = [
      { sourceThreadId: "thread:one", parentThreadId: "thread:dirac", agentPath: "/root/one", agentTaskName: "one", status: "completed" as const },
      { sourceThreadId: "thread:two", parentThreadId: "thread:one", agentPath: "/root/one/two", agentTaskName: "two", status: "completed" as const },
      { sourceThreadId: "thread:three", parentThreadId: "thread:two", agentPath: "/root/one/two/three", agentTaskName: "three", status: "completed" as const },
    ];
    let listed: readonly FixtureThread[] = [root];
    let discovered: typeof fallback | undefined = fallback;
    const client: CodexSnapshotClient = {
      async listThreads(params) { return params?.archived === true ? { threads: [] } : { threads: listed }; },
      async readThread(params) {
        const thread = listed.find((candidate) => candidate.id === params.threadId);
        if (!thread) throw new Error("fallback nodes must not use app-server read");
        return { thread, turns: [] };
      },
      async discoverRolloutTopology() { return discovered; },
    };
    const initialReconciliation = {
      client,
      binding,
      connectionEpoch: "epoch:fallback:first",
      reconciliationId: "run:fallback:exact",
    } as const;
    await reconcileCodexSnapshot({ ...initialReconciliation, store: durable });
    const first = new Map(durable.agents.list(scope).map((agent) => [agent.sourceThreadId, agent.agentId]));
    expect(durable.agents.list(scope)).toHaveLength(4);
    expect(durable.edges.list(scope)).toHaveLength(3);
    expect(durable.events.list(scope).filter((event) => event.eventType === "agent.reconciled" && event.sanitizedPayload.sourceKind === "rollout-fallback")).toHaveLength(3);

    const eventCount = durable.events.list(scope).length;
    await reconcileCodexSnapshot({ ...initialReconciliation, store: durable });
    expect(durable.events.list(scope)).toHaveLength(eventCount);

    closeTracked(durable);
    durable = new DurableStore(opened.filename);
    stores.push(durable);
    expect(durable.agents.list(scope)).toHaveLength(4);
    expect(durable.edges.list(scope)).toHaveLength(3);
    expect(durable.rebuildSnapshot(scope)).toMatchObject({
      rebuiltFromEventCount: eventCount,
      equivalentToLiveProjection: true,
    });

    const publicProjection = projectPublicHierarchy({
      snapshot: durable.getSnapshot(scope),
      events: durable.events.list(scope),
      page: 1,
      pageSize: 200,
    }).page;
    const serializedPublicProjection = JSON.stringify(publicProjection);
    expect(serializedPublicProjection).not.toContain("sourceThreadId");
    for (const sourceThreadId of ["thread:dirac", "thread:one", "thread:two", "thread:three"]) {
      expect(serializedPublicProjection).not.toContain(sourceThreadId);
    }

    discovered = undefined;
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:fallback:missing" });
    expect(durable.agents.list(scope)).toHaveLength(4);
    expect(durable.agents.list(scope).filter((agent) => agent.lifecycle === "disconnected")).toHaveLength(0);

    listed = [
      root,
      { id: "thread:one", parentThreadId: "thread:dirac", status: "active", agentTaskName: "one" },
      { id: "thread:two", parentThreadId: "thread:one", status: "idle", agentTaskName: "two" },
      { id: "thread:three", parentThreadId: "thread:two", status: "completed", agentTaskName: "three" },
    ];
    discovered = fallback.map((node) => node.sourceThreadId === "thread:one" ? { ...node, status: "failed" as const } : node);
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:fallback:authoritative" });
    const final = new Map(durable.agents.list(scope).map((agent) => [agent.sourceThreadId, agent]));
    expect(final.get("thread:one")?.lifecycle).toBe("active");
    expect(final.get("thread:two")?.lifecycle).toBe("idle");
    expect(final.get("thread:one")?.agentId).toBe(first.get("thread:one"));
    expect(durable.agents.list(scope)).toHaveLength(4);
    expect(durable.edges.list(scope)).toHaveLength(3);
  });

  it("accepts a changed snapshot in one connection epoch and replays the retry idempotently", async () => {
    const durable = store();
    let status = "active";
    const client: CodexSnapshotClient = {
      async listThreads(params) { return params?.archived === true ? { threads: [] } : { threads: [{ ...canonicalThreads[0]!, status }] }; },
      async readThread() { return { thread: { ...canonicalThreads[0]!, status }, turns: [] }; },
    };
    const first = await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:same" });
    const afterFirst = durable.events.list(scope).length;
    status = "completed";
    const changed = await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:same" });
    const afterChanged = durable.events.list(scope).length;
    expect(afterChanged).toBeGreaterThan(afterFirst);
    expect(durable.agents.list(scope)[0]?.lifecycle).toBe("completed");
    expect(changed.reconciliationRevision).not.toBe(first.reconciliationRevision);
    status = "active";
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:same" });
    expect(durable.agents.list(scope)[0]?.lifecycle).toBe("active");
    const afterAgain = durable.events.list(scope).length;
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:same" });
    expect(durable.events.list(scope).length).toBe(afterAgain);
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:same", reconciliationId: "run:explicit" });
    const afterExplicit = durable.events.list(scope).length;
    expect(afterExplicit).toBeGreaterThan(afterAgain);
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:same", reconciliationId: "run:explicit" });
    expect(durable.events.list(scope).length).toBe(afterExplicit);
  });

  it("authoritatively replaces a changed parent edge across reconciliation epochs", async () => {
    const durable = store();
    const mutable = canonicalThreads.map((thread) => ({ ...thread }));
    const client = fixtureClient(mutable);
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:parent-a" });
    const bySource = new Map(durable.agents.list(scope).map((agent) => [agent.sourceThreadId, agent.agentId]));
    mutable[2] = { ...mutable[2]!, parentThreadId: "thread:dirac" };
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:parent-b" });
    const kuhn = bySource.get("thread:kuhn")!;
    const dirac = bySource.get("thread:dirac")!;
    expect(durable.edges.getParent(scope, kuhn)?.parentAgentId).toBe(dirac);
    expect(durable.rebuildSnapshot(scope).equivalentToLiveProjection).toBe(true);
  });

  it("commits nothing on duplicate cursors or partial thread reads", async () => {
    const durable = store();
    const looping: CodexSnapshotClient = {
      async listThreads(params) {
        if (params?.archived === true) return { threads: [] };
        return typeof params?.cursor === "string" ? { threads: [], nextCursor: params.cursor } : { threads: canonicalThreads.slice(0, 1), nextCursor: "loop" };
      },
      async readThread() { return { thread: canonicalThreads[0]!, turns: [] }; },
    };
    await expect(reconcileCodexSnapshot({ client: looping, store: durable, binding, connectionEpoch: "epoch:loop" })).rejects.toMatchObject({ code: "CURSOR_LOOP" });
    expect(durable.agents.list(scope)).toHaveLength(0);
    expect(durable.events.list(scope)).toHaveLength(0);

    const partial: CodexSnapshotClient = {
      async listThreads(params) { return params?.archived === true ? { threads: [] } : { threads: canonicalThreads }; },
      async readThread(params) {
        if (params.threadId === "thread:rhea") throw new Error("private read diagnostic");
        return { thread: canonicalThreads.find((value) => value.id === params.threadId), turns: [] };
      },
    };
    await expect(reconcileCodexSnapshot({ client: partial, store: durable, binding, connectionEpoch: "epoch:partial" })).rejects.toMatchObject({ code: "THREAD_READ_FAILED" });
    expect(durable.agents.list(scope)).toHaveLength(0);
    expect(durable.events.list(scope)).toHaveLength(0);
  });

  it("ignores unrelated roots/orphans but fails closed for root-subtree and cycle graphs", async () => {
    const durable = store();
    const unrelated = { id: "thread:other", status: "active" };
    const client = fixtureClient([
      ...canonicalThreads.slice(0, 2),
      unrelated,
      { id: "thread:other-child", parentThreadId: "thread:other" },
      { id: "thread:unrelated-orphan", parentThreadId: "thread:missing" },
      { id: "thread:unrelated-orphan-child", parentThreadId: "thread:unrelated-orphan" },
    ]);
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:unrelated" });
    expect(durable.agents.list(scope).map((agent) => agent.sourceThreadId)).toEqual(["thread:dirac", "thread:rhea"]);

    const before = durable.events.list(scope).length;
    const duplicate = fixtureClient([...canonicalThreads, canonicalThreads[0]!]);
    await expect(reconcileCodexSnapshot({ client: duplicate, store: durable, binding, connectionEpoch: "epoch:duplicate" })).rejects.toMatchObject({ code: "DUPLICATE_THREAD" });
    const orphan: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [canonicalThreads[0]!] };
      },
      async readThread(params) {
        if (params.threadId === "thread:dirac") {
          return { thread: canonicalThreads[0]!, turns: [{ id: "turn:orphan", items: [{ id: "item:orphan", subagentActivity: { sourceThreadId: "thread:orphan" } }] }] };
        }
        return { thread: { id: "thread:orphan" }, turns: [] };
      },
    };
    await expect(reconcileCodexSnapshot({ client: orphan, store: durable, binding, connectionEpoch: "epoch:orphan" })).rejects.toMatchObject({ code: "ORPHAN_THREAD" });
    const cycle = fixtureClient([{ id: "thread:dirac", parentThreadId: "thread:cycle", status: "active" }, { id: "thread:cycle", parentThreadId: "thread:dirac" }]);
    await expect(reconcileCodexSnapshot({ client: cycle, store: durable, binding, connectionEpoch: "epoch:cycle" })).rejects.toMatchObject({ code: "THREAD_CYCLE" });
    expect(durable.events.list(scope)).toHaveLength(before);
  });

  it("projects a selected nested Codex task as the root of its own bounded view", async () => {
    const durable = store();
    const selectedRoot = canonicalThreads[0]!;
    const selectedChild = canonicalThreads[1]!;
    const client = fixtureClient([
      { id: "thread:upstream", status: "active" },
      { ...selectedRoot, parentThreadId: "thread:upstream" },
      selectedChild,
    ]);

    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:nested-selected-root" });

    const projected = durable.agents.list(scope);
    expect(projected.map((agent) => agent.sourceThreadId)).toEqual([selectedRoot.id, selectedChild.id]);
    expect(projected.find((agent) => agent.sourceThreadId === selectedRoot.id)?.isRoot).toBe(true);
  });

  it("discovers recursive children from sanitized activity and reads each node once", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:dirac", status: "active", agentNickname: "Dirac", agentRole: "root" };
    const rhea: FixtureThread = { id: "thread:rhea", parentThreadId: root.id, status: "active", agentNickname: "Rhea", agentRole: "planner" };
    const kuhn: FixtureThread = { id: "thread:kuhn", parentThreadId: root.id, status: "completed", agentNickname: "Kuhn", agentRole: "worker" };
    const noether: FixtureThread = { id: "thread:noether", parentThreadId: rhea.id, status: "completed", agentNickname: "Noether", agentRole: "reviewer" };
    const reads = new Map<string, FixtureRead>([
      [root.id, { thread: root, turns: [{ id: "turn:dirac", items: [
        { id: "item:rhea", subagentActivity: { sourceThreadId: rhea.id, parentThreadId: root.id } },
        { id: "item:kuhn", collaboration: { operation: "spawnAgent", receiverIds: [kuhn.id] }, prompt: "must not persist" },
      ] }] }],
      [rhea.id, { thread: rhea, turns: [{ id: "turn:rhea", items: [{ id: "item:noether", subagentActivity: { agentThreadId: noether.id, parentThreadId: rhea.id } }] }] }],
      [kuhn.id, { thread: kuhn, turns: [] }],
      [noether.id, { thread: noether, turns: [{ id: "turn:noether", items: [{ id: "item:callback", subagentActivity: { sourceThreadId: kuhn.id, parentThreadId: noether.id } }] }] }],
    ]);
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [root] };
      },
      async readThread(params) {
        calls.push(params);
        return reads.get(String(params.threadId));
      },
    };

    const result = await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:recursive" });
    expect(result.sourceThreadIds).toEqual([root.id, kuhn.id, noether.id, rhea.id]);
    expect(durable.agents.list(scope)).toHaveLength(4);
    expect(durable.edges.list(scope)).toHaveLength(3);
    expect(calls).toEqual([
      { threadId: root.id, includeTurns: true },
      { threadId: rhea.id, includeTurns: true },
      { threadId: kuhn.id, includeTurns: true },
      { threadId: noether.id, includeTurns: true },
    ]);
    expect(new Set(calls.map((call) => call.threadId))).toHaveLength(4);
    expect(JSON.stringify(durable.events.list(scope).map((event) => event.sanitizedPayload))).not.toContain("must not persist");
  });

  it("ignores an ancestor activity mention whose explicit parent is the direct child", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:dirac", status: "active" };
    const child: FixtureThread = { id: "thread:rhea", parentThreadId: root.id, status: "active" };
    const grandchild: FixtureThread = { id: "thread:noether", parentThreadId: child.id, status: "completed" };
    const reads = new Map<string, FixtureRead>([
      [root.id, { thread: root, turns: [{ id: "turn:root", items: [
        { id: "item:child", subagentActivity: { sourceThreadId: child.id, parentThreadId: root.id } },
        // This is a callback/interaction recorded on the root, not a second
        // root -> grandchild edge. The child owns the canonical spawn.
        { id: "item:grandchild", subagentActivity: { sourceThreadId: grandchild.id, parentThreadId: child.id } },
      ] }] }],
      [child.id, { thread: child, turns: [{ id: "turn:child", items: [
        { id: "item:grandchild", subagentActivity: { sourceThreadId: grandchild.id, parentThreadId: child.id } },
      ] }] }],
      [grandchild.id, { thread: grandchild, turns: [] }],
    ]);
    const calls: string[] = [];
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [root] };
      },
      async readThread(params) {
        const id = String(params.threadId);
        calls.push(id);
        return reads.get(id);
      },
    };

    const result = await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:activity-parent-interaction" });
    expect(result.sourceThreadIds).toHaveLength(3);
    expect(new Set(result.sourceThreadIds)).toEqual(new Set([root.id, child.id, grandchild.id]));
    expect(calls).toEqual([root.id, child.id, grandchild.id]);
    expect(durable.edges.list(scope)).toHaveLength(2);
  });

  it("accepts a child whose read parent matches one of multiple pre-read spawn candidates", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:dirac", status: "active" };
    const child: FixtureThread = { id: "thread:rhea", parentThreadId: root.id, status: "active" };
    const grandchild: FixtureThread = { id: "thread:noether", parentThreadId: child.id, status: "completed" };
    const reads = new Map<string, FixtureRead>([
      [root.id, { thread: root, turns: [{ id: "turn:root", items: [{
        id: "item:spawn",
        collaboration: { operation: "spawnAgent", receiverIds: [child.id, grandchild.id] },
      }] }] }],
      [child.id, { thread: child, turns: [{ id: "turn:child", items: [{
        id: "item:spawn",
        collaboration: { operation: "spawnAgent", receiverIds: [grandchild.id] },
      }] }] }],
      [grandchild.id, { thread: grandchild, turns: [] }],
    ]);
    const calls: string[] = [];
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [root] };
      },
      async readThread(params) {
        const id = String(params.threadId);
        calls.push(id);
        return reads.get(id);
      },
    };

    const result = await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:candidate-parents" });
    expect(new Set(result.sourceThreadIds)).toEqual(new Set([root.id, child.id, grandchild.id]));
    expect(calls).toEqual([root.id, child.id, grandchild.id]);
    expect(durable.edges.list(scope)).toHaveLength(2);
  });

  it("makes candidate closure independent of receiver and item order", async () => {
    const root: FixtureThread = { id: "thread:dirac", status: "active" };
    const child: FixtureThread = { id: "thread:rhea", parentThreadId: root.id, status: "active" };
    const grandchild: FixtureThread = { id: "thread:noether", parentThreadId: child.id, status: "completed" };
    const variants: readonly (readonly unknown[])[] = [
      [{ id: "item:spawn", collaboration: { operation: "spawnAgent", receiverIds: [grandchild.id, child.id] } }],
      [
        { id: "item:grandchild", collaboration: { operation: "spawnAgent", receiverIds: [grandchild.id] } },
        { id: "item:child", collaboration: { operation: "spawnAgent", receiverIds: [child.id] } },
      ],
    ];

    for (const [index, rootItems] of variants.entries()) {
      const durable = store();
      const reads = new Map<string, FixtureRead>([
        [root.id, { thread: root, turns: [{ id: "turn:root", items: rootItems }] }],
        [child.id, { thread: child, turns: [{ id: "turn:child", items: [{
          id: "item:spawn",
          collaboration: { operation: "spawnAgent", receiverIds: [grandchild.id] },
        }] }] }],
        [grandchild.id, { thread: grandchild, turns: [] }],
      ]);
      const calls: string[] = [];
      const client: CodexSnapshotClient = {
        async listThreads(params) {
          return params?.archived === true ? { threads: [] } : { threads: [root] };
        },
        async readThread(params) {
          const id = String(params.threadId);
          calls.push(id);
          return reads.get(id);
        },
      };

      const result = await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: `epoch:candidate-order-${index}` });
      expect(new Set(result.sourceThreadIds)).toEqual(new Set([root.id, child.id, grandchild.id]));
      expect(calls).toEqual([root.id, grandchild.id, child.id]);
      expect(durable.edges.list(scope)).toHaveLength(2);
    }
  });

  it("rejects a discovered child whose direct read parent is outside all candidates", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:dirac", status: "active" };
    const child: FixtureThread = { id: "thread:rhea", parentThreadId: "thread:outside", status: "active" };
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [root] };
      },
      async readThread(params) {
        if (params.threadId === root.id) {
          return { thread: root, turns: [{ id: "turn:root", items: [{
            id: "item:spawn",
            collaboration: { operation: "spawnAgent", receiverIds: [child.id] },
          }] }] };
        }
        return { thread: child, turns: [] };
      },
    };

    await expect(reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:candidate-parent-mismatch" })).rejects.toMatchObject({ code: "CROSS_ROOT" });
    expect(durable.agents.list(scope)).toHaveLength(0);
    expect(durable.events.list(scope)).toHaveLength(0);
  });

  it("holds an outside-parent read without expanding its nested children or rollout evidence", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:dirac", status: "active" };
    const suspect: FixtureThread = { id: "thread:suspect", parentThreadId: "thread:outside", status: "active" };
    const nested: FixtureThread = { id: "thread:nested", parentThreadId: suspect.id, status: "completed" };
    const readCalls: string[] = [];
    const rolloutCalls: string[] = [];
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [root] };
      },
      async readThread(params) {
        const id = String(params.threadId);
        readCalls.push(id);
        if (id === root.id) {
          return { thread: root, turns: [{ id: "turn:root", items: [{
            id: "item:suspect",
            collaboration: { operation: "spawnAgent", receiverIds: [suspect.id] },
          }] }] };
        }
        if (id === suspect.id) {
          return { thread: suspect, turns: [{ id: "turn:suspect", items: [{
            id: "item:nested",
            collaboration: { operation: "spawnAgent", receiverIds: [nested.id] },
          }] }] };
        }
        throw new Error("held suspect must not expand nested child");
      },
      async readRolloutIdentity(threadId) {
        rolloutCalls.push(threadId);
        return undefined;
      },
    };

    await expect(reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:held-outside-parent" })).rejects.toMatchObject({ code: "CROSS_ROOT" });
    expect(readCalls).toEqual([root.id, suspect.id]);
    expect(rolloutCalls).toEqual([root.id]);
    expect(durable.agents.list(scope)).toHaveLength(0);
    expect(durable.events.list(scope)).toHaveLength(0);
  });

  it("accepts real per-thread session ids but rejects a same-thread list/read mismatch", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:dirac", sessionId: "session:main", status: "active" };
    const child: FixtureThread = { id: "thread:rhea", parentThreadId: root.id, sessionId: "session:rhea", status: "active" };
    const grandchild: FixtureThread = { id: "thread:noether", parentThreadId: child.id, sessionId: "session:noether", status: "completed" };
    await reconcileCodexSnapshot({ client: fixtureClient([root, child, grandchild]), store: durable, binding, connectionEpoch: "epoch:per-thread-sessions" });
    expect(durable.agents.list(scope)).toHaveLength(3);
    expect(new Set(durable.agents.list(scope).map((agent) => agent.sourceSessionId))).toEqual(new Set([root.sessionId, child.sessionId, grandchild.sessionId]));

    const mismatchStore = store();
    const mismatchClient: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [{ id: root.id, sessionId: root.sessionId }] };
      },
      async readThread() {
        return { thread: { id: root.id, sessionId: "session:other" }, turns: [] };
      },
    };
    await expect(reconcileCodexSnapshot({ client: mismatchClient, store: mismatchStore, binding, connectionEpoch: "epoch:same-thread-session-mismatch" })).rejects.toMatchObject({ code: "CROSS_ROOT" });
    expect(mismatchStore.events.list(scope)).toHaveLength(0);
  });

  it("does not treat send/follow-up/wait receiver mentions as child lineage", async () => {
    const durable = store();
    const calls: string[] = [];
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [{ id: "thread:dirac", status: "active" }] };
      },
      async readThread(params) {
        const id = String(params.threadId);
        calls.push(id);
        if (id !== "thread:dirac") throw new Error("messaging receiver must not be read as a child");
        return {
          thread: { id },
          turns: [{ id: "turn:messages", items: [
            { id: "item:send", collaboration: { operation: "send_message", receiverIds: ["thread:unlisted"] } },
            { id: "item:follow", collaboration: { operation: "followup_task", receiverIds: ["thread:unlisted"] } },
            { id: "item:wait", collaboration: { operation: "wait", receiverIds: ["thread:unlisted"] } },
          ] }],
        };
      },
    };
    const result = await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:non-spawn-collaboration" });
    expect(result.sourceThreadIds).toEqual(["thread:dirac"]);
    expect(calls).toEqual(["thread:dirac"]);
    expect(durable.agents.list(scope)).toHaveLength(1);
  });

  it("does not accept requested identity from non-spawn collaboration receivers", async () => {
    const durable = store();
    const root: FixtureThread = { id: "thread:dirac", status: "active" };
    const child: FixtureThread = { id: "thread:rhea", parentThreadId: root.id, status: "completed" };
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [root, child] };
      },
      async readThread(params) {
        if (params.threadId === root.id) {
          return {
            thread: root,
            turns: [{ id: "turn:messages", items: [{
              id: "item:send",
              collaboration: {
                operation: "send_message",
                receiverIds: [child.id],
                requestedModel: "gpt-5.6-sol",
                requestedReasoningEffort: "high",
              },
            }] }],
          };
        }
        return { thread: child, turns: [] };
      },
    };

    const result = await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:non-spawn-identity" });
    expect(result.sourceThreadIds).toEqual([root.id, child.id]);
    const childAgent = durable.agents.list(scope).find((agent) => agent.sourceThreadId === child.id);
    expect(childAgent).toBeDefined();
    expect(durable.identityEvidence.list(scope).filter((evidence) => evidence.agentId === childAgent?.agentId)).toEqual([]);
    expect(durable.events.list(scope).some((event) => JSON.stringify(event.sanitizedPayload).includes("collab.spawn"))).toBe(false);
  });

  it("rejects malformed or ambiguous discovered lineage without writes", async () => {
    const cases: Array<{ readonly name: string; readonly child: FixtureThread; readonly expected: string }> = [
      { name: "wrong-parent", child: { id: "thread:child", parentThreadId: "thread:other" }, expected: "CROSS_ROOT" },
      { name: "missing-parent", child: { id: "thread:child" }, expected: "ORPHAN_THREAD" },
    ];
    for (const entry of cases) {
      const durable = store();
      const root: FixtureThread = { id: "thread:dirac", status: "active", sessionId: "source-session-a" };
      const client: CodexSnapshotClient = {
        async listThreads(params) { return params?.archived === true ? { threads: [] } : { threads: [root] }; },
        async readThread(params) {
          if (params.threadId === root.id) return { thread: root, turns: [{ id: "turn:root", items: [{ id: "item:child", subagentActivity: { sourceThreadId: entry.child.id } }] }] };
          return { thread: entry.child, turns: [] };
        },
      };
      await expect(reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: `epoch:${entry.name}` })).rejects.toMatchObject({ code: entry.expected });
      expect(durable.agents.list(scope)).toHaveLength(0);
      expect(durable.events.list(scope)).toHaveLength(0);
    }
  });

  it("fails closed for recursive cycles, malformed receivers, and node limits", async () => {
    const cycleStore = store();
    const cycleClient: CodexSnapshotClient = {
      async listThreads(params) { return params?.archived === true ? { threads: [] } : { threads: [{ id: "thread:dirac" }] }; },
      async readThread() { return { thread: { id: "thread:dirac" }, turns: [{ id: "turn:cycle", items: [{ id: "item:self", subagentActivity: { sourceThreadId: "thread:dirac" } }] }] }; },
    };
    await expect(reconcileCodexSnapshot({ client: cycleClient, store: cycleStore, binding, connectionEpoch: "epoch:recursive-cycle" })).rejects.toMatchObject({ code: "THREAD_CYCLE" });
    expect(cycleStore.events.list(scope)).toHaveLength(0);

    const malformedStore = store();
    const malformedClient: CodexSnapshotClient = {
      async listThreads(params) { return params?.archived === true ? { threads: [] } : { threads: [{ id: "thread:dirac" }] }; },
      async readThread() { return { thread: { id: "thread:dirac" }, turns: [{ id: "turn:malformed", items: [{ id: "item:bad", collaboration: { receiverIds: ["not a source id"] } }] }] }; },
    };
    await expect(reconcileCodexSnapshot({ client: malformedClient, store: malformedStore, binding, connectionEpoch: "epoch:recursive-malformed" })).rejects.toMatchObject({ code: "INVALID_PAGE" });
    expect(malformedStore.events.list(scope)).toHaveLength(0);

    const limitedStore = store();
    const limitedClient: CodexSnapshotClient = {
      async listThreads(params) { return params?.archived === true ? { threads: [] } : { threads: [{ id: "thread:dirac" }] }; },
      async readThread(params) {
        if (params.threadId === "thread:dirac") return { thread: { id: "thread:dirac" }, turns: [{ id: "turn:fanout", items: [{ id: "item:a", subagentActivity: { sourceThreadId: "thread:a" } }, { id: "item:b", subagentActivity: { sourceThreadId: "thread:b" } }] }] };
        return { thread: { id: String(params.threadId), parentThreadId: "thread:dirac" }, turns: [] };
      },
    };
    await expect(reconcileCodexSnapshot({ client: limitedClient, store: limitedStore, binding, limits: { maxNodes: 2 }, connectionEpoch: "epoch:recursive-limit" })).rejects.toMatchObject({ code: "NODE_LIMIT" });
    expect(limitedStore.events.list(scope)).toHaveLength(0);
  });

  it("uses the latest sanitized turn status when a read lifecycle is unknown", async () => {
    const durable = store();
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [{ id: "thread:dirac", status: "not_loaded" }] };
      },
      async readThread() {
        return { thread: { id: "thread:dirac", status: "unknown" }, turns: [{ id: "turn:done", status: "completed", items: [] }] };
      },
    };
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:turn-status" });
    expect(durable.agents.list(scope).find((agent) => agent.sourceThreadId === "thread:dirac")?.lifecycle).toBe("completed");
  });

  it("uses exact trusted rollout lifecycle only when list and read remain unknown", async () => {
    const durable = store();
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [{ id: "thread:dirac", status: "unknown" }] };
      },
      async readThread() {
        return { thread: { id: "thread:dirac", status: "unknown" }, turns: [] };
      },
      async readRolloutIdentity(threadId) {
        return { sourceThreadId: threadId, lifecycle: "completed", observedHistory: [], requestedSpawns: [] };
      },
    };
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:rollout-lifecycle" });
    expect(durable.agents.list(scope).find((agent) => agent.sourceThreadId === "thread:dirac")?.lifecycle).toBe("completed");
  });

  it("lets an explicit terminal rollout close a stale app-server active snapshot", async () => {
    const durable = store();
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [{ id: "thread:dirac", status: "active" }] };
      },
      async readThread() {
        return { thread: { id: "thread:dirac", status: "active" }, turns: [] };
      },
      async readRolloutIdentity(threadId) {
        return { sourceThreadId: threadId, lifecycle: "completed", observedHistory: [], requestedSpawns: [] };
      },
    };
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:explicit-lifecycle" });
    expect(durable.agents.list(scope).find((agent) => agent.sourceThreadId === "thread:dirac")?.lifecycle).toBe("completed");
  });

  it("keeps a current active turn ahead of an older terminal rollout", async () => {
    const durable = store();
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [{ id: "thread:dirac", status: "active" }] };
      },
      async readThread() {
        return { thread: { id: "thread:dirac", status: "active" }, turns: [{ id: "turn:current", status: "active", items: [] }] };
      },
      async readRolloutIdentity(threadId) {
        return { sourceThreadId: threadId, lifecycle: "completed", observedHistory: [], requestedSpawns: [] };
      },
    };
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:current-turn-active" });
    expect(durable.agents.list(scope).find((agent) => agent.sourceThreadId === "thread:dirac")?.lifecycle).toBe("active");
  });

  it("ignores an invalid rollout lifecycle instead of fabricating state", async () => {
    const durable = store();
    const client: CodexSnapshotClient = {
      async listThreads(params) {
        return params?.archived === true ? { threads: [] } : { threads: [{ id: "thread:dirac", status: "unknown" }] };
      },
      async readThread() {
        return { thread: { id: "thread:dirac", status: "unknown" }, turns: [] };
      },
      async readRolloutIdentity(threadId) {
        return { sourceThreadId: threadId, lifecycle: "probably-done", observedHistory: [], requestedSpawns: [] } as never;
      },
    };
    await reconcileCodexSnapshot({ client, store: durable, binding, connectionEpoch: "epoch:invalid-rollout-lifecycle" });
    expect(durable.agents.list(scope).find((agent) => agent.sourceThreadId === "thread:dirac")?.lifecycle).toBe("unknown");
  });

  it("rejects an unverified binding before touching the client", async () => {
    const durable = store();
    let calls = 0;
    const client: CodexSnapshotClient = {
      async listThreads() { calls += 1; return { threads: [] }; },
      async readThread() { calls += 1; return {}; },
    };
    await expect(reconcileCodexSnapshot({ client, store: durable, binding: { ...binding, status: "revoked" }, connectionEpoch: "epoch:revoked" })).rejects.toBeInstanceOf(CodexReconciliationError);
    expect(calls).toBe(0);
    expect(durable.events.list(scope)).toHaveLength(0);
  });
});
