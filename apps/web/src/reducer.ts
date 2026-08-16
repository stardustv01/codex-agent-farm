import { normalizeSnapshot } from './normalize';
import type {
  AgentFarmAction,
  AgentFarmState,
  AgentHierarchyInput,
  AgentHierarchySnapshot,
  AgentNode,
  AgentStatus,
  ConnectionInfo,
  Density,
  PresentationMode,
} from './types';

const validId = (snapshot: AgentHierarchySnapshot, id: string | null): string | null =>
  id && snapshot.agents[id] ? id : null;

function definedFields(value: Partial<AgentNode> | undefined): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, candidate]) => candidate !== undefined));
}

function normalizeEventNode(
  existing: AgentNode | undefined,
  agent: Partial<AgentNode> & Pick<AgentNode, 'id'>,
  patch: Partial<AgentNode> | undefined,
): AgentNode | undefined {
  const incoming = { ...definedFields(agent), ...definedFields(patch) };
  // Event routing is keyed by the immutable agent ID; a partial patch must
  // never move data into a different map entry.
  delete incoming.id;
  const eventIdentity = incoming.identity as AgentNode['identity'] | undefined;
  if (eventIdentity && existing?.identity) {
    incoming.identity = {
      ...existing.identity,
      ...eventIdentity,
      ...(eventIdentity.requested === undefined && existing.identity.requested === undefined ? {} : {
        requested: { ...existing.identity.requested, ...eventIdentity.requested },
      }),
      ...(eventIdentity.observed === undefined && existing.identity.observed === undefined ? {} : {
        observed: { ...existing.identity.observed, ...eventIdentity.observed },
      }),
    };
  }
  const identity = (incoming.identity as AgentNode['identity'] | undefined) ?? existing?.identity;
  const requestedPatch = {
    ...(incoming.requestedModel === undefined ? {} : { model: incoming.requestedModel as string }),
    ...(incoming.requestedProvider === undefined ? {} : { provider: incoming.requestedProvider as string }),
    ...(incoming.requestedEffort === undefined ? {} : { effort: incoming.requestedEffort as string }),
  };
  const observedPatch = {
    ...(incoming.observedModel === undefined ? {} : { model: incoming.observedModel as string }),
    ...(incoming.observedProvider === undefined ? {} : { provider: incoming.observedProvider as string }),
    ...(incoming.observedEffort === undefined ? {} : { effort: incoming.observedEffort as string }),
  };
  if (identity && (Object.keys(requestedPatch).length > 0 || Object.keys(observedPatch).length > 0)) {
    incoming.identity = {
      ...identity,
      ...(Object.keys(requestedPatch).length === 0 ? {} : { requested: { ...identity.requested, ...requestedPatch } }),
      ...(Object.keys(observedPatch).length === 0 ? {} : { observed: { ...identity.observed, ...observedPatch } }),
    };
  }
  const mergedIdentity = incoming.identity as AgentNode['identity'] | undefined;
  if (mergedIdentity?.requested?.model !== undefined) incoming.requestedModel = mergedIdentity.requested.model;
  if (mergedIdentity?.requested?.provider !== undefined) incoming.requestedProvider = mergedIdentity.requested.provider;
  if (mergedIdentity?.requested?.effort !== undefined) incoming.requestedEffort = mergedIdentity.requested.effort;
  if (mergedIdentity?.observed?.model !== undefined) incoming.observedModel = mergedIdentity.observed.model;
  if (mergedIdentity?.observed?.provider !== undefined) incoming.observedProvider = mergedIdentity.observed.provider;
  if (mergedIdentity?.observed?.effort !== undefined) incoming.observedEffort = mergedIdentity.observed.effort;
  const candidate: Record<string, unknown> = {
    ...(existing ?? { id: agent.id, parentId: null, name: agent.id, status: 'unknown' }),
    ...incoming,
  };
  const parentId = typeof candidate.parentId === 'string' ? candidate.parentId : null;
  const parentPlaceholder = parentId === null ? [] : [{ id: parentId, name: parentId, parentId: null, status: 'unknown' }];
  const normalized = normalizeSnapshot({
    agents: [candidate, ...parentPlaceholder] as unknown as AgentNode[],
    rootAgentId: parentId ?? agent.id,
  }).agents[agent.id];
  return normalized;
}

export function createInitialState(
  input: AgentHierarchyInput | AgentHierarchySnapshot,
  mode: PresentationMode = 'standalone',
): AgentFarmState {
  const snapshot = normalizeSnapshot(input);
  const expandedIds = new Set<string>();
  if (snapshot.rootAgentId) expandedIds.add(snapshot.rootAgentId);
  return {
    snapshot,
    mode,
    density: 'comfortable',
    selectedId: snapshot.rootAgentId,
    expandedIds,
    search: '',
    statusFilter: 'all',
    focusId: null,
    loading: false,
    error: null,
    localDetails: {},
  };
}

function replaceSnapshot(state: AgentFarmState, input: AgentHierarchyInput | AgentHierarchySnapshot): AgentFarmState {
  const snapshot = normalizeSnapshot(input);
  const raw = input as AgentHierarchyInput & { readonly session?: Record<string, unknown> };
  const session = raw.session;
  const budgetProvided = raw.orchestrationBudget !== undefined
    || (session !== null && typeof session === 'object' && !Array.isArray(session) && session.orchestrationBudget !== undefined);
  if (!budgetProvided && snapshot.orchestrationBudget === undefined && state.snapshot.orchestrationBudget !== undefined) {
    snapshot.orchestrationBudget = state.snapshot.orchestrationBudget;
  }
  const oldExpanded = [...state.expandedIds].filter((id) => snapshot.agents[id]);
  const expandedIds = new Set(oldExpanded);
  if (!expandedIds.size && snapshot.rootAgentId) expandedIds.add(snapshot.rootAgentId);
  return {
    ...state,
    snapshot,
    selectedId: validId(snapshot, state.selectedId) ?? snapshot.rootAgentId,
    focusId: validId(snapshot, state.focusId),
    expandedIds,
    localDetails: {},
    error: null,
  };
}

export function agentFarmReducer(state: AgentFarmState, action: AgentFarmAction): AgentFarmState {
  switch (action.type) {
    case 'snapshot.received':
      return replaceSnapshot(state, action.snapshot);
    case 'event.received': {
      const event = action.event;
      if (event.type === 'snapshot' && event.snapshot) return replaceSnapshot(state, event.snapshot);
      if (event.type === 'connection.changed') {
        const connectionInput = typeof event.connection === 'string'
          ? event.connection
          : { ...state.snapshot.connection, ...(event.connection ?? {}) };
        const connection: ConnectionInfo = normalizeSnapshot({ connection: connectionInput }).connection;
        return { ...state, snapshot: { ...state.snapshot, connection } };
      }
      if (event.type === 'watermark.changed') {
        const snapshot: AgentHierarchySnapshot = { ...state.snapshot };
        if (event.watermark !== undefined) snapshot.watermark = event.watermark;
        if (event.version !== undefined) snapshot.version = event.version;
        return { ...state, snapshot };
      }
      if ((event.type === 'agent.updated' || event.type === 'agent.added') && event.agent) {
        const existing = state.snapshot.agents[event.agent.id];
        const node = normalizeEventNode(existing, event.agent, event.patch);
        if (!node) return state;
        const agents = { ...state.snapshot.agents, [node.id]: node };
        const parentId = node.parentId;
        const edges = state.snapshot.edges.filter((edge) => edge.childId !== node.id);
        for (const parent of Object.values(agents)) {
          if (parent.id !== node.id && parent.childIds?.includes(node.id)) {
            agents[parent.id] = { ...parent, childIds: parent.childIds.filter((id) => id !== node.id) };
          }
        }
        if (parentId && agents[parentId] && !edges.some((edge) => edge.parentId === parentId && edge.childId === node.id)) {
          edges.push({ parentId, childId: node.id, verified: true, source: 'event' });
          const parent = agents[parentId];
          if (parent) agents[parentId] = { ...parent, childIds: [...new Set([...(parent.childIds ?? []), node.id])] };
        }
        const rootAgentId = state.snapshot.rootAgentId === node.id && parentId
          ? null
          : state.snapshot.rootAgentId ?? (parentId ? null : node.id);
        const snapshot: AgentHierarchySnapshot = { ...state.snapshot, agents, edges, rootAgentId };
        return { ...state, snapshot, selectedId: state.selectedId ?? node.id };
      }
      if (event.type === 'agent.removed' && event.agentId) {
        if (!state.snapshot.agents[event.agentId]) return state;
        const agents = { ...state.snapshot.agents };
        delete agents[event.agentId];
        const edges = state.snapshot.edges.filter((edge) => edge.parentId !== event.agentId && edge.childId !== event.agentId);
        for (const node of Object.values(agents)) {
          if (node.childIds?.includes(event.agentId)) agents[node.id] = { ...node, childIds: node.childIds.filter((id) => id !== event.agentId) };
        }
        const snapshot = { ...state.snapshot, agents, edges, rootAgentId: state.snapshot.rootAgentId === event.agentId ? null : state.snapshot.rootAgentId };
        const expandedIds = new Set(state.expandedIds);
        expandedIds.delete(event.agentId);
        return { ...state, snapshot, expandedIds, selectedId: validId(snapshot, state.selectedId), focusId: validId(snapshot, state.focusId) };
      }
      return state;
    }
    case 'mode.changed':
      return { ...state, mode: action.mode };
    case 'density.changed':
      return { ...state, density: action.density };
    case 'selection.changed':
      return { ...state, selectedId: validId(state.snapshot, action.id) };
    case 'local-detail.received':
      return state.snapshot.agents[action.id]
        ? { ...state, localDetails: { ...state.localDetails, [action.id]: action.detail } }
        : state;
    case 'focus.changed':
      return { ...state, focusId: validId(state.snapshot, action.id) };
    case 'expanded.changed': {
      const expandedIds = new Set(state.expandedIds);
      const expanded = action.expanded ?? !expandedIds.has(action.id);
      if (expanded) expandedIds.add(action.id);
      else expandedIds.delete(action.id);
      return { ...state, expandedIds };
    }
    case 'expanded.set':
      return { ...state, expandedIds: new Set(action.ids.filter((id) => Boolean(state.snapshot.agents[id]))) };
    case 'search.changed':
      return { ...state, search: action.search };
    case 'status-filter.changed':
      return { ...state, statusFilter: action.status };
    case 'loading.changed':
      return { ...state, loading: action.loading };
    case 'error.changed':
      return {
        ...state,
        error: action.error,
        loading: false,
        snapshot: action.error
          ? { ...state.snapshot, connection: { ...state.snapshot.connection, state: 'error', label: 'Connection error', detail: action.error } }
          : state.snapshot,
      };
    default:
      return state;
  }
}

export const setDensity = (density: Density): AgentFarmAction => ({ type: 'density.changed', density });
export const setStatusFilter = (status: AgentStatus | 'all'): AgentFarmAction => ({ type: 'status-filter.changed', status });
