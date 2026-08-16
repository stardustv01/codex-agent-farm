import { useMemo, useReducer, type ReactNode } from 'react';
import { createInitialState, agentFarmReducer } from './reducer';
import { mergeHierarchyPages } from './pagination';
import { normalizeSnapshot } from './normalize';
import { createG6FixtureData } from './g6-fixtures';
import ProductionHierarchy from './production-hierarchy';
import type { AgentHierarchyInput } from './types';

/**
 * Browser-review harness for the production G7 renderer. It deliberately
 * reuses only the strict public-v1 fixture pages as input, merges both pages,
 * and then enters the same reducer/component path used by standalone and MCP.
 * The entry is dynamically imported only by the DEV-only query gate in main.
 */
export function G7ProductionFixture(): ReactNode {
  const initial = useMemo(() => {
    const fixture = createG6FixtureData('connected');
    const merged = mergeHierarchyPages(fixture.pages as unknown as AgentHierarchyInput[]);
    return createInitialState(normalizeSnapshot(merged), 'standalone');
  }, []);
  const [state, dispatch] = useReducer(agentFarmReducer, initial);
  return <ProductionHierarchy state={state} dispatch={dispatch} title="G7 production public-v1 review" />;
}

export default G7ProductionFixture;
