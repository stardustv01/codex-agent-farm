import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  PHASE_A_BINARY_SHA256,
  PHASE_A_SCHEMA_HASHES,
  PHASE_A_USER_AGENT_PREFIX,
  createTrustedLocalRolloutResolver,
  generateStableSchemaBundle,
  validateStableSchema,
  type ConnectionFingerprint,
  type StableSchemaBundle,
  type TestedAdapter,
  type TrustedLocalRolloutResolver,
} from "@agent-farm/codex-bridge";
import { DurableStore, type PrincipalScope } from "@agent-farm/store";

import {
  CodexRuntimeController,
  type CodexRuntimeBinding,
  type CodexRuntimeBindingRequest,
  type CodexRuntimeConnectionState,
  type CodexRuntimeControllerOptions,
  type CodexRuntimeReadOnlyClient,
  type CodexRuntimeStatus,
} from "./codex-runtime.js";
import {
  CodexReconciliationError,
  reconcileCodexSnapshot,
  type CodexReconciliationLimits,
  type CodexReconciliationResult,
} from "./codex-reconciler.js";
import { reviewedPricingProvider, type ReviewedPricingProvider } from "./pricing.js";

/** The service only accepts a binding that has passed the runtime gate. */
export type DurableCodexBindingLookup = (
  request: CodexRuntimeBindingRequest,
) => CodexRuntimeBinding | null | Promise<CodexRuntimeBinding | null>;

/** Selector for the public durable bridge-binding repository. */
export interface DurableCodexBindingSelector {
  readonly scope: PrincipalScope;
  readonly installationId: string;
  readonly sourceRootId?: string;
  readonly now?: () => number;
}

export type CodexRuntimeReconciliationState = "idle" | "running" | "reconciled" | "failed" | "skipped";

export interface CodexRuntimeReconciliationStatus {
  readonly state: CodexRuntimeReconciliationState;
  readonly lastResult?: CodexReconciliationResult;
  /** A stable classification only; raw bridge/store errors are never kept. */
  readonly errorCode?: string;
}

export type CodexRuntimeServiceReason =
  | NonNullable<CodexRuntimeStatus["reason"]>
  | "unsupported-adapter"
  | "reconciliation-failed"
  | "binding-unavailable"
  | "stopped";

export interface CodexRuntimeServiceStatus {
  readonly state: CodexRuntimeConnectionState;
  /** Alias for hosts that use status as the connection discriminant. */
  readonly status: CodexRuntimeConnectionState;
  /** True when the lifecycle is enabled; it does not imply a live child. */
  readonly running: boolean;
  readonly controller: CodexRuntimeStatus;
  readonly reconciliation: CodexRuntimeReconciliationStatus;
  /** Flattened aliases make health checks possible without unpacking fields. */
  readonly reconciliationState: CodexRuntimeReconciliationState;
  readonly connectionEpoch?: string;
  readonly fingerprint?: ConnectionFingerprint;
  readonly rejectedNotificationCount: number;
  readonly lastIngestOutcome?: CodexRuntimeStatus["lastIngestOutcome"];
  readonly gate?: CodexRuntimeStatus["gate"];
  readonly reason?: CodexRuntimeServiceReason;
  readonly retryAttempt: number;
}

export interface CodexRuntimeServiceOptions
  extends Omit<CodexRuntimeControllerOptions, "bindingResolver" | "onStatusChange"> {
  /** The durable lookup is intentionally injected; DurableStore has no global binding query. */
  readonly bindingResolver?: DurableCodexBindingLookup;
  /** Descriptive alias for callers wiring a durable binding repository. */
  readonly durableBindingLookup?: DurableCodexBindingLookup;
  /** Optional selector for the store's durable bridgeBindings repository. */
  readonly durableBinding?: DurableCodexBindingSelector;
  readonly reconciliationIntervalMs?: number;
  /** Defaults to true; a successful connection gets a complete snapshot before idle polling. */
  readonly reconcileOnConnect?: boolean;
  readonly reconcilerLimits?: CodexReconciliationLimits;
  readonly pricing?: ReviewedPricingProvider;
  /** Test seam for a content-free sessions-root change hint source. */
  readonly sessionsWatcherFactory?: SessionsWatcherFactory;
  readonly sessionsWatcherDebounceMs?: number;
  readonly onStatusChange?: (status: CodexRuntimeServiceStatus) => void;
  /** Test seam; production uses CodexRuntimeController directly. */
  readonly controllerFactory?: (options: CodexRuntimeControllerOptions) => CodexRuntimeController;
}

export interface SessionsWatcherHandle { close(): void }
export type SessionsWatcherFactory = (
  sessionsRoot: string,
  onHint: () => void,
  onError: () => void,
) => SessionsWatcherHandle;

export type ProductionCodexRuntimeOptions = Omit<CodexRuntimeServiceOptions, "store">;

const ID = /^[A-Za-z0-9._:-]{1,256}$/;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 30_000;
const MAX_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_WATCH_DEBOUNCE_MS = 250;
const MAX_WATCHED_DIRECTORIES = 512;
const MAX_WATCH_DISCOVERY_ENTRIES = 5_000;

function defaultSessionsWatcher(sessionsRoot: string, onHint: () => void, onError: () => void): SessionsWatcherHandle {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let refreshing = false;
  let refreshPending = false;
  const refresh = async (): Promise<void> => {
    if (closed) return;
    if (refreshing) {
      refreshPending = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshPending = false;
        const pending: Array<{ path: string; depth: number }> = [{ path: sessionsRoot, depth: 0 }];
        let examined = 0;
        while (pending.length > 0 && !closed) {
          const current = pending.pop();
          if (!current) break;
          const stat = await lstat(current.path);
          if (closed) break;
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
          if (!watchers.has(current.path)) {
            if (watchers.size >= MAX_WATCHED_DIRECTORIES) throw new Error("watch-bound");
            const watcher = watch(current.path, { persistent: false }, () => { onHint(); void refresh(); });
            watcher.on("error", onError);
            if (closed) {
              watcher.close();
              break;
            }
            watchers.set(current.path, watcher);
          }
          if (current.depth >= 8) continue;
          const entries = await readdir(current.path, { withFileTypes: true });
          if (closed) break;
          for (const entry of entries) {
            if (++examined > MAX_WATCH_DISCOVERY_ENTRIES) throw new Error("watch-bound");
            if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
          }
        }
      } while (refreshPending && !closed);
    } catch { onError(); } finally { refreshing = false; }
  };
  void refresh();
  return { close: () => { closed = true; for (const watcher of watchers.values()) watcher.close(); watchers.clear(); } };
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function validBinding(value: CodexRuntimeBinding | null | undefined): value is CodexRuntimeBinding {
  return Boolean(
    value &&
      value.status !== "revoked" &&
      value.status !== "expired" &&
      validId(value.tenantId) &&
      validId(value.ownerId) &&
      validId(value.agentSessionId) &&
      validId(value.sourceRootId),
  );
}

function sameBinding(left: CodexRuntimeBinding, right: CodexRuntimeBinding): boolean {
  return left.tenantId === right.tenantId &&
    left.ownerId === right.ownerId &&
    left.agentSessionId === right.agentSessionId &&
    left.sourceRootId === right.sourceRootId;
}

/**
 * Validate the retained schema and explicit adapter allowlist before a child
 * can be launched. This deliberately does not generate a production default.
 */
function supportedAnchors(schema: StableSchemaBundle | undefined, adapters: readonly TestedAdapter[] | undefined): boolean {
  if (!schema || !Array.isArray(schema.methods) || !Array.isArray(adapters) || adapters.length === 0) return false;
  try {
    const validation = validateStableSchema(schema);
    const generated = generateStableSchemaBundle(schema.methods, schema.version);
    if (!validation.valid || generated.sha256 !== schema.sha256) return false;
    return adapters.some((adapter) =>
      typeof adapter.adapterVersion === "string" && adapter.adapterVersion.length > 0 &&
      typeof adapter.userAgentPrefix === "string" && adapter.userAgentPrefix.length > 0 &&
      typeof adapter.binarySha256 === "string" && adapter.binarySha256.length > 0 &&
      adapter.schemaBundleSha256 === schema.sha256,
    );
  } catch {
    return false;
  }
}

function interval(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECONCILIATION_INTERVAL_MS;
  if (!Number.isFinite(value) || value < 1) return DEFAULT_RECONCILIATION_INTERVAL_MS;
  return Math.min(Math.floor(value), MAX_RECONCILIATION_INTERVAL_MS);
}

function durableLookup(store: DurableStore, selector: DurableCodexBindingSelector): DurableCodexBindingLookup {
  return () => {
    try {
      if (store.readSession(selector.scope).status !== "active") return null;
      const now = selector.now?.() ?? Date.now();
      const candidates = store.bridgeBindings.list(selector.scope)
        .filter((binding) =>
          binding.installationId === selector.installationId &&
          (selector.sourceRootId === undefined || binding.selectedSourceRootId === selector.sourceRootId) &&
          binding.sourceAdapter === "codex-app-server" &&
          binding.status === "active" &&
          binding.expiresAt > now,
        )
        .sort((left, right) => right.createdAt - left.createdAt || right.bindingId.localeCompare(left.bindingId));
      if (selector.sourceRootId === undefined && new Set(candidates.map((candidate) => candidate.selectedSourceRootId)).size > 1) return null;
      const selected = candidates[0];
      if (!selected) return null;
      return {
        tenantId: selected.tenantId,
        ownerId: selected.ownerId,
        agentSessionId: selected.agentSessionId,
        sourceRootId: selected.selectedSourceRootId,
        installationId: selected.installationId,
        status: selected.status,
      };
    } catch {
      return null;
    }
  };
}

function errorCode(error: unknown): string {
  if (error instanceof CodexReconciliationError) return error.code;
  return "RECONCILIATION_FAILED";
}

/**
 * Owns the production lifecycle around one read-only Codex runtime.
 *
 * The controller remains the authority for process, protocol, event
 * sanitisation, and binding continuity. This layer only decides when to
 * connect, when to run a bounded snapshot reconciliation, and when to stop.
 */
export class CodexRuntimeService {
  private readonly options: CodexRuntimeServiceOptions;
  private readonly controller: CodexRuntimeController;
  private readonly lookup: DurableCodexBindingLookup | undefined;
  private readonly anchorsSupported: boolean;
  private readonly intervalMs: number;
  private readonly localRollout: TrustedLocalRolloutResolver | undefined;
  private readonly listeners = new Set<(status: CodexRuntimeServiceStatus) => void>();
  private statusValue: CodexRuntimeServiceStatus;
  private running = false;
  private retryCount = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sessionsWatcher: SessionsWatcherHandle | undefined;
  private watcherDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** A failed watcher stays disabled until an explicit lifecycle start/retry. */
  private watcherUnavailable = false;
  /** Filesystem hints never compete with the first authoritative reconciliation. */
  private watcherEligible = false;
  private observedBinding: CodexRuntimeBinding | undefined;
  /** Source ids admitted by the last fully validated snapshot. */
  private readonly allowedSourceThreadIds = new Set<string>();
  private reconcilePromise: Promise<CodexReconciliationResult | undefined> | undefined;
  /** At most one follow-up run is retained while reconciliation is active. */
  private reconcilePending = false;
  private reconciliationSequence = 0;
  private lastReconciliationId: string | undefined;
  private lastReconciliationFailed = false;
  /** A background refresh must not hide the last valid snapshot. */
  private hasReconciledCurrentBinding = false;
  private lifecycleQueue: Promise<void> = Promise.resolve();

  constructor(options: CodexRuntimeServiceOptions) {
    this.options = options;
    this.lookup = options.bindingResolver ?? options.durableBindingLookup ??
      (options.durableBinding === undefined ? undefined : durableLookup(options.store, options.durableBinding));
    this.anchorsSupported = supportedAnchors(options.schema, options.testedAdapters);
    this.intervalMs = interval(options.reconciliationIntervalMs);
    this.localRollout = options.rolloutIdentity === undefined ? undefined : createTrustedLocalRolloutResolver(options.rolloutIdentity);

    const {
      bindingResolver: _configuredBindingResolver,
      durableBindingLookup: _durableBindingLookup,
      durableBinding: _durableBinding,
      reconciliationIntervalMs: _reconciliationIntervalMs,
      reconcileOnConnect: _reconcileOnConnect,
      reconcilerLimits: _reconcilerLimits,
      pricing: _pricing,
      sessionsWatcherFactory: _sessionsWatcherFactory,
      sessionsWatcherDebounceMs: _sessionsWatcherDebounceMs,
      onStatusChange: _serviceStatusObserver,
      controllerFactory: _controllerFactory,
      onProjectionHint: configuredProjectionHint,
      sourceThreadAllowed: configuredSourceThreadAllowed,
      ...controllerOptionsBase
    } = options;
    const sourceThreadAllowed = async (binding: CodexRuntimeBinding, sourceThreadId: string): Promise<boolean> => {
      if (this.allowedSourceThreadIds.has(sourceThreadId)) return true;
      if (!configuredSourceThreadAllowed) return false;
      try {
        return await configuredSourceThreadAllowed(binding, sourceThreadId);
      } catch {
        return false;
      }
    };
    const controllerOptions = this.lookup === undefined
      ? {
          ...controllerOptionsBase,
          sourceThreadAllowed,
          onStatusChange: (status: CodexRuntimeStatus): void => this.handleControllerStatus(status),
          onProjectionHint: (): void => {
            this.requestEventReconciliation();
            try { configuredProjectionHint?.(); } catch { /* observer isolation */ }
          },
        }
      : {
          ...controllerOptionsBase,
          sourceThreadAllowed,
          bindingResolver: async (request: CodexRuntimeBindingRequest): Promise<CodexRuntimeBinding | null> => {
            let binding: CodexRuntimeBinding | null;
            try {
              binding = await this.lookup?.(request) ?? null;
            } catch {
              binding = null;
            }
            if (validBinding(binding) && this.observedBinding === undefined) this.observedBinding = binding;
            return binding;
          },
          onStatusChange: (status: CodexRuntimeStatus): void => this.handleControllerStatus(status),
          onProjectionHint: (): void => {
            this.requestEventReconciliation();
            try { configuredProjectionHint?.(); } catch { /* observer isolation */ }
          },
        };
    const factory = options.controllerFactory ?? ((value: CodexRuntimeControllerOptions) => new CodexRuntimeController(value));
    this.controller = factory(controllerOptions);
    this.statusValue = this.makeStatus(
      this.anchorsSupported ? this.controller.status : {
        ...this.controller.status,
        state: "quarantined",
        status: "quarantined",
        reason: "adapter-quarantined",
      },
      this.anchorsSupported ? undefined : "unsupported-adapter",
    );
  }

  get status(): CodexRuntimeServiceStatus {
    return this.statusValue;
  }

  get state(): CodexRuntimeConnectionState {
    return this.statusValue.state;
  }

  ready(): boolean {
    return this.running && this.anchorsSupported && this.controller.ready() &&
      (this.options.reconcileOnConnect === false || (
        this.hasReconciledCurrentBinding &&
        (this.statusValue.reconciliation.state === "reconciled" || this.statusValue.reconciliation.state === "running")
      ));
  }

  /** True when the adapter gate is accepted for pre-pair root attestation. */
  attestationReady(): boolean {
    return this.running && this.anchorsSupported && this.controller.attestationReady();
  }

  /** Stable narrow facade shared with pairing/source-root authority. */
  getReadOnlyClient(): CodexRuntimeReadOnlyClient {
    const client = this.controller.getReadOnlyClient();
    if (!this.localRollout) return client;
    const localRollout = this.localRollout;
    return {
      get gate() { return client.gate; },
      get installationId() { return client.installationId; },
      listThreads: client.listThreads,
      readThread: client.readThread,
      listModels: client.listModels,
      readRolloutIdentity: (threadId) => localRollout.readIdentity(threadId),
      readRolloutLocalDetail: (threadId) => localRollout.readDetail(threadId),
    };
  }

  subscribe(listener: (status: CodexRuntimeServiceStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<CodexRuntimeServiceStatus> {
    return this.serialized(async () => {
      if (this.running) return this.statusValue;
      this.running = true;
      this.retryCount += 1;
      this.watcherUnavailable = false;
      this.watcherEligible = false;
      this.hasReconciledCurrentBinding = false;
      this.observedBinding = undefined;
      this.allowedSourceThreadIds.clear();
      if (!this.anchorsSupported) {
        this.publishUnsupported();
        return this.statusValue;
      }
      this.publish(this.controller.status);
      const connected = await this.connectAndReconcile();
      return connected;
    });
  }

  /** Retry pairing/gating after a disconnected or unpaired start. */
  async retry(): Promise<CodexRuntimeServiceStatus> {
    return this.serialized(async () => {
      if (!this.running) {
        this.running = true;
        this.retryCount += 1;
      } else {
        this.retryCount += 1;
      }
      this.clearTimer();
      this.clearWatcher();
      this.watcherUnavailable = false;
      this.watcherEligible = false;
      this.hasReconciledCurrentBinding = false;
      // An explicit retry follows a newly committed pairing. Reset the
      // service-side continuity cache so the controller can activate and
      // reconcile that authoritative durable binding.
      this.observedBinding = undefined;
      this.allowedSourceThreadIds.clear();
      this.hasReconciledCurrentBinding = false;
      if (!this.anchorsSupported) {
        this.publishUnsupported();
        return this.statusValue;
      }
      // Always resolve the durable binding again before reconciliation. The
      // controller may still be connected to a previously selected task when
      // local pairing atomically replaces that binding; reconciling first
      // would run against the stale scope and make the new pairing fail.
      const activated = await this.controller.activateBinding();
      if (activated.state === "connected") {
        if (this.options.reconcileOnConnect !== false) await this.reconcileNowInternal(true);
        this.schedule();
        return this.statusValue;
      }
      this.clearTimer();
      // A lost transport cannot be reactivated in place. Spawn and gate a
      // fresh metadata client so an active durable binding remount recovers
      // without requiring the user to pair again.
      if (activated.state === "disconnected") return this.connectAndReconcile();
      this.publish(activated);
      return this.statusValue;
    });
  }

  /** Stop polling and close the child without deleting any durable projection. */
  async stop(): Promise<CodexRuntimeServiceStatus> {
    return this.serialized(async () => {
      this.running = false;
      this.reconcilePending = false;
      this.clearTimer();
      this.clearWatcher();
      if (this.reconcilePromise) await this.reconcilePromise.catch(() => undefined);
      this.observedBinding = undefined;
      this.allowedSourceThreadIds.clear();
      const status = await this.controller.disconnect("closed");
      this.publish(status, "stopped");
      return this.statusValue;
    });
  }

  async close(): Promise<CodexRuntimeServiceStatus> {
    return this.stop();
  }

  async flushEvents(): Promise<void> {
    await this.controller.flushEvents();
  }

  /**
   * Run or join the active bounded reconciliation. A call made while one is
   * active marks one follow-up run pending, but resolves with the active run;
   * event freshness is consumed through the revision endpoint, not this API.
   */
  async reconcileNow(): Promise<CodexReconciliationResult | undefined> {
    return this.reconcileNowInternal(false);
  }

  private async reconcileNowInternal(reuseFailedAttempt: boolean): Promise<CodexReconciliationResult | undefined> {
    if (this.reconcilePromise) {
      this.reconcilePending = true;
      return this.reconcilePromise;
    }
    if (!this.running || !this.anchorsSupported || !this.controller.ready()) {
      if (this.running && this.statusValue.reconciliation.state !== "skipped") {
        this.setReconciliation({ state: "skipped", errorCode: "RUNTIME_NOT_CONNECTED" });
      }
      return undefined;
    }

    const connectionEpoch = this.controller.status.connectionEpoch;
    if (!connectionEpoch) {
      this.setReconciliation({ state: "skipped", errorCode: "RUNTIME_NOT_CONNECTED" });
      return undefined;
    }
    const reconciliationId = reuseFailedAttempt && this.lastReconciliationFailed && this.lastReconciliationId
      ? this.lastReconciliationId
      : `runtime-reconcile:${connectionEpoch}:${++this.reconciliationSequence}`;
    this.lastReconciliationId = reconciliationId;
    this.lastReconciliationFailed = false;
    const task = this.performReconciliation(reconciliationId);
    this.reconcilePromise = task;
    try {
      return await task;
    } finally {
      if (this.reconcilePromise === task) this.reconcilePromise = undefined;
      const rerun = this.reconcilePending;
      this.reconcilePending = false;
      if (rerun && this.running && this.anchorsSupported && this.controller.ready()) {
        // Start one coalesced follow-up after the active run has fully
        // released its single-flight slot. Any further burst can set the same
        // pending bit again, but cannot create an unbounded queue.
        void this.reconcileNowInternal(false);
      }
    }
  }

  /** Alias used by lifecycle callers that describe the operation as reconcile. */
  async reconcile(): Promise<CodexReconciliationResult | undefined> {
    return this.reconcileNow();
  }

  private async connectAndReconcile(): Promise<CodexRuntimeServiceStatus> {
    let status: CodexRuntimeStatus;
    try {
      status = await this.controller.connect();
    } catch {
      this.clearTimer();
      this.publish({
        ...this.controller.status,
        state: "disconnected",
        status: "disconnected",
        reason: "spawn-failed",
      }, "spawn-failed");
      return this.statusValue;
    }
    if (status.state !== "connected") {
      this.clearTimer();
      this.publish(status);
      return this.statusValue;
    }
    if (this.options.reconcileOnConnect !== false) await this.reconcileNowInternal(false);
    this.schedule();
    return this.statusValue;
  }

  private async performReconciliation(reconciliationId: string): Promise<CodexReconciliationResult | undefined> {
    const controllerStatus = this.controller.status;
    const fingerprint = controllerStatus.fingerprint;
    const connectionEpoch = controllerStatus.connectionEpoch;
    if (!fingerprint || !connectionEpoch || !this.lookup) {
      this.lastReconciliationFailed = true;
      this.setReconciliation({ state: "skipped", errorCode: "BINDING_UNAVAILABLE" });
      return undefined;
    }

    let binding: CodexRuntimeBinding | null = null;
    try {
      binding = await this.lookup({ fingerprint, connectionEpoch });
    } catch {
      binding = null;
    }
    if (!validBinding(binding)) {
      this.lastReconciliationFailed = true;
      this.hasReconciledCurrentBinding = false;
      await this.controller.deactivateBinding("binding-revoked");
      this.observedBinding = undefined;
      this.setReconciliation({ state: "skipped", errorCode: "BINDING_UNAVAILABLE" });
      this.publish(this.controller.status, "binding-unavailable");
      return undefined;
    }
    if (this.observedBinding && !sameBinding(this.observedBinding, binding)) {
      this.lastReconciliationFailed = true;
      this.hasReconciledCurrentBinding = false;
      await this.controller.deactivateBinding("binding-revoked");
      this.observedBinding = undefined;
      this.setReconciliation({ state: "skipped", errorCode: "BINDING_REVOKED" });
      this.publish(this.controller.status, "binding-unavailable");
      return undefined;
    }
    this.observedBinding = binding;

    // Structural reconciliation deliberately avoids loading complete rollout
    // turns: Agent Farm's reviewed AppServerClient line cap is 8 MiB, while
    // Codex 0.145.0 thread/read is one-shot with no read pagination. An
    // oversized history can therefore close the transport before retry.
    // Thread/list metadata still carries the authoritative parent/lifecycle
    // graph; live sanitized notifications provide subsequent activity detail.
    // Do not couple structural recovery to rollout enrichment. The app-server
    // identity helper currently requires a full thread/read response, which is
    // unbounded for large active tasks and can close the shared metadata
    // transport. Canonical rollout identity/detail is read separately from the
    // trusted local rollout file; a restart must always recover the hierarchy
    // first and leave unavailable enrichment truthful.
    const metadataClient = this.controller.getSnapshotClient({ metadataOnly: true, includeRolloutIdentity: false });
    if (!metadataClient) {
      this.lastReconciliationFailed = true;
      this.hasReconciledCurrentBinding = false;
      this.setReconciliation({ state: "failed", errorCode: "RUNTIME_CLIENT_UNAVAILABLE" });
      return undefined;
    }
    const localRollout = this.localRollout;
    const client = localRollout === undefined ? metadataClient : {
      ...metadataClient,
      readRolloutIdentity: (threadId: string) => localRollout.readIdentity(threadId),
      discoverRolloutTopology: (rootThreadId: string) => localRollout.discoverTopology(rootThreadId),
    };
    this.setReconciliation({ state: "running" });
    try {
      const result = await reconcileCodexSnapshot({
        client,
        store: this.options.store,
        binding,
        connectionEpoch,
        reconciliationId,
        sourceAdapter: this.options.sourceAdapter ?? "codex-app-server",
        ...(this.options.reconcilerLimits === undefined ? {} : { limits: this.options.reconcilerLimits }),
        pricing: this.options.pricing ?? reviewedPricingProvider(),
      });
      this.lastReconciliationFailed = false;
      this.hasReconciledCurrentBinding = true;
      this.allowedSourceThreadIds.clear();
      for (const sourceThreadId of result.sourceThreadIds) this.allowedSourceThreadIds.add(sourceThreadId);
      this.setReconciliation({ state: "reconciled", lastResult: result });
      this.watcherEligible = true;
      // Do not make filesystem discovery part of reconciliation latency. The
      // interval is already authoritative; this optional hint source begins
      // only after the durable snapshot and ready state are published.
      queueMicrotask(() => this.startWatcher());
      return result;
    } catch (error: unknown) {
      const code = errorCode(error);
      this.lastReconciliationFailed = true;
      this.hasReconciledCurrentBinding = false;
      this.setReconciliation({ state: "failed", errorCode: code });
      if (this.controller.state === "disconnected") {
        this.publish(this.controller.status, "transport-closed");
        return undefined;
      }
      if (code === "INVALID_BINDING" || code === "SESSION_NOT_FOUND") {
        await this.controller.deactivateBinding("binding-revoked");
        this.observedBinding = undefined;
        this.publish(this.controller.status, "binding-unavailable");
      } else {
        this.publish(this.controller.status, "reconciliation-failed");
      }
      return undefined;
    }
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.running || !this.controller.ready()) return;
    this.timer = setInterval(() => {
      void this.reconcileNow();
    }, this.intervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
    this.startWatcher();
  }

  private startWatcher(): void {
    if (this.sessionsWatcher || this.watcherUnavailable || !this.watcherEligible || !this.running || !this.controller.ready() || this.options.rolloutIdentity === undefined) return;
    const factory = this.options.sessionsWatcherFactory ?? defaultSessionsWatcher;
    let factoryFailed = false;
    try {
      const watcher = factory(this.options.rolloutIdentity.sessionsRoot, () => {
        if (this.watcherDebounceTimer !== undefined) clearTimeout(this.watcherDebounceTimer);
        const delay = Math.max(10, Math.min(this.options.sessionsWatcherDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS, 1_000));
        this.watcherDebounceTimer = setTimeout(() => {
          this.watcherDebounceTimer = undefined;
          this.requestEventReconciliation();
        }, delay);
        (this.watcherDebounceTimer as unknown as { unref?: () => void }).unref?.();
      }, () => {
        factoryFailed = true;
        this.watcherUnavailable = true;
        this.clearWatcher();
      });
      this.sessionsWatcher = watcher;
      // A test seam or future implementation may report failure
      // synchronously before returning its handle. Never retain that handle.
      if (factoryFailed) this.clearWatcher();
    } catch {
      this.watcherUnavailable = true;
      this.clearWatcher();
    }
  }

  private clearWatcher(): void {
    if (this.watcherDebounceTimer !== undefined) clearTimeout(this.watcherDebounceTimer);
    this.watcherDebounceTimer = undefined;
    this.sessionsWatcher?.close();
    this.sessionsWatcher = undefined;
  }

  private requestEventReconciliation(): void {
    if (!this.running || !this.anchorsSupported || !this.controller.ready()) return;
    if (this.reconcilePromise) {
      this.reconcilePending = true;
      return;
    }
    void this.reconcileNowInternal(false);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private handleControllerStatus(status: CodexRuntimeStatus): void {
    if (status.state !== "connected") { this.clearTimer(); this.clearWatcher(); }
    if (status.state === "unpaired" || status.state === "disconnected" || status.state === "quarantined") {
      this.watcherEligible = false;
      this.hasReconciledCurrentBinding = false;
      this.allowedSourceThreadIds.clear();
    }
    this.publish(status);
    if (status.state === "connected" && this.running) this.schedule();
  }

  private publishUnsupported(): void {
    const controller: CodexRuntimeStatus = {
      ...this.controller.status,
      state: "quarantined",
      status: "quarantined",
      reason: "adapter-quarantined",
    };
    this.publish(controller, "unsupported-adapter");
  }

  private makeStatus(controller: CodexRuntimeStatus, reason?: CodexRuntimeServiceReason): CodexRuntimeServiceStatus {
    const reconciliation = this.statusValue?.reconciliation ?? { state: "idle" as const };
    return {
      state: controller.state,
      status: controller.status,
      running: this.running,
      controller,
      reconciliation,
      reconciliationState: reconciliation.state,
      ...(controller.connectionEpoch === undefined ? {} : { connectionEpoch: controller.connectionEpoch }),
      ...(controller.fingerprint === undefined ? {} : { fingerprint: controller.fingerprint }),
      rejectedNotificationCount: controller.rejectedNotificationCount,
      ...(controller.lastIngestOutcome === undefined ? {} : { lastIngestOutcome: controller.lastIngestOutcome }),
      ...(controller.gate === undefined ? {} : { gate: controller.gate }),
      ...(reason === undefined ? {} : { reason }),
      retryAttempt: this.retryCount,
    };
  }

  private publish(controller: CodexRuntimeStatus, reason?: CodexRuntimeServiceReason): void {
    const previousReason = this.statusValue?.reason;
    const nextReason = reason ?? controller.reason ?? (controller.state === "connected" ? undefined : previousReason);
    this.statusValue = this.makeStatus(controller, nextReason);
    const snapshot = this.statusValue;
    try {
      this.options.onStatusChange?.(snapshot);
    } catch {
      // A health observer cannot compromise process or persistence lifecycle.
    }
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers are isolated from the runtime.
      }
    }
  }

  private setReconciliation(reconciliation: CodexRuntimeReconciliationStatus): void {
    this.statusValue = {
      ...this.statusValue,
      reconciliation,
      reconciliationState: reconciliation.state,
    };
    const snapshot = this.statusValue;
    try {
      this.options.onStatusChange?.(snapshot);
    } catch {
      // A health observer cannot compromise process or persistence lifecycle.
    }
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers are isolated from the runtime.
      }
    }
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(task, task);
    this.lifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Build the explicit Phase-A Codex anchors for callers that have retained the evidence. */
export function createSupportedCodexRuntimeAnchors(): {
  readonly schema: StableSchemaBundle;
  readonly schemaHashes: Readonly<Record<string, string>>;
  readonly testedAdapters: readonly TestedAdapter[];
} {
  const schema = generateStableSchemaBundle();
  return {
    schema,
    schemaHashes: PHASE_A_SCHEMA_HASHES,
    testedAdapters: Object.freeze([{
      adapterVersion: "codex-app-server-phase-a",
      binarySha256: PHASE_A_BINARY_SHA256,
      schemaBundleSha256: schema.sha256,
      schemaHashes: PHASE_A_SCHEMA_HASHES,
      userAgentPrefix: PHASE_A_USER_AGENT_PREFIX,
    }]),
  };
}

/** Type helper for composition callers that need the service's store injected there. */
export type RuntimeServiceFactory = (options: CodexRuntimeServiceOptions) => CodexRuntimeService;
