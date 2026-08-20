import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { once } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  AdapterQuarantinedError,
  AppServerClient,
  canonicalObservationKey,
  spawnStdioAppServer,
  type AdapterGateResult,
  type ConnectionFingerprint,
  type JsonObject,
  type LineTransport,
  type NormalizedEvent,
  type SanitizedModelCatalog,
  type SanitizedThreadPage,
  type SanitizedThreadRead,
  type StableSchemaBundle,
  type TestedAdapter,
  type RolloutIdentityEvidence,
  type LocalRolloutDetail,
  type RolloutIdentityReaderOptions,
} from "@agent-farm/codex-bridge";
import { DurableStore, type EventIngestResult } from "@agent-farm/store";

import type { CodexSnapshotClient } from "./codex-reconciler.js";

/** The only connection states the runtime may report to its callers. */
export type CodexRuntimeConnectionState =
  | "unpaired"
  | "connecting"
  | "connected"
  | "quarantined"
  | "disconnected";

/** A resolved Agent Farm session binding. No Codex credential is retained here. */
export interface CodexRuntimeBinding {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly agentSessionId: string;
  /** Private source-root identifier selected during pairing. */
  readonly sourceRootId: string;
  readonly installationId?: string;
  readonly status?: "active" | "revoked" | "expired";
}

export interface CodexRuntimeBindingRequest {
  readonly fingerprint: ConnectionFingerprint;
  readonly connectionEpoch?: string;
}

/**
 * Resolves the current local installation/root to one Agent Farm session.
 * Returning null (or a non-active binding) is fail-closed and means unpaired.
 * The resolver is called again before every event so revocation stops ingest.
 */
export type CodexRuntimeBindingResolver = (
  request: CodexRuntimeBindingRequest,
) => CodexRuntimeBinding | null | Promise<CodexRuntimeBinding | null>;

export interface CodexRuntimeSpawnedAppServer {
  readonly process: ChildProcessWithoutNullStreams;
  readonly transport: LineTransport;
}

export interface CodexRuntimeSpawnOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The one read-only facade shared by pairing/root-attestation and the
 * reconciliation service.  It deliberately omits AppServerClient.call so a
 * caller can never smuggle a generic RPC through the composition root.
 *
 * The object is stable across the runtime lifecycle; its gate is a getter so
 * a pre-pair caller can attest a root after the adapter is accepted, while a
 * transport close immediately removes that authority.
 */
export interface CodexRuntimeReadOnlyClient {
  readonly gate?: AdapterGateResult | undefined;
  readonly installationId?: string | undefined;
  readonly listThreads: (params?: JsonObject) => Promise<SanitizedThreadPage>;
  readonly readThread: (params: JsonObject) => Promise<SanitizedThreadRead>;
  readonly listModels: (params?: JsonObject) => Promise<SanitizedModelCatalog>;
  /** Optional sanitized title lookup from Codex Desktop's local index. */
  readonly readChatTitle?: (threadId: string) => Promise<string | undefined>;
  /** Optional bounded identity evidence from the pinned local rollout store. */
  readonly readRolloutIdentity?: (threadId: string) => Promise<RolloutIdentityEvidence | undefined>;
  readonly readRolloutLocalDetail?: (threadId: string) => Promise<LocalRolloutDetail | undefined>;
}

export type CodexRuntimeSpawner = (
  options: CodexRuntimeSpawnOptions,
) => CodexRuntimeSpawnedAppServer;

export type CodexRuntimeClientFactory = (
  transport: LineTransport,
  options: ConstructorParameters<typeof AppServerClient>[1],
) => AppServerClient;

export interface CodexRuntimeControllerOptions {
  readonly store: DurableStore;
  /** The configured binary passed to spawnStdioAppServer. */
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Optional display path; defaults to executable. */
  readonly binaryPath?: string;
  /** Trusted local installation identity used by source-root attestation. */
  readonly installationId?: string;
  /** A precomputed hash is useful for tests and packaged launchers. */
  readonly binarySha256?: string;
  /** Retained, generated schema bundle for the configured tested adapter. */
  readonly schema: StableSchemaBundle;
  /** Exact generated schema-file hashes required by configured adapters. */
  readonly schemaHashes?: Readonly<Record<string, string>>;
  /** Explicit allowlist; an empty list causes a quarantined connection. */
  readonly testedAdapters: readonly TestedAdapter[];
  readonly initializeParams?: JsonObject;
  readonly bindingResolver?: CodexRuntimeBindingResolver;
  readonly sourceAdapter?: string;
  readonly maxLineBytes?: number;
  readonly connectionEpoch?: string;
  readonly now?: () => Date;
  /** Optional bounded reader for pinned local rollout identity evidence. */
  readonly rolloutIdentity?: RolloutIdentityReaderOptions;
  readonly spawn?: CodexRuntimeSpawner;
  readonly clientFactory?: CodexRuntimeClientFactory;
  /** Optional local mapping check for descendants of the selected root. */
  readonly sourceThreadAllowed?: (
    binding: CodexRuntimeBinding,
    sourceThreadId: string,
  ) => boolean | Promise<boolean>;
  /** Called with safe, aggregate status changes only. */
  readonly onStatusChange?: (status: CodexRuntimeStatus) => void;
  /**
   * Content-free hint that a sanitized notification advanced the durable
   * projection. Consumers may use this to schedule a bounded authoritative
   * reconciliation; the notification itself is never structural authority.
   */
  readonly onProjectionHint?: () => void;
}

export interface CodexRuntimeStatus {
  readonly state: CodexRuntimeConnectionState;
  /** Alias kept for hosts that use `status` as the discriminant. */
  readonly status: CodexRuntimeConnectionState;
  readonly connectionEpoch?: string;
  readonly gate?: AdapterGateResult;
  readonly fingerprint?: ConnectionFingerprint;
  readonly reason?:
    | "binding-unavailable"
    | "fingerprint-failed"
    | "spawn-failed"
    | "adapter-quarantined"
    | "transport-closed"
    | "binding-revoked"
    | "ingest-failed"
    | "closed";
  readonly rejectedNotificationCount: number;
  readonly lastIngestOutcome?: EventIngestResult["outcome"];
}

export interface CodexRuntimeConnectResult extends CodexRuntimeStatus {}

/** A safe aggregate error classification; raw process/bridge errors are not retained. */
type RuntimeFailure = Exclude<NonNullable<CodexRuntimeStatus["reason"]>, "closed">;

const DEFAULT_INITIALIZE_PARAMS: JsonObject = {
  clientInfo: { name: "agent-farm", title: "Agent Farm", version: "1.0.0" },
  capabilities: { supportsNotifications: true, requestAttestation: false },
};

const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const SAFE_WORD = /^[A-Za-z0-9._:-]{1,256}$/;
const AGENT_PATH = /^\/root(?:\/[A-Za-z0-9._:@+-]{1,128}){0,63}$/u;
const AGENT_PATH_MAX_CHARS = 512;
const AGENT_TASK_NAME = /^[A-Za-z0-9._:@+-]{1,128}$/u;
const EVENT_STATUSES = new Set([
  "started",
  "in_progress",
  "completed",
  "failed",
  "interrupted",
  "unknown",
  "idle",
  "active",
]);
const EVENT_KINDS = new Set([
  "turn.started",
  "turn.completed",
  "item.started",
  "item.completed",
  "thread.status.changed",
  "collaboration.observed",
  "subagent.activity",
  "thread.settings.changed",
  "model.rerouted",
]);

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && OPAQUE_ID.test(value) ? value : undefined;
}

function safeWord(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_WORD.test(value) ? value : undefined;
}

function safeAgentPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > AGENT_PATH_MAX_CHARS) return undefined;
  return AGENT_PATH.test(value) ? value : undefined;
}

function safeAgentTaskName(value: unknown): string | undefined {
  return typeof value === "string" && AGENT_TASK_NAME.test(value) ? value : undefined;
}

function taskNameFromAgentPath(value: string): string | undefined {
  const taskName = value.slice(value.lastIndexOf("/") + 1);
  return safeAgentTaskName(taskName);
}

function safeStatus(value: unknown): string | undefined {
  return typeof value === "string" && EVENT_STATUSES.has(value) ? value : undefined;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function safeDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000
    ? value
    : undefined;
}

function safeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const values = value.map(safeWord);
  return values.every((entry): entry is string => entry !== undefined) ? values : undefined;
}

function pickObject<T extends Record<string, unknown>>(value: unknown): T | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as T : undefined;
}

function safeCollaboration(value: unknown): Record<string, unknown> | undefined {
  const source = pickObject(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  const operation = safeWord(source.operation);
  const senderId = safeId(source.senderId);
  const requestedModel = safeWord(source.requestedModel);
  const requestedReasoningEffort = safeWord(source.requestedReasoningEffort);
  const status = safeStatus(source.status);
  const receiverIds = safeStringArray(source.receiverIds);
  if (operation !== undefined) result.operation = operation;
  if (senderId !== undefined) result.senderId = senderId;
  if (receiverIds !== undefined) result.receiverIds = receiverIds;
  if (requestedModel !== undefined) result.requestedModel = requestedModel;
  if (requestedReasoningEffort !== undefined) result.requestedReasoningEffort = requestedReasoningEffort;
  if (status !== undefined) result.status = status;
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeSubagentActivity(value: unknown): Record<string, unknown> | undefined {
  const source = pickObject(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  const sourceThreadId = safeId(source.sourceThreadId);
  const sourceTurnId = safeId(source.sourceTurnId);
  const parentThreadId = safeId(source.parentThreadId);
  const status = safeStatus(source.status);
  const agentPath = safeAgentPath(source.agentPath);
  const derivedTaskName = agentPath === undefined ? undefined : taskNameFromAgentPath(agentPath);
  const suppliedTaskName = safeAgentTaskName(source.agentTaskName);
  const agentTaskName = derivedTaskName !== undefined && (suppliedTaskName === undefined || suppliedTaskName === derivedTaskName)
    ? derivedTaskName
    : undefined;
  if (sourceThreadId !== undefined) result.sourceThreadId = sourceThreadId;
  if (sourceTurnId !== undefined) result.sourceTurnId = sourceTurnId;
  if (parentThreadId !== undefined) result.parentThreadId = parentThreadId;
  if (status !== undefined) result.status = status;
  if (agentPath !== undefined && agentTaskName !== undefined) {
    result.agentPath = agentPath;
    result.agentTaskName = agentTaskName;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeSettings(value: unknown): Record<string, unknown> | undefined {
  const source = pickObject(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  const model = safeWord(source.model);
  const provider = safeWord(source.provider);
  const reasoningEffort = safeWord(source.reasoningEffort);
  if (model !== undefined) result.model = model;
  if (provider !== undefined) result.provider = provider;
  if (reasoningEffort !== undefined) result.reasoningEffort = reasoningEffort;
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeReroute(value: unknown): Record<string, unknown> | undefined {
  const source = pickObject(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  const fromModel = safeWord(source.fromModel);
  const toModel = safeWord(source.toModel);
  if (fromModel !== undefined) result.fromModel = fromModel;
  if (toModel !== undefined) result.toModel = toModel;
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeItem(value: unknown): Record<string, unknown> | undefined {
  const source = pickObject(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  const sourceItemId = safeId(source.sourceItemId);
  const kind = safeWord(source.kind);
  const status = safeStatus(source.status);
  const startedAt = safeTimestamp(source.startedAt);
  const completedAt = safeTimestamp(source.completedAt);
  const durationMs = safeDuration(source.durationMs);
  const collaboration = safeCollaboration(source.collaboration);
  const subagentActivity = safeSubagentActivity(source.subagentActivity);
  const effectiveSettings = safeSettings(source.effectiveSettings);
  const modelRerouted = safeReroute(source.modelRerouted);
  const errorCode = safeWord(source.errorCode);
  if (sourceItemId !== undefined) result.sourceItemId = sourceItemId;
  if (kind !== undefined) result.kind = kind;
  if (status !== undefined) result.status = status;
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (completedAt !== undefined) result.completedAt = completedAt;
  if (durationMs !== undefined) result.durationMs = durationMs;
  if (collaboration !== undefined) result.collaboration = collaboration;
  if (subagentActivity !== undefined) result.subagentActivity = subagentActivity;
  if (effectiveSettings !== undefined) result.effectiveSettings = effectiveSettings;
  if (modelRerouted !== undefined) result.modelRerouted = modelRerouted;
  if (errorCode !== undefined) result.errorCode = errorCode;
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Copy only the NormalizedEvent fields permitted by the bridge contract.
 * This second boundary is intentional: callers cannot smuggle an unknown
 * field into persistence by casting a wire payload to NormalizedEvent.
 */
export function sanitizeNormalizedEvent(event: NormalizedEvent): Record<string, unknown> {
  const kind = EVENT_KINDS.has(event.kind) ? event.kind : "unknown";
  const result: Record<string, unknown> = { version: 1, kind };
  const sourceThreadId = safeId(event.sourceThreadId);
  const sourceTurnId = safeId(event.sourceTurnId);
  const sourceItemId = safeId(event.sourceItemId);
  const observedAt = safeTimestamp(event.observedAt);
  const startedAt = safeTimestamp(event.startedAt);
  const completedAt = safeTimestamp(event.completedAt);
  const durationMs = safeDuration(event.durationMs);
  const status = safeStatus(event.status);
  if (sourceThreadId !== undefined) result.sourceThreadId = sourceThreadId;
  if (sourceTurnId !== undefined) result.sourceTurnId = sourceTurnId;
  if (sourceItemId !== undefined) result.sourceItemId = sourceItemId;
  if (observedAt !== undefined) result.observedAt = observedAt;
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (completedAt !== undefined) result.completedAt = completedAt;
  if (durationMs !== undefined) result.durationMs = durationMs;
  if (status !== undefined) result.status = status;
  const item = safeItem(event.item);
  const collaboration = safeCollaboration(event.collaboration);
  const subagentActivity = safeSubagentActivity(event.subagentActivity);
  const effectiveSettings = safeSettings(event.effectiveSettings);
  const modelRerouted = safeReroute(event.modelRerouted);
  if (item !== undefined) result.item = item;
  if (collaboration !== undefined) result.collaboration = collaboration;
  if (subagentActivity !== undefined) result.subagentActivity = subagentActivity;
  if (effectiveSettings !== undefined) result.effectiveSettings = effectiveSettings;
  if (modelRerouted !== undefined) result.modelRerouted = modelRerouted;
  // DurableStore's public event vocabulary is intentionally flat. Keep the
  // bridge-shaped values above for local callers while also projecting the
  // corresponding allowed fields so the store does not silently lose the
  // idempotency-relevant observation details.
  if (collaboration !== undefined) {
    if (typeof collaboration.operation === "string") result.sourceOperationId = collaboration.operation;
    if (typeof collaboration.requestedModel === "string") result.requestedModel = collaboration.requestedModel;
    if (typeof collaboration.requestedReasoningEffort === "string") result.requestedEffort = collaboration.requestedReasoningEffort;
    if (typeof collaboration.status === "string") result.status = collaboration.status;
  }
  if (subagentActivity !== undefined) {
    if (typeof subagentActivity.parentThreadId === "string") result.parentSourceThreadId = subagentActivity.parentThreadId;
    if (typeof subagentActivity.status === "string") result.status = subagentActivity.status;
  }
  if (effectiveSettings !== undefined) {
    if (typeof effectiveSettings.model === "string") result.model = effectiveSettings.model;
    if (typeof effectiveSettings.provider === "string") result.provider = effectiveSettings.provider;
    if (typeof effectiveSettings.reasoningEffort === "string") result.effort = effectiveSettings.reasoningEffort;
  }
  if (modelRerouted !== undefined) {
    if (typeof modelRerouted.fromModel === "string") result.from = modelRerouted.fromModel;
    if (typeof modelRerouted.toModel === "string") result.to = modelRerouted.toModel;
  }
  if (item !== undefined) {
    if (typeof item.errorCode === "string") result.errorCode = item.errorCode;
    if (typeof item.status === "string") result.status = item.status;
  }
  return result;
}

/** Hash a configured binary without retaining its bytes or diagnostics. */
export async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filename);
  stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
  await once(stream, "end");
  return hash.digest("hex");
}

function validBinding(value: CodexRuntimeBinding | null | undefined): value is CodexRuntimeBinding {
  return Boolean(
    value &&
      value.status !== "revoked" &&
      value.status !== "expired" &&
      safeId(value.tenantId) &&
      safeId(value.ownerId) &&
      safeId(value.agentSessionId) &&
      safeId(value.sourceRootId),
  );
}

function safeReason(error: unknown): RuntimeFailure {
  // Deliberately classify by stable bridge error type only. The original
  // message/path/process details are never retained or sent to callers.
  if (error instanceof AdapterQuarantinedError) return "adapter-quarantined";
  return "transport-closed";
}

/**
 * Read-only Codex runtime controller. It exposes no generic RPC method and no
 * Codex mutation surface; the only write performed is Agent Farm's sanitized
 * event ingestion through DurableStore.ingestEvent.
 */
export class CodexRuntimeController {
  private readonly options: CodexRuntimeControllerOptions;
  private readonly schema: StableSchemaBundle;
  private readonly spawner: CodexRuntimeSpawner;
  private readonly clientFactory: CodexRuntimeClientFactory;
  private readonly listeners = new Set<(status: CodexRuntimeStatus) => void>();
  private currentClient: AppServerClient | undefined;
  private currentProcess: ChildProcessWithoutNullStreams | undefined;
  private currentBinding: CodexRuntimeBinding | undefined;
  private currentFingerprint: ConnectionFingerprint | undefined;
  private currentEpoch: string | undefined;
  private acceptingEvents = false;
  private closed = false;
  private statusValue: CodexRuntimeStatus;
  private ingestQueue: Promise<void> = Promise.resolve();
  private rejectedNotifications = 0;
  /**
   * Lifecycle notifications often have no source timestamp or event id. Keep
   * a connection-local transition ledger so A -> B -> A is not collapsed into
   * the first A, while an exact transport replay of the latest observation is
   * still idempotent.
   */
  private readonly lifecycleObservations = new Map<string, { signature: string; eventKey: string }>();
  private lifecycleTransitionOrdinal = 0;
  /**
   * One stable facade is handed to the composition root.  It resolves the
   * current gated client at call time, so pairing can be completed after
   * startup without constructing another AppServerClient.
   */
  private readonly readOnlyFacade: CodexRuntimeReadOnlyClient;

  constructor(options: CodexRuntimeControllerOptions) {
    if (!options.executable || options.executable.includes("\0")) throw new Error("invalid app-server executable");
    this.options = options;
    this.schema = options.schema;
    this.spawner = options.spawn ?? ((spawnOptions) => spawnStdioAppServer(spawnOptions));
    this.clientFactory = options.clientFactory ?? ((transport, clientOptions) => new AppServerClient(transport, clientOptions));
    this.statusValue = this.makeStatus("unpaired", "binding-unavailable");
    const controller = this;
    this.readOnlyFacade = {
      get gate(): AdapterGateResult | undefined {
        const client = controller.currentClient;
        return client?.gate?.status === "accepted" ? client.gate : undefined;
      },
      get installationId(): string | undefined {
        return controller.options.installationId;
      },
      listThreads: async (params = {}): Promise<SanitizedThreadPage> => {
        const client = controller.requireAcceptedClient();
        return client.listThreads(params);
      },
      readThread: async (params): Promise<SanitizedThreadRead> => {
        const client = controller.requireAcceptedClient();
        return client.readThread(params);
      },
      listModels: async (params = {}): Promise<SanitizedModelCatalog> => {
        const client = controller.requireAcceptedClient();
        return client.listModels(params);
      },
      readRolloutIdentity: async (threadId: string): Promise<RolloutIdentityEvidence | undefined> => {
        const client = controller.requireAcceptedClient();
        return client.readRolloutIdentity(threadId);
      },
      readRolloutLocalDetail: async (threadId: string): Promise<LocalRolloutDetail | undefined> => {
        const client = controller.requireAcceptedClient();
        return client.readRolloutLocalDetail(threadId);
      },
    };
  }

  get status(): CodexRuntimeStatus {
    return this.statusValue;
  }

  get state(): CodexRuntimeConnectionState {
    return this.statusValue.state;
  }

  ready(): boolean {
    return this.statusValue.state === "connected";
  }

  /**
   * True once the single client has passed the binary/schema/user-agent gate,
   * even when no durable Agent Farm binding exists yet.  This is intentionally
   * weaker than ready(): it authorizes only metadata root attestation.
   */
  attestationReady(): boolean {
    return this.readOnlyFacade.gate?.status === "accepted";
  }

  subscribe(listener: (status: CodexRuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Fingerprint, resolve the app-session binding, then launch and gate the
   * configured app-server. Quarantine is returned as state, not thrown.
   */
  async connect(): Promise<CodexRuntimeConnectResult> {
    if (this.closed) {
      this.closed = false;
    }
    // A pairing callback may call connect/retry directly.  Keep the already
    // gated process/client and only resolve the newly persisted binding.
    if (this.currentClient && this.currentProcess && this.currentClient.gate?.status === "accepted") {
      return this.activateBinding();
    }
    if (this.currentClient || this.currentProcess) await this.disconnect();
    this.currentFingerprint = undefined;
    this.currentEpoch = undefined;
    this.currentBinding = undefined;
    this.acceptingEvents = false;
    this.lifecycleObservations.clear();
    this.lifecycleTransitionOrdinal = 0;

    let fingerprint: ConnectionFingerprint;
    const binaryPath = this.options.binaryPath ?? this.options.executable;
    let binarySha256: string;
    try {
      if (this.options.binarySha256 === undefined) {
        binarySha256 = await sha256File(binaryPath);
      } else {
        // A launcher may provide a precomputed digest when the executable is
        // inside a sealed bundle. If the file is readable, verify rather than
        // trusting the hint; an unreadable file is still represented by the
        // supplied digest so the tested-adapter gate can fail closed.
        try {
          const actual = await sha256File(binaryPath);
          if (actual !== this.options.binarySha256) return this.setStatus("disconnected", "fingerprint-failed");
        } catch {
          // Keep the explicit launcher digest as the local fingerprint.
        }
        binarySha256 = this.options.binarySha256;
      }
      fingerprint = {
        binaryPath,
        binarySha256,
        reportedUserAgent: "",
        schemaBundleSha256: this.schema.sha256,
        ...(this.options.schemaHashes === undefined ? {} : { schemaHashes: this.options.schemaHashes }),
        connectionTime: (this.options.now ?? (() => new Date()))().toISOString(),
      };
    } catch {
      return this.setStatus("disconnected", "fingerprint-failed");
    }
    this.currentFingerprint = fingerprint;
    this.setStatus("connecting");

    let spawned: CodexRuntimeSpawnedAppServer;
    try {
      spawned = this.spawner({
        executable: this.options.executable,
        ...(this.options.args === undefined ? {} : { args: this.options.args }),
        ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
        ...(this.options.env === undefined ? {} : { env: this.options.env }),
      });
    } catch {
      this.currentBinding = undefined;
      return this.setStatus("disconnected", "spawn-failed");
    }
    this.currentProcess = spawned.process;
    this.attachProcess(spawned.process);
    this.currentEpoch = this.options.connectionEpoch ?? randomUUID();
    const clientOptions = {
      ...(this.currentEpoch === undefined ? {} : { connectionEpoch: this.currentEpoch }),
      ...(this.options.maxLineBytes === undefined ? {} : { maxLineBytes: this.options.maxLineBytes }),
      ...(this.options.rolloutIdentity === undefined ? {} : { rolloutIdentity: this.options.rolloutIdentity }),
      onEvent: (event: NormalizedEvent) => this.enqueueEvent(event),
      onRejectedNotification: () => {
        this.rejectedNotifications += 1;
        this.refreshStatus();
      },
    } satisfies ConstructorParameters<typeof AppServerClient>[1];
    let client: AppServerClient;
    try {
      client = this.clientFactory(this.monitorTransport(spawned.transport), clientOptions);
    } catch {
      this.currentBinding = undefined;
      await this.disposeProcess();
      return this.setStatus("disconnected", "spawn-failed");
    }
    this.currentClient = client;
    this.currentEpoch = client.connectionEpoch;
    try {
      const connection = await client.connect({
        initializeParams: this.options.initializeParams ?? DEFAULT_INITIALIZE_PARAMS,
        schema: this.schema,
        testedAdapters: this.options.testedAdapters,
        binaryPath,
        binarySha256,
        ...(this.options.schemaHashes === undefined ? {} : { schemaHashes: this.options.schemaHashes }),
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      });
      this.currentEpoch = connection.connectionEpoch;
      this.currentFingerprint = connection.gate.fingerprint;
      // The adapter is accepted before any durable binding is required. Keep
      // the process/client alive for source-root attestation, but leave event
      // ingestion disabled until activateBinding() succeeds.
      const binding = await this.resolveBinding({
        fingerprint: this.currentFingerprint,
        connectionEpoch: this.currentEpoch,
      });
      if (!binding) {
        this.currentBinding = undefined;
        this.acceptingEvents = false;
        this.setStatus("unpaired", "binding-unavailable", connection.gate);
        return this.statusValue;
      }
      this.currentBinding = binding;
      this.acceptingEvents = true;
      this.setStatus("connected", undefined, connection.gate);
      return this.statusValue;
    } catch (error: unknown) {
      this.acceptingEvents = false;
      const gate = error instanceof AdapterQuarantinedError ? error.gate : client.gate;
      await this.disposeProcess();
      this.currentClient = undefined;
      this.currentBinding = undefined;
      if (gate?.status === "quarantined") {
        return this.setStatus("quarantined", "adapter-quarantined", gate);
      }
      return this.setStatus("disconnected", safeReason(error));
    }
  }

  /**
   * Resolve and activate the durable binding on the existing accepted client.
   * If no client survived startup this safely falls back to a full connect.
   */
  async activateBinding(): Promise<CodexRuntimeStatus> {
    if (this.closed) this.closed = false;
    const client = this.currentClient;
    const fingerprint = this.currentFingerprint;
    if (!client || !this.currentProcess || client.gate?.status !== "accepted" || !fingerprint) {
      return this.connect();
    }
    const binding = await this.resolveBinding({
      fingerprint,
      ...(this.currentEpoch === undefined ? {} : { connectionEpoch: this.currentEpoch }),
    });
    if (!binding) {
      this.acceptingEvents = false;
      this.currentBinding = undefined;
      return this.setStatus("unpaired", "binding-unavailable", client.gate);
    }
    this.currentBinding = binding;
    this.acceptingEvents = true;
    this.lifecycleObservations.clear();
    this.lifecycleTransitionOrdinal = 0;
    return this.setStatus("connected", undefined, client.gate);
  }

  /** Stop the local child and prevent queued notifications from ingesting. */
  async disconnect(reason: "closed" | "transport-closed" | "binding-revoked" = "closed"): Promise<CodexRuntimeStatus> {
    if (reason === "binding-revoked") return this.deactivateBinding(reason);
    this.acceptingEvents = false;
    const client = this.currentClient;
    this.currentClient = undefined;
    this.currentBinding = undefined;
    this.lifecycleObservations.clear();
    if (client) {
      try {
        await client.close();
      } catch {
        // The public state remains truthful even when a child is already gone.
      }
    }
    await this.disposeProcess();
    return this.setStatus("disconnected", reason);
  }

  /** Disable ingestion immediately while retaining the accepted read-only
   * client for a subsequent explicit pairing/activation retry. */
  async deactivateBinding(reason: "binding-revoked" | "binding-unavailable" = "binding-revoked"): Promise<CodexRuntimeStatus> {
    this.acceptingEvents = false;
    this.currentBinding = undefined;
    if (this.currentClient?.gate?.status === "accepted") {
      return this.setStatus("unpaired", reason, this.currentClient.gate);
    }
    return this.setStatus("unpaired", reason);
  }

  async close(): Promise<CodexRuntimeStatus> {
    this.closed = true;
    return this.disconnect("closed");
  }

  /** Wait until all already-received notifications have reached the store. */
  async flushEvents(): Promise<void> {
    await this.ingestQueue;
  }

  /**
   * Return the deliberately narrow snapshot surface for reconciliation.
   *
   * The controller owns the app-server client and never exposes its generic
   * request method. A caller can only list/read sanitized thread snapshots,
   * and only while the connection is still accepted. The facade is created
   * per call so a stale reference cannot be mistaken for a live connection.
   */
  getSnapshotClient(options: { readonly metadataOnly?: boolean; readonly includeRolloutIdentity?: boolean } = {}): CodexSnapshotClient | undefined {
    const client = this.currentClient;
    if (!client || !this.ready()) return undefined;
    const facade: CodexSnapshotClient = {
      listThreads: async (params) => client.listThreads((params ?? {}) as JsonObject),
      // A production root can contain a very large rollout history. Agent
      // Farm's reviewed AppServerClient line cap is 8 MiB, while Codex
      // 0.145.0 thread/read is one-shot and exposes no read pagination. An
      // oversized history can therefore close the transport before retry.
      // Runtime reconciliation requests structural metadata only; live
      // sanitized notifications continue to supply turn/activity detail.
      readThread: async (params) => client.readThread({
        ...(params as JsonObject),
        ...(options.metadataOnly === true ? { includeTurns: false } : {}),
      }),
    };
    // Structural reconciliation stays metadata-only for thread/read, but the
    // bounded local rollout reader is a separate exact-current evidence path.
    // Expose it in both modes so metadata-only reconciliation does not silently
    // downgrade canonical identity to "unverified". The bridge reader remains
    // read-only, size-bounded, and fail-closed when path/turn correlation is
    // unavailable.
    if (options.includeRolloutIdentity === true || options.metadataOnly !== true) {
      facade.readRolloutIdentity = async (threadId: string): Promise<RolloutIdentityEvidence | undefined> => client.readRolloutIdentity(threadId);
    }
    return facade;
  }

  /** Stable narrow facade used by pairing/source-root authority. */
  getReadOnlyClient(): CodexRuntimeReadOnlyClient {
    return this.readOnlyFacade;
  }

  private async resolveBinding(request: CodexRuntimeBindingRequest): Promise<CodexRuntimeBinding | null> {
    if (!this.options.bindingResolver) return null;
    try {
      const value = await this.options.bindingResolver(request);
      return validBinding(value) ? value : null;
    } catch {
      return null;
    }
  }

  private requireAcceptedClient(): AppServerClient {
    const client = this.currentClient;
    if (!client || client.gate?.status !== "accepted") {
      throw new Error("Codex bridge adapter is not accepted");
    }
    return client;
  }

  private attachProcess(child: ChildProcessWithoutNullStreams): void {
    child.once("exit", () => {
      if (this.currentProcess !== child) return;
      this.acceptingEvents = false;
      this.currentClient = undefined;
      this.currentProcess = undefined;
      this.currentBinding = undefined;
      this.setStatus("disconnected", "transport-closed");
    });
    child.once("error", () => {
      if (this.currentProcess !== child) return;
      this.acceptingEvents = false;
      this.currentClient = undefined;
      this.currentProcess = undefined;
      this.currentBinding = undefined;
      this.setStatus("disconnected", "transport-closed");
    });
  }

  private monitorTransport(transport: LineTransport): LineTransport {
    return {
      send: (line) => transport.send(line),
      subscribe: (handler, onError) => transport.subscribe(
        handler,
        async (error) => {
          if (this.acceptingEvents || this.currentClient !== undefined) {
            this.acceptingEvents = false;
            this.currentClient = undefined;
            this.currentBinding = undefined;
            this.setStatus("disconnected", "transport-closed");
            await this.disposeProcess();
          }
          await onError?.(error);
        },
      ),
      close: () => transport.close(),
    };
  }

  private async disposeProcess(): Promise<void> {
    const child = this.currentProcess;
    this.currentProcess = undefined;
    if (!child) return;
    try {
      if ((child.exitCode === null || child.exitCode === undefined) && !child.killed) child.kill();
    } catch {
      // Process termination is best effort; state is already disconnected.
    }
  }

  private enqueueEvent(event: NormalizedEvent): void {
    const task = this.ingestQueue.then(async () => {
      if (!this.acceptingEvents || !this.currentBinding || !this.currentFingerprint || !this.currentEpoch) return;
      const binding = await this.resolveBinding({ fingerprint: this.currentFingerprint, connectionEpoch: this.currentEpoch });
      if (!binding) {
        await this.disconnect("binding-revoked");
        return;
      }
      if (
        binding.tenantId !== this.currentBinding.tenantId ||
        binding.ownerId !== this.currentBinding.ownerId ||
        binding.agentSessionId !== this.currentBinding.agentSessionId ||
        binding.sourceRootId !== this.currentBinding.sourceRootId
      ) {
        await this.disconnect("binding-revoked");
        return;
      }
      const payload = sanitizeNormalizedEvent(event);
      if (!EVENT_KINDS.has(event.kind)) return;
      const sourceThreadId = safeId(event.sourceThreadId);
      if (!sourceThreadId) return;
      let sourceAllowed = sourceThreadId === binding.sourceRootId;
      if (!sourceAllowed && this.options.sourceThreadAllowed) {
        try {
          sourceAllowed = await this.options.sourceThreadAllowed(binding, sourceThreadId);
        } catch {
          sourceAllowed = false;
        }
      }
      if (!sourceAllowed) return;
      const sourceTurnId = safeId(event.sourceTurnId);
      const sourceItemId = safeId(event.sourceItemId);
      const normalizedStatus = safeStatus(event.status);
      const normalizedObservedAt = safeTimestamp(event.observedAt);
      const scope = { tenantId: binding.tenantId, ownerId: binding.ownerId, agentSessionId: binding.agentSessionId };
      // The wire event is still sanitized above. This local projection hint
      // is looked up from the already-durable source mapping and is never
      // accepted from the Codex payload itself.
      if (event.kind === "thread.status.changed") {
        try {
          const sourceAdapter = this.options.sourceAdapter ?? "codex-app-server";
          const agent = this.options.store.agents.list(scope).find((candidate) =>
            candidate.sourceThreadId === sourceThreadId && candidate.sourceAdapter === sourceAdapter,
          );
          if (agent) payload.agentId = agent.agentId;
        } catch {
          // A missing projection is safe; reconciliation will establish it.
        }
      }
      let eventKey: string;
      try {
        const canonicalKey = canonicalObservationKey({
          ...event,
          sourceThreadId,
          ...(sourceTurnId === undefined ? {} : { sourceTurnId }),
          ...(sourceItemId === undefined ? {} : { sourceItemId }),
          ...(normalizedStatus === undefined ? {} : { status: normalizedStatus as NormalizedEvent["status"] }),
          ...(normalizedObservedAt === undefined ? {} : { observedAt: normalizedObservedAt }),
        } as NormalizedEvent);
        eventKey = canonicalKey;
        if (event.kind === "thread.status.changed" && normalizedObservedAt === undefined) {
          const observationId = `${event.kind}:${sourceThreadId}`;
          const signature = JSON.stringify(payload);
          const previous = this.lifecycleObservations.get(observationId);
          if (previous?.signature === signature) {
            // Exact replay of the current observation: retain its key.
            eventKey = previous.eventKey;
          } else {
            this.lifecycleTransitionOrdinal += 1;
            eventKey = `${canonicalKey}|arrival:${this.lifecycleTransitionOrdinal}`;
            this.lifecycleObservations.set(observationId, { signature, eventKey });
          }
        }
      } catch {
        return;
      }
      const observedAtMillis = normalizedObservedAt === undefined ? undefined : Date.parse(normalizedObservedAt);
      const result = this.options.store.ingestEvent(
        scope,
        {
          eventKey,
          eventType: event.kind,
          connectionEpoch: this.currentEpoch,
          sourceAdapter: this.options.sourceAdapter ?? "codex-app-server",
          sourceThreadId,
          ...(sourceTurnId === undefined ? {} : { turnId: sourceTurnId }),
          ...(sourceItemId === undefined ? {} : { itemId: sourceItemId }),
          ...(normalizedStatus === undefined ? {} : { status: normalizedStatus }),
          payload,
          authority: "notification",
          redactionVersion: "v1",
          ...(observedAtMillis === undefined ? {} : { observedAt: observedAtMillis }),
        },
      );
      this.statusValue = { ...this.statusValue, lastIngestOutcome: result.outcome };
      this.emitStatus();
      if (result.outcome === "inserted") {
        try {
          this.options.onProjectionHint?.();
        } catch {
          // A scheduler hint cannot compromise notification persistence.
        }
      }
    });
    this.ingestQueue = task.catch(() => undefined);
    void task.catch(() => {
      this.acceptingEvents = false;
      this.setStatus("disconnected", "ingest-failed");
    });
  }

  private makeStatus(state: CodexRuntimeConnectionState, reason?: CodexRuntimeStatus["reason"], gate?: AdapterGateResult): CodexRuntimeStatus {
    return {
      state,
      status: state,
      ...(this.currentEpoch === undefined ? {} : { connectionEpoch: this.currentEpoch }),
      ...(gate === undefined ? {} : { gate }),
      ...(this.currentFingerprint === undefined ? {} : { fingerprint: this.currentFingerprint }),
      ...(reason === undefined ? {} : { reason }),
      rejectedNotificationCount: this.rejectedNotifications,
      ...(this.statusValue?.lastIngestOutcome === undefined ? {} : { lastIngestOutcome: this.statusValue.lastIngestOutcome }),
    };
  }

  private setStatus(state: CodexRuntimeConnectionState, reason?: CodexRuntimeStatus["reason"], gate?: AdapterGateResult): CodexRuntimeStatus {
    this.statusValue = this.makeStatus(state, reason, gate);
    this.emitStatus();
    return this.statusValue;
  }

  private refreshStatus(): void {
    this.statusValue = this.makeStatus(this.statusValue.state, this.statusValue.reason, this.statusValue.gate);
    this.emitStatus();
  }

  private emitStatus(): void {
    const snapshot = this.statusValue;
    try {
      this.options.onStatusChange?.(snapshot);
    } catch {
      // Status observers cannot compromise the bridge lifecycle.
    }
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Status observers cannot compromise the bridge lifecycle.
      }
    }
  }
}
