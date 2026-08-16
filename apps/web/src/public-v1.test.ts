import { describe, expect, it } from 'vitest';

import { StandaloneAdapter } from './adapters';
import { mergeHierarchyPages } from './pagination';
import { normalizeSnapshot } from './normalize';

const identity = { requested: null, observed: null, verification: 'unverified' as const };
const rootId = `agent:${'a'.repeat(40)}`;
const plannerId = `agent:${'b'.repeat(40)}`;
const workerId = `agent:${'c'.repeat(40)}`;
const reviewerId = `agent:${'d'.repeat(40)}`;

function node(agentId: string, parentAgentId: string | null, lifecycle: 'active' | 'completed' = 'active', displayName = agentId) {
  return {
    schemaVersion: 'agent-farm.public.v1' as const,
    agentId,
    parentAgentId,
    childIds: [] as string[],
    displayName,
    role: parentAgentId === null ? 'root' as const : 'worker' as const,
    lifecycle,
    taskState: { lifecycle, activityLabel: lifecycle === 'active' ? 'working' as const : 'returned' as const },
    identity,
    directChildCount: 0,
    descendantCount: 0,
    cluster: { state: lifecycle === 'active' ? 'active' as const : 'completed' as const },
  };
}

function page(nodes: ReturnType<typeof node>[], edges: Array<{ edgeId: string; parentAgentId: string; childAgentId: string; state: 'verified' }>, pageNumber = 1, hasMore = false): any {
  return {
    schemaVersion: 'agent-farm.public.v1' as const,
    agentSessionId: 'session-public-v1',
    watermark: pageNumber,
    generatedAt: '2026-08-12T00:00:00.000Z',
    snapshotState: hasMore ? 'partial' as const : 'complete' as const,
    connection: { state: 'connected' as const },
    rootAgentId: rootId,
    nodes,
    edges: edges.map((edge) => ({ schemaVersion: 'agent-farm.public.v1' as const, ...edge })),
    total: 5,
    page: pageNumber,
    pageSize: 200,
    hasMore,
    nextCursor: hasMore ? `p_${pageNumber + 1}` : null,
    counts: { total: 5, active: 4, completed: 1, failed: 0, disconnected: 0, unverified: 5 },
    storyMilestones: [{
      schemaVersion: 'agent-farm.public.v1' as const,
      milestoneId: `milestone:${pageNumber.toString(16).padStart(64, '0')}`,
      sequence: pageNumber,
      kind: 'spawned' as const,
      agentId: rootId,
      occurredAt: '2026-08-12T00:00:00.000Z',
    }],
  };
}

describe('public-v1 web normalization', () => {
  it('keeps launcher budget outside strict public-v1 page parsing', async () => {
    const root = node(rootId, null, 'active', 'Root');
    const input = page([root], [], 1, false);
    const adapter = new StandaloneAdapter({
      snapshot: input,
      fetchSnapshot: async () => input,
      orchestrationBudget: { solHigh: 10, lunaMax: 10, solMax: 3 },
    });
    const snapshot = await adapter.getSnapshot();
    expect(Object.keys(snapshot.agents)).toHaveLength(1);
    expect(snapshot.snapshotState).toBe('complete');
    expect(snapshot.orchestrationBudget).toEqual({ solHigh: 10, lunaMax: 10, solMax: 3 });
  });

  it('rejects an invalid launcher budget at the post-normalization overlay boundary', async () => {
    const root = node(rootId, null, 'active', 'Root');
    const input = page([root], [], 1, false);
    const adapter = new StandaloneAdapter({
      snapshot: input,
      fetchSnapshot: async () => input,
      orchestrationBudget: { solHigh: 11, lunaMax: 10, solMax: 3 } as never,
    });
    const snapshot = await adapter.getSnapshot();
    expect(snapshot.snapshotState).toBe('complete');
    expect(snapshot.orchestrationBudget).toBeUndefined();
  });

  it('keeps authoritative public IDs, edges, counts, story and partial state without private fields', () => {
    const root = node(rootId, null, 'active', 'Root');
    const planner = node(plannerId, root.agentId, 'active', 'Planner');
    const worker = node(workerId, planner.agentId, 'completed', 'Worker');
    const reviewer = node(reviewerId, root.agentId, 'active', 'Reviewer');
    root.childIds = [planner.agentId, reviewer.agentId];
    root.directChildCount = 2;
    root.descendantCount = 3;
    planner.childIds = [worker.agentId];
    planner.directChildCount = 1;
    planner.descendantCount = 1;
    const input = page(
      [root, planner, worker, reviewer],
      [
        { edgeId: `edge:${'1'.repeat(40)}`, parentAgentId: root.agentId, childAgentId: planner.agentId, state: 'verified' },
        { edgeId: `edge:${'2'.repeat(40)}`, parentAgentId: planner.agentId, childAgentId: worker.agentId, state: 'verified' },
        { edgeId: `edge:${'3'.repeat(40)}`, parentAgentId: root.agentId, childAgentId: reviewer.agentId, state: 'verified' },
      ],
      1,
      true,
    );
    const snapshot = normalizeSnapshot(input);
    expect(snapshot.schemaVersion).toBe('agent-farm.public.v1');
    expect(Object.keys(snapshot.agents)).toEqual([root.agentId, planner.agentId, worker.agentId, reviewer.agentId]);
    expect(snapshot.edges.map((edge) => `${edge.parentId}>${edge.childId}`)).toEqual([
      `${root.agentId}>${planner.agentId}`,
      `${planner.agentId}>${worker.agentId}`,
      `${root.agentId}>${reviewer.agentId}`,
    ]);
    expect(snapshot.connection.state).toBe('connected');
    expect(snapshot.counts).toMatchObject({ total: 5, active: 4, completed: 1, disconnected: 0 });
    expect(snapshot.snapshotState).toBe('partial');
    expect(snapshot.storyMilestones?.[0]?.kind).toBe('spawned');
    expect(snapshot.publicProjection?.schemaVersion).toBe('agent-farm.public.v1');
    expect(snapshot.agents[root.agentId]?.publicNode?.taskState.activityLabel).toBe('working');
    expect(snapshot.agents[worker.agentId]?.publicNode?.descendantCount).toBe(0);
    expect(JSON.stringify(snapshot)).not.toMatch(/sourceThreadId|sourceSessionId|agentPath|resultSummary|errorSummary|prompt|reasoning|credential|ownerId|tenantId/iu);
  });

  it('merges public-v1 pages without remapping IDs and marks bounded pagination stale', () => {
    const root = node(rootId, null);
    const child = node(plannerId, root.agentId, 'completed');
    const first = page([root], [], 1, true);
    const second = page([child], [{ edgeId: `edge:${'4'.repeat(40)}`, parentAgentId: root.agentId, childAgentId: child.agentId, state: 'verified' }], 2, false);
    const merged = mergeHierarchyPages([first, second], { maxNodes: 10 });
    const snapshot = normalizeSnapshot(merged);
    expect(Object.keys(snapshot.agents)).toEqual([root.agentId, child.agentId]);
    expect(snapshot.edges).toEqual([{ parentId: root.agentId, childId: child.agentId, verified: true, source: 'public-v1' }]);
    expect(snapshot.connection.state).toBe('connected');
    expect(snapshot.snapshotState).toBe('complete');
    expect(snapshot.agents[child.agentId]?.publicNode?.lifecycle).toBe('completed');
  });

  it('fails closed when a payload declares public-v1 but is malformed', () => {
    const snapshot = normalizeSnapshot({
      schemaVersion: 'agent-farm.public.v1',
      agentSessionId: 'private-session-must-not-echo',
      nodes: [{ agentId: rootId, displayName: 'Root' }],
    });
    expect(snapshot.connection.state).toBe('error');
    expect(snapshot.snapshotState).toBe('error');
    expect(snapshot.agents).toEqual({});
    expect(JSON.stringify(snapshot)).not.toContain('private-session-must-not-echo');
  });
});
