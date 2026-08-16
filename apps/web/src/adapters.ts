import { LocalAgentDetailSchema, PublicAgentIdSchema } from '@agent-farm/contracts';
import { normalizeOrchestrationBudget, normalizeSnapshot } from './normalize';
import {
  hasMorePages,
  isAgentEvent,
  isSafeCursor,
  MAX_HIERARCHY_PAGES,
  countHierarchyNodes,
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
  HostAdapter,
  HostEventListener,
  McpBridge,
  McpBridgeMessage,
  PresentationMode,
  StandaloneAdapterOptions,
  Unsubscribe,
} from './types';

function notify(listeners: Set<HostEventListener>, event: AgentEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // One observer cannot prevent the host from delivering to the others.
    }
  }
}

function paginationFrom(options: HierarchyPaginationOptions): Required<HierarchyPaginationOptions> {
  return normalizePaginationOptions(options);
}

function pageFrom(value: unknown): ParsedHierarchyPage | AgentEvent | undefined {
  const parsed = parseAgentFarmToolPage(value);
  if (!parsed || isAgentEvent(parsed)) return parsed;
  return parsed;
}

async function fetchAllPages(
  fetchPage: NonNullable<StandaloneAdapterOptions['fetchSnapshot']>,
  signal: AbortSignal | undefined,
  options: Required<HierarchyPaginationOptions>,
): Promise<AgentHierarchySnapshot> {
  const pages: AgentHierarchyInput[] = [];
  const seenCursors = new Set<string>();
  const seenPages = new Set<number>();
  let cursor: string | undefined;
  let pageNumber = 1;
  let incompleteReason: string | undefined;

  for (let pageIndex = 0; pageIndex < options.maxPages; pageIndex += 1) {
    if (signal?.aborted) throw new DOMException('The hierarchy request was aborted', 'AbortError');
    const raw = await fetchPage(signal, { limit: options.pageSize, page: pageNumber, ...(cursor === undefined ? {} : { cursor }) });
    const parsed = pageFrom(raw);
    if (!parsed || isAgentEvent(parsed)) {
      // A malformed page is still a host response. Keep any previously
      // accepted pages and mark the merged projection stale instead of
      // throwing an unrelated transport error or presenting a false complete
      // hierarchy. A host that claimed more data without a valid cursor gets
      // the same truthful reason as a well-formed page with that violation.
      const rawRecord = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : undefined;
      incompleteReason = rawRecord?.hasMore === true
        ? 'Host indicated more hierarchy data without a usable cursor'
        : 'Host returned a malformed hierarchy page';
      break;
    }
    pages.push(parsed.payload);
    if (countHierarchyNodes(pages) >= options.maxNodes && hasMorePages(parsed)) {
      incompleteReason = `Hierarchy node limit reached (${options.maxNodes})`;
      break;
    }
    const failure = paginationFailureReason(parsed, cursor, seenCursors);
    if (failure) {
      incompleteReason = failure;
      break;
    }
    if (!hasMorePages(parsed)) break;
    if (pageIndex + 1 >= options.maxPages) {
      incompleteReason = `Hierarchy page limit reached (${options.maxPages})`;
      break;
    }
    const nextCursor = parsed.nextCursor;
    if (!nextCursor && parsed.nextPage) {
      if (seenPages.has(parsed.nextPage) || parsed.nextPage <= pageNumber) {
        incompleteReason = 'Host repeated a hierarchy page';
        break;
      }
      seenPages.add(parsed.nextPage);
      pageNumber = parsed.nextPage;
      cursor = undefined;
      continue;
    }
    if (!nextCursor || !isSafeCursor(nextCursor)) {
      incompleteReason = 'Host returned an invalid hierarchy cursor';
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    pageNumber += 1;
  }

  return normalizeSnapshot(mergeHierarchyPages(pages, { maxNodes: options.maxNodes, ...(incompleteReason === undefined ? {} : { incompleteReason }) }));
}

export class StandaloneAdapter implements HostAdapter {
  readonly kind = 'standalone' as const;
  readonly mode: PresentationMode;
  private snapshot: AgentHierarchySnapshot;
  private readonly listeners = new Set<HostEventListener>();
  private readonly fetchSnapshot?: StandaloneAdapterOptions['fetchSnapshot'];
  private readonly fetchLocalDetail?: StandaloneAdapterOptions['fetchLocalDetail'];
  private readonly fetchRevision?: StandaloneAdapterOptions['fetchRevision'];
  private readonly orchestrationBudget?: StandaloneAdapterOptions['orchestrationBudget'];
  private readonly pagination: Required<HierarchyPaginationOptions>;
  private readonly revisionPollMs: number;
  private revisionTimer: ReturnType<typeof setTimeout> | undefined;
  private liveAbort: AbortController | undefined;
  private revisionRequest: Promise<void> | undefined;
  private revisionBaseline: { sessionId: string; revision: number } | undefined;
  private disposed = false;
  private generation = 0;

  constructor(options: StandaloneAdapterOptions = {}) {
    this.mode = options.mode ?? 'standalone';
    this.snapshot = normalizeSnapshot(options.snapshot ?? {});
    this.fetchSnapshot = options.fetchSnapshot;
    this.fetchLocalDetail = options.fetchLocalDetail;
    this.fetchRevision = options.fetchRevision;
    // The adapter is exported and may be constructed outside the launcher.
    // Revalidate at this final overlay boundary instead of trusting a
    // compile-time type assertion to preserve the strict public-v1 contract.
    this.orchestrationBudget = normalizeOrchestrationBudget(options.orchestrationBudget);
    this.pagination = paginationFrom(options);
    this.revisionPollMs = Math.max(1_000, Math.min(options.revisionPollMs ?? 3_000, 7_000));
  }

  private applySnapshot(snapshot: AgentHierarchyInput | AgentHierarchySnapshot, fallbackRevision?: number): void {
    const normalized = normalizeSnapshot(snapshot);
    this.snapshot = normalized.orchestrationBudget === undefined && this.orchestrationBudget !== undefined
      ? { ...normalized, orchestrationBudget: this.orchestrationBudget }
      : normalized;
    if (typeof this.snapshot.watermark === 'number' && Number.isSafeInteger(this.snapshot.watermark) && this.snapshot.watermark >= 0) {
      this.revisionBaseline = { sessionId: this.snapshot.sessionId, revision: this.snapshot.watermark };
    } else if (fallbackRevision !== undefined) {
      this.revisionBaseline = { sessionId: this.snapshot.sessionId, revision: fallbackRevision };
    } else {
      this.revisionBaseline = undefined;
    }
  }

  async getSnapshot(signal?: AbortSignal): Promise<AgentHierarchySnapshot> {
    if (this.disposed) throw new Error('Standalone adapter is disposed');
    const generation = ++this.generation;
    if (this.fetchSnapshot) {
      const fetched = await fetchAllPages(this.fetchSnapshot, signal, this.pagination);
      // An explicit refresh/switch is authoritative over any older request for
      // the same public session. Return the latest accepted snapshot to stale
      // callers so they cannot dispatch their older response into the reducer.
      if (this.disposed || generation !== this.generation) return this.snapshot;
      this.applySnapshot(fetched);
    } else if (generation === this.generation) {
      this.applySnapshot(this.snapshot);
    }
    return this.snapshot;
  }

  async getLocalAgentDetail(agentId: string, signal?: AbortSignal) {
    if (!this.fetchLocalDetail) return undefined;
    const canonicalId = PublicAgentIdSchema.safeParse(agentId);
    if (!canonicalId.success) return undefined;
    const raw = await this.fetchLocalDetail(canonicalId.data, signal);
    const parsed = LocalAgentDetailSchema.safeParse(raw);
    if (!parsed.success || parsed.data.agent.agentId !== canonicalId.data) return undefined;
    const projectedSessionId = this.snapshot.sessionId;
    if (projectedSessionId && parsed.data.agentSessionId !== projectedSessionId) return undefined;
    return parsed.data;
  }

  subscribe(listener: HostEventListener): Unsubscribe {
    this.listeners.add(listener);
    this.startRevisionPolling();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopRevisionPolling();
    };
  }

  requestFullscreen(): boolean {
    return false;
  }

  emit(event: AgentEvent): void {
    if (event.type === 'snapshot' && event.snapshot) {
      this.generation += 1;
      this.applySnapshot(event.snapshot);
    }
    notify(this.listeners, event);
  }

  setSnapshot(snapshot: AgentHierarchyInput | AgentHierarchySnapshot): void {
    this.emit({ type: 'snapshot', snapshot });
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.stopRevisionPolling();
    this.listeners.clear();
  }

  private startRevisionPolling(): void {
    if (!this.fetchRevision || this.disposed || this.revisionTimer !== undefined || this.revisionRequest !== undefined) return;
    this.revisionTimer = setTimeout(() => {
      this.revisionTimer = undefined;
      void this.pollRevision();
    }, this.revisionPollMs);
  }

  private stopRevisionPolling(): void {
    if (this.revisionTimer !== undefined) clearTimeout(this.revisionTimer);
    this.revisionTimer = undefined;
    this.liveAbort?.abort();
    this.liveAbort = undefined;
  }

  private async pollRevision(): Promise<void> {
    if (!this.fetchRevision || this.revisionRequest || this.disposed || this.listeners.size === 0) return;
    const generation = this.generation;
    const abort = new AbortController();
    this.liveAbort = abort;
    const task = (async (): Promise<void> => {
      const incoming = await this.fetchRevision!(abort.signal);
      if (abort.signal.aborted || this.disposed || generation !== this.generation) return;
      const baseline = this.revisionBaseline;
      if (baseline?.sessionId !== incoming.agentSessionId) {
        if (this.snapshot.sessionId === incoming.agentSessionId && typeof this.snapshot.watermark === 'number' && incoming.revision > this.snapshot.watermark && this.fetchSnapshot) {
          const fetched = await fetchAllPages(this.fetchSnapshot, abort.signal, this.pagination);
          if (abort.signal.aborted || this.disposed || generation !== this.generation || fetched.sessionId !== incoming.agentSessionId) return;
          if (typeof fetched.watermark === 'number' && fetched.watermark < incoming.revision) return;
          this.applySnapshot(fetched, incoming.revision);
          notify(this.listeners, { type: 'snapshot', snapshot: this.snapshot });
          return;
        }
        this.revisionBaseline = { sessionId: incoming.agentSessionId, revision: incoming.revision };
        return;
      }
      if (incoming.revision <= baseline.revision || !this.fetchSnapshot) return;
      const fetched = await fetchAllPages(this.fetchSnapshot, abort.signal, this.pagination);
      if (abort.signal.aborted || this.disposed || generation !== this.generation || fetched.sessionId !== incoming.agentSessionId) return;
      if (typeof fetched.watermark === 'number' && fetched.watermark < incoming.revision) return;
      this.applySnapshot(fetched, incoming.revision);
      notify(this.listeners, { type: 'snapshot', snapshot: this.snapshot });
    })().catch(() => undefined).finally(() => {
      if (this.revisionRequest === task) this.revisionRequest = undefined;
      if (this.liveAbort === abort) this.liveAbort = undefined;
      this.startRevisionPolling();
    });
    this.revisionRequest = task;
    await task;
  }
}

interface PendingRequest {
  readonly id: string;
  resolve: (value: ParsedHierarchyPage) => void;
  reject: (reason?: unknown) => void;
}

function messageKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function errorFromMessage(message: McpBridgeMessage): Error {
  if (message.error instanceof Error) return message.error;
  if (typeof message.error === 'string') return new Error(message.error);
  if (message.error && typeof message.error === 'object' && typeof (message.error as Record<string, unknown>).message === 'string') {
    return new Error((message.error as Record<string, unknown>).message as string);
  }
  return new Error('Agent Farm host returned an invalid hierarchy response');
}

/** JSON-RPC bridge adapter. The MCP host and standalone app share reducer input. */
export class McpAdapter implements HostAdapter {
  readonly kind = 'mcp' as const;
  readonly mode: PresentationMode = 'inline';
  private readonly listeners = new Set<HostEventListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly bridge: McpBridge;
  private readonly removeBridgeListener: Unsubscribe;
  private readonly pagination: Required<HierarchyPaginationOptions>;
  private disposed = false;
  private requestSequence = 0;

  constructor(bridge: McpBridge, options: HierarchyPaginationOptions = {}) {
    this.bridge = bridge;
    this.pagination = paginationFrom(options);
    this.removeBridgeListener = bridge.subscribe((message) => this.handleMessage(message));
  }

  async getSnapshot(signal?: AbortSignal): Promise<AgentHierarchySnapshot> {
    if (this.disposed) throw new Error('MCP adapter is disposed');
    const pages: AgentHierarchyInput[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let incompleteReason: string | undefined;

    for (let pageIndex = 0; pageIndex < this.pagination.maxPages; pageIndex += 1) {
      const page = await this.requestPage(cursor, signal);
      pages.push(page.payload);
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
    }
    return normalizeSnapshot(mergeHierarchyPages(pages, { maxNodes: this.pagination.maxNodes, ...(incompleteReason === undefined ? {} : { incompleteReason }) }));
  }

  subscribe(listener: HostEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  requestFullscreen(): Promise<boolean> | boolean {
    return this.bridge.requestFullscreen?.() ?? false;
  }

  private nextId(): string {
    this.requestSequence += 1;
    return `agent-farm-${Date.now()}-${this.requestSequence}-${Math.random().toString(16).slice(2)}`;
  }

  private requestPage(cursor: string | undefined, signal?: AbortSignal): Promise<ParsedHierarchyPage> {
    if (signal?.aborted) return Promise.reject(new DOMException('The hierarchy request was aborted', 'AbortError'));
    const id = this.nextId();
    const key = messageKey(id);
    return new Promise<ParsedHierarchyPage>((resolve, reject) => {
      let settled = false;
      const cleanupAbort = (): void => signal?.removeEventListener('abort', onAbort);
      const timeout = globalThis.setTimeout(() => {
        if (settled || !this.pending.delete(key)) return;
        settled = true;
        cleanupAbort();
        reject(new Error('Agent Farm host did not return a hierarchy snapshot'));
      }, 10_000);
      const onAbort = (): void => {
        if (settled || !this.pending.delete(key)) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        cleanupAbort();
        reject(new DOMException('The hierarchy request was aborted', 'AbortError'));
      };
      const pending: PendingRequest = {
        id,
        resolve: (value) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeout);
          cleanupAbort();
          resolve(value);
        },
        reject: (reason) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeout);
          cleanupAbort();
          reject(reason);
        },
      };
      this.pending.set(key, pending);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const args = { limit: this.pagination.pageSize, ...(cursor === undefined ? {} : { cursor }) };
        this.bridge.postMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_agent_hierarchy', arguments: args } });
      } catch (error) {
        this.pending.delete(key);
        pending.reject(error);
      }
    });
  }

  private handleMessage(message: McpBridgeMessage): void {
    // JSON-RPC responses are correlated strictly by their response ID. A
    // stale response must never satisfy the first pending request by order.
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pending.get(messageKey(message.id));
      if (!pending) return;
      this.pending.delete(messageKey(message.id));
      if (message.error !== undefined) {
        pending.reject(errorFromMessage(message));
        return;
      }
      const parsed = pageFrom(message.result);
      if (!parsed || isAgentEvent(parsed)) {
        pending.reject(new Error('Agent Farm host returned no hierarchy data'));
        return;
      }
      pending.resolve(parsed);
      return;
    }

    // Notifications have no request ID and are therefore observable events,
    // never responses for a pending call.
    const parsed = pageFrom(message.params ?? message.result);
    if (!parsed) return;
    if (isAgentEvent(parsed)) notify(this.listeners, parsed);
    else notify(this.listeners, { type: 'snapshot', snapshot: parsed.payload });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeBridgeListener();
    for (const pending of this.pending.values()) pending.reject(new Error('MCP adapter disposed'));
    this.pending.clear();
    this.listeners.clear();
  }
}

export const createStandaloneAdapter = (options: StandaloneAdapterOptions = {}): StandaloneAdapter => new StandaloneAdapter(options);
export const createMcpAdapter = (bridge: McpBridge, options: HierarchyPaginationOptions = {}): McpAdapter => new McpAdapter(bridge, options);

// Keep the old name available for consumers that imported this constant from
// an adapter module while making the actual bound explicit to reviewers.
export { MAX_HIERARCHY_PAGES };
