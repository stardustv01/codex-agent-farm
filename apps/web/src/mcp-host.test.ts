import { describe, expect, it, vi } from 'vitest';
import { McpAdapter, StandaloneAdapter } from './adapters';
import {
  emptyAgentFarmSnapshot,
  createStandaloneRuntime,
  isMcpAppsHostEnvironment,
  McpAppsHostAdapter,
  parseAgentFarmToolResult,
} from './mcp-host';
import type { AgentHierarchyInput, AgentNode, McpBridgeMessage } from './types';

function pageNodes(start: number, end: number): AgentNode[] {
  return Array.from({ length: end - start }, (_, offset) => {
    const index = start + offset;
    return {
      id: index === 0 ? 'root' : `agent-${index}`,
      name: index === 0 ? 'Root' : `Agent ${index}`,
      parentId: index === 0 ? null : index === 1 ? 'root' : `agent-${index - 1}`,
      status: index === 0 ? 'running' : 'completed',
    };
  });
}

function pageEdges(start: number, end: number): Array<Record<string, unknown>> {
  const edges: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < Math.max(0, end - start); offset += 1) {
    const index = start + offset;
    if (index === 0) continue;
    edges.push({
      parentId: index === 1 ? 'root' : `agent-${index - 1}`,
      childId: `agent-${index}`,
      verified: true,
    });
  }
  return edges;
}

function hierarchyPage(start: number, end: number, nextCursor?: string, hasMore = false): AgentHierarchyInput {
  return {
    sessionId: 'paged-session',
    rootAgentId: 'root',
    nodes: pageNodes(start, end),
    edges: pageEdges(start, end),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    hasMore,
  } as unknown as AgentHierarchyInput;
}

function fakeMcpApp(callServerTool: (params: { name?: string; arguments?: Record<string, unknown> }) => Promise<unknown>, displayMode: 'inline' | 'fullscreen' = 'inline') {
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  const app = {
    addEventListener(type: string, handler: (value: unknown) => void) {
      const set = handlers.get(type) ?? new Set<(value: unknown) => void>();
      set.add(handler);
      handlers.set(type, set);
    },
    removeEventListener(type: string, handler: (value: unknown) => void) {
      handlers.get(type)?.delete(handler);
    },
    async connect() { return undefined; },
    async close() { return undefined; },
    getHostContext() { return { displayMode, availableDisplayModes: ['inline', 'fullscreen'] }; },
    callServerTool,
    requestDisplayMode: async () => ({ mode: 'fullscreen' }),
  };
  return { app, handlers };
}

describe('MCP Apps host integration helpers', () => {
  it('does not let a delayed live poll overwrite a newer explicit snapshot in the same session', async () => {
    vi.useFakeTimers();
    try {
      let releasePoll: ((value: AgentHierarchyInput) => void) | undefined;
      let snapshotCall = 0;
      const fetchSnapshot = vi.fn(async () => {
        snapshotCall += 1;
        if (snapshotCall === 1) return new Promise<AgentHierarchyInput>((resolve) => { releasePoll = resolve; });
        return { ...hierarchyPage(0, 2), sessionId: 'paged-session', watermark: 2 } as AgentHierarchyInput;
      });
      const adapter = new StandaloneAdapter({
        snapshot: { ...hierarchyPage(0, 1), sessionId: 'paged-session', watermark: 0 },
        fetchSnapshot,
        fetchRevision: async () => ({ agentSessionId: 'paged-session', revision: 1 }),
        revisionPollMs: 1_000,
      });
      const events: unknown[] = [];
      adapter.subscribe((event) => events.push(event));
      await vi.advanceTimersByTimeAsync(1_000);
      const explicit = await adapter.getSnapshot();
      expect(explicit.watermark).toBe(2);
      releasePoll?.({ ...hierarchyPage(0, 1), sessionId: 'paged-session', watermark: 1 });
      await Promise.resolve();
      expect((await adapter.getSnapshot()).watermark).toBe(2);
      expect(events).toHaveLength(0);
      adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes on the first newer revision, ignores stale revisions, and aborts on dispose', async () => {
    vi.useFakeTimers();
    try {
      let revision = 1;
      let watermark = 0;
      const fetchSnapshot = vi.fn(async () => hierarchyPage(0, 1) as AgentHierarchyInput & { watermark: number });
      fetchSnapshot.mockImplementation(async () => ({ ...hierarchyPage(0, 1), sessionId: 'paged-session', watermark }));
      const adapter = new StandaloneAdapter({
        snapshot: { ...hierarchyPage(0, 1), sessionId: 'paged-session', watermark: 0 },
        fetchSnapshot,
        fetchRevision: async (signal) => {
          if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
          return { agentSessionId: 'paged-session', revision };
        },
        revisionPollMs: 3_000,
      });
      const events: unknown[] = [];
      const unsubscribe = adapter.subscribe((event) => events.push(event));
      watermark = 1;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);
      revision = 1;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);
      adapter.dispose();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers structuredContent from the initial tool result', () => {
    const parsed = parseAgentFarmToolResult({
      content: [{ type: 'text', text: 'not the authoritative payload' }],
      structuredContent: {
        schemaVersion: 'agent-farm.v1',
        agentSessionId: 'session-1',
        nodes: [{ id: 'root', name: 'Root', status: 'running' }],
      },
    });
    expect(parsed).toMatchObject({ agentSessionId: 'session-1', nodes: [{ id: 'root' }] });
  });

  it('accepts a JSON text compatibility payload without treating arbitrary text as data', () => {
    expect(parseAgentFarmToolResult({ content: [{ type: 'text', text: JSON.stringify({ sessionId: 's', agents: [] }) }] })).toMatchObject({ sessionId: 's' });
    expect(parseAgentFarmToolResult({ content: [{ type: 'text', text: 'hello from host' }] })).toBeUndefined();
  });

  it('preserves an inline branch preview as bounded authoritative data', () => {
    const parsed = parseAgentFarmToolResult({
      structuredContent: {
        agentSessionId: 'preview-session',
        mode: 'inline',
        connectionState: 'connected',
        counts: { total: 225, active: 25, completed: 200, failed: 0, unverified: 0 },
        agents: [],
        branchPreview: [{ agentId: 'root', name: 'Preview root' }],
        hasMore: false,
      },
    });
    expect(parsed).toMatchObject({ agents: [{ agentId: 'root' }], sessionId: 'preview-session' });
  });

  it('preserves event payloads for live hierarchy updates', () => {
    expect(parseAgentFarmToolResult({ structuredContent: { type: 'watermark.changed', watermark: 12 } })).toMatchObject({ type: 'watermark.changed', watermark: 12 });
  });

  it('marks empty standalone state unverified instead of using the demo fixture', () => {
    const snapshot = emptyAgentFarmSnapshot('standalone');
    expect(snapshot.sourceAdapter).toBe('standalone');
    expect(snapshot.connection.state).toBe('unverified');
    expect(Object.keys(snapshot.agents)).toHaveLength(0);
  });

  it('preserves an orchestration budget through standalone normalization', () => {
    const snapshot = emptyAgentFarmSnapshot('standalone', 'local-session', { solHigh: 10, lunaMax: 10, solMax: 3 });
    expect(snapshot.orchestrationBudget).toEqual({ solHigh: 10, lunaMax: 10, solMax: 3 });
  });

  it('carries sanitized local pairing state through the standalone runtime', () => {
    const runtime = createStandaloneRuntime({
      localMode: true,
      paired: false,
      agentSessionId: 'local-session',
      candidateRoots: [{ selectionHandle: 'h'.repeat(43), displayName: 'Main Codex' }],
    });
    expect(runtime.config).toMatchObject({ localMode: true, paired: false });
    expect(runtime.config.candidateRoots).toEqual([{ selectionHandle: 'h'.repeat(43), displayName: 'Main Codex' }]);
  });

  it('uses the local agent-session hierarchy path and carries its budget into fetched data', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      sessionId: 'local-session',
      agents: [],
      connection: { state: 'connected' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const runtime = createStandaloneRuntime({
        apiBaseUrl: 'http://127.0.0.1:4210',
        agentSessionId: 'local-session',
        localMode: true,
        demo: true,
        orchestrationBudget: { solHigh: 10, lunaMax: 10, solMax: 3 },
      });
      expect(runtime.demo).toBe(false);
      expect(runtime.snapshot.orchestrationBudget).toEqual({ solHigh: 10, lunaMax: 10, solMax: 3 });
      const snapshot = await runtime.adapter.getSnapshot();
      const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(requestUrl.pathname).toBe('/api/v1/agent-sessions/local-session/hierarchy');
      expect(snapshot.orchestrationBudget).toEqual({ solHigh: 10, lunaMax: 10, solMax: 3 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps local hierarchy reads same-origin even when config injects a remote API origin', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      sessionId: 'local-session',
      agents: [],
      connection: { state: 'connected' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const runtime = createStandaloneRuntime({
        apiBaseUrl: 'https://evil.example',
        snapshotPath: '/api/v1/unsafe-snapshot',
        agentSessionId: 'as_test',
        localMode: true,
      });
      await runtime.adapter.getSnapshot();
      const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(requestUrl.origin).toBe(window.location.origin);
      expect(requestUrl.pathname).toBe('/api/v1/agent-sessions/as_test/hierarchy');
      expect(requestUrl.origin).not.toBe('https://evil.example');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not honor an injected snapshot path when local mode has no session ID', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const runtime = createStandaloneRuntime({
        apiBaseUrl: 'http://127.0.0.1:4210',
        snapshotPath: '/api/v1/unsafe-snapshot',
        localMode: true,
      });
      const snapshot = await runtime.adapter.getSnapshot();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(snapshot.connection.state).toBe('unverified');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('detects an iframe host but not the top-level standalone window', () => {
    const top = {} as Window;
    Object.defineProperty(top, 'parent', { value: top });
    expect(isMcpAppsHostEnvironment(top)).toBe(false);
    const parent = {} as Window;
    const child = { parent } as Window;
    expect(isMcpAppsHostEnvironment(child)).toBe(true);
  });

  it('aggregates a 225-node MCP Apps hierarchy across cursor pages without duplicate edges', async () => {
    const calls: Array<{ arguments?: Record<string, unknown> }> = [];
    const { app } = fakeMcpApp(async (params) => {
      calls.push(params);
      const cursor = params.arguments?.cursor;
      if (cursor === 'c1') return hierarchyPage(100, 200, 'c2', true);
      if (cursor === 'c2') return hierarchyPage(200, 225);
      return hierarchyPage(0, 100, 'c1', true);
    }, 'fullscreen');
    const adapter = new McpAppsHostAdapter(app as never, {} as never, { pageSize: 100 });
    await adapter.connect();
    const snapshot = await adapter.getSnapshot();
    expect(Object.keys(snapshot.agents)).toHaveLength(225);
    expect(snapshot.edges).toHaveLength(224);
    expect(new Set(snapshot.edges.map((edge) => `${edge.parentId}:${edge.childId}`)).size).toBe(224);
    expect(calls.map((call) => call.arguments?.cursor)).toEqual([undefined, 'c1', 'c2']);
    adapter.dispose();
  });

  it('stops safely on repeated cursors and marks the partial projection stale', async () => {
    const calls: Array<{ arguments?: Record<string, unknown> }> = [];
    const { app } = fakeMcpApp(async (params) => {
      calls.push(params);
      return hierarchyPage(0, 100, 'repeat', true);
    }, 'fullscreen');
    const adapter = new McpAppsHostAdapter(app as never, {} as never, { pageSize: 100 });
    await adapter.connect();
    const snapshot = await adapter.getSnapshot();
    expect(calls).toHaveLength(2);
    expect(Object.keys(snapshot.agents)).toHaveLength(100);
    expect(snapshot.connection.state).toBe('stale');
    adapter.dispose();
  });

  it('uses the inline render contract without fetching hierarchy pages', async () => {
    const calls: Array<{ name?: string; arguments?: Record<string, unknown> }> = [];
    const { app } = fakeMcpApp(async (params) => {
      calls.push(params);
      return {
        structuredContent: {
          agentSessionId: 'inline-session',
          mode: 'inline',
          connectionState: 'connected',
          rootAgentId: 'root',
          counts: { total: 225, active: 25, completed: 200, failed: 0, unverified: 0 },
          agents: [],
          edges: [],
          branchPreview: [
            { agentId: 'root', parentAgentId: null, name: 'Root', role: 'lead', lifecycle: 'active' },
            { agentId: 'child', parentAgentId: 'root', name: 'Child', role: 'worker', lifecycle: 'completed' },
          ],
          hasMore: true,
        },
      };
    });
    const adapter = new McpAppsHostAdapter(app as never, {} as never);
    await adapter.connect();
    const snapshot = await adapter.getSnapshot();
    expect(calls).toEqual([{ name: 'render_agent_hierarchy', arguments: { mode: 'inline' } }]);
    expect(Object.keys(snapshot.agents)).toHaveLength(2);
    expect(snapshot.counts?.total).toBe(225);
    expect(snapshot.connection.state).toBe('connected');
    adapter.dispose();
  });

  it('reloads the complete hierarchy after expanding an inline preview', async () => {
    const calls: Array<{ name?: string; arguments?: Record<string, unknown> }> = [];
    const { app } = fakeMcpApp(async (params) => {
      calls.push(params);
      if (params.name === 'render_agent_hierarchy') {
        return { structuredContent: { agentSessionId: 'expand-session', mode: 'inline', connectionState: 'connected', agents: [], branchPreview: [{ agentId: 'root', name: 'Root', lifecycle: 'active' }], hasMore: true } };
      }
      return hierarchyPage(0, 2);
    });
    const adapter = new McpAppsHostAdapter(app as never, {} as never);
    await adapter.connect();
    const inline = await adapter.getSnapshot();
    expect(Object.keys(inline.agents)).toHaveLength(1);
    expect(await adapter.requestFullscreen()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Object.keys((await adapter.getSnapshot()).agents)).toHaveLength(2);
    expect(calls.map((call) => call.name)).toEqual(['render_agent_hierarchy', 'get_agent_hierarchy']);
    adapter.dispose();
  });

  it('aggregates standalone fetch pages with a bounded cursor loop', async () => {
    const cursors: Array<string | undefined> = [];
    const adapter = new StandaloneAdapter({
      pageSize: 100,
      fetchSnapshot: async (_signal, page) => {
        cursors.push(page?.cursor);
        if (page?.cursor === 'c1') return hierarchyPage(100, 200, 'c2', true);
        if (page?.cursor === 'c2') return hierarchyPage(200, 225);
        return hierarchyPage(0, 100, 'c1', true);
      },
    });
    const snapshot = await adapter.getSnapshot();
    expect(Object.keys(snapshot.agents)).toHaveLength(225);
    expect(snapshot.edges).toHaveLength(224);
    expect(cursors).toEqual([undefined, 'c1', 'c2']);
  });

  it('supports the legacy page/pageSize standalone endpoint while retaining cursor bounds', async () => {
    const pages: number[] = [];
    const adapter = new StandaloneAdapter({
      pageSize: 100,
      fetchSnapshot: async (_signal, page) => {
        pages.push(page?.page ?? 0);
        const current = page?.page ?? 1;
        return { ...hierarchyPage((current - 1) * 100, Math.min(current * 100, 225), undefined, current < 3), page: current, pageSize: 100 } as AgentHierarchyInput;
      },
    });
    const snapshot = await adapter.getSnapshot();
    expect(Object.keys(snapshot.agents)).toHaveLength(225);
    expect(pages).toEqual([1, 2, 3]);
  });

  it('correlates legacy JSON-RPC responses by ID instead of first-pending order', async () => {
    let listener: ((message: McpBridgeMessage) => void) | undefined;
    const requests: Array<{ id: string }> = [];
    const bridge = {
      postMessage(message: unknown) {
        requests.push(message as { id: string });
      },
      subscribe(next: (message: McpBridgeMessage) => void) {
        listener = next;
        return () => { listener = undefined; };
      },
    };
    const adapter = new McpAdapter(bridge);
    const pending = adapter.getSnapshot();
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    listener?.({ id: 'stale-response', result: hierarchyPage(0, 1) });
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    listener?.({ id: requests[0]!.id, result: hierarchyPage(0, 1) });
    expect(Object.keys((await pending).agents)).toHaveLength(1);
    adapter.dispose();
  });
});
