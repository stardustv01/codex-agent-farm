import { createHash } from "node:crypto";

import {
  PUBLIC_SCHEMA_VERSION,
  PublicAgentDetailsSchema,
  PublicHierarchyPageSchema,
  type PublicActivityLabel,
  type PublicAgent,
  type PublicAgentDetails,
  type PublicConnection,
  type PublicConnectionState,
  type PublicEdge,
  type PublicFailureCategory,
  type PublicHierarchyPage,
  type PublicLifecycle,
  type PublicReasonCode,
  type PublicSnapshotState,
  type PublicStoryKind,
  type PublicStoryMilestone,
} from "@agent-farm/contracts";
import type {
  AgentEdge,
  AgentRecord,
  IdentityEvidence,
  SanitizedEvent,
  SessionSnapshot,
} from "@agent-farm/store";

const MAX_PAGE_SIZE = 200;
const MAX_STORY = 256;

type RuntimeConnection = "connected" | "disconnected" | "unverified";

interface EventFacts {
  readonly firstSpawnOrdinal: number | null;
  readonly firstSpawnAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly returnedAt?: string;
  readonly lastActivityAt?: string;
  readonly failureCategory?: PublicFailureCategory;
  readonly milestones: readonly PublicStoryMilestone[];
}

interface MutableEventFacts {
  firstSpawnOrdinal: number | null;
  firstSpawnAt?: string;
  startedAt?: string;
  completedAt?: string;
  returnedAt?: string;
  lastActivityAt?: string;
  failureCategory?: PublicFailureCategory;
  milestones: PublicStoryMilestone[];
}

interface PublicProjectionOptions {
  readonly snapshot: SessionSnapshot;
  readonly events?: readonly SanitizedEvent[];
  readonly page: number;
  readonly pageSize: number;
  readonly connectionState?: RuntimeConnection;
}

interface PublicProjectionResult {
  readonly page: PublicHierarchyPage;
  readonly details: (agentId: string) => PublicAgentDetails | null;
}

/**
 * Project one durable snapshot into the only hierarchy shape allowed across
 * REST, MCP, and the standalone web host. This function intentionally has no
 * access to source-thread mappings or bridge credentials; it only receives
 * the already-sanitized durable projection and event envelopes.
 */
export function projectPublicHierarchy(options: PublicProjectionOptions): PublicProjectionResult {
  const { snapshot } = options;
  const events = [...(options.events ?? [])].sort((a, b) => a.ingestOrdinal - b.ingestOrdinal || a.eventId.localeCompare(b.eventId));
  const facts = collectEventFacts(events, snapshot.agents);
  const edgeStates = validateEdges(snapshot.agents, snapshot.edges);
  const parentByChild = edgeStates.parentByChild;
  const publicIds = new Map(snapshot.agents.map((agent) => [agent.agentId, publicAgentId(agent.agentId)]));
  const privateIdentifiers = snapshot.agents.flatMap((agent) => [agent.agentId, agent.sourceThreadId]).filter((value): value is string => value !== null);
  const childrenByParent = new Map<string, AgentRecord[]>();
  for (const agent of snapshot.agents) {
    const parent = parentByChild.get(agent.agentId);
    if (parent === undefined) continue;
    const children = childrenByParent.get(parent) ?? [];
    children.push(agent);
    childrenByParent.set(parent, children);
  }
  const legacyOrdinal = new Map<string, number>();
  let legacyCounter = 0;
  for (const agent of snapshot.agents) {
    if (agent.spawnOrdinal === null) legacyOrdinal.set(agent.agentId, ++legacyCounter);
  }
  const compareAgents = (a: AgentRecord, b: AgentRecord): number => {
    const aOrdinal = a.spawnOrdinal ?? legacyOrdinal.get(a.agentId) ?? Number.MAX_SAFE_INTEGER;
    const bOrdinal = b.spawnOrdinal ?? legacyOrdinal.get(b.agentId) ?? Number.MAX_SAFE_INTEGER;
    return aOrdinal - bOrdinal || publicAgentId(a.agentId).localeCompare(publicAgentId(b.agentId));
  };
  const roots = snapshot.agents
    .filter((agent) => agent.isRoot || !parentByChild.has(agent.agentId))
    .sort(compareAgents);
  const ordered: AgentRecord[] = [];
  const seen = new Set<string>();
  const visit = (agent: AgentRecord): void => {
    if (seen.has(agent.agentId)) return;
    seen.add(agent.agentId);
    ordered.push(agent);
    for (const child of [...(childrenByParent.get(agent.agentId) ?? [])].sort(compareAgents)) visit(child);
  };
  for (const root of roots) visit(root);
  for (const agent of [...snapshot.agents].sort(compareAgents)) visit(agent);

  const descendants = (agentId: string): number => {
    const visited = new Set<string>();
    const walk = (current: string): number => {
      if (visited.has(current)) return 0;
      visited.add(current);
      let total = 0;
      for (const child of childrenByParent.get(current) ?? []) total += 1 + walk(child.agentId);
      return total;
    };
    return walk(agentId);
  };
  const buildAgent = (agent: AgentRecord): PublicAgent => {
    const parentInternal = parentByChild.get(agent.agentId);
    const childRecords = [...(childrenByParent.get(agent.agentId) ?? [])].sort(compareAgents);
    const eventFacts = facts.get(agent.agentId) ?? emptyFacts();
    const lifecycle = publicLifecycle(agent.lifecycle);
    const connection = publicConnection(options.connectionState, events);
    const effectiveLifecycle = connection.state === "disconnected" && lifecycle !== "completed" && lifecycle !== "failed"
      ? "disconnected"
      : lifecycle;
    const taskState = {
      lifecycle: effectiveLifecycle,
      activityLabel: activityLabel(effectiveLifecycle, agent.verificationState, connection.state),
      ...(eventFacts.failureCategory === undefined ? {} : { failureCategory: eventFacts.failureCategory }),
      ...(eventFacts.startedAt === undefined ? {} : { startedAt: eventFacts.startedAt }),
      ...(eventFacts.completedAt === undefined ? {} : { completedAt: eventFacts.completedAt }),
      ...(eventFacts.returnedAt === undefined ? {} : { returnedAt: eventFacts.returnedAt }),
      ...(eventFacts.lastActivityAt === undefined ? {} : { lastActivityAt: eventFacts.lastActivityAt }),
    };
    const cluster = effectiveLifecycle === "active" || effectiveLifecycle === "pending" || effectiveLifecycle === "idle"
      ? "active"
      : effectiveLifecycle === "completed" ? "completed"
        : effectiveLifecycle === "failed" || effectiveLifecycle === "interrupted" ? "failed"
          : effectiveLifecycle === "disconnected" ? "disconnected" : "unknown";
    return {
      schemaVersion: PUBLIC_SCHEMA_VERSION,
      agentId: publicIds.get(agent.agentId) ?? publicAgentId(agent.agentId),
      parentAgentId: parentInternal === undefined ? null : publicIds.get(parentInternal) ?? publicAgentId(parentInternal),
      childIds: childRecords.map((child) => publicIds.get(child.agentId) ?? publicAgentId(child.agentId)),
      displayName: safeDisplayName(agent.name, privateIdentifiers, ordered.indexOf(agent)),
      role: publicRole(agent.role),
      lifecycle: effectiveLifecycle,
      taskState,
      identity: publicIdentity(
        snapshot.identityEvidence.filter((item) => item.agentId === agent.agentId),
        agent.verificationState,
        privateIdentifiers,
      ),
      directChildCount: childRecords.length,
      descendantCount: descendants(agent.agentId),
      ...(eventFacts.firstSpawnAt === undefined ? {} : { spawnAt: eventFacts.firstSpawnAt }),
      cluster: { state: cluster },
    };
  };

  const allNodes = ordered.map(buildAgent);
  const allNodeById = new Map(allNodes.map((node) => [node.agentId, node]));
  const allEdges = snapshot.edges
    .filter((edge) => allNodeById.has(publicIds.get(edge.parentAgentId) ?? publicAgentId(edge.parentAgentId)) && allNodeById.has(publicIds.get(edge.childAgentId) ?? publicAgentId(edge.childAgentId)))
    .sort((a, b) => compareEdges(a, b, legacyOrdinal))
    .map((edge): PublicEdge => ({
      schemaVersion: PUBLIC_SCHEMA_VERSION,
      edgeId: publicEdgeId(edge, publicIds),
      parentAgentId: publicIds.get(edge.parentAgentId) ?? publicAgentId(edge.parentAgentId),
      childAgentId: publicIds.get(edge.childAgentId) ?? publicAgentId(edge.childAgentId),
      state: edgeStates.states.get(edgeKey(edge)) ?? "unknown",
    }));
  const page = clampPage(options.page);
  const pageSize = clampPageSize(options.pageSize);
  const start = (page - 1) * pageSize;
  const pageNodes = allNodes.slice(start, start + pageSize);
  const pageNodeIds = new Set(pageNodes.map((node) => node.agentId));
  const pageEdges = allEdges.filter((edge) => pageNodeIds.has(edge.childAgentId));
  const connection = publicConnection(options.connectionState, events);
  const hasMore = start + pageNodes.length < allNodes.length;
  const legacy = snapshot.agents.some((agent) => agent.spawnOrdinal === null) || snapshot.edges.some((edge) => edge.spawnOrdinal === null);
  const snapshotState = snapshotStateFor(connection.state, hasMore, legacy, events.length === 0);
  const partialReason = reasonFor(snapshotState, hasMore, legacy, connection.state);
  const counts = countNodes(allNodes);
  const generatedAt = publicTimestamp(events.at(-1)?.observedAt) ?? publicTimestamp(snapshot.session.updatedAt) ?? "1970-01-01T00:00:00.000Z";
  const rootInternal = roots[0]?.agentId ?? ordered[0]?.agentId ?? null;
  const result: PublicHierarchyPage = PublicHierarchyPageSchema.parse({
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    agentSessionId: snapshot.session.agentSessionId,
    watermark: snapshot.watermarkIngestOrdinal,
    generatedAt,
    snapshotState,
    ...(partialReason === undefined ? {} : { partialReason }),
    connection,
    rootAgentId: rootInternal === null ? null : publicIds.get(rootInternal) ?? publicAgentId(rootInternal),
    nodes: pageNodes,
    edges: pageEdges,
    total: allNodes.length,
    page,
    pageSize,
    hasMore,
    nextCursor: hasMore ? `p_${page + 1}` : null,
    counts,
    storyMilestones: factsToStory(facts, publicIds, connection, snapshot.session.agentSessionId, generatedAt),
  });
  return {
    page: result,
    details: (requestedAgentId: string): PublicAgentDetails | null => {
      const internal = snapshot.agents.find((agent) => (publicIds.get(agent.agentId) ?? publicAgentId(agent.agentId)) === requestedAgentId);
      if (!internal) return null;
      const agent = buildAgent(internal);
      const parentInternal = parentByChild.get(internal.agentId);
      const parent = parentInternal === undefined ? null : buildAgent(snapshot.agents.find((candidate) => candidate.agentId === parentInternal) as AgentRecord);
      const children = [...(childrenByParent.get(internal.agentId) ?? [])].sort(compareAgents).map(buildAgent);
      const story = factsToStory(facts, publicIds, connection, snapshot.session.agentSessionId, generatedAt)
        .filter((milestone) => milestone.agentId === agent.agentId)
        .slice(-64);
      return PublicAgentDetailsSchema.parse({
        schemaVersion: PUBLIC_SCHEMA_VERSION,
        agentSessionId: snapshot.session.agentSessionId,
        connection,
        agent,
        parent,
        children,
        storyMilestones: story,
      });
    },
  };
}

function collectEventFacts(events: readonly SanitizedEvent[], agents: readonly AgentRecord[]): Map<string, EventFacts> {
  const facts = new Map<string, MutableEventFacts>();
  const known = new Set(agents.map((agent) => agent.agentId));
  const ensure = (agentId: string): MutableEventFacts => {
    const prior = facts.get(agentId);
    if (prior) return prior;
    const created = { firstSpawnOrdinal: null, milestones: [] };
    facts.set(agentId, created);
    return created;
  };
  const addMilestone = (factsForAgent: MutableEventFacts, event: SanitizedEvent, kind: PublicStoryKind, agentId: string | null): void => {
    factsForAgent.milestones.push({
      schemaVersion: PUBLIC_SCHEMA_VERSION,
      milestoneId: `milestone:${sha256({ eventId: event.eventId, kind })}`,
      sequence: event.ingestOrdinal,
      kind,
      agentId,
      occurredAt: new Date(event.observedAt).toISOString(),
    });
  };
  for (const event of events) {
    const payload = event.sanitizedPayload;
    const rawAgentId = typeof payload.agentId === "string" ? payload.agentId : undefined;
    const agentId = rawAgentId !== undefined && known.has(rawAgentId) ? rawAgentId : undefined;
    const type = event.eventType.toLowerCase();
    if (agentId === undefined) {
      if (type === "connection.state") continue;
      continue;
    }
    const target = ensure(agentId);
    const observedAt = publicTimestamp(event.observedAt) ?? "1970-01-01T00:00:00.000Z";
    target.lastActivityAt = observedAt;
    if (["agent.upsert", "agent.created", "agent.reconciled"].includes(type) && target.firstSpawnOrdinal === null) {
      target.firstSpawnOrdinal = event.ingestOrdinal;
      target.firstSpawnAt = observedAt;
      addMilestone(target, event, "spawned", agentId);
    } else if (type === "turn.started") {
      target.startedAt = observedAt;
      addMilestone(target, event, "working", agentId);
    } else if (type === "turn.completed") {
      target.completedAt = observedAt;
      target.returnedAt = observedAt;
      addMilestone(target, event, "returned", agentId);
    } else if (type === "turn.failed") {
      target.completedAt = observedAt;
      target.failureCategory = failureCategory(payload.errorCode);
      addMilestone(target, event, "failed", agentId);
    } else if (type === "turn.interrupted") {
      target.completedAt = observedAt;
      target.failureCategory = "cancelled";
      addMilestone(target, event, "interrupted", agentId);
    } else if (type === "thread.status.changed") {
      const status = typeof payload.status === "string" ? payload.status.toLowerCase() : "unknown";
      if (status === "disconnected") addMilestone(target, event, "disconnected", agentId);
      if (status === "active" || status === "running") addMilestone(target, event, "working", agentId);
    }
  }
  return new Map([...facts.entries()].map(([agentId, value]) => [agentId, value]));
}

function emptyFacts(): EventFacts {
  return { firstSpawnOrdinal: null, milestones: [] };
}

function factsToStory(
  facts: ReadonlyMap<string, EventFacts>,
  publicIds: ReadonlyMap<string, string>,
  connection: PublicConnection,
  sessionId: string,
  fallbackAt: string,
): PublicStoryMilestone[] {
  const story = [...facts.values()].flatMap((item) => item.milestones).sort((a, b) => a.sequence - b.sequence || a.milestoneId.localeCompare(b.milestoneId));
  if (connection.state === "disconnected") {
    story.push({
      schemaVersion: PUBLIC_SCHEMA_VERSION,
      milestoneId: `milestone:connection:${sha256({ sessionId, state: connection.state })}`,
      sequence: Number.MAX_SAFE_INTEGER,
      kind: "disconnected",
      agentId: null,
      occurredAt: connection.updatedAt ?? fallbackAt,
    });
  }
  return story.slice(-MAX_STORY).map((item) => ({
    ...item,
    agentId: item.agentId === null ? null : publicIds.get(item.agentId) ?? publicAgentId(item.agentId),
  }));
}

function publicIdentity(evidence: readonly IdentityEvidence[], fallback: string, privateIdentifiers: readonly string[]) {
  const latest = (kind: "requested" | "observed") => {
    for (let index = evidence.length - 1; index >= 0; index -= 1) {
      const item = evidence[index];
      if (!item) continue;
      const values = kind === "requested"
        ? { model: item.requestedModel, provider: item.requestedProvider, effort: item.requestedEffort }
        : { model: item.observedModel, provider: item.observedProvider, effort: item.observedEffort };
      const model = safeIdentityValue(values.model, privateIdentifiers);
      const provider = safeIdentityValue(values.provider, privateIdentifiers);
      const effort = safeIdentityValue(values.effort, privateIdentifiers);
      if (model || provider || effort) {
        const trust: "requested" | "observed" | "reconciled" | "unknown" = kind === "requested"
          ? item.trustClass === "requested" || item.trustClass === "reconciled" ? item.trustClass : "unknown"
          : item.trustClass === "observed" || item.trustClass === "reconciled" ? item.trustClass : "unknown";
        return {
          ...(model === undefined ? {} : { model }),
          ...(provider === undefined ? {} : { provider }),
          ...(effort === undefined ? {} : { effort }),
          source: publicEvidenceSource(item.source),
          trust,
        };
      }
    }
    return null;
  };
  const requested = latest("requested");
  const observed = latest("observed");
  const identityKeys = ["model", "provider", "effort"] as const;
  const sharedMismatch = requested && observed && identityKeys.some((key) =>
    requested[key] !== undefined && observed[key] !== undefined && requested[key] !== observed[key]);
  const exactEvidence = requested && observed && identityKeys.some((key) => requested[key] !== undefined) &&
    identityKeys.every((key) => requested[key] === undefined || requested[key] === observed[key]);
  const verification = sharedMismatch ? "mismatch" : exactEvidence ? "verified" :
    requested || observed ? "unverified" : publicVerification(fallback);
  return { requested, observed, verification };
}

function safeIdentityValue(value: string | null | undefined, privateIdentifiers: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (!candidate || candidate.length > 128 || /[\u0000-\u001f\u007f/%\\]/u.test(candidate)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return undefined;
  }
  const normalized = decoded.toLowerCase();
  if (decoded.includes("/") || decoded.includes("\\") ||
      privateIdentifiers.some((identifier) => normalized === identifier.toLowerCase() ||
        (identifier.length >= 8 && normalized.includes(identifier.toLowerCase()))) ||
      /(?:^|[\s._-])(token|secret|credential|password|cookie|session|path|prompt|reasoning)(?:$|[\s._=-])/iu.test(decoded)) {
    return undefined;
  }
  return candidate;
}

function publicVerification(value: string): "verified" | "unverified" | "mismatch" | "unknown" {
  return value === "verified" || value === "mismatch" || value === "unverified" ? value : "unknown";
}

function publicEvidenceSource(value: string): "collab.spawn" | "thread.settings" | "model.rerouted" | "thread.list" | "thread.read" | "reconciliation" | "unknown" {
  return ["collab.spawn", "thread.settings", "model.rerouted", "thread.list", "thread.read", "reconciliation"].includes(value)
    ? value as ReturnType<typeof publicEvidenceSource>
    : "unknown";
}

function publicLifecycle(value: string): PublicLifecycle {
  return ["pending", "active", "idle", "completed", "failed", "interrupted", "disconnected"].includes(value)
    ? value as PublicLifecycle
    : "unknown";
}

function publicRole(value: string | null): "root" | "planner" | "worker" | "reviewer" | "subagent" | "unknown" {
  return value && ["root", "planner", "worker", "reviewer", "subagent"].includes(value)
    ? value as ReturnType<typeof publicRole>
    : "unknown";
}

function activityLabel(lifecycle: PublicLifecycle, verification: string, connection: PublicConnectionState): PublicActivityLabel {
  if (connection === "disconnected") return "disconnected";
  if (verification !== "verified" && lifecycle === "unknown") return "unverified";
  if (lifecycle === "pending") return "queued";
  if (lifecycle === "active") return "working";
  if (lifecycle === "idle") return "waiting";
  if (lifecycle === "completed") return "returned";
  if (lifecycle === "failed") return "failed";
  if (lifecycle === "interrupted") return "interrupted";
  return "unknown";
}

function safeDisplayName(value: string | null, privateIdentifiers: readonly string[], index: number): string {
  if (typeof value !== "string") return `Agent ${String(index + 1).padStart(2, "0")}`;
  const candidate = value.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 160);
  let decoded = candidate;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return `Agent ${String(index + 1).padStart(2, "0")}`;
  }
  if (!candidate || candidate.includes("/") || candidate.includes("\\") || candidate.includes("%") ||
      privateIdentifiers.some((identifier) => candidate.toLowerCase() === identifier.toLowerCase() ||
        (identifier.length >= 8 && candidate.toLowerCase().includes(identifier.toLowerCase()))) ||
      decoded.includes("/") || decoded.includes("\\") ||
      /(?:^|[\s._-])(prompt|token|secret|credential|password|cookie|session|path|command|tool.?arg|reasoning)(?:$|[\s._=-])/iu.test(decoded)) {
    return `Agent ${String(index + 1).padStart(2, "0")}`;
  }
  return candidate;
}

export function publicAgentId(value: string): string {
  return `agent:${sha256(value).slice(0, 40)}`;
}

function publicEdgeId(edge: AgentEdge, publicIds: ReadonlyMap<string, string>): string {
  return `edge:${sha256({ parent: publicIds.get(edge.parentAgentId) ?? publicAgentId(edge.parentAgentId), child: publicIds.get(edge.childAgentId) ?? publicAgentId(edge.childAgentId) }).slice(0, 40)}`;
}

function edgeKey(edge: Pick<AgentEdge, "parentAgentId" | "childAgentId">): string {
  return `${edge.parentAgentId}\u0000${edge.childAgentId}`;
}

function validateEdges(
  agents: readonly AgentRecord[],
  edges: readonly AgentEdge[],
): { readonly parentByChild: Map<string, string>; readonly states: Map<string, "verified" | "pending" | "orphan" | "cycle" | "duplicate-parent" | "unknown"> } {
  const known = new Set(agents.map((agent) => agent.agentId));
  const parentByChild = new Map<string, string>();
  const states = new Map<string, "verified" | "pending" | "orphan" | "cycle" | "duplicate-parent" | "unknown">();
  const roots = new Set(agents.filter((agent) => agent.isRoot).map((agent) => agent.agentId));
  const eligible: AgentEdge[] = [];
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (!known.has(edge.parentAgentId) || !known.has(edge.childAgentId)) {
      states.set(key, "orphan");
      continue;
    }
    if (edge.parentAgentId === edge.childAgentId) {
      states.set(key, "cycle");
      continue;
    }
    if (edge.source !== "codex-reconciliation" && edge.source !== "event" && edge.source !== "app-server") {
      states.set(key, "unknown");
      continue;
    }
    if (roots.has(edge.childAgentId)) {
      states.set(key, "unknown");
      continue;
    }
    eligible.push(edge);
  }
  const parentsByChild = new Map<string, Set<string>>();
  for (const edge of eligible) {
    const parents = parentsByChild.get(edge.childAgentId) ?? new Set<string>();
    parents.add(edge.parentAgentId);
    parentsByChild.set(edge.childAgentId, parents);
  }
  const candidates = new Map<string, string>();
  for (const [child, parents] of parentsByChild) {
    if (parents.size === 1) candidates.set(child, [...parents][0] as string);
  }
  const cycleChildren = new Set<string>();
  for (const start of candidates.keys()) {
    const path: string[] = [];
    const indexByNode = new Map<string, number>();
    let cursor: string | undefined = start;
    while (cursor !== undefined && candidates.has(cursor)) {
      const prior = indexByNode.get(cursor);
      if (prior !== undefined) {
        for (const child of path.slice(prior)) cycleChildren.add(child);
        break;
      }
      indexByNode.set(cursor, path.length);
      path.push(cursor);
      cursor = candidates.get(cursor);
    }
  }
  for (const edge of eligible) {
    const key = edgeKey(edge);
    if ((parentsByChild.get(edge.childAgentId)?.size ?? 0) > 1) {
      states.set(key, "duplicate-parent");
    } else if (cycleChildren.has(edge.childAgentId)) {
      states.set(key, "cycle");
    } else {
      parentByChild.set(edge.childAgentId, edge.parentAgentId);
      states.set(key, "verified");
    }
  }
  return { parentByChild, states };
}

function compareEdges(a: AgentEdge, b: AgentEdge, legacyOrdinal: ReadonlyMap<string, number>): number {
  const aOrdinal = a.spawnOrdinal ?? legacyOrdinal.get(a.childAgentId) ?? Number.MAX_SAFE_INTEGER;
  const bOrdinal = b.spawnOrdinal ?? legacyOrdinal.get(b.childAgentId) ?? Number.MAX_SAFE_INTEGER;
  return aOrdinal - bOrdinal || a.parentAgentId.localeCompare(b.parentAgentId) || a.childAgentId.localeCompare(b.childAgentId);
}

function publicConnection(runtime: RuntimeConnection | undefined, events: readonly SanitizedEvent[], now = Date.now()): PublicConnection {
  const latest = [...events].reverse().find((event) => event.eventType.toLowerCase() === "connection.state");
  const raw = latest?.sanitizedPayload.status ?? latest?.status;
  const eventState = typeof raw === "string" ? raw.toLowerCase() : undefined;
  const state: PublicConnectionState = runtime === "disconnected" || eventState === "disconnected"
    ? "disconnected"
    : runtime === "connected" || eventState === "connected"
      ? "connected"
      : runtime === "unverified" || (runtime === undefined && eventState === undefined) ? "unverified" : "stale";
  const updatedAt = latest === undefined ? undefined : publicTimestamp(latest.observedAt);
  return {
    state,
    ...(state === "disconnected" ? { reason: "source-disconnected" as const } : state === "stale" ? { reason: "projection-lag" as const } : state === "unverified" ? { reason: "missing-evidence" as const } : {}),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

function publicTimestamp(value: number | string | undefined): string | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  try {
    return new Date(parsed).toISOString();
  } catch {
    return undefined;
  }
}

function snapshotStateFor(connection: PublicConnectionState, hasMore: boolean, legacy: boolean, noEvents: boolean): PublicSnapshotState {
  if (connection === "disconnected") return "disconnected";
  if (connection === "error") return "error";
  if (connection === "stale" || connection === "reconnecting") return "stale";
  if (connection === "unverified" || hasMore || legacy || noEvents) return "partial";
  return "complete";
}

function reasonFor(state: PublicSnapshotState, hasMore: boolean, legacy: boolean, connection: PublicConnectionState): PublicReasonCode | undefined {
  if (connection === "disconnected") return "source-disconnected";
  if (connection === "stale" || connection === "reconnecting") return "projection-lag";
  if (hasMore) return "pagination-bounded";
  if (legacy) return "legacy-projection";
  if (connection === "unverified") return "missing-evidence";
  if (state === "partial") return "missing-evidence";
  return undefined;
}

function countNodes(nodes: readonly PublicAgent[]) {
  return {
    total: nodes.length,
    active: nodes.filter((node) => node.lifecycle === "active" || node.lifecycle === "pending" || node.lifecycle === "idle").length,
    completed: nodes.filter((node) => node.lifecycle === "completed").length,
    failed: nodes.filter((node) => node.lifecycle === "failed" || node.lifecycle === "interrupted").length,
    disconnected: nodes.filter((node) => node.lifecycle === "disconnected").length,
    unverified: nodes.filter((node) => node.identity.verification !== "verified").length,
  };
}

function failureCategory(value: unknown): PublicFailureCategory {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("deadline")) return "timeout";
  if (normalized.includes("cancel") || normalized.includes("interrupt")) return "cancelled";
  if (normalized.includes("auth") || normalized.includes("permission")) return "authorization";
  if (normalized.includes("valid") || normalized.includes("schema")) return "validation";
  if (normalized.includes("bridge") || normalized.includes("connect")) return "bridge";
  if (normalized.includes("runtime") || normalized.includes("exception")) return "runtime";
  return "unknown";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function clampPage(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, 100_000) : 1;
}

function clampPageSize(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, MAX_PAGE_SIZE) : MAX_PAGE_SIZE;
}
