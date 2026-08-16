import type {
  LocalAgentDetail,
  PublicAgent,
  PublicReasonCode,
  PublicSnapshotState,
  PublicStoryMilestone,
} from '@agent-farm/contracts';

/**
 * UI-facing contracts.  The web app deliberately does not depend on a
 * transport implementation: both the standalone and MCP hosts feed the same
 * normalized snapshot/event shape into the reducer.
 */

export type AgentId = string;
export type PresentationMode = 'inline' | 'fullscreen' | 'standalone';
export type Density = 'compact' | 'comfortable';

export const AGENT_STATUSES = [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'disconnected',
  'unverified',
  'unknown',
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const CONNECTION_STATES = [
  'connected',
  'reconnecting',
  'stale',
  'disconnected',
  'error',
  'unverified',
] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

export type IdentityTrust = 'authenticated' | 'requested' | 'observed' | 'reconciled' | 'inferred' | 'unknown';
export type IdentityVerification = 'verified' | 'mismatch' | 'unverified' | 'unknown';

export interface IdentityValue {
  model?: string;
  provider?: string;
  effort?: string;
  source?: string;
  observedAt?: string;
  trust?: IdentityTrust;
}

export interface IdentityEvidence {
  requested?: IdentityValue;
  observed?: IdentityValue;
  verification?: IdentityVerification;
}

export interface AgentNode {
  id: AgentId;
  parentId: AgentId | null;
  sessionId?: string;
  sourceThreadId?: string;
  name: string;
  nickname?: string;
  role?: string;
  status: AgentStatus;
  task?: string;
  summary?: string;
  resultSummary?: string;
  errorSummary?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  durationMs?: number;
  depth?: number;
  childIds?: AgentId[];
  requestedModel?: string;
  requestedProvider?: string;
  requestedEffort?: string;
  observedModel?: string;
  observedProvider?: string;
  observedEffort?: string;
  identity?: IdentityEvidence;
  verification?: IdentityVerification;
  /** Strict public-v1 node retained for the production visual adapter. */
  publicNode?: PublicAgent;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AgentEdge {
  parentId: AgentId;
  childId: AgentId;
  verified?: boolean;
  source?: string;
}

export interface ConnectionInfo {
  state: ConnectionState;
  label?: string;
  detail?: string;
  connectedAt?: string;
  lastEventAt?: string;
  epoch?: string | number;
  watermark?: string | number;
}

export interface AgentCounts {
  total: number;
  active: number;
  completed: number;
  failed: number;
  unverified: number;
  disconnected?: number;
}

/**
 * Strict public-v1 data retained by the web normalizer for the production
 * visual surface. It deliberately contains only the server-owned public
 * contract; generic/legacy inputs do not populate this projection.
 */
export interface PublicHierarchyProjection {
  schemaVersion: 'agent-farm.public.v1';
  storyMilestones: PublicStoryMilestone[];
  snapshotState: PublicSnapshotState;
  partialReason?: PublicReasonCode;
}

export interface OrchestrationBudget {
  solHigh: number;
  lunaMax: number;
  solMax: number;
}

/** Public, non-secret information used to select a local Codex source root. */
export interface LocalCandidateRoot {
  /** Server-generated, single-use local selection capability. */
  selectionHandle: string;
  /** Session-scoped opaque identity used to reacquire a fresh capability. */
  chatHandle?: string;
  displayName: string;
  chatTitle?: string;
  workspaceName?: string;
  /** Current durable binding marker from the authenticated status response. */
  active?: true;
  bound?: true;
  /** Opaque marker for the server-only task identity supplied at launch. */
  launchTarget?: true;
  lifecycle?: string;
  lastActivityAt?: string;
  descendantCount?: number;
}

/** Safe server-derived description of the active local binding. */
export interface LocalActiveTask {
  displayName: string;
  chatTitle?: string;
  workspaceName?: string;
  lifecycle?: string;
  lastActivityAt?: string;
}

/** Runtime values injected by the standalone launcher. */
export interface AgentFarmRuntimeConfig {
  /** Same-origin or trusted API origin; never a token-bearing URL. */
  apiBaseUrl?: string;
  /** Explicit hierarchy endpoint path. */
  snapshotPath?: string;
  /** Session identifier used to construct the default hierarchy path. */
  agentSessionId?: string;
  /** Local-only standalone mode; OAuth routes must not be used. */
  localMode?: boolean;
  /** Whether a Codex source root has been paired for this installation. */
  paired?: boolean;
  /** First verified snapshot is still being reconciled in the background. */
  syncing?: boolean;
  /** Safe label for the exact durable binding owned by this browser session. */
  activeTask?: LocalActiveTask;
  /** Session-bound CSRF value; never persisted in a URL or browser storage. */
  csrfToken?: string;
  /** Sanitized, non-secret source-root choices exposed by local status. */
  candidateRoots?: LocalCandidateRoot[];
  /** Monotonic server marker for a verified launcher current-chat handoff. */
  focusVersion?: number;
  focusChangedAt?: string;
  /** Safe status code when current task discovery could not be completed. */
  discoveryError?: 'source_roots_unavailable';
  /** Per-install orchestration allowances shown in the hierarchy toolbar. */
  orchestrationBudget?: OrchestrationBudget;
  /** Demo fixture is honored only by a Vite development build. */
  demo?: boolean;
}

export interface AgentHierarchySnapshot {
  schemaVersion: string;
  sessionId: string;
  rootAgentId: AgentId | null;
  agents: Record<AgentId, AgentNode>;
  edges: AgentEdge[];
  connection: ConnectionInfo;
  counts?: AgentCounts;
  orchestrationBudget?: OrchestrationBudget;
  watermark?: string | number;
  version?: string | number;
  sourceAdapter?: 'standalone' | 'mcp' | 'fixture' | string;
  generatedAt?: string;
  snapshotState?: 'complete' | 'partial' | 'stale' | 'disconnected' | 'error' | 'unknown';
  partialReason?: string;
  /** Strict public-v1 projection retained end-to-end for production views. */
  publicProjection?: PublicHierarchyProjection;
  storyMilestones?: Array<{
    schemaVersion: string;
    milestoneId: string;
    sequence: number;
    kind: string;
    agentId: string | null;
    occurredAt: string;
  }>;
}

/** Accept common backend payload spellings before normalizing. */
export interface AgentHierarchyInput {
  schemaVersion?: string;
  sessionId?: string;
  agentSessionId?: string;
  session?: Record<string, unknown>;
  rootAgentId?: AgentId | null;
  agents?: Record<string, AgentNode> | AgentNode[];
  nodes?: Record<string, AgentNode> | AgentNode[];
  edges?: AgentEdge[] | Array<{ parent: string; child: string; verified?: boolean }>;
  root?: AgentNode | AgentHierarchyInput;
  connection?: Partial<ConnectionInfo> | ConnectionState;
  connectionState?: ConnectionState | string;
  counts?: Partial<AgentCounts> | Record<string, unknown>;
  orchestrationBudget?: Partial<OrchestrationBudget> | Record<string, unknown>;
  watermark?: string | number;
  version?: string | number;
  /** Optional HTTP/MCP pagination envelope fields. */
  nextCursor?: string | null;
  nextPage?: number | null;
  hasMore?: boolean;
  page?: number;
  pageSize?: number;
  total?: number;
  sourceAdapter?: string;
  generatedAt?: string;
}

export interface AgentEvent {
  type:
    | 'snapshot'
    | 'agent.updated'
    | 'agent.added'
    | 'agent.removed'
    | 'connection.changed'
    | 'watermark.changed';
  agent?: Partial<AgentNode> & Pick<AgentNode, 'id'>;
  agentId?: AgentId;
  patch?: Partial<AgentNode>;
  connection?: Partial<ConnectionInfo> | ConnectionState;
  snapshot?: AgentHierarchyInput;
  watermark?: string | number;
  version?: string | number;
}

export type HostEventListener = (event: AgentEvent) => void;
export type Unsubscribe = () => void;

export interface HostAdapter {
  readonly kind: 'standalone' | 'mcp' | string;
  readonly mode?: PresentationMode;
  getSnapshot(signal?: AbortSignal): Promise<AgentHierarchyInput | AgentHierarchySnapshot>;
  /** Local-only, read-only detail fetch keyed by the canonical public agent ID. */
  getLocalAgentDetail?(agentId: AgentId, signal?: AbortSignal): Promise<LocalAgentDetail | undefined>;
  subscribe(listener: HostEventListener): Unsubscribe;
  requestFullscreen?: () => Promise<boolean> | boolean;
  dispose?: () => void;
}

export interface StandaloneAdapterOptions {
  snapshot?: AgentHierarchyInput | AgentHierarchySnapshot;
  fetchSnapshot?: (signal?: AbortSignal, page?: { readonly cursor?: string; readonly page?: number; readonly limit: number }) => Promise<AgentHierarchyInput | AgentHierarchySnapshot>;
  /** Local-only detail endpoint; never accepts a source-thread or token-bearing identifier. */
  fetchLocalDetail?: (agentId: AgentId, signal?: AbortSignal) => Promise<LocalAgentDetail | undefined>;
  /** Content-free session revision signal used to trigger full snapshot reads. */
  fetchRevision?: (signal?: AbortSignal) => Promise<{ agentSessionId: string; revision: number }>;
  revisionPollMs?: number;
  mode?: PresentationMode;
  /** Safe launcher-owned advisory budget overlaid after strict page parsing. */
  orchestrationBudget?: OrchestrationBudget;
  pageSize?: number;
  maxPages?: number;
  maxNodes?: number;
}

export interface McpBridgeMessage {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface McpBridge {
  postMessage(message: unknown): void;
  subscribe(listener: (message: McpBridgeMessage) => void): Unsubscribe;
  requestFullscreen?: () => Promise<boolean> | boolean;
}

export interface AgentFarmState {
  snapshot: AgentHierarchySnapshot;
  mode: PresentationMode;
  density: Density;
  selectedId: AgentId | null;
  expandedIds: Set<AgentId>;
  search: string;
  statusFilter: AgentStatus | 'all';
  focusId: AgentId | null;
  loading: boolean;
  error: string | null;
  /** Bounded local-only detail cache used for inspector and hierarchy cost summaries. */
  localDetails: Record<AgentId, LocalAgentDetail | null>;
}

export type AgentFarmAction =
  | { type: 'snapshot.received'; snapshot: AgentHierarchyInput | AgentHierarchySnapshot }
  | { type: 'event.received'; event: AgentEvent }
  | { type: 'mode.changed'; mode: PresentationMode }
  | { type: 'density.changed'; density: Density }
  | { type: 'selection.changed'; id: AgentId | null }
  | { type: 'focus.changed'; id: AgentId | null }
  | { type: 'expanded.changed'; id: AgentId; expanded?: boolean }
  | { type: 'expanded.set'; ids: AgentId[] }
  | { type: 'search.changed'; search: string }
  | { type: 'status-filter.changed'; status: AgentStatus | 'all' }
  | { type: 'loading.changed'; loading: boolean }
  | { type: 'local-detail.received'; id: AgentId; detail: LocalAgentDetail | null }
  | { type: 'error.changed'; error: string | null };
