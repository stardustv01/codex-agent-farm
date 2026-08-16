import { describe, expect, it } from 'vitest';
import {
  countHierarchyNodes,
  isSafeCursor,
  mergeHierarchyPages,
  paginationFailureReason,
  parseAgentFarmToolPage,
  type ParsedHierarchyPage,
} from './pagination';
import { localBudgetFixture } from './fixtures';
import { normalizeOrchestrationBudget } from './normalize';
import type { AgentHierarchyInput, AgentNode } from './types';

const node = (id: string, parentId: string | null, extra: Partial<AgentNode> = {}): AgentNode => ({
  id,
  name: id,
  parentId,
  status: 'running',
  ...extra,
});

const page = (
  nodes: AgentNode[],
  edges: Array<Record<string, unknown>> = [],
  extra: Record<string, unknown> = {},
): AgentHierarchyInput => ({
  agentSessionId: 'pagination-session',
  nodes,
  edges: edges as NonNullable<AgentHierarchyInput['edges']>,
  ...extra,
});

const parsed = (extra: Partial<ParsedHierarchyPage>): ParsedHierarchyPage => ({
  payload: {},
  hasMore: true,
  ...extra,
});

describe('hierarchy pagination helpers', () => {
  it('accepts a valid local API page and rejects malformed envelopes', () => {
    const result = parseAgentFarmToolPage({
      agentSessionId: 'local-session',
      watermark: 12,
      nodes: [node('root', null)],
      edges: [],
      page: 1,
      pageSize: 100,
      total: 1,
      hasMore: true,
      nextCursor: 'p_2',
    });

    expect(result).toMatchObject({
      hasMore: true,
      nextCursor: 'p_2',
      nextPage: 2,
      payload: { agentSessionId: 'local-session', total: 1 },
    });
    expect(parseAgentFarmToolPage({ agentSessionId: 'local-session', nodes: 'not-an-array', edges: [], total: 1, hasMore: false })).toBeUndefined();
    expect(parseAgentFarmToolPage({ agentSessionId: 'local-session', nodes: [], edges: 'not-an-array', total: 0, hasMore: false })).toBeUndefined();
    expect(parseAgentFarmToolPage({ agentSessionId: 'local-session', nodes: [], edges: [], total: '1', hasMore: false })).toBeUndefined();
    expect(parseAgentFarmToolPage({ agentSessionId: 'local-session', nodes: [], edges: [], total: 0, hasMore: 'false' })).toBeUndefined();
    expect(parseAgentFarmToolPage({ agentSessionId: 'local-session', nodes: [], edges: [], total: 0, hasMore: true, nextCursor: '\u0000bad' })).toBeUndefined();
  });

  it('merges pages by node ID, dedupes edges, and marks a node-limit truncation', () => {
    const first = page(
      [node('root', null), node('child', 'root')],
      [{ parentAgentId: 'root', childAgentId: 'child' }],
      { page: 1, pageSize: 2, total: 3, hasMore: true, nextCursor: 'p_2' },
    );
    const second = page(
      [node('child', 'root', { status: 'completed', summary: 'Richer second-page record' }), node('leaf', 'child')],
      [
        { parentAgentId: 'root', childAgentId: 'child' },
        { parentAgentId: 'child', childAgentId: 'leaf' },
      ],
      { page: 2, pageSize: 2, total: 3, hasMore: false },
    );

    const merged = mergeHierarchyPages([first, second]);
    expect(merged.agents).toHaveLength(3);
    expect((merged.agents as AgentNode[]).find((value) => value.id === 'child')).toMatchObject({
      status: 'completed',
      summary: 'Richer second-page record',
    });
    expect(merged.edges).toHaveLength(2);

    const bounded = mergeHierarchyPages([first, second], { maxNodes: 2 });
    expect(bounded.agents).toHaveLength(2);
    expect(bounded.connection).toMatchObject({ state: 'stale', label: 'Hierarchy pagination incomplete' });
  });

  it('counts unique nodes and validates cursor/page/limit failure guards', () => {
    const first = page([node('root', null), node('child', 'root')]);
    const second = page([node('child', 'root'), node('leaf', 'child')]);
    expect(countHierarchyNodes([first, second])).toBe(3);
    expect(isSafeCursor('cursor-1')).toBe(true);
    expect(isSafeCursor('bad\u0000cursor')).toBe(false);

    expect(paginationFailureReason(parsed({ nextCursor: 'cursor-1' }), 'cursor-1', new Set(['cursor-1']))).toBe('Host repeated a hierarchy cursor');
    expect(paginationFailureReason(parsed({ nextPage: 2 }), undefined, new Set(), { currentPage: 2 })).toBe('Host repeated a hierarchy page');
    expect(paginationFailureReason(parsed({ nextCursor: 'cursor-2' }), undefined, new Set(), { pageCount: 2, maxPages: 2 })).toBe('Hierarchy page limit reached (2)');
    expect(paginationFailureReason(parsed({ nextCursor: 'cursor-2' }), undefined, new Set(), { nodeCount: 3, maxNodes: 3 })).toBe('Hierarchy node limit reached (3)');
    expect(paginationFailureReason(parsed({}), undefined, new Set())).toBe('Host indicated more hierarchy data without a usable cursor');
  });

  it('provides a small local-budget tree fixture', () => {
    expect(localBudgetFixture.orchestrationBudget).toEqual({ solHigh: 10, lunaMax: 10, solMax: 3 });
    expect(Object.keys(localBudgetFixture.agents)).toEqual(['local-root', 'local-worker', 'local-result']);
    expect(localBudgetFixture.edges).toHaveLength(2);
  });

  it('fails closed on budgets outside the server concurrency bounds', () => {
    expect(normalizeOrchestrationBudget({ solHigh: 11, lunaMax: 10, solMax: 3 })).toBeUndefined();
    expect(normalizeOrchestrationBudget({ solHigh: 10, lunaMax: 10, solMax: 1 })).toBeUndefined();
    expect(normalizeOrchestrationBudget({ solHigh: 10, lunaMax: 10, solMax: 3 })).toEqual({ solHigh: 10, lunaMax: 10, solMax: 3 });
    expect(normalizeOrchestrationBudget({ solHigh: 10, lunaMax: 10, solMax: 3.5 })).toBeUndefined();
  });
});
