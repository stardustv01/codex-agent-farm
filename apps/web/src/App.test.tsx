import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentFarmApp } from './App';
import { canonicalHierarchyFixture } from './fixtures';
import { emptyAgentFarmSnapshot } from './mcp-host';
import type { HostAdapter } from './types';

function adapterWithSnapshot(): HostAdapter {
  return { kind: 'test', mode: 'standalone', async getSnapshot() { return canonicalHierarchyFixture; }, subscribe() { return () => undefined; } };
}

describe('AgentFarmApp', () => {
  it('keeps inline mode bounded and offers only Expand for deep navigation', async () => {
    const onExpand = vi.fn();
    render(<AgentFarmApp mode="inline" snapshot={canonicalHierarchyFixture} onExpand={onExpand} />);
    expect(screen.getByRole('region', { name: 'Agent Farm summary' })).toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Open hierarchy/i }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('renders one hierarchy surface with semantic node buttons and contextual inspector', async () => {
    const user = userEvent.setup();
    render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} />);
    expect(screen.getByRole('region', { name: 'Agent Farm hierarchy' })).toBeInTheDocument();
    expect(screen.getByText('Hierarchy')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Rhea,/i }));
    expect(screen.getByRole('complementary', { name: /Inspector for Rhea/i })).toBeInTheDocument();
    const inspector = screen.getByRole('complementary', { name: /Inspector for Rhea/i });
    expect(within(inspector).getByRole('heading', { name: 'Children (1)' })).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: /Search agents/i }), 'Noether');
    expect(within(screen.getByRole('region', { name: 'Hierarchy' })).getByRole('button', { name: /Noether/i })).toBeInTheDocument();
  });

  it('does not leak a host subscription or adapter when unmounted', () => {
    const adapter = adapterWithSnapshot();
    const unsubscribe = vi.fn(); const dispose = vi.fn();
    adapter.subscribe = () => unsubscribe; adapter.dispose = dispose;
    const { unmount } = render(<AgentFarmApp adapter={adapter} />);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('defaults to a truthful empty task state without an injected snapshot', async () => {
    render(<AgentFarmApp mode="standalone" />);
    expect(await screen.findByRole('heading', { name: 'No active Codex task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Dirac')).not.toBeInTheDocument();
  });

  it('does not refresh the pre-pair adapter after choosing an ambiguous local task', async () => {
    const user = userEvent.setup();
    const getSnapshot = vi.fn(async () => emptyAgentFarmSnapshot('test', 'stale-session'));
    const adapter: HostAdapter = {
      kind: 'standalone',
      mode: 'standalone',
      getSnapshot,
      subscribe: () => () => undefined,
      dispose: vi.fn(),
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      agentSessionId: 'paired-session',
      paired: true,
      activeTask: { displayName: 'Beta task', lifecycle: 'running' },
    }), { status: 201, headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf_pair_1234567890' } })));
    try {
      render(<AgentFarmApp adapter={adapter} runtimeConfig={{
        localMode: true,
        paired: false,
        agentSessionId: 'local-session',
        csrfToken: 'csrf_status_1234567890',
        candidateRoots: [
          { selectionHandle: 'a'.repeat(43), displayName: 'Alpha task' },
          { selectionHandle: 'b'.repeat(43), displayName: 'Beta task' },
        ],
      }} />);
      await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('button', { name: /Alpha task/i }));
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Choose a task to open' })).not.toBeInTheDocument());
      expect(getSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rebuilds only a launcher-managed adapter after an ambiguous local selection', async () => {
    const user = userEvent.setup();
    const staleSnapshot = emptyAgentFarmSnapshot('test', 'stale-session');
    const pairedSnapshot = { ...canonicalHierarchyFixture, sessionId: 'paired-session' };
    const getSnapshot = vi.fn(async () => staleSnapshot);
    const adapter: HostAdapter = { kind: 'standalone', mode: 'standalone', getSnapshot, subscribe: () => () => undefined, dispose: vi.fn() };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/local/pairing/root')) return new Response(JSON.stringify({ agentSessionId: 'paired-session', paired: true, activeTask: { displayName: 'Beta task', lifecycle: 'running' } }), { status: 201, headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf_pair_1234567890' } });
      if (url.includes('/agent-sessions/paired-session/hierarchy')) return new Response(JSON.stringify(pairedSnapshot), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }));
    try {
      render(<AgentFarmApp adapter={adapter} managedAdapter runtimeConfig={{ localMode: true, paired: false, agentSessionId: 'local-session', csrfToken: 'csrf_status_1234567890', candidateRoots: [{ selectionHandle: 'a'.repeat(43), displayName: 'Alpha task' }, { selectionHandle: 'b'.repeat(43), displayName: 'Beta task' }] }} />);
      await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('button', { name: /Alpha task/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^Rhea,/i })).toBeInTheDocument());
      expect(getSnapshot).toHaveBeenCalledTimes(1);
      expect(adapter.dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('auto-mounts the trusted launch target when several tasks exist', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      agentSessionId: 'launched-session',
      paired: true,
      activeTask: { displayName: 'Launched task', lifecycle: 'running' },
    }), { status: 201, headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf_pair_1234567890' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<AgentFarmApp mode="standalone" runtimeConfig={{
        localMode: true,
        paired: false,
        agentSessionId: 'empty-session',
        csrfToken: 'csrf_status_1234567890',
        candidateRoots: [
          { selectionHandle: 'a'.repeat(43), displayName: 'Historical task' },
          { selectionHandle: 'b'.repeat(43), displayName: 'Launched task', launchTarget: true },
        ],
      }} />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ selectionHandle: 'b'.repeat(43) });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('auto-mounts the unique launch target under the production Strict Mode wrapper', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({
      agentSessionId: 'strict-launched-session',
      paired: true,
      activeTask: { displayName: 'Strict launched task', lifecycle: 'running' },
      }), { status: 201, headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf_pair_1234567890' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<StrictMode><AgentFarmApp mode="standalone" runtimeConfig={{
        localMode: true,
        paired: false,
        agentSessionId: 'strict-empty-session',
        csrfToken: 'csrf_status_1234567890',
        candidateRoots: [
          { selectionHandle: 'a'.repeat(43), displayName: 'Historical task' },
          { selectionHandle: 'b'.repeat(43), displayName: 'Strict launched task', launchTarget: true },
        ],
      }} /></StrictMode>);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({ selectionHandle: 'b'.repeat(43) });
      await waitFor(() => expect(screen.getByText('Strict launched task')).toBeInTheDocument());
      expect(screen.queryByRole('heading', { name: 'Choose a task to open' })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pauses launcher-focus polling while a manual first sync is pending', async () => {
    const user = userEvent.setup();
    let resolveSwitch!: (response: Response) => void;
    const switchResponse = new Promise<Response>((resolve) => { resolveSwitch = resolve; });
    let focusCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/local/pairing/switch')) return switchResponse;
      if (url.includes('/api/v1/local/focus')) {
        focusCalls += 1;
        return new Response(JSON.stringify({ focusVersion: 1, focusChangedAt: '2026-08-14T10:00:00.000Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/agent-sessions/next-session/hierarchy')) return new Response(JSON.stringify({ ...canonicalHierarchyFixture, sessionId: 'next-session' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<AgentFarmApp mode="standalone" snapshot={canonicalHierarchyFixture} runtimeConfig={{
        localMode: true,
        paired: true,
        agentSessionId: 'current-session',
        csrfToken: 'csrf_status_1234567890',
        focusVersion: 1,
        focusChangedAt: '2026-08-14T10:00:00.000Z',
        activeTask: { displayName: 'Current task' },
        candidateRoots: [
          { selectionHandle: 'a'.repeat(43), displayName: 'Current task', active: true, bound: true },
          { selectionHandle: 'b'.repeat(43), displayName: 'First sync task' },
        ],
      }} />);
      await waitFor(() => expect(focusCalls).toBeGreaterThan(0));
      await user.click(screen.getByRole('button', { name: /Current task/i }));
      await user.click(screen.getByRole('button', { name: /First sync task/i }));
      await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/local/pairing/switch'))).toBe(true));
      const callsWhenSelectionStarted = focusCalls;
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      expect(focusCalls).toBe(callsWhenSelectionStarted);
      resolveSwitch(new Response(JSON.stringify({ agentSessionId: 'next-session', paired: true, activeTask: { displayName: 'First sync task' } }), { status: 200, headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf_pair_1234567890' } }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switch chat' })).not.toBeInTheDocument());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('restores the verified chat when a background first sync rolls back', async () => {
    const empty = { ...emptyAgentFarmSnapshot('standalone'), sessionId: 'pending-session' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/local/focus')) {
        return new Response(JSON.stringify({ focusVersion: 1, focusChangedAt: '2026-08-14T10:00:00.000Z', agentSessionId: 'verified-session' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/v1/local/status')) {
        return new Response(JSON.stringify({
          localMode: true,
          agentSessionId: 'verified-session',
          paired: true,
          csrfToken: 'csrf_restored_1234567890',
          focusVersion: 1,
          focusChangedAt: '2026-08-14T10:00:00.000Z',
          activeTask: { displayName: 'Verified task', lifecycle: 'completed' },
          candidateRoots: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/agent-sessions/verified-session/hierarchy')) {
        return new Response(JSON.stringify({ ...canonicalHierarchyFixture, sessionId: 'verified-session' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<AgentFarmApp mode="standalone" snapshot={empty} runtimeConfig={{
        localMode: true,
        paired: true,
        syncing: true,
        agentSessionId: 'pending-session',
        csrfToken: 'csrf_pending_1234567890',
        focusVersion: 1,
        focusChangedAt: '2026-08-14T10:00:00.000Z',
        activeTask: { displayName: 'Pending task' },
      }} />);
      await waitFor(() => expect(screen.getByRole('button', { name: /Verified task.*Current chat/i })).toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole('button', { name: /^Root Chat,/i })).toBeInTheDocument());
      expect(screen.queryByRole('heading', { name: 'Syncing this chat' })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
