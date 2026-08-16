import { normalizeSnapshot } from './normalize';
import type { AgentHierarchySnapshot, AgentNode, AgentStatus } from './types';

const node = (id: string, name: string, parentId: string | null, status: AgentStatus, extra: Partial<AgentNode> = {}): AgentNode => ({
  id,
  name,
  parentId,
  status,
  ...extra,
});

export const canonicalDiracRheaKuhnNoether: AgentHierarchySnapshot = normalizeSnapshot({
  schemaVersion: 'agent-farm.v1',
  sessionId: 'fixture-canonical-session',
  rootAgentId: 'dirac',
  connection: { state: 'connected', label: 'Live projection', detail: 'Reconciled from fixture adapter', watermark: 42 },
  sourceAdapter: 'fixture',
  agents: [
    node('dirac', 'Dirac', null, 'running', {
      role: 'Structure lead',
      task: 'Coordinate the workspace audit and keep the branch hierarchy coherent.',
      requestedModel: 'gpt-5.6-sol',
      requestedEffort: 'high',
      observedModel: 'gpt-5.6-sol',
      observedEffort: 'high',
      identity: {
        requested: { model: 'gpt-5.6-sol', provider: 'openai', effort: 'high', source: 'spawn event', trust: 'authenticated' },
        observed: { model: 'gpt-5.6-sol', provider: 'openai', effort: 'high', source: 'thread settings', trust: 'observed' },
        verification: 'verified',
      },
    }),
    node('rhea', 'Rhea', 'dirac', 'waiting', {
      role: 'Instruction routing',
      task: 'Locate the active guide and report the operational boundary.',
      requestedModel: 'gpt-5.6-luna',
      requestedEffort: 'max',
      observedModel: 'gpt-5.6-luna',
      observedEffort: 'max',
      identity: {
        requested: { model: 'gpt-5.6-luna', provider: 'openai', effort: 'max', source: 'spawn event', trust: 'authenticated' },
        observed: { model: 'gpt-5.6-luna', provider: 'openai', effort: 'max', source: 'thread settings', trust: 'observed' },
        verification: 'verified',
      },
    }),
    node('kuhn', 'Kuhn', 'dirac', 'completed', {
      role: 'Source verification',
      task: 'Check the selected source area without opening archives.',
      summary: 'Read-only source check complete; no files changed.',
      requestedModel: 'gpt-5.6-luna',
      requestedEffort: 'max',
      observedModel: 'gpt-5.6-luna',
      observedEffort: 'max',
      identity: {
        requested: { model: 'gpt-5.6-luna', provider: 'openai', effort: 'max', source: 'spawn event', trust: 'authenticated' },
        observed: { model: 'gpt-5.6-luna', provider: 'openai', effort: 'max', source: 'thread read', trust: 'observed' },
        verification: 'verified',
      },
    }),
    node('noether', 'Noether', 'rhea', 'unverified', {
      role: 'Evidence reviewer',
      task: 'Compare requested and observed runtime identity evidence.',
      requestedModel: 'gpt-5.6-luna',
      requestedEffort: 'high',
      observedModel: 'gpt-5.6-luna',
      observedEffort: 'max',
      identity: {
        requested: { model: 'gpt-5.6-luna', provider: 'openai', effort: 'high', source: 'spawn event', trust: 'authenticated' },
        observed: { model: 'gpt-5.6-luna', provider: 'openai', effort: 'max', source: 'reroute evidence', trust: 'observed' },
        verification: 'mismatch',
      },
      verification: 'mismatch',
    }),
  ],
});

export function makeScaleFixture(activeCount = 25, completedCount = 200): AgentHierarchySnapshot {
  const agents: AgentNode[] = [
    node('dirac', 'Dirac', null, 'running', { role: 'Workspace coordinator', task: 'Observe the complete recursive agent projection.' }),
  ];
  for (let index = 1; index < activeCount; index += 1) {
    const id = `active-${index.toString().padStart(2, '0')}`;
    const statuses: AgentStatus[] = ['running', 'queued', 'waiting', 'disconnected', 'unverified'];
    agents.push(node(id, `Rhea ${index.toString().padStart(2, '0')}`, 'dirac', statuses[(index - 1) % statuses.length] ?? 'running', {
      role: index % 2 ? 'Source worker' : 'Evidence worker',
      task: `Active branch ${index}: inspect a bounded projection.`,
      requestedModel: index % 2 ? 'gpt-5.6-luna' : 'gpt-5.6-sol',
      requestedEffort: index % 3 ? 'high' : 'max',
      observedModel: index % 5 === 0 ? 'gpt-5.6-luna' : index % 2 ? 'gpt-5.6-luna' : 'gpt-5.6-sol',
      observedEffort: index % 3 ? 'high' : 'max',
      verification: index % 5 === 0 ? 'unverified' : 'verified',
    }));
  }
  for (let index = 1; index <= completedCount; index += 1) {
    const parentIndex = ((index - 1) % Math.max(1, activeCount - 1)) + 1;
    const parentId = activeCount > 1 ? `active-${parentIndex.toString().padStart(2, '0')}` : 'dirac';
    agents.push(node(`completed-${index.toString().padStart(3, '0')}`, `Kuhn ${index.toString().padStart(3, '0')}`, parentId, 'completed', {
      role: 'Completed run',
      summary: 'Read-only result summary retained by the projection.',
      resultSummary: `Completed branch ${index} of ${completedCount}.`,
      requestedModel: index % 2 ? 'gpt-5.6-luna' : 'gpt-5.6-sol',
      observedModel: index % 2 ? 'gpt-5.6-luna' : 'gpt-5.6-sol',
      requestedEffort: 'high',
      observedEffort: 'high',
      verification: 'verified',
    }));
  }
  return normalizeSnapshot({
    schemaVersion: 'agent-farm.v1',
    sessionId: 'fixture-scale-session',
    rootAgentId: 'dirac',
    agents,
    connection: { state: 'connected', label: 'Live projection', detail: `${activeCount} active - ${completedCount} completed`, watermark: 9001 },
    sourceAdapter: 'fixture',
  });
}

export const largeHierarchyFixture = makeScaleFixture();
export const canonicalHierarchyFixture = canonicalDiracRheaKuhnNoether;
export const canonicalTreeFixture = canonicalDiracRheaKuhnNoether;
export const canonicalDiracRheaKuhnNoetherFixture = canonicalDiracRheaKuhnNoether;
export const scaleFixture = largeHierarchyFixture;

/** Small local-mode fixture with the configured bounded orchestration budget. */
export const localBudgetFixture: AgentHierarchySnapshot = normalizeSnapshot({
  schemaVersion: 'agent-farm.v1',
  sessionId: 'fixture-local-budget-session',
  rootAgentId: 'local-root',
  connection: { state: 'connected', label: 'Local projection', detail: 'Fixture for local-mode budget checks', watermark: 7 },
  sourceAdapter: 'fixture',
  orchestrationBudget: { solHigh: 10, lunaMax: 10, solMax: 3 },
  agents: [
    node('local-root', 'Local Root', null, 'running', {
      role: 'Local coordinator',
      task: 'Coordinate a bounded local hierarchy.',
      requestedModel: 'gpt-5.6-sol',
      requestedEffort: 'high',
    }),
    node('local-worker', 'Local Worker', 'local-root', 'waiting', {
      role: 'Local worker',
      task: 'Inspect the selected local source.',
      requestedModel: 'gpt-5.6-luna',
      requestedEffort: 'max',
    }),
    node('local-result', 'Local Result', 'local-worker', 'completed', {
      role: 'Local result',
      summary: 'Bounded local fixture result.',
      requestedModel: 'gpt-5.6-sol',
      requestedEffort: 'max',
    }),
  ],
  edges: [
    { parentId: 'local-root', childId: 'local-worker' },
    { parentId: 'local-worker', childId: 'local-result' },
  ],
});

export const fixtures = {
  canonicalDiracRheaKuhnNoether,
  canonicalHierarchyFixture,
  canonicalTreeFixture,
  largeHierarchyFixture,
  scaleFixture,
  localBudgetFixture,
};
