import { DurableStore } from "@agent-farm/store";

import type { PairingChallenge } from "./contracts.js";
import type { CodexRuntimeReadOnlyClient } from "./codex-runtime.js";
import {
  CodexRuntimeService,
  type CodexRuntimeServiceStatus,
  type ProductionCodexRuntimeOptions,
} from "./runtime-service.js";

// The normal local path activates one chat projection at a time. Keep the
// bounded LRU as a defense-in-depth safety net for legacy/injected callers so
// an unexpected concurrent binding cannot grow child processes without bound.
const DEFAULT_MAX_CHAT_PROJECTIONS = 4;

type ActivePairing = Pick<PairingChallenge,
  "tenantId" | "ownerId" | "agentSessionId" | "installationId" | "sourceRootId"
>;

interface ManagedProjection {
  readonly binding: ActivePairing;
  readonly bindingRef: { current: ActivePairing };
  readonly service: CodexRuntimeService;
  readonly lastUsed: number;
}

/**
 * The discovery service owns the shared selector/attestation surface, while
 * the selected chat receives an exact fail-closed runtime service. Exclusive
 * activation stops the previous app-server child before mounting the new one.
 * The projection map remains bounded as a safety net outside that normal path.
 */
export class CodexRuntimeManager {
  readonly discoveryService: CodexRuntimeService;
  private readonly projections = new Map<string, ManagedProjection>();
  private readonly maxChatProjections: number;
  private accessSequence = 0;
  private running = false;

  constructor(
    private readonly options: ProductionCodexRuntimeOptions,
    private readonly store: DurableStore,
    maxChatProjections = DEFAULT_MAX_CHAT_PROJECTIONS,
  ) {
    this.maxChatProjections = Math.max(1, Math.min(Math.floor(maxChatProjections), DEFAULT_MAX_CHAT_PROJECTIONS));
    this.discoveryService = new CodexRuntimeService({
      ...this.baseOptions(),
      store,
      bindingResolver: () => null,
      reconcileOnConnect: false,
    });
  }

  getReadOnlyClient(): CodexRuntimeReadOnlyClient {
    return this.discoveryService.getReadOnlyClient();
  }

  attestationReady(): boolean {
    return this.discoveryService.attestationReady();
  }

  ready(): boolean {
    return [...this.projections.values()].some(({ service }) => service.ready());
  }

  connectionStateForScope(scope: { readonly tenantId: string; readonly ownerId: string; readonly agentSessionId: string }): "connected" | "disconnected" | "unverified" {
    const projection = [...this.projections.values()].find(({ binding }) =>
      binding.tenantId === scope.tenantId && binding.ownerId === scope.ownerId && binding.agentSessionId === scope.agentSessionId,
    );
    if (projection?.service.ready()) return "connected";
    if (projection !== undefined) return "disconnected";
    return "unverified";
  }

  async start(): Promise<CodexRuntimeServiceStatus> {
    this.running = true;
    const status = await this.discoveryService.start();
    const installationId = this.options.installationId;
    if (installationId !== undefined) {
      const binding = this.store.bridgeBindings.resolveUniqueActive(installationId);
      if (binding !== null) {
        await this.ensurePairing({
          tenantId: binding.tenantId,
          ownerId: binding.ownerId,
          agentSessionId: binding.agentSessionId,
          installationId: binding.installationId,
          sourceRootId: binding.selectedSourceRootId,
        }).catch(() => undefined);
      }
    }
    return status;
  }

  /**
   * Mount one exact durable binding and tear down every other chat worker.
   * Resolve the durable singleton first so a stale or ambiguous switch cannot
   * stop the currently authorized projection.
   */
  async ensureExclusivePairing(binding: ActivePairing): Promise<void> {
    if (!this.running) throw new Error("runtime manager is stopped");
    if (binding.installationId !== this.options.installationId) throw new Error("runtime installation mismatch");
    const durable = this.store.bridgeBindings.resolveUniqueActive(binding.installationId);
    if (durable === null ||
      durable.tenantId !== binding.tenantId ||
      durable.ownerId !== binding.ownerId ||
      durable.agentSessionId !== binding.agentSessionId ||
      durable.selectedSourceRootId !== binding.sourceRootId) {
      throw new Error("runtime binding unavailable");
    }
    await this.deactivateExcept(binding.installationId, binding.sourceRootId);
    await this.ensurePairing(binding);
  }

  /** Stop and forget every chat projection except the selected source root. */
  async deactivateExcept(installationId: string, keepSourceRootId: string): Promise<void> {
    if (!this.running) throw new Error("runtime manager is stopped");
    if (installationId !== this.options.installationId) throw new Error("runtime installation mismatch");
    const services: CodexRuntimeService[] = [];
    for (const [sourceRootId, projection] of this.projections) {
      if (sourceRootId === keepSourceRootId) continue;
      this.projections.delete(sourceRootId);
      services.push(projection.service);
    }
    await Promise.all(services.map(async (service) => service.stop()));
  }

  async ensurePairing(binding: ActivePairing): Promise<void> {
    if (!this.running) throw new Error("runtime manager is stopped");
    if (binding.installationId !== this.options.installationId) throw new Error("runtime installation mismatch");
    const durable = this.store.bridgeBindings.listActiveForInstallation(binding.installationId).find((candidate) =>
      candidate.tenantId === binding.tenantId &&
      candidate.ownerId === binding.ownerId &&
      candidate.agentSessionId === binding.agentSessionId &&
      candidate.selectedSourceRootId === binding.sourceRootId,
    );
    if (durable === undefined) throw new Error("runtime binding unavailable");
    const existing = this.projections.get(binding.sourceRootId);
    if (existing !== undefined) {
      if (!this.sameBinding(existing.binding, binding)) throw new Error("runtime root ownership mismatch");
      this.projections.set(binding.sourceRootId, { ...existing, lastUsed: ++this.accessSequence });
      if (!existing.service.ready()) await existing.service.retry();
      if (!existing.service.ready()) throw new Error("runtime reconciliation unavailable");
      return;
    }
    if (this.projections.size >= this.maxChatProjections) {
      const oldest = [...this.projections.entries()].sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
      if (oldest !== undefined) {
        this.projections.delete(oldest[0]);
        // Retarget the already accepted read-only app-server connection. A
        // fresh child spawn is the expensive part of first sync on a busy
        // machine; activateBinding() safely replaces the exact durable scope
        // before the reused service accepts events or reconciles.
        oldest[1].bindingRef.current = binding;
        const reused = { ...oldest[1], binding, lastUsed: ++this.accessSequence };
        this.projections.set(binding.sourceRootId, reused);
        try {
          await reused.service.retry();
          if (!reused.service.ready()) throw new Error("runtime reconciliation unavailable");
          return;
        } catch {
          this.projections.delete(binding.sourceRootId);
          await reused.service.stop().catch(() => undefined);
        }
      }
    }
    const bindingRef = { current: binding };
    const service = new CodexRuntimeService({
      ...this.baseOptions(),
      store: this.store,
      bindingResolver: () => {
        const selected = bindingRef.current;
        const current = this.store.bridgeBindings.listActiveForInstallation(selected.installationId).find((candidate) =>
          candidate.tenantId === selected.tenantId &&
          candidate.ownerId === selected.ownerId &&
          candidate.agentSessionId === selected.agentSessionId &&
          candidate.selectedSourceRootId === selected.sourceRootId,
        );
        return current === undefined ? null : { ...selected, status: "active" as const };
      },
    });
    this.projections.set(binding.sourceRootId, { binding, bindingRef, service, lastUsed: ++this.accessSequence });
    try {
      await service.start();
      if (!service.ready()) throw new Error("runtime reconciliation unavailable");
    } catch (error) {
      this.projections.delete(binding.sourceRootId);
      await service.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    const services = [...this.projections.values()].map(({ service }) => service);
    this.projections.clear();
    await Promise.allSettled(services.map((service) => service.stop()));
    await this.discoveryService.stop();
  }

  private baseOptions(): ProductionCodexRuntimeOptions {
    const {
      bindingResolver: _bindingResolver,
      durableBindingLookup: _durableBindingLookup,
      durableBinding: _durableBinding,
      reconcileOnConnect: _reconcileOnConnect,
      ...base
    } = this.options;
    return base;
  }

  private sameBinding(left: ActivePairing, right: ActivePairing): boolean {
    return left.tenantId === right.tenantId && left.ownerId === right.ownerId &&
      left.agentSessionId === right.agentSessionId && left.installationId === right.installationId &&
      left.sourceRootId === right.sourceRootId;
  }
}
