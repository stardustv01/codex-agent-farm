import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  PHASE_A_BINARY_SHA256,
  spawnStdioAppServer,
  type SpawnedStdioAppServer,
} from "../../packages/codex-bridge/src/index.ts";
// Use the built package boundary so the recovery run exercises the same
// durable store/error identity as the production composition.
import { DurableStore } from "../../packages/store/dist/index.js";

import { createProductionComposition } from "../../apps/server/src/composition.ts";
import { createSupportedCodexRuntimeAnchors } from "../../apps/server/src/runtime-service.ts";

const enabled = process.env.AGENT_FARM_REAL_CODEX_RECOVERY === "1";
if (!enabled) {
  process.stdout.write(`${JSON.stringify({ result: "SKIP", reason: "set AGENT_FARM_REAL_CODEX_RECOVERY=1" })}\n`);
  process.exit(0);
}

const sourceRootId = process.env.AGENT_FARM_SOURCE_ROOT_ID;
if (typeof sourceRootId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(sourceRootId)) {
  throw new Error("AGENT_FARM_SOURCE_ROOT_ID is required");
}

const binaryPath = process.env.AGENT_FARM_CODEX_BIN ?? "/Users/praveengupta/.local/bin/codex";
const sessionsRoot = process.env.AGENT_FARM_CODEX_SESSIONS_ROOT ?? "/Users/praveengupta/.codex/sessions";
const installationId = "agent-farm-recovery-codex-0.145.0";
const tenantId = "agent-farm-recovery-tenant";
const ownerId = "agent-farm-recovery-owner";
const agentSessionId = "agent-farm-recovery-session";
const scope = { tenantId, ownerId, agentSessionId } as const;
const databaseRoot = mkdtempSync(join(tmpdir(), "agent-farm-recovery-"));
const databaseFilename = join(databaseRoot, "agent-farm.sqlite");
const runStartedAt = new Date().toISOString();

let composition: ReturnType<typeof createProductionComposition> | undefined;
let durable: DurableStore | undefined;
let remounted: DurableStore | undefined;
const children: ChildProcessWithoutNullStreams[] = [];

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate: () => boolean, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("runtime recovery timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

function spawnProductionChild(options: Parameters<typeof spawnStdioAppServer>[0]): SpawnedStdioAppServer {
  // This is the production spawn helper, wrapped only to retain the exact
  // returned child handle. Recovery terminates only this handle, never a PID
  // discovered from the host process table.
  const spawned = spawnStdioAppServer(options);
  children.push(spawned.process);
  return spawned;
}

function graphCounts(store: DurableStore): { agents: number; edges: number; events: number; duplicateEventDelta: number; duplicateSourceDelta: number } {
  const agents = store.agents.list(scope);
  const edges = store.edges.list(scope);
  const events = store.events.list(scope);
  const uniqueEventKeys = new Set(events.map((event) => event.eventKey));
  const uniqueSources = new Set(agents.map((agent) => agent.sourceThreadId).filter((value): value is string => value !== null));
  return {
    agents: agents.length,
    edges: edges.length,
    events: events.length,
    duplicateEventDelta: events.length - uniqueEventKeys.size,
    duplicateSourceDelta: agents.length - uniqueSources.size,
  };
}

/**
 * Hash only the stable public projection. Volatile lifecycle/activity fields
 * are intentionally excluded so a reconnect can change status timestamps
 * without becoming a false structural mismatch. Raw source IDs never leave
 * this function; they are used only inside the digest input.
 */
function semanticProjectionFingerprint(store: DurableStore): string {
  const agents = store.agents.list(scope);
  const evidence = store.identityEvidence.list(scope)
    .sort((left, right) => left.observedAt - right.observedAt || left.evidenceId.localeCompare(right.evidenceId));
  const identityByAgent = new Map<string, {
    requestedProvider: string | null;
    requestedModel: string | null;
    requestedEffort: string | null;
    observedProvider: string | null;
    observedModel: string | null;
    observedEffort: string | null;
  }>();
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
  const stableAgents = agents.map((agent) => {
    const identity = identityByAgent.get(agent.agentId) ?? {
      requestedProvider: null,
      requestedModel: null,
      requestedEffort: null,
      observedProvider: null,
      observedModel: null,
      observedEffort: null,
    };
    return {
      agentId: agent.agentId,
      name: agent.name,
      role: agent.role,
      isRoot: agent.isRoot,
      verificationState: agent.verificationState,
      ...identity,
    };
  }).sort((left, right) => left.agentId.localeCompare(right.agentId));
  const stableEdges = store.edges.list(scope).map((edge) => ({
    parentAgentId: edge.parentAgentId,
    childAgentId: edge.childAgentId,
    state: "verified",
  })).sort((left, right) => left.parentAgentId.localeCompare(right.parentAgentId) || left.childAgentId.localeCompare(right.childAgentId));
  return createHash("sha256").update(JSON.stringify({ agents: stableAgents, edges: stableEdges }), "utf8").digest("hex");
}

function hasRequiredBranch(store: DurableStore): boolean {
  const agents = store.agents.list(scope);
  const edges = store.edges.list(scope);
  const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
  const mainRoots = agents.filter((agent) => agent.isRoot);
  if (mainRoots.length !== 1 || mainRoots[0] === undefined) return false;
  const childrenOf = (parentAgentId: string) => edges
    .filter((edge) => edge.parentAgentId === parentAgentId)
    .map((edge) => byId.get(edge.childAgentId))
    .filter((agent): agent is (typeof agents)[number] => agent !== undefined);
  const uniqueNamedChild = (parentAgentId: string, name: string) => {
    const matches = childrenOf(parentAgentId).filter((agent) => agent.name?.toLowerCase() === name);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const main = mainRoots[0];
  const dirac = uniqueNamedChild(main.agentId, "dirac");
  const rhea = dirac === undefined ? undefined : uniqueNamedChild(dirac.agentId, "rhea");
  const kuhn = dirac === undefined ? undefined : uniqueNamedChild(dirac.agentId, "kuhn");
  const noether = rhea === undefined ? undefined : uniqueNamedChild(rhea.agentId, "noether");
  return dirac !== undefined && rhea !== undefined && kuhn !== undefined && noether !== undefined;
}

try {
  durable = new DurableStore(databaseFilename);
  durable.createAgentSession({
    ...scope,
    sourceAdapter: "codex-app-server",
    idempotencyKey: "agent-farm-real-recovery-session",
  });

  const compositionOptions = {
    durableStore: durable,
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
      // Deliberately omit connectionEpoch: a new child must receive a new
      // runtime epoch after a dropped transport.
      spawn: spawnProductionChild,
    },
  } as const;
  composition = createProductionComposition(compositionOptions);
  const started = await composition.runtimeStart;
  assertCondition(started?.state === "unpaired", "runtime did not reach accepted pre-pair state");
  assertCondition(composition.runtimeService?.attestationReady(), "adapter gate was not accepted");
  assertCondition(children.length === 1, "initial connection did not create one child");

  const attestation = await composition.bridge.attestSourceRoot({ installationId, sourceRootId });
  const issued = await composition.bridge.issuePairingCredential({
    pairingId: "agent-farm-real-recovery-pairing",
    nonce: "agent-farm-real-recovery-nonce",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ownerId,
    tenantId,
    installationId,
    publicKey: "agent-farm-real-recovery-key",
    sourceRootId,
    sourceSessionId: attestation.sourceSessionId,
    sourceRootAttestationDigest: attestation.attestationDigest,
    sourceRootAttestationExpiresAt: attestation.expiresAt,
    agentSessionId,
    requestedScopes: ["bridge:ingest"],
  });
  assertCondition(issued.credential.length > 20, "pairing credential was not issued");
  await waitFor(() => composition?.runtimeService?.state === "connected" && composition.runtimeService.status.reconciliationState === "reconciled");
  const firstEpoch = composition.runtimeService?.status.connectionEpoch;
  assertCondition(typeof firstEpoch === "string" && firstEpoch.length > 0, "initial connection epoch missing");
  const firstChild = children[0];
  assertCondition(firstChild !== undefined, "initial child handle missing");
  const firstCounts = graphCounts(durable);
  const initialSemanticFingerprint = semanticProjectionFingerprint(durable);
  assertCondition(firstCounts.agents > 0 && firstCounts.edges > 0, "initial hierarchy was empty");
  const requiredBranchPresent = hasRequiredBranch(durable);
  assertCondition(requiredBranchPresent, "required recursive branch was not present");

  // Drop exactly the child returned by the production spawn helper. The
  // controller's process/transport listeners must publish disconnected and
  // stop accepting events before retry is attempted.
  assertCondition(firstChild.kill("SIGTERM"), "initial child termination was not accepted");
  await waitFor(() => composition?.runtimeService?.state === "disconnected");
  const disconnectedState = composition.runtimeService?.state;
  const disconnectedConnectionState = composition.bridge.connectionState();
  assertCondition(disconnectedState === "disconnected" && disconnectedConnectionState === "disconnected", "dropped transport was not reported as disconnected");

  const recovered = await composition.runtimeService?.retry();
  assertCondition(recovered?.state === "connected", "runtime retry did not reconnect");
  await waitFor(() => composition?.runtimeService?.state === "connected" && composition.runtimeService.status.reconciliationState === "reconciled");
  assertCondition(Number(children.length) === 2, "recovery did not create exactly one replacement child");
  const secondEpoch = composition.runtimeService?.status.connectionEpoch;
  assertCondition(typeof secondEpoch === "string" && secondEpoch.length > 0 && secondEpoch !== firstEpoch, "reconnect did not create a new connection epoch");
  const recoveredCounts = graphCounts(durable);
  const recoveredSemanticFingerprint = semanticProjectionFingerprint(durable);
  assertCondition(recoveredCounts.agents === firstCounts.agents && recoveredCounts.edges === firstCounts.edges, "recovery changed durable hierarchy cardinality");
  assertCondition(recoveredCounts.duplicateEventDelta === 0 && recoveredCounts.duplicateSourceDelta === 0, "recovery created duplicate durable keys");
  assertCondition(recoveredSemanticFingerprint === initialSemanticFingerprint, "recovery changed the stable semantic projection");
  assertCondition(hasRequiredBranch(durable), "required recursive branch was lost during recovery");
  assertCondition(durable.rebuildSnapshot(scope).equivalentToLiveProjection, "live projection did not survive deterministic rebuild");

  await composition.close();
  composition = undefined;
  durable = undefined;
  remounted = new DurableStore(databaseFilename);
  const remountedCounts = graphCounts(remounted);
  const remountedSemanticFingerprint = semanticProjectionFingerprint(remounted);
  assertCondition(remountedCounts.agents === recoveredCounts.agents && remountedCounts.edges === recoveredCounts.edges, "durable remount changed hierarchy cardinality");
  assertCondition(remountedCounts.events === recoveredCounts.events && remountedCounts.duplicateEventDelta === 0, "durable remount changed event identity");
  assertCondition(remountedSemanticFingerprint === initialSemanticFingerprint, "durable remount changed the stable semantic projection");
  assertCondition(hasRequiredBranch(remounted), "required recursive branch was lost on durable remount");
  assertCondition(remounted.rebuildSnapshot(scope).equivalentToLiveProjection, "durable remount failed deterministic rebuild");

  process.stdout.write(`${JSON.stringify({
    result: "PASS",
    observedAt: new Date().toISOString(),
    runStartedAt,
    stateTransitions: ["unpaired", "connected", "disconnected", "connected"],
    disconnectedState,
    disconnectedConnectionState,
    epochChanged: true,
    initial: firstCounts,
    recovered: recoveredCounts,
    remounted: remountedCounts,
    semanticProjection: {
      initialSha256: initialSemanticFingerprint,
      recoveredSha256: recoveredSemanticFingerprint,
      remountedSha256: remountedSemanticFingerprint,
      initialEqualsRecovered: initialSemanticFingerprint === recoveredSemanticFingerprint,
      initialEqualsRemounted: initialSemanticFingerprint === remountedSemanticFingerprint,
    },
    requiredBranchPresent: true,
    childCount: children.length,
  }, null, 2)}\n`);
} finally {
  if (composition) await composition.close().catch(() => undefined);
  for (const child of children) {
    try {
      if (child.exitCode === null || child.exitCode === undefined) child.kill("SIGTERM");
    } catch {
      // The child may have exited between the state check and cleanup.
    }
  }
  remounted?.close();
  durable?.close();
  rmSync(databaseRoot, { recursive: true, force: true });
}
