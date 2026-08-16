import {
  PublicHierarchyPageSchema,
  type PublicActivityLabel,
  type PublicAgent,
  type PublicHierarchyPage,
  type PublicLifecycle,
} from '@agent-farm/contracts';

export const G6_SESSION_ID = 'g6-visual-fixture-session';
export const G6_GENERATED_AT = '2026-08-12T09:00:00.000Z';

export type G6Scenario = 'connected' | 'partial' | 'disconnected' | 'failed' | 'unverified';
export type G6Family = 'sol' | 'luna';
type G6Role = 'root' | 'planner' | 'worker' | 'reviewer' | 'subagent' | 'unknown';

export interface G6DisplayNode {
  readonly publicNode: PublicAgent;
  readonly family: G6Family;
  readonly modelLabel: string;
  readonly branchId: string;
  readonly depth: number;
}

export interface G6CompletedCluster {
  readonly id: string;
  readonly branchId: string;
  readonly displayName: string;
  readonly count: number;
}

export interface G6FixtureData {
  readonly pages: readonly PublicHierarchyPage[];
  readonly nodes: readonly G6DisplayNode[];
  readonly completedClusters: readonly G6CompletedCluster[];
  readonly rootId: string;
  readonly primaryBranchIds: readonly string[];
  readonly scenario: G6Scenario;
}

const PRIMARY_BRANCHES = [
  { key: 'atlas', name: 'Atlas', family: 'sol' as const, role: 'planner' as const, model: 'Sol', effort: 'High' },
  { key: 'ceres', name: 'Ceres', family: 'luna' as const, role: 'worker' as const, model: 'Luna', effort: 'Max' },
  { key: 'vega', name: 'Vega', family: 'sol' as const, role: 'reviewer' as const, model: 'Sol', effort: 'Medium' },
];

const BRANCH_CHILDREN: Record<string, readonly string[]> = {
  atlas: ['Ada', 'Kepler', 'Lumen', 'Noor', 'Vale', 'Rook', 'Sable'],
  ceres: ['Iris', 'Mira', 'Pax', 'Quill', 'Rune', 'Sora', 'Tess'],
  vega: ['Borel', 'Cato', 'Dahl', 'Eon', 'Faye', 'Galen', 'Hale'],
};

const COMPLETED_BY_BRANCH: Record<string, readonly string[]> = {
  atlas: ['Atlas', 'Ada', 'Kepler', 'Lumen', 'Noor', 'Vale', 'Rook', 'Sable'],
  ceres: ['Ceres', 'Iris', 'Mira', 'Pax', 'Quill', 'Rune', 'Sora', 'Tess'],
  vega: ['Vega', 'Borel', 'Cato', 'Dahl', 'Eon', 'Faye', 'Galen', 'Hale'],
};

const BRANCH_COLORS: Record<G6Family, string> = {
  sol: 'Sol',
  luna: 'Luna',
};

function opaqueId(prefix: 'agent' | 'edge' | 'milestone', value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let hex = '';
  for (let index = 0; index < 10; index += 1) {
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 1274126177);
    hex += (hash >>> 0).toString(16).padStart(8, '0');
  }
  return `${prefix}:${hex.slice(0, prefix === 'milestone' ? 64 : 40)}`;
}

function isoAt(seconds: number): string {
  return new Date(Date.parse(G6_GENERATED_AT) + seconds * 1000).toISOString();
}

function safeIdentity(family: G6Family, effort: string, verification: 'verified' | 'unverified' | 'mismatch' = 'verified'): PublicAgent['identity'] {
  const model = family === 'sol' ? 'gpt-5.6-sol' : 'gpt-5.6-luna';
  return {
    requested: { model, provider: 'openai', effort: effort.toLowerCase(), source: 'collab.spawn', trust: 'requested' },
    observed: verification === 'unverified' ? null : { model, provider: 'openai', effort: effort.toLowerCase(), source: 'thread.settings', trust: 'observed' },
    verification,
  };
}

function taskState(lifecycle: PublicLifecycle, activityLabel: PublicActivityLabel, offset: number, failureCategory?: 'runtime' | 'bridge'): PublicAgent['taskState'] {
  return {
    lifecycle,
    activityLabel,
    ...(failureCategory === undefined ? {} : { failureCategory }),
    startedAt: isoAt(Math.max(0, offset - 900)),
    ...(lifecycle === 'completed' ? { completedAt: isoAt(offset), returnedAt: isoAt(offset) } : {}),
    lastActivityAt: isoAt(offset),
  };
}

function createFixtureData(scenario: G6Scenario): G6FixtureData {
  const rootId = opaqueId('agent', 'g6:main');
  const records: Array<{ key: string; name: string; parentKey: string | null; branchKey: string; family: G6Family; role: G6Role; effort: string; depth: number; lifecycle: PublicLifecycle; activity: PublicActivityLabel; verification?: 'verified' | 'unverified' | 'mismatch'; failureCategory?: 'runtime' | 'bridge' }> = [
    { key: 'main', name: 'Main', parentKey: null, branchKey: 'main', family: 'sol', role: 'root', effort: 'XHigh', depth: 0, lifecycle: 'active', activity: 'working' },
  ];

  for (const branch of PRIMARY_BRANCHES) {
    records.push({ key: branch.key, name: branch.name, parentKey: 'main', branchKey: branch.key, family: branch.family, role: branch.role, effort: branch.effort, depth: 1, lifecycle: branch.key === 'ceres' ? 'idle' : 'active', activity: branch.key === 'ceres' ? 'waiting' : 'working' });
    const children = BRANCH_CHILDREN[branch.key] ?? [];
    const orderedChildren = [children[0], ...children.slice(2), children[1]].filter((name): name is string => name !== undefined);
    orderedChildren.forEach((name) => {
      const index = children.indexOf(name);
      const key = `${branch.key}-${name.toLowerCase()}`;
      const firstLevel = index < 2;
      const activity = index % 3 === 0 ? 'working' as const : index % 3 === 1 ? 'waiting' as const : 'queued' as const;
      records.push({
        key,
        name: `${branch.name} · ${name}`,
        parentKey: firstLevel ? branch.key : `${branch.key}-${children[0]?.toLowerCase() ?? name.toLowerCase()}`,
        branchKey: branch.key,
        family: index % 2 === 0 ? branch.family : branch.family === 'sol' ? 'luna' : 'sol',
        role: index % 3 === 0 ? 'worker' : index % 3 === 1 ? 'reviewer' : 'subagent',
        effort: index % 2 === 0 ? 'High' : 'Max',
        depth: firstLevel ? 2 : 3,
        lifecycle: activity === 'waiting' ? 'idle' : activity === 'queued' ? 'pending' : 'active',
        activity,
      });
    });
  }

  const activeByKey = new Set(records.map((record) => record.key));
  const completedRecords: typeof records = [];
  for (let index = 1; index <= 200; index += 1) {
    const branch = PRIMARY_BRANCHES[(index - 1) % PRIMARY_BRANCHES.length] ?? PRIMARY_BRANCHES[0]!;
    const parentNames = COMPLETED_BY_BRANCH[branch.key] ?? [branch.name];
    const parentName = parentNames[(index - 1) % parentNames.length] ?? branch.name;
    const parentKey = parentName === branch.name ? branch.key : `${branch.key}-${parentName.toLowerCase()}`;
    completedRecords.push({
      key: `completed-${index.toString().padStart(3, '0')}`,
      name: `${branch.name} · Record ${index.toString().padStart(3, '0')}`,
      parentKey: activeByKey.has(parentKey) ? parentKey : branch.key,
      branchKey: branch.key,
      family: index % 2 === 0 ? 'luna' : 'sol',
      role: 'subagent',
      effort: index % 3 === 0 ? 'Medium' : 'High',
      depth: parentKey === branch.key ? 2 : 3,
      lifecycle: 'completed',
      activity: 'returned',
    });
  }
  records.push(...completedRecords);

  const childrenByKey = new Map<string, string[]>();
  for (const record of records) {
    if (record.parentKey !== null) {
      const children = childrenByKey.get(record.parentKey) ?? [];
      children.push(record.key);
      childrenByKey.set(record.parentKey, children);
    }
  }
  const recordByKey = new Map(records.map((record) => [record.key, record]));
  const orderedRecords: typeof records = [];
  const visit = (key: string): void => {
    const record = recordByKey.get(key);
    if (!record) return;
    orderedRecords.push(record);
    for (const child of childrenByKey.get(key) ?? []) visit(child);
  };
  visit('main');
  records.splice(0, records.length, ...orderedRecords);

  const ids = new Map(records.map((record) => [record.key, opaqueId('agent', `g6:${record.key}`)]));
  const descendantCount = new Map<string, number>();
  const countDescendants = (key: string): number => {
    const cached = descendantCount.get(key);
    if (cached !== undefined) return cached;
    const total = (childrenByKey.get(key) ?? []).reduce((sum, child) => sum + 1 + countDescendants(child), 0);
    descendantCount.set(key, total);
    return total;
  };
  records.forEach((record) => countDescendants(record.key));

  const publicNodes: PublicAgent[] = records.map((record, index) => {
    let lifecycle = record.lifecycle;
    let activity = record.activity;
    let verification = record.verification ?? 'verified';
    let failureCategory = record.failureCategory;
    if (scenario === 'disconnected' && record.lifecycle !== 'completed') {
      lifecycle = 'disconnected';
      activity = 'disconnected';
    } else if (scenario === 'failed' && record.key === 'atlas-ada') {
      lifecycle = 'failed';
      activity = 'failed';
      failureCategory = 'runtime';
    } else if (scenario === 'unverified' && record.key === 'vega') {
      verification = 'unverified';
    }
    const agentId = ids.get(record.key) ?? opaqueId('agent', `g6:fallback:${record.key}`);
    const parentAgentId = record.parentKey === null ? null : ids.get(record.parentKey) ?? null;
    return {
      schemaVersion: 'agent-farm.public.v1',
      agentId,
      parentAgentId,
      childIds: (childrenByKey.get(record.key) ?? []).map((child) => ids.get(child) ?? '').filter(Boolean),
      displayName: record.name,
      role: record.role,
      lifecycle,
      taskState: taskState(lifecycle, activity, 120 + index * 7, failureCategory),
      identity: safeIdentity(record.family, record.effort, verification),
      directChildCount: (childrenByKey.get(record.key) ?? []).length,
      descendantCount: descendantCount.get(record.key) ?? 0,
      spawnAt: isoAt(30 + index * 5),
      cluster: { state: lifecycle === 'completed' ? 'completed' : lifecycle === 'failed' ? 'failed' : lifecycle === 'disconnected' ? 'disconnected' : 'active' },
    };
  });

  const nodeByKey = new Map(records.map((record, index) => [record.key, publicNodes[index] as PublicAgent]));
  const edgeRecords = records.filter((record) => record.parentKey !== null);
  const edges = edgeRecords.map((record) => ({
    schemaVersion: 'agent-farm.public.v1' as const,
    edgeId: opaqueId('edge', `g6:${record.parentKey}:${record.key}`),
    parentAgentId: ids.get(record.parentKey ?? '') ?? rootId,
    childAgentId: ids.get(record.key) ?? rootId,
    state: 'verified' as const,
  }));
  const storyKeys: Array<{ key: string; kind: 'spawned' | 'working' | 'returned' | 'failed' | 'disconnected' | 'partial' }> = [
    { key: 'main', kind: 'spawned' },
    { key: 'atlas', kind: 'working' },
    { key: 'ceres', kind: 'working' },
    { key: 'vega', kind: 'working' },
    { key: 'atlas-ada', kind: scenario === 'failed' ? 'failed' : 'returned' },
    { key: 'ceres-iris', kind: 'returned' },
    { key: 'vega-borel', kind: 'returned' },
    ...(scenario === 'partial' ? [{ key: 'main', kind: 'partial' as const }] : []),
    ...(scenario === 'disconnected' ? [{ key: 'ceres', kind: 'disconnected' as const }] : []),
  ];
  const storyMilestones = storyKeys.map((story, sequence) => ({
    schemaVersion: 'agent-farm.public.v1' as const,
    milestoneId: opaqueId('milestone', `g6:${scenario}:${story.key}:${story.kind}`),
    sequence,
    kind: story.kind,
    agentId: nodeByKey.get(story.key)?.agentId ?? null,
    occurredAt: isoAt(160 + sequence * 30),
  }));

  const activeCount = publicNodes.filter((node) => node.lifecycle === 'active' || node.lifecycle === 'idle' || node.lifecycle === 'pending').length;
  const completedCount = publicNodes.filter((node) => node.lifecycle === 'completed').length;
  const failedCount = publicNodes.filter((node) => node.lifecycle === 'failed').length;
  const disconnectedCount = publicNodes.filter((node) => node.lifecycle === 'disconnected').length;
  const unverifiedCount = publicNodes.filter((node) => node.identity.verification !== 'verified' || node.lifecycle === 'unknown').length;
  const counts = { total: publicNodes.length, active: activeCount, completed: completedCount, failed: failedCount, disconnected: disconnectedCount, unverified: unverifiedCount };
  const snapshotState = scenario === 'partial' ? 'partial' as const : scenario === 'disconnected' ? 'disconnected' as const : 'complete' as const;
  const connection = scenario === 'partial'
    ? { state: 'stale' as const, reason: 'projection-lag' as const, updatedAt: G6_GENERATED_AT }
    : scenario === 'disconnected'
      ? { state: 'disconnected' as const, reason: 'source-disconnected' as const, updatedAt: G6_GENERATED_AT }
      : { state: 'connected' as const, updatedAt: G6_GENERATED_AT };
  const pages: PublicHierarchyPage[] = [];
  const firstPage = publicNodes.slice(0, 200);
  const secondPage = publicNodes.slice(200);
  const pageFields = (nodes: PublicAgent[], page: number, hasMore: boolean, nextCursor: string | null): PublicHierarchyPage => PublicHierarchyPageSchema.parse({
    schemaVersion: 'agent-farm.public.v1',
    agentSessionId: G6_SESSION_ID,
    watermark: 6000 + page,
    generatedAt: G6_GENERATED_AT,
    snapshotState,
    ...(scenario === 'partial' ? { partialReason: 'projection-lag' as const } : {}),
    connection,
    rootAgentId: rootId,
    nodes,
    edges: page === 1 ? edges.slice(0, 199) : edges.slice(199),
    total: publicNodes.length,
    page,
    pageSize: 200,
    hasMore,
    nextCursor,
    counts,
    storyMilestones,
  });
  pages.push(pageFields(firstPage, 1, true, 'p_2'));
  pages.push(pageFields(secondPage, 2, false, null));

  const displayNodes = publicNodes.map((publicNode) => {
    const record = records.find((candidate) => ids.get(candidate.key) === publicNode.agentId) ?? records[0];
    const branchId = record?.branchKey === 'main' ? rootId : ids.get(record?.branchKey ?? '') ?? rootId;
    const family = record?.family ?? 'sol';
    return { publicNode, family, modelLabel: `${BRANCH_COLORS[family]} · ${record?.effort ?? 'High'}`, branchId, depth: record?.depth ?? 0 };
  });
  const completedClusters: G6CompletedCluster[] = PRIMARY_BRANCHES.map((branch) => ({
    id: `cluster-${branch.key}`,
    branchId: ids.get(branch.key) ?? '',
    displayName: `${branch.name} completed descendants`,
    count: publicNodes.filter((node) => node.lifecycle === 'completed' && node.displayName.startsWith(`${branch.name} ·`)).length,
  }));
  return { pages, nodes: displayNodes, completedClusters, rootId, primaryBranchIds: PRIMARY_BRANCHES.map((branch) => ids.get(branch.key) ?? ''), scenario };
}

export function createG6FixtureData(scenario: G6Scenario = 'connected'): G6FixtureData {
  return createFixtureData(scenario);
}

export const g6Fixture = createG6FixtureData();
