import {
  App,
  PostMessageTransport,
  type McpUiDisplayMode,
  type McpUiHostContext,
  type McpUiToolResultNotification,
} from '@modelcontextprotocol/ext-apps';
import { StandaloneAdapter } from './adapters';
import { canonicalHierarchyFixture } from './fixtures';
import { normalizeOrchestrationBudget, normalizeSnapshot } from './normalize';
import { isSafeSessionId, safeRuntimeConfig } from './standalone-bootstrap';
import {
  countHierarchyNodes,
  hasMorePages,
  isAgentEvent,
  isSafeCursor,
  mergeHierarchyPages,
  normalizePaginationOptions,
  paginationFailureReason,
  parseAgentFarmToolPage,
  type HierarchyPaginationOptions,
  type ParsedHierarchyPage,
} from './pagination';
import type {
  AgentEvent,
  AgentHierarchyInput,
  AgentHierarchySnapshot,
  AgentFarmRuntimeConfig,
  HostAdapter,
  HostEventListener,
  OrchestrationBudget,
  PresentationMode,
  StandaloneAdapterOptions,
  Unsubscribe,
} from './types';

export { parseAgentFarmToolResult } from './pagination';

/**
 * Empty state used until a real MCP tool result or standalone API response is
 * available. It is intentionally not the demo fixture: a production failure
 * must be visible as an unverified projection instead of looking live.
 */
export function emptyAgentFarmSnapshot(
  sourceAdapter: string,
  sessionId = `${sourceAdapter}-session`,
  orchestrationBudget?: OrchestrationBudget,
): AgentHierarchySnapshot {
  return normalizeSnapshot({
    schemaVersion: 'agent-farm.v1',
    sessionId,
    agents: [],
    connection: { state: 'unverified', label: 'Awaiting hierarchy data' },
    sourceAdapter,
    ...(orchestrationBudget === undefined ? {} : { orchestrationBudget }),
  });
}

function modeFromHost(mode: unknown): PresentationMode {
  return mode === 'fullscreen' ? 'fullscreen' : mode === 'standalone' ? 'standalone' : 'inline';
}

function safeHostContext(app: App): McpUiHostContext | undefined {
  try {
    return app.getHostContext();
  } catch {
    return undefined;
  }
}

function isMcpDisplayMode(value: unknown): value is McpUiDisplayMode {
  return value === 'inline' || value === 'fullscreen' || value === 'pip';
}

/**
 * Adapter around the official MCP Apps `App` + `PostMessageTransport` APIs.
 * The view never talks to a raw postMessage channel and never carries an
 * access token in a URL.
 */
export class McpAppsHostAdapter implements HostAdapter {
  readonly kind = 'mcp' as const;
  mode: PresentationMode = 'inline';

  private readonly app: App;
  private readonly transport: PostMessageTransport;
  private readonly listeners = new Set<HostEventListener>();
  private readonly pagination: Required<HierarchyPaginationOptions>;
  private initialSnapshot: AgentHierarchySnapshot | undefined;
  private snapshotPromise: Promise<AgentHierarchySnapshot> | undefined;
  private inlineSnapshot = false;
  private loadingInline = false;
  private disposed = false;
  private connected = false;
  private readonly onToolResult = (result: McpUiToolResultNotification['params']): void => {
    const parsed = parseAgentFarmToolPage(result);
    if (!parsed) {
      if (result.isError) this.notify({ type: 'connection.changed', connection: { state: 'error', label: 'Hierarchy tool failed' } });
      return;
    }
    if (isAgentEvent(parsed)) {
      this.notify(parsed);
      if (parsed.type === 'snapshot' && parsed.snapshot) this.initialSnapshot = normalizeSnapshot(parsed.snapshot);
      return;
    }
    this.startSnapshotLoad(parsed);
  };
  private readonly onHostContextChanged = (context: McpUiHostContext): void => {
    const nextMode = modeFromHost(context.displayMode);
    if (nextMode !== 'inline' || this.mode === 'inline') this.mode = nextMode;
    this.notify({
      type: 'connection.changed',
      connection: { state: 'connected', label: 'MCP host connected' },
    });
  };

  constructor(app: App, transport: PostMessageTransport, options: HierarchyPaginationOptions = {}) {
    this.app = app;
    this.transport = transport;
    this.pagination = normalizePaginationOptions(options);
    // These listeners are registered before connect() because the host can
    // deliver the initial tool result immediately after initialization.
    this.app.addEventListener('toolresult', this.onToolResult);
    this.app.addEventListener('hostcontextchanged', this.onHostContextChanged);
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error('MCP Apps adapter is disposed');
    if (this.connected) return;
    await this.app.connect(this.transport);
    this.connected = true;
    const context = safeHostContext(this.app);
    if (context?.displayMode) this.mode = modeFromHost(context.displayMode);
    this.notify({ type: 'connection.changed', connection: { state: 'connected', label: 'MCP host connected' } });
  }

  async getSnapshot(): Promise<AgentHierarchySnapshot> {
    if (this.disposed) throw new Error('MCP Apps adapter is disposed');
    if (!this.connected) throw new Error('MCP Apps adapter is not connected');
    if (this.initialSnapshot) return this.initialSnapshot;
    if (!this.snapshotPromise) this.startSnapshotLoad();
    return await this.snapshotPromise!;
  }

  subscribe(listener: HostEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async requestFullscreen(): Promise<boolean> {
    if (this.disposed || !this.connected) return false;
    const context = safeHostContext(this.app);
    const available = context?.availableDisplayModes;
    if (available && !available.includes('fullscreen')) return false;
    try {
      const result = await this.app.requestDisplayMode({ mode: 'fullscreen' });
      if (isMcpDisplayMode(result.mode)) this.mode = modeFromHost(result.mode);
      if (result.mode === 'fullscreen' && (this.inlineSnapshot || this.loadingInline)) {
        const refresh = (): void => {
          if (this.disposed || this.mode !== 'fullscreen' || !this.inlineSnapshot) return;
          this.initialSnapshot = undefined;
          this.inlineSnapshot = false;
          this.snapshotPromise = undefined;
          this.startSnapshotLoad();
        };
        if (this.snapshotPromise) {
          void this.snapshotPromise.then(() => {
            if (this.loadingInline) this.inlineSnapshot = true;
            refresh();
          }).catch(() => undefined);
        }
        else refresh();
      }
      return result.mode === 'fullscreen';
    } catch {
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.app.removeEventListener('toolresult', this.onToolResult);
    this.app.removeEventListener('hostcontextchanged', this.onHostContextChanged);
    this.snapshotPromise = undefined;
    this.listeners.clear();
    void this.app.close();
  }

  private startSnapshotLoad(firstPage?: ParsedHierarchyPage): void {
    if (this.disposed || this.initialSnapshot || this.snapshotPromise) return;
    const promise = this.loadSnapshot(firstPage);
    this.snapshotPromise = promise;
    this.loadingInline = this.mode === 'inline' || firstPage?.presentationMode === 'inline' || firstPage?.boundedPreview === true;
    void promise.then((snapshot) => {
      if (this.disposed) return;
      this.initialSnapshot = snapshot;
      this.inlineSnapshot = this.loadingInline;
      this.notify({ type: 'snapshot', snapshot });
    }).catch((error: unknown) => {
      if (!this.disposed) this.notify({ type: 'connection.changed', connection: { state: 'error', label: error instanceof Error ? error.message : 'Hierarchy tool failed' } });
    }).finally(() => {
      if (this.snapshotPromise === promise) this.snapshotPromise = undefined;
    });
  }

  private async loadSnapshot(firstPage?: ParsedHierarchyPage): Promise<AgentHierarchySnapshot> {
    const pages: AgentHierarchyInput[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let page: ParsedHierarchyPage | undefined = firstPage;
    let incompleteReason: string | undefined;
    const inline = this.mode === 'inline' || firstPage?.presentationMode === 'inline' || firstPage?.boundedPreview === true;

    for (let pageIndex = 0; pageIndex < this.pagination.maxPages; pageIndex += 1) {
      if (!page) {
        const result = await this.app.callServerTool({
          name: inline ? 'render_agent_hierarchy' : 'get_agent_hierarchy',
          arguments: inline ? { mode: 'inline' } : { limit: this.pagination.pageSize },
        });
        if (result.isError) throw new Error('The hierarchy tool returned an error');
        const parsed = parseAgentFarmToolPage(result);
        if (!parsed || isAgentEvent(parsed)) throw new Error('The hierarchy tool returned no hierarchy data');
        page = parsed;
      }
      pages.push(page.payload);
      // Inline render output is an authoritative bounded branch preview. It
      // must never trigger a full hierarchy read merely because it advertises
      // that more nodes exist for the fullscreen view.
      if (inline) break;
      if (countHierarchyNodes(pages) >= this.pagination.maxNodes && hasMorePages(page)) {
        incompleteReason = `Hierarchy node limit reached (${this.pagination.maxNodes})`;
        break;
      }
      const failure = paginationFailureReason(page, cursor, seenCursors);
      if (failure) {
        incompleteReason = failure;
        break;
      }
      if (!hasMorePages(page)) break;
      if (pageIndex + 1 >= this.pagination.maxPages) {
        incompleteReason = `Hierarchy page limit reached (${this.pagination.maxPages})`;
        break;
      }
      const nextCursor = page.nextCursor;
      if (!nextCursor || !isSafeCursor(nextCursor)) {
        incompleteReason = 'Host returned an invalid hierarchy cursor';
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      const result = await this.app.callServerTool({
        name: 'get_agent_hierarchy',
        arguments: { cursor: nextCursor, limit: this.pagination.pageSize },
      });
      if (result.isError) throw new Error('The hierarchy tool returned an error');
      const parsed = parseAgentFarmToolPage(result);
      if (!parsed || isAgentEvent(parsed)) throw new Error('The hierarchy tool returned no hierarchy data');
      page = parsed;
    }
    return normalizeSnapshot(mergeHierarchyPages(pages, { maxNodes: this.pagination.maxNodes, ...(incompleteReason === undefined ? {} : { incompleteReason }) }));
  }

  private notify(event: AgentEvent): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One observer cannot prevent other observers from receiving events.
      }
    }
  }
}

export interface McpAppsConnectOptions {
  app?: App;
  transport?: PostMessageTransport;
  timeoutMs?: number;
  pageSize?: number;
  maxPages?: number;
  maxNodes?: number;
}

/** Connect the web view to its MCP Apps host through the SDK transport. */
export async function connectMcpAppsHost(options: McpAppsConnectOptions = {}): Promise<McpAppsHostAdapter> {
  const app = options.app ?? new App(
    { name: 'Agent Farm', version: '0.1.0' },
    { availableDisplayModes: ['inline', 'fullscreen'] },
    { autoResize: true },
  );
  const transport = options.transport ?? new PostMessageTransport(window.parent, window.parent);
  const adapter = new McpAppsHostAdapter(app, transport, options);
  const timeoutMs = Math.max(500, options.timeoutMs ?? 8_000);
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    await Promise.race([
      adapter.connect(),
      new Promise<never>((_, reject) => {
        timer = globalThis.setTimeout(() => reject(new Error('MCP Apps host handshake timed out')), timeoutMs);
      }),
    ]);
    return adapter;
  } catch (error) {
    adapter.dispose();
    throw error;
  } finally {
    if (timer) globalThis.clearTimeout(timer);
  }
}

/** Detect an MCP Apps iframe without assuming a particular host brand. */
export function isMcpAppsHostEnvironment(win: Window = window): boolean {
  if (win === undefined) return false;
  if (win.document?.documentElement?.dataset.mcpAppsHost === 'true') return true;
  return win.parent !== win;
}

function readRuntimeConfig(): AgentFarmRuntimeConfig {
  const configured = (globalThis as typeof globalThis & { __AGENT_FARM_CONFIG__?: AgentFarmRuntimeConfig }).__AGENT_FARM_CONFIG__;
  return configured && typeof configured === 'object' ? { ...configured } : {};
}

function isViteDevelopment(): boolean {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  return env?.DEV === true || env?.MODE === 'development';
}

function apiSnapshotOptions(config: AgentFarmRuntimeConfig): StandaloneAdapterOptions['fetchSnapshot'] | undefined {
  const agentSessionId = isSafeSessionId(config.agentSessionId) ? config.agentSessionId : undefined;
  // Local mode may only read the server-issued agent session route. Without a
  // public session identifier, stay unverified instead of honoring an
  // injected snapshot path or falling back to the current-session endpoint.
  if (config.localMode === true && !agentSessionId) return undefined;
  if (!config.apiBaseUrl && !config.snapshotPath && !agentSessionId) return undefined;
  return async (signal?: AbortSignal, page?: { readonly cursor?: string; readonly page?: number; readonly limit: number }): Promise<AgentHierarchyInput> => {
    const path = config.localMode === true && agentSessionId
      ? `/api/v1/agent-sessions/${encodeURIComponent(agentSessionId)}/hierarchy`
      : config.snapshotPath ?? (agentSessionId
        ? `/api/v1/agent-sessions/${encodeURIComponent(agentSessionId)}/hierarchy`
        : '/api/v1/agent-sessions/current/hierarchy');
    // Local mode is same-origin by contract. Ignore injected API origins and
    // snapshot paths so an agent session ID cannot be sent cross-origin.
    const base = config.localMode === true ? window.location.origin : config.apiBaseUrl ?? window.location.origin;
    const url = new URL(path, base);
    if (page?.cursor) url.searchParams.set('cursor', page.cursor);
    if (page?.page !== undefined) url.searchParams.set('page', String(page.page));
    if (page?.limit !== undefined) {
      url.searchParams.set('limit', String(page.limit));
      url.searchParams.set('pageSize', String(page.limit));
    }
    const credentialQuery = [...url.searchParams.keys()].some((key) => /token|secret|password|credential|authorization|api[-_]?key/i.test(key));
    if (url.username || url.password || credentialQuery) throw new Error('Token-bearing hierarchy URL rejected');
    const init: RequestInit = {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    };
    if (signal) init.signal = signal;
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`Hierarchy API returned HTTP ${response.status}`);
    const payload = await response.json() as AgentHierarchyInput;
    // Keep strict public-v1 pages byte-for-byte valid. The launcher-owned
    // advisory budget is overlaid by StandaloneAdapter only after page
    // validation, so it can never become an unknown public-v1 field.
    return payload;
  };
}

function apiLocalDetailOptions(config: AgentFarmRuntimeConfig): StandaloneAdapterOptions['fetchLocalDetail'] | undefined {
  const agentSessionId = isSafeSessionId(config.agentSessionId) ? config.agentSessionId : undefined;
  if (config.localMode !== true || !agentSessionId) return undefined;
  return async (agentId, signal) => {
    if (!/^agent:[a-f0-9]{40}$/u.test(agentId)) return undefined;
    const path = `/api/v1/local/sessions/${encodeURIComponent(agentSessionId)}/agents/${encodeURIComponent(agentId)}/details`;
    const url = new URL(path, window.location.origin);
    const init: RequestInit = { method: 'GET', credentials: 'include', headers: { accept: 'application/json' } };
    if (signal) init.signal = signal;
    const response = await fetch(url, init);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Local details API returned HTTP ${response.status}`);
    return response.json();
  };
}

function apiRevisionOptions(config: AgentFarmRuntimeConfig): StandaloneAdapterOptions['fetchRevision'] | undefined {
  const agentSessionId = isSafeSessionId(config.agentSessionId) ? config.agentSessionId : undefined;
  if (config.localMode !== true || !agentSessionId) return undefined;
  return async (signal) => {
    const url = new URL(`/api/v1/agent-sessions/${encodeURIComponent(agentSessionId)}/hierarchy/revision`, window.location.origin);
    const response = await fetch(url, { method: 'GET', credentials: 'include', headers: { accept: 'application/json' }, ...(signal === undefined ? {} : { signal }) });
    if (!response.ok) throw new Error(`Hierarchy revision API returned HTTP ${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    if (value.agentSessionId !== agentSessionId || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new Error('Hierarchy revision API returned invalid data');
    return { agentSessionId, revision: value.revision as number };
  };
}

export interface StandaloneRuntime {
  adapter: StandaloneAdapter;
  snapshot: AgentHierarchySnapshot;
  demo: boolean;
  config: AgentFarmRuntimeConfig;
}

/**
 * Configure the standalone view from an in-memory global or same-origin API.
 * No config is read from localStorage and no token is accepted in a URL.
 */
export function createStandaloneRuntime(config: AgentFarmRuntimeConfig = readRuntimeConfig()): StandaloneRuntime {
  const safeConfig = safeRuntimeConfig(config);
  const demo = !safeConfig.localMode && isViteDevelopment() && (safeConfig.demo === true || new URLSearchParams(window.location.search).get('demo') === '1');
  const snapshot = demo
    ? canonicalHierarchyFixture
    : emptyAgentFarmSnapshot('standalone', safeConfig.agentSessionId ?? 'standalone-session', safeConfig.orchestrationBudget);
  const options: StandaloneAdapterOptions = {
    snapshot,
    mode: 'standalone',
    ...(safeConfig.orchestrationBudget === undefined ? {} : { orchestrationBudget: safeConfig.orchestrationBudget }),
  };
  const fetchSnapshot = apiSnapshotOptions(safeConfig);
  if (fetchSnapshot) options.fetchSnapshot = fetchSnapshot;
  const fetchLocalDetail = apiLocalDetailOptions(safeConfig);
  if (fetchLocalDetail) options.fetchLocalDetail = fetchLocalDetail;
  const fetchRevision = apiRevisionOptions(safeConfig);
  if (fetchRevision) options.fetchRevision = fetchRevision;
  const adapter = new StandaloneAdapter(options);
  return { adapter, snapshot, demo, config: safeConfig };
}
