import {
  AGENT_STATUSES,
  CONNECTION_STATES,
  type AgentEdge,
  type AgentCounts,
  type AgentHierarchyInput,
  type AgentHierarchySnapshot,
  type AgentId,
  type AgentNode,
  type AgentStatus,
  type ConnectionInfo,
  type ConnectionState,
  type IdentityEvidence,
  type IdentityTrust,
  type IdentityValue,
  type LocalCandidateRoot,
  type OrchestrationBudget,
} from './types';
import {
  PublicAgentSchema,
  PublicEdgeSchema,
  PublicHierarchyPageSchema,
  type PublicAgent,
  type PublicEdge,
  type PublicHierarchyPage,
} from '@agent-farm/contracts';

const MAX_UI_AGENTS = 1_000;
const MAX_UI_EDGES = 2_000;
const MAX_TREE_DEPTH = 64;
const MAX_TEXT_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const MAX_METADATA_FIELDS = 32;
const MAX_CANDIDATE_ROOTS = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_TEXT_LENGTH && !/[\u0000-\u001f\u007f]/u.test(trimmed)
    ? trimmed
    : undefined;
};

const asId = (value: unknown): string | undefined => {
  const text = asString(value);
  return text && text.length <= MAX_ID_LENGTH ? text : undefined;
};

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asStatus = (value: unknown): AgentStatus => {
  if (typeof value === 'string' && (AGENT_STATUSES as readonly string[]).includes(value)) {
    return value as AgentStatus;
  }
  if (value === 'pending') return 'queued';
  if (value === 'active') return 'running';
  if (value === 'idle') return 'waiting';
  if (value === 'interrupted') return 'cancelled';
  return 'unknown';
};

const asConnectionState = (value: unknown): ConnectionState => {
  if (typeof value === 'string' && (CONNECTION_STATES as readonly string[]).includes(value)) {
    return value as ConnectionState;
  }
  if (value === 'connecting') return 'reconnecting';
  if (value === 'degraded') return 'stale';
  if (value === 'incompatible' || value === 'revoked') return 'error';
  return 'unverified';
};

const asTrust = (value: unknown): IdentityTrust | undefined => {
  if (value === 'authenticated' || value === 'observed' || value === 'inferred' || value === 'unknown') {
    return value;
  }
  return undefined;
};

function parseIdentityValue(value: unknown): IdentityValue | undefined {
  if (!isRecord(value)) return undefined;
  const result: IdentityValue = {};
  const model = asString(value.model ?? value.modelName ?? value.requestedModel ?? value.observedModel);
  const provider = asString(value.provider ?? value.modelProvider);
  const effort = asString(value.effort ?? value.reasoningEffort ?? value.requestedReasoningEffort ?? value.observedReasoningEffort);
  const source = asString(value.source);
  const observedAt = asString(value.observedAt ?? value.timestamp);
  const trust = asTrust(value.trust ?? value.trustClass);
  if (model) result.model = model;
  if (provider) result.provider = provider;
  if (effort) result.effort = effort;
  if (source) result.source = source;
  if (observedAt) result.observedAt = observedAt;
  if (trust) result.trust = trust;
  return Object.keys(result).length ? result : undefined;
}

function parseIdentity(raw: Record<string, unknown>): IdentityEvidence | undefined {
  const nested = isRecord(raw.identity) ? raw.identity : undefined;
  const requested = parseIdentityValue(raw.requested ?? raw.requestedIdentity ?? nested?.requested ?? {
    model: nested?.requestedModel ?? raw.requestedModel,
    provider: nested?.requestedProvider ?? raw.requestedProvider,
    effort: nested?.requestedReasoningEffort ?? nested?.requestedEffort ?? raw.requestedReasoningEffort ?? raw.requestedEffort,
  });
  const observed = parseIdentityValue(raw.observed ?? raw.observedIdentity ?? nested?.observed ?? {
    model: nested?.observedModel ?? raw.observedModel,
    provider: nested?.observedProvider ?? raw.observedProvider,
    effort: nested?.observedReasoningEffort ?? nested?.observedEffort ?? raw.observedReasoningEffort ?? raw.observedEffort,
  });
  const verificationValue = raw.verification ?? raw.verificationStatus ?? nested?.verification ?? nested?.verificationStatus ?? raw.identityVerification;
  const verification =
    verificationValue === 'verified' || verificationValue === 'mismatch' || verificationValue === 'unverified' || verificationValue === 'unknown'
      ? verificationValue
      : undefined;
  if (!requested && !observed && !verification) return undefined;
  const result: IdentityEvidence = {};
  if (requested) result.requested = requested;
  if (observed) result.observed = observed;
  if (verification) result.verification = verification;
  return result;
}

function parseMetadata(raw: Record<string, unknown>): AgentNode['metadata'] {
  if (!isRecord(raw.metadata)) return undefined;
  const metadata: NonNullable<AgentNode['metadata']> = {};
  for (const [key, value] of Object.entries(raw.metadata).slice(0, MAX_METADATA_FIELDS)) {
    if (!key || key.length > 64 || /[\u0000-\u001f\u007f]/u.test(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      metadata[key] = value as string | number | boolean | null;
    }
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

function parseNode(rawValue: unknown, fallbackId?: string, parentId: string | null = null): AgentNode | undefined {
  if (!isRecord(rawValue)) return undefined;
  const id = asId(rawValue.id ?? rawValue.agentId ?? rawValue.threadId) ?? fallbackId;
  if (!id) return undefined;
  const childValues = Array.isArray(rawValue.children) ? rawValue.children.slice(0, MAX_UI_AGENTS) : [];
  const childIds = childValues
    .map((child) => (isRecord(child) ? asId(child.id ?? child.agentId ?? child.threadId) : asId(child)))
    .filter((value): value is string => Boolean(value));
  const explicitChildIds = Array.isArray(rawValue.childIds)
    ? rawValue.childIds.slice(0, MAX_UI_AGENTS).map(asId).filter((value): value is string => value !== undefined)
    : [];
  const identity = parseIdentity(rawValue);
  const requested = identity?.requested;
  const observed = identity?.observed;
  const node: AgentNode = {
    id,
    parentId: asId(rawValue.parentId ?? rawValue.parentAgentId ?? rawValue.parent) ?? parentId,
    name: asString(rawValue.name ?? rawValue.nickname ?? rawValue.agentName) ?? id,
    status: asStatus(rawValue.status ?? rawValue.lifecycle),
  };
  const sessionId = asString(rawValue.sessionId);
  const sourceThreadId = asString(rawValue.sourceThreadId ?? rawValue.source_thread_id ?? rawValue.threadId);
  const nickname = asString(rawValue.nickname);
  const role = asString(rawValue.role ?? rawValue.agentRole);
  const task = asString(rawValue.task ?? rawValue.assignedTask);
  const summary = asString(rawValue.summary ?? rawValue.resultSummary ?? rawValue.result);
  const resultSummary = asString(rawValue.resultSummary ?? rawValue.result);
  const errorSummary = asString(rawValue.errorSummary ?? rawValue.error);
  const startedAt = asString(rawValue.startedAt ?? rawValue.started_at);
  const updatedAt = asString(rawValue.updatedAt ?? rawValue.updated_at);
  const completedAt = asString(rawValue.completedAt ?? rawValue.endedAt ?? rawValue.completed_at);
  const depth = asNumber(rawValue.depth);
  const durationMs = asNumber(rawValue.durationMs ?? rawValue.duration_ms);
  const requestedModel = asString(rawValue.requestedModel) ?? requested?.model;
  const requestedProvider = asString(rawValue.requestedProvider) ?? requested?.provider;
  const requestedEffort = asString(rawValue.requestedEffort ?? rawValue.requestedReasoningEffort) ?? requested?.effort;
  // Some MCP envelopes expose the effective identity under generic model /
  // provider / effort keys. Treat those as observed evidence while retaining
  // explicit requested/observed fields when present.
  const observedModel = asString(rawValue.observedModel ?? rawValue.model ?? rawValue.effectiveModel) ?? observed?.model;
  const observedProvider = asString(rawValue.observedProvider ?? rawValue.provider ?? rawValue.modelProvider ?? rawValue.effectiveProvider) ?? observed?.provider;
  const observedEffort = asString(rawValue.observedEffort ?? rawValue.observedReasoningEffort ?? rawValue.effort ?? rawValue.reasoningEffort ?? rawValue.effectiveReasoningEffort) ?? observed?.effort;
  const verification = identity?.verification ?? (
    rawValue.verification === 'verified' || rawValue.verification === 'mismatch' || rawValue.verification === 'unverified' || rawValue.verification === 'unknown'
      ? rawValue.verification
      : rawValue.verificationStatus === 'verified' || rawValue.verificationStatus === 'mismatch' || rawValue.verificationStatus === 'unverified' || rawValue.verificationStatus === 'unknown'
        ? rawValue.verificationStatus
        : undefined
  );
  if (sessionId) node.sessionId = sessionId;
  if (sourceThreadId) node.sourceThreadId = sourceThreadId;
  if (nickname) node.nickname = nickname;
  if (role) node.role = role;
  if (task) node.task = task;
  if (summary) node.summary = summary;
  if (resultSummary) node.resultSummary = resultSummary;
  if (errorSummary) node.errorSummary = errorSummary;
  if (startedAt) node.startedAt = startedAt;
  if (updatedAt) node.updatedAt = updatedAt;
  if (completedAt) node.completedAt = completedAt;
  if (depth !== undefined) node.depth = depth;
  if (durationMs !== undefined) node.durationMs = durationMs;
  const mergedChildIds = [...new Set([...explicitChildIds, ...childIds])];
  if (mergedChildIds.length) node.childIds = mergedChildIds;
  if (requestedModel) node.requestedModel = requestedModel;
  if (requestedProvider) node.requestedProvider = requestedProvider;
  if (requestedEffort) node.requestedEffort = requestedEffort;
  if (observedModel) node.observedModel = observedModel;
  if (observedProvider) node.observedProvider = observedProvider;
  if (observedEffort) node.observedEffort = observedEffort;
  if (identity) node.identity = identity;
  if (verification) node.verification = verification;
  const metadata = parseMetadata(rawValue);
  if (metadata) node.metadata = metadata;
  return node;
}

interface CollectionBudget {
  readonly seen: WeakSet<object>;
  count: number;
}

function collectNodes(
  raw: unknown,
  nodes: Map<string, AgentNode>,
  parentId: string | null = null,
  depth = 0,
  budget: CollectionBudget = { seen: new WeakSet<object>(), count: 0 },
): string | undefined {
  if (depth > MAX_TREE_DEPTH || budget.count >= MAX_UI_AGENTS) return undefined;
  if (isRecord(raw)) {
    if (budget.seen.has(raw)) return undefined;
    budget.seen.add(raw);
  }
  const parsed = parseNode(raw, undefined, parentId);
  if (!parsed) return undefined;
  const prior = nodes.get(parsed.id);
  const node: AgentNode = prior
    ? { ...prior, ...parsed, parentId: parsed.parentId ?? prior.parentId }
    : parsed;
  if (!prior) budget.count += 1;
  nodes.set(node.id, node);
  if (isRecord(raw) && Array.isArray(raw.children)) {
    const childIds: string[] = [];
    for (const child of raw.children.slice(0, MAX_UI_AGENTS)) {
      const childId = collectNodes(child, nodes, node.id, depth + 1, budget);
      if (childId) childIds.push(childId);
    }
    if (childIds.length) {
      nodes.set(node.id, { ...node, childIds: [...new Set([...(node.childIds ?? []), ...childIds])] });
    }
  }
  return node.id;
}

function addNodeCollection(value: unknown, nodes: Map<string, AgentNode>): void {
  const budget: CollectionBudget = { seen: new WeakSet<object>(), count: 0 };
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_UI_AGENTS)) collectNodes(item, nodes, null, 0, budget);
    return;
  }
  if (isRecord(value)) {
    for (const [id, item] of Object.entries(value).slice(0, MAX_UI_AGENTS)) {
      if (collectNodes(item, nodes, null, 0, budget) === undefined && isRecord(item)) collectNodes({ ...item, id }, nodes, null, 0, budget);
      else if (!isRecord(item)) collectNodes({ id, value: item }, nodes, null, 0, budget);
    }
  }
}

function parseConnection(value: unknown): ConnectionInfo {
  if (typeof value === 'string') return { state: asConnectionState(value) };
  if (!isRecord(value)) return { state: 'unverified' };
  const result: ConnectionInfo = { state: asConnectionState(value.state ?? value.status ?? value.connectionState) };
  const label = asString(value.label);
  const detail = asString(value.detail ?? value.message);
  const connectedAt = asString(value.connectedAt);
  const lastEventAt = asString(value.lastEventAt ?? value.lastEvent);
  if (label) result.label = label;
  if (detail) result.detail = detail;
  if (connectedAt) result.connectedAt = connectedAt;
  if (lastEventAt) result.lastEventAt = lastEventAt;
  if (typeof value.epoch === 'string' || typeof value.epoch === 'number') result.epoch = value.epoch;
  if (typeof value.watermark === 'string' || typeof value.watermark === 'number') result.watermark = value.watermark;
  return result;
}

function parseCounts(value: unknown, agents: Record<string, AgentNode>): AgentCounts | undefined {
  if (!isRecord(value)) return undefined;
  const read = (key: string): number | undefined => {
    const candidate = value[key];
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= 100_000 ? candidate : undefined;
  };
  const total = read('total');
  const active = read('active');
  const completed = read('completed');
  const failed = read('failed');
  const unverified = read('unverified');
  if ([total, active, completed, failed, unverified].every((item) => item === undefined)) return undefined;
  const derived = Object.values(agents).reduce((counts, node) => {
    counts.total += 1;
    if (node.status === 'running' || node.status === 'queued' || node.status === 'waiting') counts.active += 1;
    if (node.status === 'completed') counts.completed += 1;
    if (node.status === 'failed') counts.failed += 1;
    if (node.status === 'unverified' || node.status === 'disconnected') counts.unverified += 1;
    return counts;
  }, { total: 0, active: 0, completed: 0, failed: 0, unverified: 0 });
  // API responses are allowed to expose only a subset of count fields. Fill
  // omitted values from the normalized nodes so the toolbar never renders
  // misleading zeroes for a partial count envelope.
  return {
    total: total ?? derived.total,
    active: active ?? derived.active,
    completed: completed ?? derived.completed,
    failed: failed ?? derived.failed,
    unverified: unverified ?? derived.unverified,
  };
}

/** Keep the UI contract aligned with the server's 25-slot budget ceiling. */
export function normalizeOrchestrationBudget(value: unknown): OrchestrationBudget | undefined {
  if (!isRecord(value)) return undefined;
  const read = (key: keyof OrchestrationBudget, minimum: number, maximum: number): number | undefined => {
    const candidate = value[key];
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= minimum && candidate <= maximum ? candidate : undefined;
  };
  const solHigh = read('solHigh', 0, 10);
  const lunaMax = read('lunaMax', 0, 10);
  const solMax = read('solMax', 2, 3);
  if (solHigh === undefined || lunaMax === undefined || solMax === undefined || solHigh + lunaMax + solMax > 25) return undefined;
  return { solHigh, lunaMax, solMax };
}

/** Local selection handles are opaque, bounded URL-safe capabilities. */
export function isSafeSelectionHandle(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export function isSafeChatHandle(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

/**
 * Keep local pairing choices deliberately narrow.  The local server may know
 * considerably more about a source root, but the browser only needs these
 * display fields; malformed input fails closed to an empty list.
 */
export function normalizeCandidateRoots(value: unknown): LocalCandidateRoot[] {
  if (!Array.isArray(value) || value.length > MAX_CANDIDATE_ROOTS) return [];
  const roots: LocalCandidateRoot[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) return [];
    const selectionHandle = isSafeSelectionHandle(candidate.selectionHandle) ? candidate.selectionHandle : undefined;
    const candidateDisplayName = asString(candidate.displayName);
    if (!selectionHandle || !candidateDisplayName || seen.has(selectionHandle)) return [];
    const displayName = isSafeLocalDisplayName(candidateDisplayName) && !isGenericChatTitle(candidateDisplayName)
      ? candidateDisplayName
      : `Chat · ${String(roots.length + 1).padStart(2, '0')}`;
    const root: LocalCandidateRoot = { selectionHandle, displayName };
    if (candidate.chatHandle !== undefined) {
      if (!isSafeChatHandle(candidate.chatHandle)) return [];
      root.chatHandle = candidate.chatHandle;
    }
    const chatTitle = asString(candidate.chatTitle);
    const workspaceName = asString(candidate.workspaceName);
    if (candidate.chatTitle !== undefined && (!chatTitle || !isSafeLocalDisplayName(chatTitle))) return [];
    if (candidate.workspaceName !== undefined && (!workspaceName || !isSafeLocalDisplayName(workspaceName))) return [];
    if (chatTitle && !isGenericChatTitle(chatTitle)) root.chatTitle = chatTitle;
    if (workspaceName) root.workspaceName = workspaceName;
    if (candidate.active !== undefined && candidate.active !== true) return [];
    if (candidate.active === true) {
      if (roots.some((rootCandidate) => rootCandidate.active === true)) return [];
      root.active = true;
    }
    if (candidate.bound !== undefined && candidate.bound !== true) return [];
    if (candidate.bound === true) root.bound = true;
    if (candidate.launchTarget !== undefined && candidate.launchTarget !== true) return [];
    if (candidate.launchTarget === true) {
      if (roots.some((rootCandidate) => rootCandidate.launchTarget === true)) return [];
      root.launchTarget = true;
    }
    const lifecycle = safeLocalLifecycle(candidate.lifecycle ?? candidate.status);
    const lastActivityAt = safeLocalTimestamp(candidate.lastActivityAt ?? candidate.updatedAt);
    if (candidate.lifecycle !== undefined && lifecycle === undefined) return [];
    if (candidate.lastActivityAt !== undefined && lastActivityAt === undefined) return [];
    if (lifecycle) root.lifecycle = lifecycle;
    if (lastActivityAt) root.lastActivityAt = lastActivityAt;
    if (candidate.descendantCount !== undefined) {
      const descendantCount = candidate.descendantCount;
      if (typeof descendantCount !== 'number' || !Number.isSafeInteger(descendantCount) || descendantCount < 0 || descendantCount > 1_000) return [];
      root.descendantCount = descendantCount;
    }
    seen.add(selectionHandle);
    roots.push(root);
  }
  return roots;
}

function safeLocalTimestamp(value: unknown): string | undefined {
  const timestamp = asString(value);
  if (timestamp === undefined || timestamp.length > 64) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export function isSafeLocalDisplayName(value: string): boolean {
  // Ordinary words such as "code" or "id" are valid chat titles. Reject
  // only labels that have the shape of a credential or bearer value.
  const sensitiveLabel = /(?:bearer\s+\S+|(?:access|refresh|auth|api)[\s._-]?(?:token|key|secret)\b|(?:password|passwd|cookie|authorization|credential|private[_-]?key|secret)\s*[:=]\s*\S+)/iu;
  return !value.includes('/') && !value.includes('\\') && !/^(?:[A-Za-z]:|\.{0,2}\/|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/u.test(value) && !sensitiveLabel.test(value);
}

function isGenericChatTitle(value: string): boolean {
  return /^untitled\s+chat(?:\s*(?:·|•|\||:|-)\s*\d+)?$/iu.test(value.trim());
}

function safeLocalLifecycle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'disconnected', 'idle', 'ready', 'pending', 'active', 'unknown'].includes(normalized)
    ? normalized
    : 'unknown';
}

export function normalizeSnapshot(input: AgentHierarchyInput | AgentHierarchySnapshot | unknown): AgentHierarchySnapshot {
  // Reducer/host hand-offs carry the already validated public projection as
  // an internal snapshot shape. Preserve that safe projection instead of
  // treating its `agents` map as an untrusted transport page.
  if (isNormalizedPublicSnapshot(input)) return input;
  const publicSnapshot = normalizePublicV1Snapshot(input);
  if (publicSnapshot) return publicSnapshot;
  // A payload that declares the strict public contract must never fall
  // through to the permissive legacy parser. Keep the browser empty and
  // visibly errored instead of guessing at private/partial fields.
  if (isPublicV1Envelope(input)) return invalidPublicV1Snapshot();
  const raw = isRecord(input) ? input : {};
  const nodes = new Map<string, AgentNode>();
  addNodeCollection(raw.agents ?? raw.nodes, nodes);
  const sessionRecord = isRecord(raw.session) ? raw.session : undefined;
  let rootId: string | null = asId(raw.rootAgentId ?? sessionRecord?.rootAgentId) ?? null;
  if (isRecord(raw.root)) {
    const collected = collectNodes(raw.root, nodes);
    if (collected) rootId ??= collected;
  } else if (raw.root) {
    const collected = collectNodes(raw.root, nodes);
    if (collected) rootId ??= collected;
  }
  const edges: AgentEdge[] = [];
  if (Array.isArray(raw.edges)) {
    for (const edge of raw.edges.slice(0, MAX_UI_EDGES)) {
      if (!isRecord(edge)) continue;
      const parentId = asId(edge.parentId ?? edge.parentAgentId ?? edge.parent);
      const childId = asId(edge.childId ?? edge.childAgentId ?? edge.child);
      if (parentId && childId && nodes.has(parentId) && nodes.has(childId)) {
        const normalizedEdge: AgentEdge = { parentId, childId, verified: edge.verified !== false };
        const source = asString(edge.source);
        if (source) normalizedEdge.source = source;
        edges.push(normalizedEdge);
      }
    }
  }
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId) && !edges.some((edge) => edge.parentId === node.parentId && edge.childId === node.id)) {
      edges.push({ parentId: node.parentId, childId: node.id, verified: true, source: 'parentId' });
    }
  }
  for (const node of nodes.values()) {
    if (node.childIds) {
      for (const childId of node.childIds) {
        if (nodes.has(childId) && !edges.some((edge) => edge.parentId === node.id && edge.childId === childId)) {
          edges.push({ parentId: node.id, childId, verified: true, source: 'childIds' });
        }
      }
    }
  }
  if (!rootId) rootId = [...nodes.values()].find((node) => !node.parentId)?.id ?? [...nodes.keys()][0] ?? null;
  const childrenByParent = new Map<string, string[]>();
  for (const edge of edges) {
    const children = childrenByParent.get(edge.parentId) ?? [];
    children.push(edge.childId);
    childrenByParent.set(edge.parentId, children);
  }
  const agents: Record<string, AgentNode> = {};
  for (const node of nodes.values()) {
    const childIds = childrenByParent.get(node.id);
    const normalizedNode: AgentNode = {
      ...node,
      parentId: node.parentId && nodes.has(node.parentId) ? node.parentId : node.id === rootId ? null : node.parentId,
    };
    if (childIds?.length) normalizedNode.childIds = [...new Set(childIds)];
    agents[node.id] = normalizedNode;
  }
  const sessionId = asString(raw.sessionId ?? raw.agentSessionId ?? sessionRecord?.agentSessionId) ?? 'agent-farm-session';
  const schemaVersion = asString(raw.schemaVersion) ?? 'agent-farm.v1';
  const connection = parseConnection(raw.connection ?? raw.connectionState);
  const counts = parseCounts(raw.counts, agents);
  const orchestrationBudget = normalizeOrchestrationBudget(raw.orchestrationBudget) ?? normalizeOrchestrationBudget(sessionRecord?.orchestrationBudget);
  const result: AgentHierarchySnapshot = {
    schemaVersion,
    sessionId,
    rootAgentId: rootId,
    agents,
    edges,
    connection,
    ...(counts === undefined ? {} : { counts }),
    ...(orchestrationBudget === undefined ? {} : { orchestrationBudget }),
  };
  if (typeof raw.watermark === 'string' || typeof raw.watermark === 'number') result.watermark = raw.watermark;
  if (typeof raw.version === 'string' || typeof raw.version === 'number') result.version = raw.version;
  const sourceAdapter = asString(raw.sourceAdapter);
  const generatedAt = asString(raw.generatedAt);
  if (sourceAdapter) result.sourceAdapter = sourceAdapter;
  if (generatedAt) result.generatedAt = generatedAt;
  return result;
}

/**
 * Parse the strict server-owned public-v1 hierarchy before any generic/demo
 * compatibility logic. This path is intentionally a direct projection: IDs,
 * parent/child edges, ordering, counts, story milestones, and partial state
 * are already authoritative and must not be remapped or inferred in the UI.
 */
function normalizePublicV1Snapshot(input: unknown): AgentHierarchySnapshot | undefined {
  const parsed = parsePublicV1Payload(input);
  if (!parsed) return undefined;
  const { page, nodes, edges: publicEdges } = parsed;
  const agents: Record<string, AgentNode> = {};
  for (const node of nodes) {
    const toStatus = (): AgentStatus => {
      if (node.lifecycle === 'pending') return 'queued';
      if (node.lifecycle === 'active') return 'running';
      if (node.lifecycle === 'idle') return 'waiting';
      if (node.lifecycle === 'completed') return 'completed';
      if (node.lifecycle === 'failed') return 'failed';
      if (node.lifecycle === 'interrupted') return 'cancelled';
      if (node.lifecycle === 'disconnected') return 'disconnected';
      return 'unknown';
    };
    const identity: IdentityEvidence = {
      ...(node.identity.requested === null ? {} : { requested: publicIdentityValue(node.identity.requested) }),
      ...(node.identity.observed === null ? {} : { observed: publicIdentityValue(node.identity.observed) }),
      verification: node.identity.verification,
    };
    const status = toStatus();
    const normalized: AgentNode = {
      id: node.agentId,
      parentId: node.parentAgentId,
      name: node.displayName,
      role: node.role,
      status,
      childIds: [...node.childIds],
      identity,
      verification: node.identity.verification,
      publicNode: node,
      ...(node.spawnAt === undefined ? {} : { startedAt: node.spawnAt }),
      ...(node.taskState.lastActivityAt === undefined ? {} : { updatedAt: node.taskState.lastActivityAt }),
      ...(node.taskState.completedAt === undefined ? {} : { completedAt: node.taskState.completedAt }),
    };
    agents[node.agentId] = normalized;
  }
  const edges: AgentEdge[] = publicEdges
    .filter((edge) => agents[edge.parentAgentId] !== undefined && agents[edge.childAgentId] !== undefined)
    .map((edge) => ({
      parentId: edge.parentAgentId,
      childId: edge.childAgentId,
      verified: edge.state === 'verified',
      source: 'public-v1',
    }));
  return {
    schemaVersion: page.schemaVersion,
    sessionId: page.agentSessionId,
    rootAgentId: page.rootAgentId,
    agents,
    edges,
    connection: {
      state: page.connection.state === 'unknown' ? 'unverified' : page.connection.state,
      ...(page.connection.updatedAt === undefined ? {} : { lastEventAt: page.connection.updatedAt }),
    },
    counts: {
      total: page.counts.total,
      active: page.counts.active,
      completed: page.counts.completed,
      failed: page.counts.failed,
      unverified: page.counts.unverified,
      disconnected: page.counts.disconnected,
    },
    watermark: page.watermark,
    generatedAt: page.generatedAt,
    snapshotState: page.snapshotState,
    ...(page.partialReason === undefined ? {} : { partialReason: page.partialReason }),
    storyMilestones: page.storyMilestones.map((milestone) => ({ ...milestone })),
    publicProjection: {
      schemaVersion: 'agent-farm.public.v1',
      snapshotState: page.snapshotState,
      ...(page.partialReason === undefined ? {} : { partialReason: page.partialReason }),
      storyMilestones: page.storyMilestones.map((milestone) => ({ ...milestone })),
    },
  };
}

interface ParsedPublicPayload {
  readonly page: PublicHierarchyPage;
  readonly nodes: PublicAgent[];
  readonly edges: PublicEdge[];
}

/**
 * Parse one strict public-v1 page or the bounded multi-page envelope produced
 * by the web pagination merger. The published page schema caps a transport
 * page at 200 nodes; the merged in-memory projection may contain up to the
 * UI's bounded 1,000 nodes, so each item is validated individually while the
 * envelope is validated against a bounded representative page.
 */
function parsePublicV1Payload(input: unknown): ParsedPublicPayload | undefined {
  if (!isPublicV1Envelope(input)) return undefined;
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || raw.nodes.length > MAX_UI_AGENTS || raw.edges.length > MAX_UI_EDGES) return undefined;
  const nodes: PublicAgent[] = [];
  for (const value of raw.nodes) {
    const parsedNode = PublicAgentSchema.safeParse(value);
    if (!parsedNode.success) return undefined;
    nodes.push(parsedNode.data);
  }
  const edges: PublicEdge[] = [];
  for (const value of raw.edges) {
    const parsedEdge = PublicEdgeSchema.safeParse(value);
    if (!parsedEdge.success) return undefined;
    edges.push(parsedEdge.data);
  }
  // Validate every envelope field, including strict unknown-key rejection. A
  // representative slice satisfies the published transport-size limit while
  // preserving the complete validated node/edge collection above.
  const envelope = PublicHierarchyPageSchema.safeParse({
    ...raw,
    nodes: nodes.slice(0, 200),
    edges: edges.slice(0, 400),
  });
  if (!envelope.success) return undefined;
  return { page: envelope.data, nodes, edges };
}

function isPublicV1Envelope(input: unknown): input is Record<string, unknown> {
  return isRecord(input) && input.schemaVersion === 'agent-farm.public.v1';
}

function isNormalizedPublicSnapshot(input: unknown): input is AgentHierarchySnapshot {
  if (!isRecord(input) || input.schemaVersion !== 'agent-farm.public.v1') return false;
  if (!isRecord(input.agents) || !isRecord(input.publicProjection)) return false;
  const projection = input.publicProjection;
  if (projection.schemaVersion !== 'agent-farm.public.v1' || !Array.isArray(projection.storyMilestones)) return false;
  return Object.values(input.agents).every((value) => isRecord(value) && PublicAgentSchema.safeParse(value.publicNode).success);
}

function invalidPublicV1Snapshot(): AgentHierarchySnapshot {
  return {
    schemaVersion: 'agent-farm.public.v1',
    sessionId: 'public-v1-invalid',
    rootAgentId: null,
    agents: {},
    edges: [],
    connection: {
      state: 'error',
      label: 'Public hierarchy unavailable',
      detail: 'The public hierarchy projection was rejected as malformed.',
    },
    counts: { total: 0, active: 0, completed: 0, failed: 0, unverified: 0, disconnected: 0 },
    snapshotState: 'error',
    partialReason: 'Malformed public-v1 projection',
    publicProjection: {
      schemaVersion: 'agent-farm.public.v1',
      snapshotState: 'error',
      storyMilestones: [],
    },
  };
}

function publicIdentityValue(value: NonNullable<PublicHierarchyPage['nodes'][number]['identity']['requested']>): IdentityValue {
  return {
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.effort === undefined ? {} : { effort: value.effort }),
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.trust === undefined ? {} : { trust: value.trust === 'requested' ? 'requested' : value.trust === 'reconciled' ? 'reconciled' : value.trust === 'observed' ? 'observed' : 'unknown' }),
  };
}

export function getChildren(snapshot: AgentHierarchySnapshot, id: AgentId): AgentNode[] {
  const node = snapshot.agents[id];
  if (!node?.childIds) return [];
  return node.childIds.map((childId) => snapshot.agents[childId]).filter((child): child is AgentNode => Boolean(child));
}

export function getRoots(snapshot: AgentHierarchySnapshot): AgentNode[] {
  if (snapshot.rootAgentId) {
    const root = snapshot.agents[snapshot.rootAgentId];
    if (root) {
      const detached = Object.values(snapshot.agents).filter((node) =>
        node.id !== root.id && (!node.parentId || !snapshot.agents[node.parentId]),
      );
      return [root, ...detached];
    }
  }
  const roots = Object.values(snapshot.agents).filter((node) => !node.parentId || !snapshot.agents[node.parentId]);
  // A malformed cycle can leave every node parented. Keep one visible so the
  // tree can mark the cycle instead of silently flattening the projection.
  if (!roots.length) {
    const first = Object.values(snapshot.agents)[0];
    return first ? [first] : [];
  }
  return roots;
}

export function getDescendantIds(snapshot: AgentHierarchySnapshot, id: AgentId): AgentId[] {
  const seen = new Set<AgentId>();
  const result: AgentId[] = [];
  const visit = (currentId: AgentId): void => {
    if (seen.has(currentId)) return;
    seen.add(currentId);
    for (const child of getChildren(snapshot, currentId)) {
      result.push(child.id);
      visit(child.id);
    }
  };
  visit(id);
  return result;
}
