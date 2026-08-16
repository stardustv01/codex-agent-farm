import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PublicHierarchyPageSchema } from '@agent-farm/contracts';
import { G6VisualFixture } from './g6-fixture';
import { createG6FixtureData, type G6Scenario } from './g6-fixtures';

describe('G6 code-native visual specification', () => {
  it('locks the <=480px fixture controls, header, banner, and summary to one-column stacking', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/g6-fixture.css'), 'utf8');
    const compactCss = css.split('@media (max-width: 480px) {')[1]?.split('@media (min-resolution: 192dpi)')[0] ?? '';
    expect(compactCss).toContain('.g6-header { display: grid; grid-template-columns: 1fr;');
    expect(compactCss).toContain('.g6-toolbar { grid-template-columns: 1fr; }');
    expect(compactCss).toContain('.g6-view-tabs { grid-column: 1; grid-template-columns: 1fr; }');
    expect(compactCss).toContain('.g6-state-banner { display: grid; grid-template-columns: 1fr;');
    expect(compactCss).toContain('.g6-outline-summary { grid-template-columns: 1fr;');
  });

  it('uses strict public-v1 pages with realistic three-branch depth-three density', () => {
    const fixture = createG6FixtureData();
    expect(fixture.pages).toHaveLength(2);
    fixture.pages.forEach((page) => expect(() => PublicHierarchyPageSchema.parse(page)).not.toThrow());
    expect(fixture.nodes).toHaveLength(225);
    expect(fixture.pages[0]?.counts).toMatchObject({ total: 225, active: 25, completed: 200, failed: 0, disconnected: 0, unverified: 0 });
    expect(fixture.primaryBranchIds).toHaveLength(3);
    expect(fixture.completedClusters.reduce((sum, cluster) => sum + cluster.count, 0)).toBe(200);
    expect(Math.max(...fixture.nodes.map((item) => item.depth))).toBe(3);
    fixture.nodes.forEach((item, index) => {
      const parentId = item.publicNode.parentAgentId;
      if (parentId !== null) expect(fixture.nodes.findIndex((candidate) => candidate.publicNode.agentId === parentId)).toBeLessThan(index);
    });
    expect(fixture.nodes.every((item) => !/[\\/]/u.test(item.publicNode.displayName))).toBe(true);
    expect(fixture.nodes.some((item) => item.publicNode.displayName === 'Atlas · Ada')).toBe(true);
    expect(JSON.stringify(fixture.pages)).not.toMatch(/sourceThreadId|sourceSessionId|agentPath|sourceRootId|credential|prompt|reasoning|resultSummary|errorSummary/iu);
  });

  it('keeps state variants truthful and deterministic', () => {
    const scenarios: G6Scenario[] = ['connected', 'partial', 'disconnected', 'failed', 'unverified'];
    for (const scenario of scenarios) {
      const first = createG6FixtureData(scenario);
      const second = createG6FixtureData(scenario);
      expect(first.pages).toEqual(second.pages);
      expect(first.pages[0]?.snapshotState).toBe(scenario === 'partial' ? 'partial' : scenario === 'disconnected' ? 'disconnected' : 'complete');
      if (scenario === 'partial') expect(first.pages[0]?.partialReason).toBe('projection-lag');
      if (scenario === 'disconnected') expect(first.pages[0]).toMatchObject({ connection: { state: 'disconnected' }, counts: { active: 0, disconnected: 25 } });
      if (scenario === 'failed') expect(first.pages[0]).toMatchObject({ connection: { state: 'connected' }, counts: { active: 24, failed: 1 } });
      if (scenario === 'unverified') expect(first.pages[0]).toMatchObject({ connection: { state: 'connected' }, counts: { active: 25, unverified: 1 } });
    }
  });

  it('renders Living Canopy as the primary surface with readable state shapes and clusters', async () => {
    render(<G6VisualFixture />);
    expect(screen.getByRole('heading', { name: 'Living Canopy' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Living Canopy hierarchy canvas/i })).toBeInTheDocument();
    expect(screen.getByText('↕ Scroll lane · every branch remains available')).toBeInTheDocument();
    expect(screen.getByText('25 active')).toBeInTheDocument();
    expect(screen.getByText('200 completed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Atlas completed descendants/i })).toBeInTheDocument();
    expect(screen.getByText('↓ Working activity')).toBeInTheDocument();
    const atlas = screen.getByRole('button', { name: /^Atlas,/i });
    expect(atlas).toHaveAttribute('data-activity', 'working');
    await userEvent.click(atlas);
    expect(screen.getByRole('complementary', { name: /Details for Atlas/i })).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
  });

  it('keeps Focus Lens and Outline equal modes on the same branch/count contract', async () => {
    const user = userEvent.setup();
    render(<G6VisualFixture />);
    await user.click(screen.getByRole('button', { name: 'Focus Lens' }));
    expect(screen.getByRole('heading', { level: 2, name: /Focus Lens/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Focus Lens hierarchy canvas/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Miniature hierarchy map/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Selected branch story' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Outline' }));
    expect(screen.getByRole('tree', { name: 'Agent Farm public hierarchy' })).toBeInTheDocument();
    expect(screen.getAllByRole('treeitem')).toHaveLength(225);
    expect(document.querySelector('[data-g6-outline-index="1"]')).toHaveAttribute('aria-level', '2');
    const atlas = document.querySelector<HTMLButtonElement>('[data-g6-outline-index="1"]');
    const atlasAda = document.querySelector<HTMLButtonElement>('[data-g6-outline-index="2"]');
    expect(atlas).not.toBeNull();
    expect(atlasAda).not.toBeNull();
    if (!atlas || !atlasAda) throw new Error('Expected Atlas and Atlas · Ada outline rows');
    atlas.focus();
    await user.keyboard('{ArrowRight}');
    expect(atlasAda).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(atlas).toHaveFocus();
    expect(atlasAda).toHaveAttribute('data-g6-outline-depth', '2');
    expect(screen.getAllByText('3 primary branches').length).toBeGreaterThanOrEqual(1);
  });

  it('exposes scenario, theme, reduced-motion, and 200% fixture controls with non-color state meaning', async () => {
    const user = userEvent.setup();
    const { container } = render(<G6VisualFixture />);
    const shell = container.querySelector('.g6-shell');
    expect(shell).toHaveAttribute('data-theme', 'light');
    expect(shell).toHaveAttribute('data-motion', 'full');
    expect(shell).toHaveAttribute('data-zoom', '100');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Fixture state' }), 'partial');
    expect(screen.getByRole('status')).toHaveTextContent(/Partial projection/);
    expect(screen.getAllByText('◐').length).toBeGreaterThanOrEqual(1);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Fixture state' }), 'unverified');
    expect(screen.getByText(/ID unverified/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dark canvas' }));
    await user.click(screen.getByRole('button', { name: 'Reduced motion' }));
    await user.click(screen.getByRole('button', { name: '200% zoom' }));
    expect(shell).toHaveAttribute('data-theme', 'dark');
    expect(shell).toHaveAttribute('data-motion', 'reduced');
    expect(shell).toHaveAttribute('data-zoom', '200');
    expect(shell?.getAttribute('style')).toContain('--g6-text-zoom: 200%');
    expect(shell ? getComputedStyle(shell).getPropertyValue('--g6-text-zoom').trim() : '').toBe('200%');
    expect(screen.getByRole('button', { name: 'Light canvas' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Motion off' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '100% zoom' })).toHaveAttribute('aria-pressed', 'true');
  });
});
