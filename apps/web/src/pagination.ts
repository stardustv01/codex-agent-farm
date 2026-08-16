import type {
  AgentEvent,
  AgentHierarchyInput,
  AgentHierarchySnapshot,
  PresentationMode,
} from './types';
import { PublicHierarchyPageSchema, type PublicHierarchyPage } from '@agent-farm/contracts';

/**
 * Pagination is deliberately bounded at the view boundary.  The MCP
 * contract currently allows a page of up to 200 agents; keeping a smaller
 * page is not required for correctness, while these caps prevent a hostile
 * or malfunctioning host from making the view unbounded.
 */
export const DEFAULT_HIERARCHY_PAGE_SIZE = 200;
export const MAX_HIERARCHY_PAGES = 32;
export const MAX_HIERARCHY_NODES = 1_000;
export const MAX_HIERARCHY_EDGES = 2_000;
export const MAX_CURSOR_LENGTH = 256;

export interface HierarchyPaginationOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxNodes?: number;
}

export interface ParsedHierarchyPage {
  readonly payload: AgentHierarchyInput | AgentHierarchySnapshot;
  readonly nextCursor?: string;
  readonly nextPage?: number;
  readonly hasMore: boolean;
  readonly presentationMode?: PresentationMode;
  readonly boundedPreview?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isHierarchyCollection(value: unknown): boolean {
  return Array.isArray(value) || isRecord(value);
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  return value.type === 'snapshot' || value.type === 'agent.updated' || value.type === 'agent.added' || value.type === 'agent.removed' || value.type === 'connection.changed' || value.type === 'watermark.changed';
}

function looksLikeHierarchy(value: unknown): value is AgentHierarchyInput {
  if (!isRecord(value)) return false;
  return 'agents' in value || 'nodes' in value || 'root' in value || 'rootAgentId' in value || 'sessionId' in value || 'agentSessionId' in value;
}

/**
 * Local HTTP hierarchy pages carry a small pagination envelope around their
 * node/edge arrays. Validate fields that are present before accepting that
 * envelope, while retaining support for older MCP payloads that omit totals
 * and page sizes.
 */
function isValidHierarchyPayload(value: Record<string, unknown>): boolean {
  if ('agents' in value && !isHierarchyCollection(value.agents)) return false;
  if ('nodes' in value && !isHierarchyCollection(value.nodes)) return false;
  if ('edges' in value && !Array.isArray(value.edges)) return false;
  if ('total' in value && (!Number.isSafeInteger(value.total) || (value.total as number) < 0)) return false;
  if ('hasMore' in value && typeof value.hasMore !== 'boolean') return false;
  if ('nextCursor' in value && value.nextCursor !== null && safeCursor(value.nextCursor) === undefined) return false;
  if ('next_cursor' in value && value.next_cursor !== null && safeCursor(value.next_cursor) === undefined) return false;
  if ('page' in value && (!Number.isSafeInteger(value.page) || (value.page as number) < 1)) return false;
  if ('pageSize' in value && (!Number.isSafeInteger(value.pageSize) || (value.pageSize as number) < 1)) return false;
  if ('watermark' in value && value.watermark !== null && typeof value.watermark !== 'string' && typeof value.watermark !== 'number') return false;
  if ('agentSessionId' in value && (typeof value.agentSessionId !== 'string' || value.agentSessionId.trim().length === 0)) return false;
  if ('sessionId' in value && (typeof value.sessionId !== 'string' || value.sessionId.trim().length === 0)) return false;
  return true;
}

function inlinePreviewPage(value: Record<string, unknown>): ParsedHierarchyPage | undefined {
  const summary = isRecord(value.inlineSummary) ? value.inlineSummary : undefined;
  const preview = Array.isArray(value.branchPreview)
    ? value.branchPreview
    : summary && Array.isArray(summary.branchPreview) ? summary.branchPreview : undefined;
  const mode = value.mode === 'inline' || summary?.mode === 'inline' ? 'inline' : undefined;
  const agents = value.agents;
  const emptyAgents = agents === undefined || (Array.isArray(agents) && agents.length === 0);
  if (!mode || !preview || !emptyAgents) return undefined;
  const sessionId = typeof value.agentSessionId === 'string' ? value.agentSessionId : value.sessionId;
  const connectionState = value.connectionState;
  const payload: Record<string, unknown> = {
    ...value,
    agents: preview,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(value.connection === undefined && typeof connectionState === 'string' ? { connection: { state: connectionState } } : {}),
  };
  return {
    payload: payload as AgentHierarchyInput,
    hasMore: false,
    presentationMode: 'inline',
    boundedPreview: true,
  };
}

function safeCursor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cursor = value.trim();
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH || /[\u0000-\u001f\u007f]/u.test(cursor)) return undefined;
  return cursor;
}

function readPagination(value: Record<string, unknown>): { nextCursor?: string; nextPage?: number; hasMore?: boolean } {
  const pageInfo = isRecord(value.pageInfo) ? value.pageInfo : undefined;
  const rawCursor = value.nextCursor ?? value.next_cursor ?? pageInfo?.nextCursor ?? pageInfo?.next_cursor ?? value.cursor ?? pageInfo?.cursor;
  const nextCursor = safeCursor(rawCursor);
  const rawHasMore = value.hasMore ?? value.has_more ?? pageInfo?.hasMore ?? pageInfo?.has_more;
  const hasMore = typeof rawHasMore === 'boolean' ? rawHasMore : nextCursor !== undefined;
  const rawPage = value.page ?? pageInfo?.page;
  const nextPage = typeof rawPage === 'number' && Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage < Number.MAX_SAFE_INTEGER
    ? rawPage + 1
    : undefined;
  return { ...(nextCursor === undefined ? {} : { nextCursor }), ...(nextPage === undefined ? {} : { nextPage }), hasMore: typeof rawHasMore === 'boolean' ? rawHasMore : nextCursor !== undefined || nextPage !== undefined };
}

/**
 * Extract a hierarchy page from any of the standard MCP result wrappers.
 * Structured content wins over display text, but text JSON remains supported
 * for older hosts.  The returned page retains only bounded pagination data.
 */
export function parseAgentFarmToolPage(value: unknown): ParsedHierarchyPage | AgentEvent | undefined {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown, depth: number): ParsedHierarchyPage | AgentEvent | undefined => {
    if (depth > 8 || candidate === null || candidate === undefined) return undefined;
    if (typeof candidate === 'string') {
      try {
        return visit(JSON.parse(candidate) as unknown, depth + 1);
      } catch {
        return undefined;
      }
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const parsed = visit(item, depth + 1);
        if (parsed) return parsed;
      }
      return undefined;
    }
    if (!isRecord(candidate) || seen.has(candidate)) return undefined;
    seen.add(candidate);
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      return visit(candidate.text, depth + 1);
    }
    if (isAgentEvent(candidate)) return candidate;
    const previewPage = inlinePreviewPage(candidate);
    if (previewPage) return previewPage;
    if (looksLikeHierarchy(candidate)) {
      if (!isValidHierarchyPayload(candidate)) return undefined;
      const page = readPagination(candidate);
      return {
        payload: candidate,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        ...(page.nextPage === undefined ? {} : { nextPage: page.nextPage }),
        hasMore: page.hasMore === true,
      };
    }

    const ownPage = readPagination(candidate);
    for (const key of ['structuredContent', 'snapshot', 'hierarchy', 'event', 'data', 'result', 'content']) {
      const parsed = visit(candidate[key], depth + 1);
      if (!parsed) continue;
      if ('payload' in parsed) {
        const nested = parsed as ParsedHierarchyPage;
        return {
          payload: nested.payload,
          ...(ownPage.nextCursor === undefined
            ? nested.nextCursor === undefined ? {} : { nextCursor: nested.nextCursor }
            : { nextCursor: ownPage.nextCursor }),
          ...(ownPage.nextPage === undefined
            ? nested.nextPage === undefined ? {} : { nextPage: nested.nextPage }
            : { nextPage: ownPage.nextPage }),
          hasMore: ownPage.hasMore === true || nested.hasMore,
          ...(nested.presentationMode === undefined ? {} : { presentationMode: nested.presentationMode }),
          ...(nested.boundedPreview === true ? { boundedPreview: true } : {}),
        };
      }
      return parsed;
    }
    return undefined;
  };
  return visit(value, 0);
}

/** Backward-compatible extractor used by existing callers/tests. */
export function parseAgentFarmToolResult(value: unknown): AgentHierarchyInput | AgentEvent | undefined {
  const parsed = parseAgentFarmToolPage(value);
  return parsed && !isAgentEvent(parsed) ? parsed.payload : parsed;
}

function rawId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id ?? value.agentId ?? value.threadId;
  if (typeof id !== 'string') return undefined;
  const normalized = id.trim();
  return normalized && normalized.length <= MAX_CURSOR_LENGTH && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : undefined;
}

function collectionEntries(value: unknown): Array<{ key?: string; value: unknown }> {
  if (Array.isArray(value)) return value.map((item) => ({ value: item }));
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([key, item]) => ({ key, value: item }));
}

function mergeNodes(
  pages: readonly (AgentHierarchyInput | AgentHierarchySnapshot)[],
  maxNodes: number,
): { nodes: unknown[]; truncated: boolean } {
  const nodes = new Map<string, unknown>();
  let truncated = false;
  for (const page of pages) {
    const source = page as Record<string, unknown>;
    const collections = [source.agents, source.nodes];
    for (const collection of collections) {
      for (const entry of collectionEntries(collection)) {
        const id = rawId(entry.value) ?? entry.key;
        if (!id) continue;
        if (!nodes.has(id) && nodes.size >= maxNodes) {
          truncated = true;
          continue;
        }
        // Keep insertion order stable while allowing a later page to provide a
        // richer version of an item already seen on an earlier page.
        const previous = nodes.get(id);
        nodes.set(id, isRecord(previous) && isRecord(entry.value)
          ? { ...previous, ...entry.value }
          : entry.value);
      }
    }
  }
  return { nodes: [...nodes.values()], truncated };
}

export function countHierarchyNodes(pages: readonly (AgentHierarchyInput | AgentHierarchySnapshot)[]): number {
  const ids = new Set<string>();
  for (const page of pages) {
    const source = page as Record<string, unknown>;
    for (const collection of [source.agents, source.nodes]) {
      for (const entry of collectionEntries(collection)) {
        const id = rawId(entry.value) ?? entry.key;
        if (id) ids.add(id);
      }
    }
  }
  return ids.size;
}

function edgeKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const parent = value.parentId ?? value.parentAgentId ?? value.parent;
  const child = value.childId ?? value.childAgentId ?? value.child;
  if (typeof parent !== 'string' || typeof child !== 'string') return undefined;
  const p = parent.trim();
  const c = child.trim();
  if (!p || !c || p.length > MAX_CURSOR_LENGTH || c.length > MAX_CURSOR_LENGTH) return undefined;
  return `${p}\u0000${c}`;
}

function mergeEdges(
  pages: readonly (AgentHierarchyInput | AgentHierarchySnapshot)[],
): unknown[] {
  const edges = new Map<string, unknown>();
  for (const page of pages) {
    const source = page as Record<string, unknown>;
    for (const entry of collectionEntries(source.edges)) {
      const key = edgeKey(entry.value);
      if (!key || edges.size >= MAX_HIERARCHY_EDGES && !edges.has(key)) continue;
      edges.set(key, entry.value);
    }
  }
  return [...edges.values()];
}

function boundedOption(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) return fallback;
  return Math.min(value, max);
}

export function normalizePaginationOptions(options: HierarchyPaginationOptions = {}): Required<HierarchyPaginationOptions> {
  return {
    pageSize: boundedOption(options.pageSize, DEFAULT_HIERARCHY_PAGE_SIZE, DEFAULT_HIERARCHY_PAGE_SIZE),
    maxPages: boundedOption(options.maxPages, MAX_HIERARCHY_PAGES, MAX_HIERARCHY_PAGES),
    maxNodes: boundedOption(options.maxNodes, MAX_HIERARCHY_NODES, MAX_HIERARCHY_NODES),
  };
}

/**
 * Merge page payloads by stable node ID and parent/child edge pair.  A
 * pagination stop is reflected as a stale connection so a bounded partial
 * projection cannot be mistaken for a complete live hierarchy.
 */
export function mergeHierarchyPages(
  pages: readonly (AgentHierarchyInput | AgentHierarchySnapshot)[],
  options: { readonly maxNodes?: number; readonly incompleteReason?: string } = {},
): AgentHierarchyInput {
  const first = pages[0] ?? {};
  const source = first as Record<string, unknown>;
  const maxNodes = boundedOption(options.maxNodes, MAX_HIERARCHY_NODES, MAX_HIERARCHY_NODES);
  const publicPages = pages.map((page) => PublicHierarchyPageSchema.safeParse(page)).filter((result) => result.success).map((result) => result.data as PublicHierarchyPage);
  if (publicPages.length === pages.length && publicPages.length > 0) {
    const latest = publicPages[publicPages.length - 1]!;
    const nodes = mergeNodes(publicPages as unknown as AgentHierarchyInput[], maxNodes).nodes as PublicHierarchyPage['nodes'];
    const edges = mergeEdges(publicPages as unknown as AgentHierarchyInput[]) as PublicHierarchyPage['edges'];
    const incomplete = options.incompleteReason !== undefined || nodes.length >= maxNodes;
    return {
      ...latest,
      nodes,
      edges,
      total: latest.total,
      snapshotState: incomplete ? 'stale' : latest.snapshotState,
      ...(incomplete ? { partialReason: 'pagination-bounded' as const, connection: { ...latest.connection, state: 'stale' as const, reason: 'pagination-bounded' as const } } : {}),
      hasMore: latest.hasMore,
      nextCursor: latest.nextCursor,
    } as unknown as AgentHierarchyInput;
  }
  const merged = mergeNodes(pages, maxNodes);
  const edges = mergeEdges(pages);
  const result = { ...first } as AgentHierarchyInput;
  result.agents = merged.nodes as NonNullable<AgentHierarchyInput['agents']>;
  result.edges = edges as NonNullable<AgentHierarchyInput['edges']>;
  if (options.incompleteReason || merged.truncated) {
    const current = isRecord(source.connection) ? source.connection : {};
    result.connection = {
      ...current,
      state: 'stale',
      label: 'Hierarchy pagination incomplete',
      detail: options.incompleteReason ?? 'Hierarchy node limit reached',
    };
  }
  return result;
}

export function hasMorePages(page: ParsedHierarchyPage): boolean {
  return page.hasMore;
}

export interface PaginationFailureContext {
  readonly currentPage?: number;
  readonly pageCount?: number;
  readonly maxPages?: number;
  readonly nodeCount?: number;
  readonly maxNodes?: number;
  readonly seenPages?: ReadonlySet<number>;
}

export function paginationFailureReason(
  page: ParsedHierarchyPage,
  cursor: string | undefined,
  seenCursors: ReadonlySet<string>,
  context: PaginationFailureContext = {},
): string | undefined {
  if (!hasMorePages(page)) return undefined;
  if (!page.nextCursor && !page.nextPage) return 'Host indicated more hierarchy data without a usable cursor';
  if (page.nextCursor && (seenCursors.has(page.nextCursor) || page.nextCursor === cursor)) return 'Host repeated a hierarchy cursor';
  if (page.nextPage !== undefined) {
    if (context.seenPages?.has(page.nextPage) || (context.currentPage !== undefined && page.nextPage <= context.currentPage)) {
      return 'Host repeated a hierarchy page';
    }
  }
  if (context.maxPages !== undefined && context.pageCount !== undefined && context.pageCount >= context.maxPages) {
    return `Hierarchy page limit reached (${context.maxPages})`;
  }
  if (context.maxNodes !== undefined && context.nodeCount !== undefined && context.nodeCount >= context.maxNodes) {
    return `Hierarchy node limit reached (${context.maxNodes})`;
  }
  return undefined;
}

export function isSafeCursor(value: unknown): value is string {
  return safeCursor(value) !== undefined;
}
