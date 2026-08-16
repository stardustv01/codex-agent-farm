/**
 * Protocol-neutral types used by the Codex-side bridge.
 *
 * This package deliberately keeps the app-server wire representation separate
 * from the records that may leave the bridge.  The latter are all represented
 * by the Sanitized* types below; callers should never persist the wire types.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const ALLOWED_OUTBOUND_METHODS = [
  'initialize',
  'initialized',
  'thread/list',
  'thread/read',
  'model/list',
] as const;

export type AllowedOutboundMethod = (typeof ALLOWED_OUTBOUND_METHODS)[number];

export interface JsonRpcRequest {
  /** Codex app-server omits the JSON-RPC version on its stdio wire. */
  readonly jsonrpc?: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: JsonObject;
}

export interface JsonRpcSuccess {
  readonly jsonrpc?: '2.0';
  readonly id: number;
  readonly result: JsonValue;
}

export interface JsonRpcFailure {
  readonly jsonrpc?: '2.0';
  readonly id: number;
  readonly error: {
    readonly code: number;
    /** The bridge never copies this field into an error or event. */
    readonly message?: string;
    readonly data?: JsonValue;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface JsonRpcNotification {
  readonly jsonrpc?: '2.0';
  readonly method: string;
  readonly params?: JsonObject;
}

export type BridgeLifecycleStatus =
  | 'idle'
  | 'active'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unknown';

export type BridgeTurnStatus =
  | 'started'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unknown';

export type BridgeSourceKind = 'cli' | 'ide' | 'cloud' | 'subagent' | 'unknown';

export interface SanitizedThread {
  readonly sourceThreadId: string;
  /** Bounded local display title; never a prompt, path, or raw identifier. */
  readonly chatTitle?: string;
  /** Final basename of a local working directory; the directory is discarded. */
  readonly workspaceName?: string;
  readonly sessionId?: string;
  readonly parentThreadId?: string;
  readonly forkedFromId?: string;
  readonly modelProvider?: string;
  readonly status: BridgeLifecycleStatus;
  readonly cliVersion?: string;
  readonly sourceKind?: BridgeSourceKind;
  readonly agentNickname?: string;
  readonly agentRole?: string;
  /** Structural Codex subagent path, for example `/root/dirac/rhea`. */
  readonly agentPath?: string;
  /** Last segment of `agentPath`; never copied from a raw task/name label. */
  readonly agentTaskName?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly recencyAt?: string;
}

export interface SanitizedCollaboration {
  readonly operation?: string;
  readonly senderId?: string;
  readonly receiverIds?: readonly string[];
  readonly requestedModel?: string;
  readonly requestedReasoningEffort?: string;
  readonly status?: BridgeTurnStatus;
}

export interface SanitizedSubagentActivity {
  readonly sourceThreadId?: string;
  readonly sourceTurnId?: string;
  readonly parentThreadId?: string;
  /** Structural Codex subagent path, never a filesystem path. */
  readonly agentPath?: string;
  /** Last segment of `agentPath`; never copied from free-form content. */
  readonly agentTaskName?: string;
  readonly status?: BridgeTurnStatus;
}

export interface SanitizedThreadSettings {
  readonly model?: string;
  readonly provider?: string;
  readonly reasoningEffort?: string;
}

export interface SanitizedModelReroute {
  readonly fromModel?: string;
  readonly toModel?: string;
}

export type SanitizedItemKind =
  | 'collaboration'
  | 'subagent_activity'
  | 'thread_settings'
  | 'model_rerouted'
  | 'lifecycle'
  | 'error'
  | 'unknown';

export type SanitizedErrorCode =
  | 'invalid_request'
  | 'method_not_found'
  | 'not_initialized'
  | 'permission_denied'
  | 'timeout'
  | 'cancelled'
  | 'internal'
  | 'unknown';

export interface SanitizedItem {
  readonly sourceItemId?: string;
  readonly kind: SanitizedItemKind;
  readonly status?: BridgeTurnStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly collaboration?: SanitizedCollaboration;
  readonly subagentActivity?: SanitizedSubagentActivity;
  readonly effectiveSettings?: SanitizedThreadSettings;
  readonly modelRerouted?: SanitizedModelReroute;
  readonly errorCode?: SanitizedErrorCode;
}

export interface SanitizedTurn {
  readonly sourceTurnId: string;
  readonly status: BridgeTurnStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly items?: readonly SanitizedItem[];
}

export interface SanitizedThreadPage {
  readonly threads: readonly SanitizedThread[];
  /** Cursor is local bridge state and must not be persisted or exported. */
  readonly nextCursor?: string;
}

export interface SanitizedThreadRead {
  readonly thread: SanitizedThread;
  readonly turns: readonly SanitizedTurn[];
  /** Cursor is local bridge state and must not be persisted or exported. */
  readonly nextCursor?: string;
}

export interface SanitizedModel {
  readonly model?: string;
  readonly provider?: string;
  readonly displayLabel?: string;
  readonly capabilities?: readonly string[];
}

export interface SanitizedModelCatalog {
  readonly models: readonly SanitizedModel[];
  /** Cursor is local bridge state and must not be persisted or exported. */
  readonly nextCursor?: string;
}

export interface SanitizedFinalSummary {
  readonly sourceThreadId: string;
  readonly sourceTurnId?: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly provenance: 'final_agent_message';
}

export type NormalizedEventKind =
  | 'turn.started'
  | 'turn.completed'
  | 'item.started'
  | 'item.completed'
  | 'thread.status.changed'
  | 'collaboration.observed'
  | 'subagent.activity'
  | 'thread.settings.changed'
  | 'model.rerouted';

export interface NormalizedEvent {
  readonly version: 1;
  readonly kind: NormalizedEventKind;
  readonly sourceThreadId: string;
  readonly sourceTurnId?: string;
  readonly sourceItemId?: string;
  readonly observedAt?: string;
  readonly status?: BridgeTurnStatus | BridgeLifecycleStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly item?: SanitizedItem;
  readonly collaboration?: SanitizedCollaboration;
  readonly subagentActivity?: SanitizedSubagentActivity;
  readonly effectiveSettings?: SanitizedThreadSettings;
  readonly modelRerouted?: SanitizedModelReroute;
}

export interface ConnectionFingerprint {
  /** Captured locally for provenance; never passed through a redactor. */
  readonly binaryPath?: string;
  readonly binarySha256?: string;
  readonly reportedUserAgent: string;
  readonly schemaBundleSha256: string;
  readonly schemaHashes?: Readonly<Record<string, string>>;
  readonly connectionTime: string;
}

export interface StableMethodSchema {
  readonly method: AllowedOutboundMethod;
  readonly requestFields: readonly string[];
  readonly responseFields: readonly string[];
}

export interface StableSchemaBundle {
  readonly version: string;
  readonly methods: readonly StableMethodSchema[];
  readonly sha256: string;
}

export interface TestedAdapter {
  readonly adapterVersion: string;
  readonly binarySha256?: string;
  readonly schemaBundleSha256: string;
  readonly userAgentPrefix: string;
  /**
   * Optional exact hashes for the generated protocol schema files used when
   * this adapter was tested.  Older fixture adapters may omit this evidence;
   * a configured adapter that supplies it is gated against the connection's
   * bounded map before it can be accepted.
   */
  readonly schemaHashes?: Readonly<Record<string, string>>;
}

export interface AdapterGateAccepted {
  readonly status: 'accepted';
  readonly adapterVersion: string;
  readonly schemaVersion: string;
  readonly fingerprint: ConnectionFingerprint;
}

export type AdapterQuarantineReason =
  | 'missing-user-agent'
  | 'schema-invalid'
  | 'schema-fingerprint-mismatch'
  | 'schema-hashes-missing'
  | 'schema-hashes-mismatch'
  | 'binary-fingerprint-mismatch'
  | 'user-agent-mismatch'
  | 'unsupported-fingerprint';

export interface AdapterGateQuarantined {
  readonly status: 'quarantined';
  readonly reason: AdapterQuarantineReason;
  readonly schemaVersion?: string;
  readonly missingMethods?: readonly string[];
  readonly missingFields?: readonly string[];
  readonly fingerprint: ConnectionFingerprint;
}

export type AdapterGateResult = AdapterGateAccepted | AdapterGateQuarantined;

export interface ObservationEnvelope {
  readonly connectionEpoch: string;
  /** Assigned by the Agent Farm backend; this is observed arrival order only. */
  readonly ingestOrdinal: number;
  readonly key: string;
  readonly sanitizedPayloadHash: string;
  readonly event: NormalizedEvent;
}

export type ObservationDecision =
  | { readonly kind: 'accepted'; readonly envelope: ObservationEnvelope }
  | { readonly kind: 'duplicate'; readonly key: string }
  | {
      readonly kind: 'conflict';
      readonly key: string;
      readonly existingHash: string;
      readonly incomingHash: string;
    };

export interface ProjectionCorrection<T> {
  readonly type: 'projection.corrected';
  readonly authority: 'reconciliation';
  readonly source: string;
  readonly key: string;
  readonly previous?: T;
  readonly current?: T;
}
