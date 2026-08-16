import { describe, expect, it } from 'vitest';
import { StandaloneAdapter } from './adapters';
import { canonicalHierarchyFixture, makeScaleFixture } from './fixtures';
import { createInitialState, agentFarmReducer, setDensity, setStatusFilter } from './reducer';
import { getVisibleTree, nodeMatches } from './tree';
import { normalizeSnapshot } from './normalize';
import type { AgentHierarchyInput, AgentNode } from './types';

function hierarchyPage(ids: readonly string[], pagination: Record<string, unknown> = {}): AgentHierarchyInput {
  const nodes: AgentNode[] = ids.map((id, index) => ({
    id,
    name: id === 'root' ? 'Root' : id,
    parentId: index === 0 && id === 'root' ? null : index === 0 ? null : ids[index - 1] ?? null,
    status: id === 'root' ? 'running' : 'completed',
  }));
  return {
    sessionId: 'paged-session',
    rootAgentId: 'root',
    nodes,
    connection: { state: 'connected' },
    ...pagination,
  } as unknown as AgentHierarchyInput;
}

describe('agent farm reducer and adapters', () => {
  it('keeps requested and observed identity evidence separate', () => {
    const state = createInitialState(canonicalHierarchyFixture);
    const next = agentFarmReducer(state, { type: 'event.received', event: { type: 'agent.updated', agent: { id: 'noether' }, patch: { observedEffort: 'max' } } });
    expect(next.snapshot.agents.noether?.requestedEffort).toBe('high');
    expect(next.snapshot.agents.noether?.observedEffort).toBe('max');
    expect(next.snapshot.agents.noether?.identity?.requested?.effort).toBe('high');
  });

  it('normalizes live nodes and repairs lineage when a branch is reparented', () => {
    const state = createInitialState(canonicalHierarchyFixture);
    const next = agentFarmReducer(state, {
      type: 'event.received',
      event: { type: 'agent.updated', agent: { id: 'noether', parentId: 'dirac', status: 'running' } },
    });
    expect(next.snapshot.agents.noether?.parentId).toBe('dirac');
    expect(next.snapshot.agents.rhea?.childIds).not.toContain('noether');
    expect(next.snapshot.agents.dirac?.childIds).toContain('noether');
    expect(next.snapshot.edges.some((edge) => edge.parentId === 'dirac' && edge.childId === 'noether')).toBe(true);
    expect(next.snapshot.edges.some((edge) => edge.parentId === 'rhea' && edge.childId === 'noether')).toBe(false);
  });

  it('keeps an event with a missing parent visible as a detached root', () => {
    const state = createInitialState(canonicalHierarchyFixture);
    const next = agentFarmReducer(state, {
      type: 'event.received',
      event: { type: 'agent.added', agent: { id: 'detached', parentId: 'missing-parent', name: 'Detached', status: 'waiting' } },
    });
    expect(getVisibleTree(next.snapshot, next.expandedIds).map((row) => row.node.id)).toContain('detached');
    expect(next.snapshot.agents.detached?.parentId).toBe('missing-parent');
  });

  it('reduces connection truth and removes agents without leaving stale selection', () => {
    const state = createInitialState(canonicalHierarchyFixture);
    const selected = agentFarmReducer(state, { type: 'selection.changed', id: 'kuhn' });
    const disconnected = agentFarmReducer(selected, { type: 'event.received', event: { type: 'connection.changed', connection: 'disconnected' } });
    expect(disconnected.snapshot.connection.state).toBe('disconnected');
    const removed = agentFarmReducer(disconnected, { type: 'event.received', event: { type: 'agent.removed', agentId: 'kuhn' } });
    expect(removed.snapshot.agents.kuhn).toBeUndefined();
    expect(removed.selectedId).not.toBe('kuhn');
    const errored = agentFarmReducer(state, { type: 'error.changed', error: 'host unavailable' });
    expect(errored.snapshot.connection.state).toBe('error');
  });

  it('updates status filter and density without changing the snapshot', () => {
    const state = createInitialState(canonicalHierarchyFixture);
    const filtered = agentFarmReducer(state, setStatusFilter('completed'));
    expect(filtered.statusFilter).toBe('completed');
    expect(filtered.snapshot).toBe(state.snapshot);
    const compact = agentFarmReducer(filtered, setDensity('compact'));
    expect(compact.density).toBe('compact');
    expect(compact.statusFilter).toBe('completed');
    expect(compact.snapshot).toBe(state.snapshot);
  });

  it('preserves view state but invalidates local detail after a newer snapshot', () => {
    let state = createInitialState(canonicalHierarchyFixture);
    state = agentFarmReducer(state, { type: 'selection.changed', id: 'noether' });
    state = agentFarmReducer(state, { type: 'focus.changed', id: 'rhea' });
    state = agentFarmReducer(state, { type: 'expanded.changed', id: 'rhea', expanded: true });
    state = agentFarmReducer(state, { type: 'search.changed', search: 'luna' });
    state = agentFarmReducer(state, { type: 'status-filter.changed', status: 'running' });
    state = { ...state, localDetails: { noether: null } };
    const refreshed = agentFarmReducer(state, { type: 'snapshot.received', snapshot: { ...canonicalHierarchyFixture, watermark: 2 } });
    expect(refreshed).toMatchObject({ selectedId: 'noether', focusId: 'rhea', search: 'luna', statusFilter: 'running', localDetails: {} });
    expect(refreshed.expandedIds.has('rhea')).toBe(true);
  });

  it('preserves orchestration budget through normalization and live events', () => {
    const input = {
      ...canonicalHierarchyFixture,
      orchestrationBudget: { solHigh: 10, lunaMax: 10, solMax: 3 },
    };
    const state = createInitialState(input);
    expect(state.snapshot.orchestrationBudget).toEqual(input.orchestrationBudget);

    const updated = agentFarmReducer(state, {
      type: 'event.received',
      event: { type: 'agent.updated', agent: { id: 'dirac' }, patch: { summary: 'still coordinating' } },
    });
    expect(updated.snapshot.orchestrationBudget).toEqual(input.orchestrationBudget);

    const replaced = agentFarmReducer(updated, { type: 'snapshot.received', snapshot: input });
    expect(replaced.snapshot.orchestrationBudget).toEqual(input.orchestrationBudget);

    const withoutBudget = { ...canonicalHierarchyFixture };
    const retained = agentFarmReducer(updated, { type: 'snapshot.received', snapshot: withoutBudget });
    expect(retained.snapshot.orchestrationBudget).toEqual(input.orchestrationBudget);

    const invalid = agentFarmReducer(updated, {
      type: 'snapshot.received',
      snapshot: { ...canonicalHierarchyFixture, orchestrationBudget: { solHigh: 11, lunaMax: 10, solMax: 3 } },
    });
    expect(invalid.snapshot.orchestrationBudget).toBeUndefined();
  });

  it('derives omitted count fields from normalized agent statuses', () => {
    const snapshot = normalizeSnapshot({
      agents: [
        { id: 'running', name: 'Running', status: 'running' },
        { id: 'done', name: 'Done', status: 'completed' },
        { id: 'lost', name: 'Lost', status: 'disconnected' },
      ],
      counts: { total: 3 },
      connection: 'connected',
    });
    expect(snapshot.counts).toEqual({ total: 3, active: 1, completed: 1, failed: 0, unverified: 1 });
  });

  it('delivers snapshot/event subscriptions and cleans them up', async () => {
    const adapter = new StandaloneAdapter({ snapshot: canonicalHierarchyFixture });
    const seen: string[] = [];
    const unsubscribe = adapter.subscribe((event) => seen.push(event.type));
    adapter.emit({ type: 'connection.changed', connection: 'stale' });
    expect(seen).toEqual(['connection.changed']);
    unsubscribe();
    adapter.emit({ type: 'watermark.changed', watermark: 9 });
    expect(seen).toEqual(['connection.changed']);
    expect((await adapter.getSnapshot()).sessionId).toBe(canonicalHierarchyFixture.sessionId);
    adapter.dispose();
  });

  it('ships the requested 25-active plus 200-completed regression fixture', () => {
    const snapshot = makeScaleFixture();
    const counts = Object.values(snapshot.agents).reduce<Record<string, number>>((acc, node) => { acc[node.status] = (acc[node.status] ?? 0) + 1; return acc; }, {});
    expect(Object.keys(snapshot.agents)).toHaveLength(225);
    expect(counts.running! + counts.queued! + counts.waiting! + counts.disconnected! + counts.unverified!).toBe(25);
    expect(counts.completed).toBe(200);
  });

  it('keeps malformed cycles visible and marked instead of dropping the branch', () => {
    const snapshot = normalizeSnapshot({
      sessionId: 'cycle',
      agents: [
        { id: 'a', name: 'A', parentId: 'b', childIds: ['b'], status: 'running' },
        { id: 'b', name: 'B', parentId: 'a', childIds: ['a'], status: 'running' },
      ],
      connection: 'connected',
    });
    const rows = getVisibleTree(snapshot, new Set(['a', 'b']));
    expect(rows.some((row) => row.cycle)).toBe(true);
    expect(rows.map((row) => row.node.id)).toEqual(['a', 'b', 'a']);
  });

  it('matches names, roles, tasks, models, and status while treating empty search as a match-all', () => {
    const noether = canonicalHierarchyFixture.agents.noether!;
    expect(nodeMatches(noether, 'noether', 'all')).toBe(true);
    expect(nodeMatches(noether, 'evidence reviewer', 'all')).toBe(true);
    expect(nodeMatches(noether, 'compare requested and observed', 'all')).toBe(true);
    expect(nodeMatches(noether, 'gpt-5.6-luna', 'all')).toBe(true);
    expect(nodeMatches(noether, 'mismatch', 'all')).toBe(true);
    expect(nodeMatches(noether, 'gpt-5.6-luna', 'completed')).toBe(false);
    expect(nodeMatches(noether, '', 'unverified')).toBe(true);
    expect(nodeMatches(noether, 'not present', 'all')).toBe(false);
  });

  it('respects expansion, focus branches, combined filters, and collapsed descendants', () => {
    const snapshot = canonicalHierarchyFixture;
    const collapsed = getVisibleTree(snapshot, new Set());
    expect(collapsed.map((row) => row.node.id)).toEqual(['dirac']);

    const rootExpanded = getVisibleTree(snapshot, new Set(['dirac']));
    expect(rootExpanded.map((row) => row.node.id)).toEqual(['dirac', 'rhea', 'kuhn']);
    expect(rootExpanded.some((row) => row.node.id === 'noether')).toBe(false);

    const branchExpanded = getVisibleTree(snapshot, new Set(['dirac', 'rhea']));
    expect(branchExpanded.map((row) => row.node.id)).toEqual(['dirac', 'rhea', 'noether', 'kuhn']);

    const focused = getVisibleTree(snapshot, new Set(['rhea']), '', 'all', 'rhea');
    expect(focused.map((row) => row.node.id)).toEqual(['rhea', 'noether']);

    const filtered = getVisibleTree(snapshot, new Set(), 'gpt-5.6-luna', 'unverified');
    expect(filtered.map((row) => row.node.id)).toEqual(['dirac', 'rhea', 'noether']);
    expect(filtered.filter((row) => row.matchesFilter).map((row) => row.node.id)).toEqual(['noether']);
  });

  it('fetches cursor and page pagination, and stops at node and page bounds', async () => {
    const cursorCalls: Array<string | undefined> = [];
    const cursorPages: number[] = [];
    const cursorAdapter = new StandaloneAdapter({
      pageSize: 2,
      fetchSnapshot: async (_signal, page) => {
        cursorCalls.push(page?.cursor);
        cursorPages.push(page?.page ?? 0);
        if (page?.cursor === 'cursor-2') return hierarchyPage(['child-2']);
        return hierarchyPage(['root', 'child-1'], { nextCursor: 'cursor-2', hasMore: true });
      },
    });
    const cursorSnapshot = await cursorAdapter.getSnapshot();
    expect(Object.keys(cursorSnapshot.agents)).toEqual(['root', 'child-1', 'child-2']);
    expect(cursorCalls).toEqual([undefined, 'cursor-2']);
    expect(cursorPages).toEqual([1, 2]);

    const pageCalls: number[] = [];
    const pageAdapter = new StandaloneAdapter({
      fetchSnapshot: async (_signal, page) => {
        const current = page?.page ?? 1;
        pageCalls.push(current);
        return hierarchyPage(current === 1 ? ['root', 'child-1'] : [`child-${current}`], { page: current, hasMore: current < 3 });
      },
    });
    const pageSnapshot = await pageAdapter.getSnapshot();
    expect(Object.keys(pageSnapshot.agents)).toHaveLength(4);
    expect(pageCalls).toEqual([1, 2, 3]);

    const nodeCalls: Array<string | undefined> = [];
    const nodeBoundAdapter = new StandaloneAdapter({
      maxNodes: 2,
      fetchSnapshot: async (_signal, page) => {
        nodeCalls.push(page?.cursor);
        return hierarchyPage(['root', 'child-1'], { nextCursor: 'never', hasMore: true });
      },
    });
    const nodeBoundSnapshot = await nodeBoundAdapter.getSnapshot();
    expect(nodeCalls).toHaveLength(1);
    expect(nodeBoundSnapshot.connection.state).toBe('stale');
    expect(nodeBoundSnapshot.connection.detail).toContain('node limit');

    const pageBoundCalls: Array<string | undefined> = [];
    const pageBoundAdapter = new StandaloneAdapter({
      maxPages: 2,
      fetchSnapshot: async (_signal, page) => {
        pageBoundCalls.push(page?.cursor);
        return hierarchyPage([page?.cursor ? 'child-2' : 'root'], { nextCursor: page?.cursor ? 'never' : 'cursor-2', hasMore: true });
      },
    });
    const pageBoundSnapshot = await pageBoundAdapter.getSnapshot();
    expect(pageBoundCalls).toEqual([undefined, 'cursor-2']);
    expect(pageBoundSnapshot.connection.state).toBe('stale');
    expect(pageBoundSnapshot.connection.detail).toContain('page limit');
  });

  it('fails closed on malformed and repeated pagination cursors', async () => {
    let malformedCalls = 0;
    const malformedAdapter = new StandaloneAdapter({
      fetchSnapshot: async () => {
        malformedCalls += 1;
        return hierarchyPage(['root'], { nextCursor: 'bad\u0000cursor', hasMore: true });
      },
    });
    const malformed = await malformedAdapter.getSnapshot();
    expect(malformedCalls).toBe(1);
    expect(malformed.connection.state).toBe('stale');
    expect(malformed.connection.detail).toContain('usable cursor');

    let repeatedCalls = 0;
    const repeatedAdapter = new StandaloneAdapter({
      fetchSnapshot: async () => {
        repeatedCalls += 1;
        return hierarchyPage(['root'], { nextCursor: 'repeat', hasMore: true });
      },
    });
    const repeated = await repeatedAdapter.getSnapshot();
    expect(repeatedCalls).toBe(2);
    expect(repeated.connection.state).toBe('stale');
    expect(repeated.connection.detail).toContain('repeated a hierarchy cursor');
  });

  it('normalizes the backend contract snapshot shape without flattening lineage', () => {
    const snapshot = normalizeSnapshot({
      schemaVersion: 1,
      agentSessionId: 'contract-session',
      rootAgentId: 'agent:root',
      agents: [
        { agentId: 'agent:root', agentSessionId: 'contract-session', sourceThreadId: 'thread:root', nickname: 'Root', role: 'root', lifecycle: 'active', verification: 'verified', identityEvidenceIds: [], turnGenerations: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
        { agentId: 'agent:child', agentSessionId: 'contract-session', sourceThreadId: 'thread:child', parentAgentId: 'agent:root', nickname: 'Child', role: 'worker', lifecycle: 'completed', verification: 'verified', identityEvidenceIds: [], turnGenerations: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      ],
      edges: [{ parentAgentId: 'agent:root', childAgentId: 'agent:child', state: 'verified' }],
      connection: { status: 'connected' },
    });
    expect(snapshot.sessionId).toBe('contract-session');
    expect(snapshot.agents['agent:child']?.parentId).toBe('agent:root');
    expect(snapshot.agents['agent:child']?.status).toBe('completed');
    expect(snapshot.connection.state).toBe('connected');
  });

  it('normalizes production MCP identity and connection/count fields without losing evidence', () => {
    const snapshot = normalizeSnapshot({
      agentSessionId: 'mcp-production-session',
      connectionState: 'connected',
      counts: { total: 225, active: 25, completed: 200, failed: 0, unverified: 0 },
      rootAgentId: 'agent:root',
      agents: [{
        agentId: 'agent:root',
        parentAgentId: null,
        name: 'Root',
        lifecycle: 'active',
        identity: {
          requestedModel: 'gpt-5.6-luna',
          observedModel: 'gpt-5.6-sol',
          requestedReasoningEffort: 'high',
          observedReasoningEffort: 'max',
          verificationStatus: 'mismatch',
        },
      }],
    });
    const node = snapshot.agents['agent:root'];
    expect(snapshot.connection.state).toBe('connected');
    expect(snapshot.counts).toMatchObject({ total: 225, active: 25, completed: 200 });
    expect(node?.identity).toMatchObject({
      requested: { model: 'gpt-5.6-luna', effort: 'high' },
      observed: { model: 'gpt-5.6-sol', effort: 'max' },
      verification: 'mismatch',
    });
    expect(node?.requestedModel).toBe('gpt-5.6-luna');
    expect(node?.observedModel).toBe('gpt-5.6-sol');
  });

  it('treats generic MCP model fields as observed identity evidence', () => {
    const snapshot = normalizeSnapshot({
      agents: [{ id: 'generic', name: 'Generic', status: 'running', model: 'gpt-5.6-sol', provider: 'openai', effort: 'max' }],
    });
    expect(snapshot.agents.generic?.observedModel).toBe('gpt-5.6-sol');
    expect(snapshot.agents.generic?.observedProvider).toBe('openai');
    expect(snapshot.agents.generic?.observedEffort).toBe('max');
  });

  it('bounds hostile recursive input and never displays raw prompt fields', () => {
    const cyclic: Record<string, unknown> = { id: 'root', name: 'Root', prompt: 'private prompt', status: 'running' };
    cyclic.children = [cyclic];
    const oversized = Array.from({ length: 1_100 }, (_, index) => ({ id: `agent-${index}`, name: `Agent ${index}`, status: 'completed' }));
    const cycleSnapshot = normalizeSnapshot({ root: cyclic });
    expect(Object.keys(cycleSnapshot.agents)).toEqual(['root']);
    expect(cycleSnapshot.agents.root?.task).toBeUndefined();
    const bounded = normalizeSnapshot({ agents: oversized });
    expect(Object.keys(bounded.agents)).toHaveLength(1_000);
  });
});
