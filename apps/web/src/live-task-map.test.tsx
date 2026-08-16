import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentFarmApp } from './App';
import { canonicalHierarchyFixture } from './fixtures';

describe('Live Task Map workspace', () => {
  it('mounts one hierarchy with active-first direct branches and no legacy surface', () => {
    render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} />);
    expect(screen.getByRole('region', { name: 'Agent Farm hierarchy' })).toBeInTheDocument();
    expect(screen.getByText('Hierarchy')).toBeInTheDocument();
    expect(document.querySelector('.prod-app')).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Root Chat,/i })).toHaveLength(1);
    const branchButtons = screen.getAllByRole('button').filter((button) => /Rhea|Noether/i.test(button.getAttribute('aria-label') ?? ''));
    expect(branchButtons[0]?.getAttribute('aria-label')).toMatch(/^Rhea,/i);
  });

  it('enters branch focus with breadcrumb and preserves nested children', async () => {
    const user = userEvent.setup();
    render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} />);
    await user.click(screen.getByRole('button', { name: /^Rhea,/i }));
    expect(screen.getByRole('region', { name: 'Agent Farm hierarchy' })).toHaveTextContent(/Root Chat\s*\/\s*Rhea/);
    const focus = document.querySelector('[aria-label="Branch focus"]');
    expect(focus).toBeInTheDocument();
    expect(focus?.querySelector('.task-map-focus-summary')).toHaveTextContent(/Rhea.*1 subagent.*Max effort/i);
    expect(focus?.querySelector('.task-map-focus-children')).toHaveTextContent('Noether');
  });

  it('keeps theme and 200% text controls in the overflow menu', async () => {
    const user = userEvent.setup();
    render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} />);
    await user.click(screen.getByRole('button', { name: 'More options' }));
    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
    expect(document.querySelector('.task-map-theme-dark')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'More options' }));
    await user.click(screen.getByRole('button', { name: '200% text' }));
    expect(document.querySelector('.task-map-zoom-200')).not.toBeNull();
  });
});
