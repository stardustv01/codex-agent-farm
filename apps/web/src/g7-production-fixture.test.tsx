import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentFarmApp } from './App';
import { createG6FixtureData } from './g6-fixtures';
import type { AgentHierarchyInput } from './types';

describe('G7 production browser-review harness', () => {
  it('feeds the complete strict public-v1 fixture through one hierarchy workspace', () => {
    const page = createG6FixtureData().pages[0];
    if (!page) throw new Error('fixture page missing');
    render(<AgentFarmApp mode="standalone" snapshot={page as unknown as AgentHierarchyInput} />);
    expect(screen.getByRole('region', { name: 'Agent Farm hierarchy' })).toBeInTheDocument();
    expect(screen.getByText('Hierarchy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Root Chat,/i })).toBeInTheDocument();
    expect(document.querySelector('.prod-app')).toBeNull();
    expect(document.body.textContent).not.toMatch(/sourceThreadId|sourceSessionId|agentPath|credential|prompt|reasoning/iu);
  });

  it('keeps an active branch and nested descendants reachable from branch focus', async () => {
    const user = userEvent.setup();
    const page = createG6FixtureData().pages[0];
    if (!page) throw new Error('fixture page missing');
    render(<AgentFarmApp mode="standalone" snapshot={page as unknown as AgentHierarchyInput} />);
    const firstBranch = screen.getByRole('button', { name: /^Atlas,/i });
    await user.click(firstBranch);
    expect(document.querySelector('[aria-label="Branch focus"]')).not.toBeNull();
  });
});
