import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { PublicAgent, PublicHierarchyPage } from '@agent-farm/contracts';
import { createG6FixtureData, type G6DisplayNode, type G6FixtureData, type G6Scenario } from './g6-fixtures';
import './g6-fixture.css';

export type G6ViewMode = 'canopy' | 'focus' | 'outline';
export type G6Theme = 'light' | 'dark';

const lifecycleLabels: Record<PublicAgent['lifecycle'], string> = {
  pending: 'Pending',
  active: 'Working',
  idle: 'Idle',
  completed: 'Settled',
  failed: 'Failed',
  interrupted: 'Interrupted',
  disconnected: 'Disconnected',
  unknown: 'Unverified',
};

const activityShapes: Record<PublicAgent['taskState']['activityLabel'], string> = {
  queued: '○',
  working: '●',
  waiting: '◐',
  returned: '✓',
  failed: '!',
  interrupted: '×',
  disconnected: '↯',
  unverified: '?',
  unknown: '·',
};

const scenarioLabels: Record<G6Scenario, string> = {
  connected: 'Connected / complete',
  partial: 'Partial projection',
  disconnected: 'Source disconnected',
  failed: 'Agent failure',
  unverified: 'Identity unverified',
};

const scenarioDescriptions: Record<G6Scenario, string> = {
  connected: 'All branches are reconciled from the local projection.',
  partial: 'Some descendants are still arriving; the visible snapshot is bounded and marked partial.',
  disconnected: 'The source is unavailable; retained hierarchy stays visible but is not live.',
  failed: 'One agent reported a runtime failure; the failure is visible without hiding sibling work.',
  unverified: 'One identity lacks observed evidence; the hierarchy remains readable and explicitly marked.',
};

interface Position {
  readonly x: number;
  readonly y: number;
}

interface FixtureNodeProps {
  readonly item: G6DisplayNode;
  readonly position: Position;
  readonly selected: boolean;
  readonly context?: boolean;
  readonly onSelect: (id: string) => void;
}

function statusClass(node: PublicAgent): string {
  return node.lifecycle === 'active' ? `activity-${node.taskState.activityLabel}` : `lifecycle-${node.lifecycle}`;
}

function NodeCard({ item, position, selected, context = false, onSelect }: FixtureNodeProps): ReactNode {
  const node = item.publicNode;
  const identityUnverified = node.identity.verification !== 'verified';
  const verification = identityUnverified ? 'Identity unverified' : 'Verified identity';
  const accessibleLabel = `${node.displayName}, ${lifecycleLabels[node.lifecycle]}, ${item.modelLabel}, ${verification}`;
  return <button
    type="button"
    className={`g6-node-card g6-family-${item.family} ${statusClass(node)} ${selected ? 'is-selected' : ''} ${context ? 'is-context' : ''}`}
    style={{ left: `${position.x}%`, top: `${position.y}%` }}
    aria-label={accessibleLabel}
    aria-pressed={selected}
    data-agent-id={node.agentId}
    data-lifecycle={node.lifecycle}
    data-activity={node.taskState.activityLabel}
    onClick={() => onSelect(node.agentId)}
  >
    <span className="g6-node-shape" aria-hidden="true">{activityShapes[node.taskState.activityLabel]}</span>
    <span className="g6-node-copy"><strong>{node.displayName}</strong><small>{item.modelLabel}{identityUnverified ? ' · ID unverified' : ''}</small></span>
    <span className="g6-node-state">{lifecycleLabels[node.lifecycle]}</span>
  </button>;
}

function makePositions(data: G6FixtureData, focusBranchId: string | null, view: G6ViewMode): Map<string, Position> {
  const positions = new Map<string, Position>();
  const root = data.nodes.find((item) => item.publicNode.agentId === data.rootId);
  if (root) positions.set(root.publicNode.agentId, { x: 50, y: 9 });
  const branchXs = [17, 50, 83];
  let contextIndex = 0;
  const activeByBranch = data.primaryBranchIds.map((branchId) => data.nodes.filter((item) => item.branchId === branchId && item.publicNode.lifecycle !== 'completed'));
  data.primaryBranchIds.forEach((branchId, branchIndex) => {
    const branch = data.nodes.find((item) => item.publicNode.agentId === branchId);
    const isFocusBranch = view === 'focus' && branchId === focusBranchId;
    const x = view === 'focus'
      ? isFocusBranch ? 50 : contextIndex % 2 === 0 ? 16 : 84
      : branchXs[branchIndex] ?? 50;
    const y = view === 'focus' && !isFocusBranch ? 17 + contextIndex++ * 12 : 24;
    if (branch) positions.set(branchId, { x, y });
    const descendants = activeByBranch[branchIndex]?.filter((item) => item.publicNode.agentId !== branchId) ?? [];
    descendants.forEach((item, index) => positions.set(item.publicNode.agentId, { x, y: 34 + index * 8.2 }));
    if (view === 'canopy' || focusBranchId === branchId) {
      positions.set(`cluster-${branchId}`, { x, y: 92 });
    }
  });
  if (view === 'focus' && focusBranchId !== null) {
    const branch = data.nodes.find((item) => item.publicNode.agentId === focusBranchId);
    if (branch) positions.set(branch.publicNode.agentId, { x: 50, y: 24 });
  }
  return positions;
}

function visibleCanvasNodes(data: G6FixtureData, focusBranchId: string | null, view: G6ViewMode): G6DisplayNode[] {
  const rootAndBranches = data.nodes.filter((item) => item.publicNode.agentId === data.rootId || data.primaryBranchIds.includes(item.publicNode.agentId));
  if (view === 'canopy' || focusBranchId === null) {
    return data.nodes.filter((item) => item.publicNode.lifecycle !== 'completed');
  }
  const branchNodes = data.nodes.filter((item) => item.branchId === focusBranchId && item.publicNode.lifecycle !== 'completed');
  const siblingContext = data.nodes.filter((item) => data.primaryBranchIds.includes(item.publicNode.agentId) && item.publicNode.agentId !== focusBranchId);
  return [...rootAndBranches.filter((item) => item.publicNode.agentId === data.rootId), ...siblingContext, ...branchNodes.filter((item) => item.publicNode.agentId !== focusBranchId), ...branchNodes.filter((item) => item.publicNode.agentId === focusBranchId)];
}

function connectorLines(data: G6FixtureData, focusBranchId: string | null, view: G6ViewMode, positions: Map<string, Position>): Array<{ key: string; from: Position; to: Position; state: string }> {
  const visible = visibleCanvasNodes(data, focusBranchId, view);
  const visibleIds = new Set(visible.map((item) => item.publicNode.agentId));
  return visible.flatMap((item) => {
    const parentId = item.publicNode.parentAgentId;
    if (!parentId || !visibleIds.has(parentId)) return [];
    const from = positions.get(parentId);
    const to = positions.get(item.publicNode.agentId);
    if (!from || !to) return [];
    return [{ key: `${parentId}:${item.publicNode.agentId}`, from, to, state: item.publicNode.lifecycle === 'completed' ? 'settled' : item.publicNode.taskState.activityLabel }];
  });
}

function StoryStrip({ page, selectedId, label = 'Structural activity story' }: { page: PublicHierarchyPage; selectedId: string | null; label?: string }): ReactNode {
  const items = page.storyMilestones.filter((milestone) => selectedId === null || milestone.agentId === selectedId || milestone.agentId === page.rootAgentId).slice(-6);
  return <section className="g6-story" aria-label={label}>
    <div className="g6-section-heading"><span className="g6-eyebrow">Branch story</span><span className="g6-section-note">Spawned → Working → Returned</span></div>
    <ol className="g6-story-list">
      {items.map((milestone) => <li key={milestone.milestoneId} className={`g6-story-item g6-story-${milestone.kind}`}>
        <span className="g6-story-marker" aria-hidden="true">{activityShapes[milestone.kind === 'spawned' ? 'queued' : milestone.kind === 'working' ? 'working' : milestone.kind === 'returned' ? 'returned' : milestone.kind === 'failed' ? 'failed' : milestone.kind === 'disconnected' ? 'disconnected' : 'unknown']}</span>
        <span><strong>{milestone.kind[0]?.toUpperCase() ?? ''}{milestone.kind.slice(1)}</strong><small>{milestone.agentId === selectedId ? 'Selected branch' : 'Farm projection'}</small></span>
      </li>)}
    </ol>
  </section>;
}

function DetailsPanel({ selected, data }: { selected: G6DisplayNode | undefined; data: G6FixtureData }): ReactNode {
  if (!selected) return <aside className="g6-details g6-details-empty" aria-label="Agent details"><span className="g6-eyebrow">Details on demand</span><h2>Select a node</h2><p>Choose a branch card to inspect its lifecycle, identity evidence, and descendant count.</p></aside>;
  const node = selected.publicNode;
  const parent = node.parentAgentId ? data.nodes.find((item) => item.publicNode.agentId === node.parentAgentId) : undefined;
  return <aside className="g6-details" aria-label={`Details for ${node.displayName}`}>
    <div className="g6-details-heading"><div><span className="g6-eyebrow">Selected agent</span><h2>{node.displayName}</h2><p>{selected.modelLabel} · {node.role}</p></div><span className={`g6-details-state g6-${statusClass(node)}`}>{lifecycleLabels[node.lifecycle]}</span></div>
    <dl className="g6-facts">
      <div><dt>Task state</dt><dd>{node.taskState.activityLabel}</dd></div>
      <div><dt>Identity</dt><dd>{node.identity.verification === 'verified' ? 'Verified' : 'Unverified'}</dd></div>
      <div><dt>Parent</dt><dd>{parent?.publicNode.displayName ?? 'Farm root'}</dd></div>
      <div><dt>Descendants</dt><dd>{node.descendantCount.toLocaleString()}</dd></div>
    </dl>
    <div className="g6-detail-note"><span className="g6-eyebrow">Public projection</span><p>Only the safe display name, lifecycle, task state, and identity evidence are shown here.</p></div>
  </aside>;
}

function MiniMap({ data, positions, focusBranchId }: { data: G6FixtureData; positions: Map<string, Position>; focusBranchId: string | null }): ReactNode {
  return <div className="g6-minimap" aria-label="Focus branch minimap">
    <span className="g6-eyebrow">Branch map</span>
    <svg viewBox="0 0 100 100" role="img" aria-label="Miniature hierarchy map">
      {data.primaryBranchIds.map((branchId) => {
        const branch = positions.get(branchId);
        const root = positions.get(data.rootId);
        if (!branch || !root) return null;
        return <line key={branchId} x1={root.x} y1={root.y} x2={branch.x} y2={branch.y} className={branchId === focusBranchId ? 'is-focused' : ''} />;
      })}
      <circle cx="50" cy="9" r="3" className="g6-minimap-root" />
      {data.primaryBranchIds.map((branchId) => {
        const position = positions.get(branchId);
        if (!position) return null;
        return <circle key={branchId} cx={position.x} cy={position.y} r={branchId === focusBranchId ? 4 : 2.5} className={branchId === focusBranchId ? 'is-focused' : ''} />;
      })}
    </svg>
  </div>;
}

function CanopyCanvas({ data, page, focusBranchId, view, selectedId, onSelect }: { data: G6FixtureData; page: PublicHierarchyPage; focusBranchId: string | null; view: G6ViewMode; selectedId: string | null; onSelect: (id: string) => void }): ReactNode {
  const positions = useMemo(() => makePositions(data, focusBranchId, view), [data, focusBranchId, view]);
  const visible = visibleCanvasNodes(data, focusBranchId, view);
  const visibleIds = new Set(visible.map((item) => item.publicNode.agentId));
  const lines = connectorLines(data, focusBranchId, view, positions);
  const clusters = data.completedClusters.filter((cluster) => view === 'canopy' || cluster.branchId === focusBranchId);
  return <div className={`g6-canvas-shell g6-canvas-${view}`}>
    <div className="g6-canvas-header"><div><span className="g6-eyebrow">{view === 'focus' ? 'Focus Lens' : 'Living Canopy'}</span><h2>{view === 'focus' ? 'Focus Lens · one branch, its context, and its return path' : 'Every primary branch in one readable field'}</h2></div><div className="g6-canvas-header-meta"><span className="g6-canvas-count">{view === 'focus' ? 'Selected branch' : `${page.counts.active} active · ${page.counts.completed} completed`}</span><span className="g6-compact-scroll-note">↕ Scroll lane · every branch remains available</span></div></div>
    <div className="g6-canvas" role="region" aria-label={view === 'focus' ? 'Focus Lens hierarchy canvas' : 'Living Canopy hierarchy canvas'}>
      <svg className="g6-connectors" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {lines.map((line) => <line key={line.key} x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y} className={`g6-connector g6-connector-${line.state}`} />)}
      </svg>
      <div className="g6-node-layer">
        {visible.map((item) => {
          const position = positions.get(item.publicNode.agentId);
          if (!position) return null;
          const context = view === 'focus' && item.branchId !== focusBranchId && item.publicNode.agentId !== data.rootId;
          return <NodeCard key={item.publicNode.agentId} item={item} position={position} selected={selectedId === item.publicNode.agentId} context={context} onSelect={onSelect} />;
        })}
        {clusters.map((cluster) => {
          const position = positions.get(`cluster-${cluster.branchId}`);
          if (!position) return null;
          return <button key={cluster.id} type="button" className={`g6-cluster-card ${focusBranchId === cluster.branchId ? 'is-focused' : ''}`} style={{ left: `${position.x}%`, top: `${position.y}%` }} aria-label={`${cluster.displayName}, ${cluster.count} settled descendants`} onClick={() => onSelect(data.primaryBranchIds.find((id) => data.nodes.find((item) => item.publicNode.agentId === id)?.branchId === cluster.branchId) ?? '')}>
            <span className="g6-cluster-shape" aria-hidden="true">▦</span><strong>{cluster.count}</strong><small>settled descendants</small>
          </button>;
        })}
      </div>
      <div className="g6-canvas-caption"><span>↓ Working activity</span><span>↑ Returned result</span><span>▦ Completed cluster</span></div>
    </div>
    {view === 'focus' && <MiniMap data={data} positions={positions} focusBranchId={focusBranchId} />}
  </div>;
}

function OutlineView({ data, page, selectedId, onSelect }: { data: G6FixtureData; page: PublicHierarchyPage; selectedId: string | null; onSelect: (id: string) => void }): ReactNode {
  const [activeIndex, setActiveIndex] = useState(0);
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const current = data.nodes[index];
    const firstChildId = current?.publicNode.childIds[0];
    const firstChildIndex = firstChildId === undefined ? -1 : data.nodes.findIndex((item) => item.publicNode.agentId === firstChildId);
    const parentId = current?.publicNode.parentAgentId;
    const parentIndex = parentId === null || parentId === undefined ? -1 : data.nodes.findIndex((item) => item.publicNode.agentId === parentId);
    const target = event.key === 'ArrowDown' ? Math.min(data.nodes.length - 1, index + 1)
      : event.key === 'ArrowUp' ? Math.max(0, index - 1)
        : event.key === 'ArrowRight' && firstChildIndex >= 0 ? firstChildIndex
          : event.key === 'ArrowLeft' && parentIndex >= 0 ? parentIndex
            : event.key === 'Home' ? 0 : event.key === 'End' ? data.nodes.length - 1 : index;
    if (target !== index) {
      event.preventDefault();
      setActiveIndex(target);
      const button = document.querySelector<HTMLButtonElement>(`[data-g6-outline-index="${target}"]`);
      button?.focus();
    }
  };
  return <section className="g6-outline-panel" aria-label="Outline view">
    <div className="g6-canvas-header"><div><span className="g6-eyebrow">Outline</span><h2>Equal semantic access to the same farm projection</h2></div><span className="g6-canvas-count">{data.nodes.length} nodes · 224 edges</span></div>
    <div className="g6-outline-summary" role="status"><strong>{page.counts.active} active</strong><span>{page.counts.completed} settled</span><span>3 primary branches</span><span>Depth 3</span></div>
    <ol className="g6-outline-tree" role="tree" aria-label="Agent Farm public hierarchy">
      {data.nodes.map((item, index) => {
        const node = item.publicNode;
        const siblings = data.nodes.filter((candidate) => candidate.publicNode.parentAgentId === node.parentAgentId);
        const position = Math.max(1, siblings.findIndex((candidate) => candidate.publicNode.agentId === node.agentId) + 1);
        return <li key={node.agentId} role="none">
          <button type="button" className={`g6-outline-row ${selectedId === node.agentId ? 'is-selected' : ''}`} style={{ '--g6-outline-depth': item.depth } as CSSProperties} role="treeitem" aria-level={item.depth + 1} aria-posinset={position} aria-setsize={siblings.length || 1} aria-selected={selectedId === node.agentId} {...(node.childIds.length === 0 ? {} : { 'aria-expanded': true })} tabIndex={activeIndex === index ? 0 : -1} data-g6-outline-index={index} data-g6-outline-depth={item.depth} onFocus={() => setActiveIndex(index)} onKeyDown={(event) => handleKeyDown(event, index)} onClick={() => onSelect(node.agentId)}>
            <span className={`g6-outline-shape g6-${statusClass(node)}`} aria-hidden="true">{activityShapes[node.taskState.activityLabel]}</span><span className="g6-outline-name"><strong>{node.displayName}</strong><small>{item.modelLabel} · {lifecycleLabels[node.lifecycle]}{node.identity.verification === 'verified' ? '' : ' · ID unverified'}</small></span><span className="g6-outline-descendants">{node.descendantCount.toLocaleString()} ↓</span>
          </button>
        </li>;
      })}
    </ol>
  </section>;
}

export interface G6FixtureProps {
  readonly initialScenario?: G6Scenario;
  readonly initialView?: G6ViewMode;
}

export function G6VisualFixture({ initialScenario = 'connected', initialView = 'canopy' }: G6FixtureProps): ReactNode {
  const [scenario, setScenario] = useState<G6Scenario>(initialScenario);
  const [view, setView] = useState<G6ViewMode>(initialView);
  const [theme, setTheme] = useState<G6Theme>('light');
  const [reducedMotion, setReducedMotion] = useState(false);
  const [largeZoom, setLargeZoom] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const data = useMemo(() => createG6FixtureData(scenario), [scenario]);
  const page = data.pages[0] as PublicHierarchyPage;
  const selected = data.nodes.find((item) => item.publicNode.agentId === selectedId);
  const focusBranchId = view === 'focus' ? selected?.branchId ?? data.primaryBranchIds[0] ?? null : null;
  const onSelect = (id: string): void => setSelectedId(id || null);
  const switchView = (nextView: G6ViewMode): void => {
    setView(nextView);
    if (nextView === 'focus' && selectedId === null) setSelectedId(data.primaryBranchIds[0] ?? null);
  };
  const zoomStyle = { '--g6-text-zoom': largeZoom ? '200%' : '100%' } as CSSProperties;
  return <div className="g6-shell" style={zoomStyle} data-theme={theme} data-motion={reducedMotion ? 'reduced' : 'full'} data-zoom={largeZoom ? '200' : '100'}>
    <header className="g6-header">
      <div className="g6-brand"><span className="g6-brand-mark" aria-hidden="true">✦</span><div><span className="g6-eyebrow">Agent Farm · visual specification</span><h1>{view === 'focus' ? 'Focus Lens' : view === 'outline' ? 'Outline' : 'Living Canopy'}</h1><p>Deterministic local fixture · public-v1 projection</p></div></div>
      <div className="g6-header-metrics" aria-label="Fixture density"><strong>{page.counts.active} active</strong><span>{page.counts.completed} completed</span>{page.counts.failed > 0 && <span>{page.counts.failed} failed</span>}{page.counts.disconnected > 0 && <span>{page.counts.disconnected} disconnected</span>}{page.counts.unverified > 0 && <span>{page.counts.unverified} unverified</span>}<span>3 primary branches</span></div>
    </header>
    <nav className="g6-toolbar" aria-label="Visual specification controls">
      <div className="g6-view-tabs" role="group" aria-label="View mode">
        {([['canopy', 'Living Canopy'], ['focus', 'Focus Lens'], ['outline', 'Outline']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} className={view === key ? 'is-active' : ''} onClick={() => switchView(key)}>{label}</button>)}
      </div>
      <label className="g6-select"><span>Fixture state</span><select aria-label="Fixture state" value={scenario} onChange={(event) => { setScenario(event.target.value as G6Scenario); setSelectedId(null); }}><option value="connected">{scenarioLabels.connected}</option><option value="partial">{scenarioLabels.partial}</option><option value="disconnected">{scenarioLabels.disconnected}</option><option value="failed">{scenarioLabels.failed}</option><option value="unverified">{scenarioLabels.unverified}</option></select></label>
      <button type="button" className="g6-toggle" aria-pressed={theme === 'dark'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Light canvas' : 'Dark canvas'}</button>
      <button type="button" className="g6-toggle" aria-pressed={reducedMotion} onClick={() => setReducedMotion(!reducedMotion)}>{reducedMotion ? 'Motion off' : 'Reduced motion'}</button>
      <button type="button" className="g6-toggle" aria-pressed={largeZoom} onClick={() => setLargeZoom(!largeZoom)}>{largeZoom ? '100% zoom' : '200% zoom'}</button>
    </nav>
    <section className={`g6-state-banner g6-banner-${scenario}`} role="status" aria-live="polite"><span className="g6-state-shape" aria-hidden="true">{scenario === 'connected' ? '●' : scenario === 'partial' ? '◐' : scenario === 'disconnected' ? '↯' : scenario === 'failed' ? '!' : '?'}</span><span><strong>{scenarioLabels[scenario]}</strong> · {scenarioDescriptions[scenario]}</span></section>
    <main className="g6-main">
      <section className="g6-primary-surface">
        {view === 'outline' ? <OutlineView data={data} page={page} selectedId={selectedId} onSelect={onSelect} /> : <CanopyCanvas data={data} page={page} focusBranchId={focusBranchId} view={view} selectedId={selectedId} onSelect={onSelect} />}
      </section>
      {view !== 'outline' && <DetailsPanel selected={selected} data={data} />}
    </main>
    {view === 'focus' && <StoryStrip page={page} selectedId={selectedId} label="Selected branch story" />}
    <footer className="g6-legend" aria-label="Visual language legend"><span><i className="g6-legend-swatch g6-swatch-sol" aria-hidden="true">S</i>Sol family</span><span><i className="g6-legend-swatch g6-swatch-luna" aria-hidden="true">L</i>Luna family</span><span><i className="g6-legend-swatch g6-swatch-verify" aria-hidden="true">✓</i>Verified evidence</span><span><i className="g6-legend-swatch g6-swatch-attention" aria-hidden="true">!</i>Attention / unverified</span><span><i className="g6-legend-swatch g6-swatch-settled" aria-hidden="true">▦</i>Settled cluster</span></footer>
  </div>;
}

export default G6VisualFixture;
