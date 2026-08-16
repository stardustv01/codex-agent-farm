import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentFarmApp } from './App';
import { canonicalHierarchyFixture } from './fixtures';
import { orderSiblingsActiveFirst, partialCostMicros } from './production-hierarchy';
import { agentIdentityTone } from './task-map-icons';
import type { LocalAgentDetail } from '@agent-farm/contracts';
import type { AgentHierarchyInput, HostAdapter } from './types';

describe('production public hierarchy', () => {
  it('orders direct siblings Active, Blocked, Waiting, Complete, Unknown stably', () => {
    const ordered = orderSiblingsActiveFirst([
      { lifecycle: 'completed', id: 'complete' }, { lifecycle: 'unknown', id: 'unknown' }, { lifecycle: 'failed', id: 'blocked' },
      { lifecycle: 'active', id: 'active' }, { lifecycle: 'idle', id: 'waiting' },
    ]);
    expect(ordered.map((item) => item.id)).toEqual(['active', 'blocked', 'waiting', 'complete', 'unknown']);
  });

  it('shows the known subtotal for partial cost instead of calling it unavailable', () => {
    expect(partialCostMicros({ status: 'partial', currency: 'USD', knownSelfMicros: 18_670_890, reason: 'descendant-cost-unavailable' })).toBe(18_670_890);
    expect(partialCostMicros({ status: 'partial', currency: 'USD', knownChildrenMicros: 600, reason: 'self-cost-unavailable' })).toBe(600);
    expect(partialCostMicros({ status: 'partial', currency: 'USD', reason: 'pricing-unavailable' })).toBeUndefined();
  });

  it('makes the compact mobile preview an inspector control', () => {
    render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} />);
    const preview = document.querySelector('.task-map-mobile-preview');
    expect(preview?.tagName).toBe('BUTTON');
    expect(preview).toHaveAttribute('aria-label', 'Open details for Root Chat');
  });

  it('shows an explicit first-sync state instead of an empty-task error', () => {
    render(<AgentFarmApp mode="standalone" snapshot={{
      schemaVersion: 'agent-farm.v1',
      sessionId: 'first-sync-session',
      rootAgentId: null,
      agents: {},
      edges: [],
      connection: { state: 'reconnecting', label: 'Connecting' },
    }} runtimeConfig={{
      localMode: true,
      paired: true,
      syncing: true,
      agentSessionId: 'first-sync-session',
      activeTask: { displayName: 'Fresh chat' },
    }} />);
    expect(screen.getAllByRole('status').some((status) => status.textContent?.includes('Syncing'))).toBe(true);
    expect(screen.getByRole('heading', { name: 'Syncing this chat' })).toBeInTheDocument();
    expect(screen.queryByText('No active Codex task')).not.toBeInTheDocument();
  });

  it('renders deterministic SVG branding, model glyphs, and explicit subagent counts', () => {
    render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} />);
    expect(document.querySelector('.task-map-brand-mark svg')).not.toBeNull();
    expect(document.querySelector('.task-map-model-glyph svg')).not.toBeNull();
    expect(document.querySelector('.task-map-mobile-branch[aria-label="Rhea, Waiting, Max effort, 1 subagent"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Root Chat, Active, Sol, High effort, 3 subagents' })).toBeInTheDocument();
    expect(screen.queryByText('1 agent')).not.toBeInTheDocument();
  });

  it('shows two-decimal aggregate and attributable costs without rounding tiny work to zero', async () => {
    const adapter: HostAdapter = {
      kind: 'test-local',
      mode: 'standalone',
      getSnapshot: async () => canonicalHierarchyFixture,
      getLocalAgentDetail: async (id) => ({
        cost: id === 'dirac'
          ? { status: 'estimated', currency: 'USD', selfMicros: 750_000, childrenMicros: 750_000, totalMicros: 1_500_000 }
          : id === 'rhea'
            ? { status: 'partial', currency: 'USD', knownSelfMicros: 3_500, reason: 'descendant-cost-unavailable' }
            : { status: 'unavailable', currency: 'USD', reason: 'pricing-unavailable' },
      } as unknown as LocalAgentDetail),
      subscribe: () => () => undefined,
    };
    render(<AgentFarmApp adapter={adapter} snapshot={canonicalHierarchyFixture} />);
    expect((await screen.findAllByLabelText('Estimated aggregate cost $1.50')).length).toBeGreaterThan(0);
    expect((await screen.findAllByLabelText('Known attributable cost <$0.01')).length).toBeGreaterThan(0);
  });

  it('keeps agent identity marks distinct from lifecycle badges', () => {
    expect(agentIdentityTone('gpt-5.6-sol')).toBe('sol');
    expect(agentIdentityTone('gpt-5.6-luna')).toBe('luna');
    expect(agentIdentityTone('gpt-5.6-terra')).toBe('terra');
    expect(agentIdentityTone('codex-auto-review')).toBe('luna');
    expect(agentIdentityTone('unreported-model')).toBe('unknown');
    render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} />);
    expect(document.querySelector('.task-map-model-sol .task-map-lifecycle-badge')).not.toBeNull();
    expect(document.querySelector('.task-map-model-luna .task-map-lifecycle-badge')).not.toBeNull();
  });

  it('renders animated model pets and includes Terra in the model filter cycle', async () => {
    const user = userEvent.setup();
    render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} />);
    expect(document.querySelector('[data-pet-family="sol"]')).not.toBeNull();
    expect(document.querySelector('[data-pet-family="luna"]')).not.toBeNull();
    const filter = screen.getByRole('button', { name: 'Filter agents by model' });
    await user.click(filter);
    await user.click(filter);
    expect(filter).toHaveAttribute('data-active', 'true');
  });

  it('renders a single hierarchy workspace and preserves arbitrary nested children', async () => {
    const user = userEvent.setup();
    render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} />);
    expect(screen.getByRole('region', { name: 'Agent Farm hierarchy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Root Chat,/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Noether/i })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Kuhn,/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Noether/i }));
    expect(screen.getByRole('complementary', { name: /Inspector for Noether/i })).toBeInTheDocument();
    expect(screen.queryByText('Living Canopy')).not.toBeInTheDocument();
    expect(screen.queryByText('Focus Lens')).not.toBeInTheDocument();
  });

  it('uses Root Chat as the direct parent label and explains root-plus-subagent totals', async () => {
    const user = userEvent.setup();
    const { task: _task, summary: _summary, resultSummary: _resultSummary, ...rheaWithoutRecordedSummary } = canonicalHierarchyFixture.agents.rhea!;
    const snapshot = {
      ...canonicalHierarchyFixture,
      agents: {
        ...canonicalHierarchyFixture.agents,
        rhea: rheaWithoutRecordedSummary,
      },
    };
    render(<AgentFarmApp mode="standalone" snapshot={snapshot} />);
    await user.click(screen.getByRole('button', { name: /^Rhea,/i }));
    expect(screen.getByRole('heading', { name: 'Parent' }).parentElement).toHaveTextContent('Root Chat');
    expect(screen.getByRole('heading', { name: 'Latest summary' }).parentElement).toHaveTextContent('3 subagents + Root Chat (4 agents total)');
  });

  it('keeps identity, cost truth, read-only timeline, and privacy boundaries visible', async () => {
    const user = userEvent.setup();
    render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture as unknown as AgentHierarchyInput} />);
    expect(screen.getByText('Matched')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(screen.getByText(/No recorded messages|Timeline is loading/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/credential|access_token|password|private\/agent-farm/iu);
    expect(document.body.textContent).not.toMatch(/Steer|Interrupt|Spawn|Undo|Pair|Unpair/iu);
  });

  it('exposes dark mode and 200% text as explicit overflow controls', async () => {
    const user = userEvent.setup();
    render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} />);
    await user.click(screen.getByRole('button', { name: 'More options' }));
    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
    expect(document.querySelector('.task-map-theme-dark')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'More options' }));
    await user.click(screen.getByRole('button', { name: '200% text' }));
    expect(document.querySelector('.task-map-zoom-200')).not.toBeNull();
  });

  it('exposes the current chat title as the chat switcher for a mounted hierarchy', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      agentSessionId: 'fresh-projection',
      paired: true,
      activeTask: { displayName: 'New task', lifecycle: 'running' },
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf_switch_1234567890' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} runtimeConfig={{
        localMode: true,
        paired: true,
        agentSessionId: 'old-projection',
        csrfToken: 'csrf_status_1234567890',
        candidateRoots: [
          { selectionHandle: 'a'.repeat(43), displayName: 'Old task', active: true },
          { selectionHandle: 'b'.repeat(43), displayName: 'New task', launchTarget: true },
        ],
      }} />);
      await user.click(screen.getByRole('button', { name: /Agent Farm Quick Chats · Current chat/i }));
      expect(screen.getByRole('dialog', { name: 'Switch chat' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /New task/i }));
      expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/api/v1/local/pairing/switch' }), expect.objectContaining({ method: 'POST' }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('switches from the refreshed cached catalog without a second discovery request', async () => {
    const user = userEvent.setup();
    const requests: Array<{ url: string; method: string }> = [];
    const currentChatHandle = '1'.repeat(64);
    const nextChatHandle = '2'.repeat(64);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      if (url.endsWith('/api/v1/local/status')) {
        return new Response(JSON.stringify({
          localMode: true,
          paired: true,
          csrfToken: 'csrf_status_fresh_1234567890',
          activeTask: { displayName: 'Current task', lifecycle: 'running' },
          candidateRoots: [
            { selectionHandle: 'a'.repeat(43), chatHandle: currentChatHandle, displayName: 'Current task', lifecycle: 'running', active: true },
            { selectionHandle: 'b'.repeat(43), chatHandle: nextChatHandle, displayName: 'Next task', lifecycle: 'running' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        agentSessionId: 'next-projection',
        paired: true,
        activeTask: { displayName: 'Next task', lifecycle: 'running' },
      }), { status: 200, headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf_switch_1234567890' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} runtimeConfig={{
        localMode: true,
        paired: true,
        agentSessionId: 'current-projection',
        csrfToken: 'csrf_status_1234567890',
        activeTask: { displayName: 'Current task', lifecycle: 'running' },
        candidateRoots: [
          { selectionHandle: 'c'.repeat(43), chatHandle: currentChatHandle, displayName: 'Current task', lifecycle: 'running', active: true },
          { selectionHandle: 'd'.repeat(43), chatHandle: nextChatHandle, displayName: 'Next task', lifecycle: 'running' },
        ],
      }} />);
      await user.click(screen.getByRole('button', { name: /Current task Quick Chats · Current chat/i }));
      await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/api/v1/local/status'))).toHaveLength(1));
      await user.click(screen.getByRole('button', { name: /Next task/i }));
      await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/api/v1/local/pairing/switch'))).toHaveLength(1));
      expect(requests.filter((request) => request.url.endsWith('/api/v1/local/status'))).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('prioritizes an immediate chat click before background catalog discovery', async () => {
    const user = userEvent.setup();
    const requests: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET' });
      return new Response(JSON.stringify({
        agentSessionId: 'next-projection',
        paired: true,
        activeTask: { displayName: 'Next task', lifecycle: 'running' },
      }), { status: 200, headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf_switch_1234567890' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} runtimeConfig={{
        localMode: true,
        paired: true,
        agentSessionId: 'current-projection',
        csrfToken: 'csrf_status_1234567890',
        activeTask: { displayName: 'Current task', lifecycle: 'running' },
        candidateRoots: [
          { selectionHandle: 'a'.repeat(43), displayName: 'Current task', active: true, bound: true },
          { selectionHandle: 'b'.repeat(43), displayName: 'Next task', bound: true },
        ],
      }} />);
      await user.click(screen.getByRole('button', { name: /Current task Quick Chats · Current chat/i }));
      await user.click(screen.getByRole('button', { name: /Next task/i }));
      await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/api/v1/local/pairing/switch'))).toHaveLength(1));
      expect(requests.filter((request) => request.url.endsWith('/api/v1/local/status'))).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
