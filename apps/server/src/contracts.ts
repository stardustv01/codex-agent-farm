/**
 * Narrow, protocol-neutral interfaces used by the HTTP composition root.
 *
 * The server deliberately does not import a persistence or bridge
 * implementation.  This keeps the authorization boundary at the edge and
 * lets the application wire the durable store, local bridge, and MCP adapter
 * without coupling HTTP handlers to their constructors.
 */

export type Identifier = string;

export type Scope =
  | "agent-session:create"
  | "agent-session:read"
  | "agent-session:read-details"
  | "agent-session:render"
  | "bridge:pair";

/**
 * User-configurable sub-agent orchestration budget. All values are bounded at
 * parse time and the sum never exceeds the 25-slot concurrency ceiling.
 */
export interface OrchestrationBudget {
  readonly solHigh: number;
  readonly lunaMax: number;
  readonly solMax: number;
}

/** Default local orchestration budget shared by every server entry point. */
export const DEFAULT_ORCHESTRATION_BUDGET: Readonly<OrchestrationBudget> = {
  solHigh: 10,
  lunaMax: 10,
  solMax: 3,
} as const;

export interface Principal {
  readonly subject: Identifier;
  readonly ownerId: Identifier;
  readonly tenantId: Identifier;
  readonly scopes: ReadonlySet<string>;
  readonly issuer?: string;
  readonly audience?: readonly string[];
  readonly tokenId?: string;
  /** Server-reserved Agent Farm session carried by verified authorization. */
  readonly agentSessionId?: string;
}

export interface RawTokenClaims {
  readonly sub?: unknown;
  readonly ownerId?: unknown;
  readonly owner_id?: unknown;
  readonly tenantId?: unknown;
  readonly tenant_id?: unknown;
  readonly scope?: unknown;
  readonly scopes?: unknown;
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly resource?: unknown;
  readonly exp?: unknown;
  readonly nbf?: unknown;
  readonly jti?: unknown;
  /** Refresh-stable OAuth grant/session identifier used by MCP transport. */
  readonly sid?: unknown;
  readonly agentSessionId?: unknown;
  readonly agent_session_id?: unknown;
  readonly [key: string]: unknown;
}

export interface TokenVerificationContext {
  readonly audience?: string;
  readonly issuer?: string;
  readonly resource?: string;
}

export interface AuthService {
  authenticateToken(
    token: string,
    context: TokenVerificationContext,
  ): Promise<RawTokenClaims>;
}

export interface SessionPayload {
  readonly label?: string;
  readonly sourceAdapter?: string;
  readonly capabilities?: readonly string[];
}

export interface SessionScope {
  readonly ownerId: Identifier;
  readonly tenantId: Identifier;
  readonly agentSessionId: Identifier;
}

export interface AgentSessionRecord extends SessionScope {
  readonly status?: string;
  readonly sourceAdapter?: string;
  readonly label?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly watermark?: string | number;
  readonly capabilities?: readonly string[];
}

export interface CreateAgentSessionInput extends SessionScope {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly payload: SessionPayload;
}

export interface HierarchyNode {
  readonly agentId?: Identifier;
  readonly id?: Identifier;
  readonly agentSessionId?: Identifier;
  readonly parentAgentId?: Identifier | null;
  readonly parentId?: Identifier | null;
  readonly [key: string]: unknown;
}

export interface HierarchyEdge {
  readonly parentAgentId?: Identifier;
  readonly childAgentId?: Identifier;
  readonly parentId?: Identifier;
  readonly childId?: Identifier;
  readonly agentSessionId?: Identifier;
  readonly [key: string]: unknown;
}

export interface HierarchyPage {
  readonly agentSessionId?: Identifier;
  readonly watermark?: string | number;
  readonly nodes: readonly HierarchyNode[];
  readonly edges?: readonly HierarchyEdge[];
  readonly total?: number;
  readonly hasMore?: boolean;
  readonly page?: number;
  readonly pageSize?: number;
  /** Opaque continuation cursor for the next bounded page. */
  readonly nextCursor?: string;
}

export interface AgentDetails extends HierarchyNode {
  readonly agentSessionId?: Identifier;
}

export interface StorePort {
  ready?(): boolean | Promise<boolean>;
  createAgentSession(
    input: CreateAgentSessionInput,
  ): Promise<AgentSessionRecord>;
  getAgentSession?(scope: SessionScope): Promise<AgentSessionRecord | null>;
  getSession?(scope: SessionScope): Promise<AgentSessionRecord | null>;
  getHierarchy(
    scope: SessionScope & { readonly page: number; readonly pageSize: number },
  ): Promise<HierarchyPage | null>;
  /** Content-free, session-scoped durable projection revision. */
  getHierarchyRevision?(
    scope: SessionScope,
  ): Promise<number | null>;
  getAgentDetails?(
    scope: SessionScope & { readonly agentId: Identifier },
  ): Promise<AgentDetails | null>;
  getDetails?(
    scope: SessionScope & { readonly agentId: Identifier },
  ): Promise<AgentDetails | null>;
  /** Local-only, credential-free detail projection. Public-v1 never widens. */
  getLocalAgentDetails?(
    scope: SessionScope & { readonly agentId: Identifier },
  ): Promise<unknown | null>;
}

export interface PairingChallengeInput {
  readonly ownerId: Identifier;
  readonly tenantId: Identifier;
  readonly installationId: string;
  readonly publicKey: string;
  readonly sourceRootId: string;
  /** Server-generated proof that the selected Codex root was observed. */
  readonly sourceRootAttestationDigest: string;
  readonly sourceSessionId: string;
  readonly sourceRootAttestationExpiresAt: string;
  readonly agentSessionId: Identifier;
  readonly requestedScopes: readonly string[];
}

export interface SourceRootAttestationRequest {
  readonly installationId: string;
  readonly sourceRootId: string;
}

export interface SourceRootAttestationRecord {
  readonly installationId: string;
  readonly sourceRootId: string;
  readonly sourceSessionId: string;
  readonly expiresAt: string;
  readonly attestationDigest: string;
}

/**
 * A bounded, sanitized candidate root for the local-only pairing selector.
 * Only structural metadata is copied internally: the source root id, optional
 * nickname/path/status/updatedAt and a bounded descendant count. No prompt,
 * turn, or raw app-server payload is copied here. The HTTP local selector
 * projects this into an opaque handle and never exposes these private fields.
 */
export interface SourceRootCandidate {
  readonly sourceRootId: string;
  readonly chatTitle?: string;
  readonly workspaceName?: string;
  readonly nickname?: string;
  /** Safe final segment of the structural agent task path, used only for display fallback. */
  readonly agentTaskName?: string;
  readonly agentPath?: string;
  readonly status: string;
  readonly updatedAt?: string;
  readonly descendantCount?: number;
}

export interface PairingChallenge extends PairingChallengeInput {
  readonly pairingId: string;
  readonly nonce: string;
  readonly expiresAt: string;
  /** Internal-only authorization for an already paired scope to switch roots. */
  readonly replaceExisting?: boolean;
  /** Internal-only legacy/safety-net opt-in; normal local pairing is exclusive. */
  readonly retainExisting?: boolean;
  /** Internal-only opt-in for returning while first reconciliation continues. */
  readonly deferRuntimeActivation?: boolean;
  /** Internal-only exact old root for transactional compare-and-replace. */
  readonly expectedSourceRootId?: string;
  /** Internal-only exact durable owner replaced by an authoritative launch/switch. */
  readonly expectedActiveBinding?: {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly sourceRootId: string;
  };
  /** Internal-only last-moment guard against a superseded browser selection. */
  readonly activationStillCurrent?: () => boolean;
}

export interface PairingSignatureInput extends PairingChallenge {
  readonly signature: string;
  readonly message: string;
}

export interface PairingCredential {
  readonly credential: string;
  readonly expiresAt: string;
  readonly pairingId?: string;
}

export interface ActivePairingRuntimeInput {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly agentSessionId: string;
  readonly installationId: string;
  readonly sourceRootId: string;
}

export interface BridgePort {
  ready?(): boolean | Promise<boolean>;
  /** Required by production pairing; the HTTP layer rejects its absence. */
  attestSourceRoot?(
    input: SourceRootAttestationRequest,
  ): Promise<SourceRootAttestationRecord>;
  /**
   * Optional bounded candidate-root listing for the local pairing selector.
   * The HTTP layer never falls back to generic thread/list access.
   */
  listSourceRoots?(): Promise<readonly SourceRootCandidate[]>;
  /** Return whether a durable active binding already owns this pairing tuple. */
  hasActivePairing?(input: {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId: string;
  }): boolean | Promise<boolean>;
  /** Resolve the one durable installation binding for local restart remount. */
  resolveActivePairing?(installationId: string): {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId: string;
  } | null | Promise<{
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId: string;
  } | null>;
  /** Resolve every active local chat projection for restart and navigation. */
  listActivePairings?(installationId: string): readonly {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId: string;
  }[] | Promise<readonly {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId: string;
  }[]>;
  /** Remount a still-authorized durable chat into the bounded runtime pool. */
  ensureActivePairing?(input: ActivePairingRuntimeInput): void | Promise<void>;
  /** Revoke the durable binding(s) for a deliberate local unpair/switch. */
  revokePairing?(input: {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId?: string;
    /** Internal lifecycle reason; never returned to browser callers. */
    readonly reason?: "switch" | "unpair";
  }): boolean | Promise<boolean>;
  verifyPairingSignature(
    input: PairingSignatureInput,
  ): boolean | Promise<boolean>;
  issuePairingCredential(
    input: PairingChallenge,
  ): Promise<PairingCredential>;
}

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly requiredScope?: Scope;
}

export interface McpPort {
  ready?(): boolean | Promise<boolean>;
  listTools?(principal: Principal): Promise<readonly McpTool[]>;
  callTool?(
    name: string,
    args: Record<string, unknown>,
    principal: Principal,
  ): Promise<unknown>;
}

export interface OAuthMetadata {
  readonly resource: string;
  readonly authorizationServer?: string;
  readonly scopesSupported: readonly string[];
}
