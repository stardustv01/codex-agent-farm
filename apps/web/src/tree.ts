import { getChildren, getRoots } from './normalize';
import type { AgentHierarchySnapshot, AgentId, AgentNode, AgentStatus } from './types';

export interface VisibleTreeNode {
  node: AgentNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  matchesFilter: boolean;
  cycle: boolean;
}

const searchableText = (node: AgentNode): string =>
  [
    node.name,
    node.nickname,
    node.role,
    node.task,
    node.summary,
    node.resultSummary,
    node.errorSummary,
    node.requestedModel,
    node.requestedProvider,
    node.requestedEffort,
    node.observedModel,
    node.observedProvider,
    node.observedEffort,
    node.verification,
    node.identity?.requested?.model,
    node.identity?.requested?.provider,
    node.identity?.requested?.effort,
    node.identity?.requested?.source,
    node.identity?.requested?.trust,
    node.identity?.observed?.model,
    node.identity?.observed?.provider,
    node.identity?.observed?.effort,
    node.identity?.observed?.source,
    node.identity?.observed?.trust,
    node.identity?.verification,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();

export const nodeMatches = (node: AgentNode, search: string, status: AgentStatus | 'all'): boolean => {
  const query = search.trim().toLocaleLowerCase();
  if (status !== 'all' && node.status !== status) return false;
  return !query || searchableText(node).includes(query);
};

function makeMatchSet(snapshot: AgentHierarchySnapshot, search: string, status: AgentStatus | 'all', focusId: AgentId | null): Set<AgentId> {
  const directMatches = new Set(Object.values(snapshot.agents).filter((node) => nodeMatches(node, search, status)).map((node) => node.id));
  if (!search.trim() && status === 'all' && !focusId) return new Set(Object.keys(snapshot.agents));
  const result = new Set(directMatches);
  for (const id of directMatches) {
    let current = snapshot.agents[id];
    const seen = new Set<AgentId>();
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      result.add(current.parentId);
      const parent = snapshot.agents[current.parentId];
      if (!parent) break;
      current = parent;
    }
  }
  if (focusId) {
    const focus = snapshot.agents[focusId];
    if (focus) {
      for (const id of [...result]) {
        let current: AgentNode | undefined = snapshot.agents[id];
        let inside = id === focusId;
        const seen = new Set<AgentId>();
        while (current?.parentId && !seen.has(current.id)) {
          seen.add(current.id);
          if (current.parentId === focusId) inside = true;
          current = snapshot.agents[current.parentId];
        }
        if (!inside) result.delete(id);
      }
    }
  }
  return result;
}

export function getVisibleTree(
  snapshot: AgentHierarchySnapshot,
  expandedIds: ReadonlySet<AgentId>,
  search = '',
  status: AgentStatus | 'all' = 'all',
  focusId: AgentId | null = null,
): VisibleTreeNode[] {
  const matches = makeMatchSet(snapshot, search, status, focusId);
  const output: VisibleTreeNode[] = [];
  const visit = (node: AgentNode, depth: number, ancestors: Set<AgentId>): void => {
    if (ancestors.has(node.id)) {
      output.push({ node, depth, hasChildren: false, expanded: false, matchesFilter: false, cycle: true });
      return;
    }
    if (!matches.has(node.id)) return;
    const children = getChildren(snapshot, node.id);
    const expanded = expandedIds.has(node.id) || Boolean(search.trim() || status !== 'all');
    output.push({ node, depth, hasChildren: children.length > 0, expanded, matchesFilter: nodeMatches(node, search, status), cycle: false });
    if (!expanded) return;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(node.id);
    for (const child of children) visit(child, depth + 1, nextAncestors);
  };
  const roots = getRoots(snapshot);
  if (focusId && snapshot.agents[focusId]) visit(snapshot.agents[focusId], 0, new Set());
  else for (const root of roots) visit(root, 0, new Set());
  return output;
}

export function getSiblingIds(snapshot: AgentHierarchySnapshot, id: AgentId): AgentId[] {
  const node = snapshot.agents[id];
  if (!node) return [];
  if (!node.parentId || !snapshot.agents[node.parentId]) return getRoots(snapshot).map((root) => root.id);
  return getChildren(snapshot, node.parentId).map((child) => child.id);
}

export function getParentId(snapshot: AgentHierarchySnapshot, id: AgentId): AgentId | null {
  const parentId = snapshot.agents[id]?.parentId;
  return parentId && snapshot.agents[parentId] ? parentId : null;
}
