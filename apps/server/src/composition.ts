import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";

import type {
  AdapterGateResult,
  JsonObject,
  JsonValue,
  SanitizedModelCatalog,
  SanitizedThreadPage,
  SanitizedThreadRead,
} from "@agent-farm/codex-bridge";
import { CODEX_DISCOVERY_SOURCE_KINDS } from "@agent-farm/codex-bridge";
import {
  createMcpApplication,
  getToolDescriptors,
  type AgentFarmMcpBackend,
  type AuthContextProvider,
  type McpApplication,
  type UiResourceConfig,
} from "@agent-farm/mcp";
import {
  ConstraintError,
  DurableStore,
  NotFoundError,
  type AppSession,
  type SessionSnapshot,
  type StoreOptions,
} from "@agent-farm/store";
import {
  LocalAgentDetailSchema,
  LOCAL_DETAIL_SCHEMA_VERSION,
  type LocalAgentDetail,
  type LocalCostEstimate,
} from "@agent-farm/contracts";
import type { LocalRolloutDetail } from "@agent-farm/codex-bridge";

import { createApp, type ServerOptions } from "./index.js";
import { createCodexSourceRootAuthority } from "./source-root-authority.js";
import {
  CodexRuntimeService,
  type CodexRuntimeServiceStatus,
  type ProductionCodexRuntimeOptions,
} from "./runtime-service.js";
import { CodexRuntimeManager } from "./runtime-manager.js";
import type { CodexRuntimeReadOnlyClient } from "./codex-runtime.js";
import type {
  AgentDetails,
  AgentSessionRecord,
  ActivePairingRuntimeInput,
  BridgePort,
  CreateAgentSessionInput,
  HierarchyPage,
  McpPort,
  McpTool,
  PairingChallenge,
  PairingSignatureInput,
  Principal,
  SessionScope,
  SourceRootCandidate,
  SourceRootAttestationRecord,
  SourceRootAttestationRequest,
  StorePort,
} from "./contracts.js";
import { loadProductionMcpResource } from "./resource-loader.js";
import { projectPublicHierarchy, publicAgentId } from "./public-hierarchy.js";

/**
 * The HTTP layer intentionally depends on narrow ports.  This adapter is the
 * only place where those ports are backed by the durable SQLite projection.
 * No raw Codex payload is accepted here; the bridge has already minimized it
 * before an event reaches the store.
 */
export class DurableStorePort implements StorePort {
  private connectionStateProvider?: (scope: SessionScope) => "connected" | "disconnected" | "unverified";
  private localDetailReader?: (sourceThreadId: string) => Promise<LocalRolloutDetail | undefined>;

  constructor(readonly durable: DurableStore) {}

  setConnectionStateProvider(provider: (scope: SessionScope) => "connected" | "disconnected" | "unverified"): void {
    this.connectionStateProvider = provider;
  }

  setLocalDetailReader(reader: (sourceThreadId: string) => Promise<LocalRolloutDetail | undefined>): void {
    this.localDetailReader = reader;
  }

  ready(): boolean {
    // better-sqlite3 exposes `open`; a closed database is never a usable
    // server dependency.  The property is deliberately read-only here.
    return this.durable.db.open;
  }

  async createAgentSession(input: CreateAgentSessionInput): Promise<AgentSessionRecord> {
    try {
      const session = this.durable.createAgentSession({
        tenantId: input.tenantId,
        ownerId: input.ownerId,
        agentSessionId: input.agentSessionId,
        sourceAdapter: input.payload.sourceAdapter ?? "codex-app-server",
        capabilities: input.payload.capabilities ?? [],
        idempotencyKey: input.idempotencyKey,
        requestPayload: input.payload,
      });
      return mapSession(session, input.payload.label);
    } catch (error: unknown) {
      // MCP remounts deliberately reuse the same grant-bound session ID. A
      // fresh idempotency key is still a safe replay of that scoped session;
      // same-key payload conflicts are checked by SessionRepository before
      // this branch and therefore continue to fail closed.
      if (!(error instanceof ConstraintError) || error.code !== "SESSION_EXISTS") throw error;
      try {
        const existing = this.durable.readSession({
          tenantId: input.tenantId,
          ownerId: input.ownerId,
          agentSessionId: input.agentSessionId,
        });
        return mapSession(existing, input.payload.label);
      } catch {
        // A cross-owner or deleted scope must not turn into an existence
        // oracle. Preserve the original store error for the HTTP boundary.
        throw error;
      }
    }
  }

  async getAgentSession(scope: SessionScope): Promise<AgentSessionRecord | null> {
    try {
      return mapSession(this.durable.readSession(scope));
    } catch (error: unknown) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async getSession(scope: SessionScope): Promise<AgentSessionRecord | null> {
    return this.getAgentSession(scope);
  }

  async getHierarchy(
    scope: SessionScope & { readonly page: number; readonly pageSize: number },
  ): Promise<HierarchyPage | null> {
    let snapshot: SessionSnapshot;
    try {
      snapshot = this.durable.getSnapshot(scope);
    } catch (error: unknown) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }

    return projectPublicHierarchy({
      snapshot,
      events: this.durable.events.list(scope),
      page: scope.page,
      pageSize: scope.pageSize,
      ...(this.connectionStateProvider === undefined ? {} : { connectionState: this.connectionStateProvider(scope) }),
    }).page as unknown as HierarchyPage;
  }

  async getHierarchyRevision(scope: SessionScope): Promise<number | null> {
    try {
      return this.durable.getSnapshot(scope).watermarkIngestOrdinal;
    } catch (error: unknown) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async getAgentDetails(
    scope: SessionScope & { readonly agentId: string },
  ): Promise<AgentDetails | null> {
    try {
      const snapshot = this.durable.getSnapshot(scope);
      const details = projectPublicHierarchy({
        snapshot,
        events: this.durable.events.list(scope),
        page: 1,
        pageSize: 200,
        ...(this.connectionStateProvider === undefined ? {} : { connectionState: this.connectionStateProvider(scope) }),
      }).details(scope.agentId);
      return details as unknown as AgentDetails | null;
    } catch (error: unknown) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async getDetails(
    scope: SessionScope & { readonly agentId: string },
  ): Promise<AgentDetails | null> {
    return this.getAgentDetails(scope);
  }

  async getLocalAgentDetails(
    scope: SessionScope & { readonly agentId: string },
  ): Promise<LocalAgentDetail | null> {
    try {
      const snapshot = this.durable.getSnapshot(scope);
      const internal = snapshot.agents.find((agent) => agent.agentId === scope.agentId || agent.sourceThreadId === scope.agentId || publicAgentId(agent.agentId) === scope.agentId);
      if (!internal) return null;
      const parentEdge = snapshot.edges.find((edge) => edge.childAgentId === internal.agentId);
      const parent = parentEdge === undefined
        ? internal.parentSourceThreadId === null ? null : snapshot.agents.find((agent) => agent.sourceThreadId === internal.parentSourceThreadId) ?? null
        : snapshot.agents.find((agent) => agent.agentId === parentEdge.parentAgentId) ?? null;
      const children = snapshot.edges.filter((edge) => edge.parentAgentId === internal.agentId).map((edge) => snapshot.agents.find((agent) => agent.agentId === edge.childAgentId)).filter((agent): agent is NonNullable<typeof agent> => agent !== undefined);
      const publicProject = projectPublicHierarchy({ snapshot, events: this.durable.events.list(scope), page: 1, pageSize: 200 });
      // Resolve through the canonical public-id projection, not displayName.
      // Names are neither unique nor identity-bearing, and privacy filtering
      // can deliberately replace them with generic labels.
      const publicByInternal = new Map(snapshot.agents.map((agent) => [
        agent.agentId,
        publicProject.page.nodes.find((node) => node.agentId === publicAgentId(agent.agentId)),
      ] as const));
      const publicAgent = publicByInternal.get(internal.agentId) ?? null;
      const parentPublic = parent === null ? null : publicByInternal.get(parent.agentId) ?? null;
      const childPublic = children.map((child) => publicByInternal.get(child.agentId)).filter((node): node is NonNullable<typeof node> => node !== undefined);
      if (!publicAgent) return null;
      const rolloutDetail = internal.sourceThreadId === null ? undefined : await this.localDetailReader?.(internal.sourceThreadId);
      const cost = aggregateAgentCost(snapshot, internal.agentId);
      return LocalAgentDetailSchema.parse({
        schemaVersion: LOCAL_DETAIL_SCHEMA_VERSION,
        agentSessionId: scope.agentSessionId,
        agent: publicAgent,
        parent: parentPublic,
        children: childPublic,
        activity: rolloutDetail?.activity ?? [],
        messages: rolloutDetail?.messages ?? [],
        tools: rolloutDetail?.tools ?? [],
        changedFiles: rolloutDetail?.changedFiles ?? [],
        ...(rolloutDetail?.finalSummary === undefined && internal.resultSummary === null ? {} : { summary: rolloutDetail?.finalSummary ?? internal.resultSummary! }),
        ...(internal.usage === null ? {} : { usage: internal.usage }),
        ...(internal.usageSegments === null ? {} : { usageSegments: internal.usageSegments }),
        cost,
      });
    } catch (error: unknown) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }
}

interface AggregatedCost {
  readonly projection: LocalCostEstimate;
  /** Known subtotal for this node and its complete descendants. */
  readonly knownTotalMicros: number;
  readonly complete: boolean;
}

/**
 * Recompute the local display tree from durable self-costs and durable edges.
 * Persisted child/total fields are not trusted as recursive summaries: the
 * reconciler writes per-agent projections, while this endpoint owns the
 * current hierarchy aggregate. Each descendant self-cost is therefore counted
 * exactly once, even for trees deeper than one generation.
 */
function aggregateAgentCost(snapshot: SessionSnapshot, rootAgentId: string): LocalCostEstimate {
  const agents = new Map(snapshot.agents.map((agent) => [agent.agentId, agent] as const));
  const children = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    const values = children.get(edge.parentAgentId) ?? [];
    values.push(edge.childAgentId);
    children.set(edge.parentAgentId, values);
  }
  const memo = new Map<string, AggregatedCost>();
  const visiting = new Set<string>();

  const visit = (agentId: string): AggregatedCost => {
    const prior = memo.get(agentId);
    if (prior !== undefined) return prior;
    const agent = agents.get(agentId);
    if (agent === undefined || visiting.has(agentId)) {
      return {
        projection: { status: "unavailable", currency: "USD", reason: "invalid-agent-hierarchy" },
        knownTotalMicros: 0,
        complete: false,
      };
    }
    visiting.add(agentId);
    const descendants = (children.get(agentId) ?? []).map(visit);
    visiting.delete(agentId);
    const knownChildrenMicros = descendants.reduce((sum, child) => sum + child.knownTotalMicros, 0);
    const childrenComplete = descendants.every((child) => child.complete);
    const own = agent.cost;
    const knownSelfMicros = own?.status === "estimated"
      ? own.selfMicros
      : own?.status === "partial"
        ? own.knownSelfMicros ?? 0
        : 0;
    const selfComplete = own?.status === "estimated";
    const complete = selfComplete && childrenComplete;
    let projection: LocalCostEstimate;
    if (complete && own?.status === "estimated") {
      projection = {
        ...own,
        childrenMicros: knownChildrenMicros,
        totalMicros: own.selfMicros + knownChildrenMicros,
      };
    } else if (knownSelfMicros > 0 || knownChildrenMicros > 0 || descendants.length > 0 || own?.status === "partial") {
      projection = {
        status: "partial",
        currency: "USD",
        ...(knownSelfMicros > 0 ? { knownSelfMicros } : {}),
        ...(knownChildrenMicros > 0 ? { knownChildrenMicros } : {}),
        reason: selfComplete ? "descendant-cost-unavailable" : "self-cost-unavailable",
        ...(own?.status === "estimated" ? { pricing: own.pricing } : own?.status === "partial" && own.pricing ? { pricing: own.pricing } : {}),
      };
    } else {
      projection = own ?? { status: "unavailable", currency: "USD", reason: "pricing-unavailable" };
    }
    const result = { projection, knownTotalMicros: knownSelfMicros + knownChildrenMicros, complete };
    memo.set(agentId, result);
    return result;
  };

  return visit(rootAgentId).projection;
}

export interface ReadOnlyCodexBridgeClient {
  readonly gate?: AdapterGateResult | undefined;
  readonly installationId?: string | undefined;
  readonly listThreads: (params?: JsonObject) => Promise<SanitizedThreadPage>;
  readonly readThread: (params: JsonObject) => Promise<SanitizedThreadRead>;
  readonly listModels: (params?: JsonObject) => Promise<SanitizedModelCatalog>;
  readonly readRolloutLocalDetail?: (threadId: string) => Promise<LocalRolloutDetail | undefined>;
  readonly close?: () => Promise<void>;
}

export interface ReadOnlyCodexBridgeOptions {
  readonly client?: ReadOnlyCodexBridgeClient | CodexRuntimeReadOnlyClient;
  readonly durable?: DurableStore;
  readonly verifyPairingSignature?: (
    input: PairingSignatureInput,
  ) => boolean | Promise<boolean>;
  readonly credentialTtlMs?: number;
  readonly sourceRootAuthority?: {
    attestSourceRoot(input: SourceRootAttestationRequest): Promise<SourceRootAttestationRecord>;
  };
  /** Optional runtime-owned readiness/state hooks. */
  readonly runtimeReady?: () => boolean;
  readonly runtimeConnectionState?: () => "connected" | "disconnected" | "unverified";
  /** Called after the durable binding is written, never before. */
  readonly onCredentialIssued?: (input: ActivePairingRuntimeInput) => void | Promise<void>;
}

/**
 * A Codex adapter with an intentionally tiny surface.  It exposes only the
 * allowlisted app-server read methods already enforced by AppServerClient
 * (listThreads, readThread, listModels) and local pairing operations; it has
 * no generic RPC, process, filesystem, or control method.  Pairing
 * credentials are Agent Farm records and do not grant Codex mutation
 * authority.
 */
export class ReadOnlyCodexBridgeAdapter implements BridgePort {
  private readonly client: ReadOnlyCodexBridgeClient | undefined;
  private readonly durable: DurableStore | undefined;
  private readonly signatureVerifier?: ReadOnlyCodexBridgeOptions["verifyPairingSignature"];
  private readonly credentialTtlMs: number;
  private readonly sourceRootAuthority: ReadOnlyCodexBridgeOptions["sourceRootAuthority"];
  private readonly runtimeReady?: ReadOnlyCodexBridgeOptions["runtimeReady"];
  private readonly runtimeConnectionState?: ReadOnlyCodexBridgeOptions["runtimeConnectionState"];
  private readonly onCredentialIssued?: ReadOnlyCodexBridgeOptions["onCredentialIssued"];

  constructor(options: ReadOnlyCodexBridgeOptions = {}) {
    this.client = options.client;
    this.durable = options.durable;
    this.signatureVerifier = options.verifyPairingSignature;
    this.sourceRootAuthority = options.sourceRootAuthority;
    this.runtimeReady = options.runtimeReady;
    this.runtimeConnectionState = options.runtimeConnectionState;
    this.onCredentialIssued = options.onCredentialIssued;
    this.credentialTtlMs = Math.min(
      Math.max(options.credentialTtlMs ?? 24 * 60 * 60 * 1_000, 60_000),
      7 * 24 * 60 * 60 * 1_000,
    );
  }

  ready(): boolean {
    if (this.runtimeReady !== undefined) return this.runtimeReady();
    return this.client !== undefined && this.client.gate?.status === "accepted";
  }

  connectionState(): "connected" | "disconnected" | "unverified" {
    if (this.runtimeConnectionState !== undefined) return this.runtimeConnectionState();
    if (this.client === undefined) return "unverified";
    return this.client.gate?.status === "accepted" ? "connected" : "disconnected";
  }

  async listThreads(params?: JsonObject): Promise<SanitizedThreadPage> {
    return this.requireClient().listThreads(params);
  }

  async readThread(params: JsonObject): Promise<SanitizedThreadRead> {
    return this.requireClient().readThread(params);
  }

  async listModels(params?: JsonObject): Promise<SanitizedModelCatalog> {
    return this.requireClient().listModels(params);
  }

  /**
   * Bounded root candidates for the local pairing selector. Only structural
   * metadata is copied: a candidate never carries prompts, turns, or raw
   * app-server payloads.
   */
  async listSourceRoots(): Promise<readonly SourceRootCandidate[]> {
    const client = this.requireClient();
    const candidates: SourceRootCandidate[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 5 && candidates.length < 100; pageNumber += 1) {
      const params: JsonObject = {
        archived: false,
        useStateDbOnly: false,
        sourceKinds: CODEX_DISCOVERY_SOURCE_KINDS as unknown as JsonValue,
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
      };
      const page = await client.listThreads(params);
      for (const thread of page.threads) {
        // A real Codex root is a thread without a parent. Threads with a
        // parent are subagents and can never be selected as the source root.
        if (thread.parentThreadId !== undefined) continue;
        candidates.push({
          sourceRootId: thread.sourceThreadId,
          ...(thread.chatTitle === undefined ? {} : { chatTitle: thread.chatTitle }),
          ...(thread.workspaceName === undefined ? {} : { workspaceName: thread.workspaceName }),
          ...(thread.agentNickname === undefined ? {} : { nickname: thread.agentNickname }),
          ...(thread.agentPath === undefined ? {} : { agentPath: thread.agentPath }),
          status: thread.status,
          ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
        });
        if (candidates.length >= 100) break;
      }
      const nextCursor = page.nextCursor;
      if (candidates.length >= 100 || nextCursor === undefined || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return candidates;
  }

  async hasActivePairing(input: {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId: string;
  }): Promise<boolean> {
    if (this.durable === undefined) return false;
    const bindings = this.durable.bridgeBindings.list({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      agentSessionId: input.agentSessionId,
    });
    const now = this.durable.now();
    return bindings.some((binding) =>
      binding.installationId === input.installationId &&
      binding.selectedSourceRootId === input.sourceRootId &&
      binding.status === "active" &&
      binding.expiresAt > now,
    );
  }

  async resolveActivePairing(installationId: string): Promise<{
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId: string;
  } | null> {
    if (this.durable === undefined) return null;
    const selected = this.durable.bridgeBindings.resolveUniqueActive(installationId);
    return selected === null ? null : {
      tenantId: selected.tenantId,
      ownerId: selected.ownerId,
      agentSessionId: selected.agentSessionId,
      installationId: selected.installationId,
      sourceRootId: selected.selectedSourceRootId,
    };
  }

  async listActivePairings(installationId: string): Promise<readonly {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId: string;
  }[]> {
    if (this.durable === undefined) return [];
    return this.durable.bridgeBindings.listActiveForInstallation(installationId).map((selected) => ({
      tenantId: selected.tenantId,
      ownerId: selected.ownerId,
      agentSessionId: selected.agentSessionId,
      installationId: selected.installationId,
      sourceRootId: selected.selectedSourceRootId,
    }));
  }

  async ensureActivePairing(input: ActivePairingRuntimeInput): Promise<void> {
    if (!await this.hasActivePairing(input)) throw new Error("runtime binding unavailable");
    await this.onCredentialIssued?.(input);
  }

  async revokePairing(input: {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId?: string;
    readonly reason?: "switch" | "unpair";
  }): Promise<boolean> {
    if (this.durable === undefined) return false;
    return this.durable.transaction(() => {
      const changed = this.durable!.bridgeBindings.revokeActive({
        tenantId: input.tenantId,
        ownerId: input.ownerId,
        agentSessionId: input.agentSessionId,
      }, input.installationId, input.sourceRootId);
      if (changed > 0) {
        this.durable!.audit.append({
          tenantId: input.tenantId,
          ownerId: input.ownerId,
          agentSessionId: input.agentSessionId,
          action: input.reason === "switch" ? "bridge.pairing.switched" : "bridge.pairing.unpaired",
          actorType: "local-session",
          actorId: `local-${hashSecret(input.ownerId).slice(0, 32)}`,
          metadata: {
            installationDigest: hashSecret(input.installationId),
            bindingCount: changed,
          },
        });
      }
      return changed > 0;
    });
  }

  async verifyPairingSignature(input: PairingSignatureInput): Promise<boolean> {
    if (this.signatureVerifier) return Boolean(await this.signatureVerifier(input));
    try {
      const key = createPublicKey(input.publicKey);
      const signature = decodeSignature(input.signature);
      // The bridge accepts signatures over the canonical challenge message
      // only.  Ed25519 has a null digest; RSA/ECDSA callers may provide a key
      // whose algorithm is handled by Node's default verification semantics.
      return verifySignature(null, Buffer.from(input.message, "utf8"), key, signature);
    } catch {
      return false;
    }
  }

  async attestSourceRoot(input: SourceRootAttestationRequest): Promise<SourceRootAttestationRecord> {
    if (!this.sourceRootAuthority) throw new Error("Codex source-root authority is unavailable");
    const attestation = await this.sourceRootAuthority.attestSourceRoot(input);
    if (
      attestation.installationId !== input.installationId ||
      attestation.sourceRootId !== input.sourceRootId ||
      !Number.isFinite(Date.parse(attestation.expiresAt)) ||
      Date.parse(attestation.expiresAt) <= Date.now()
    ) {
      throw new Error("Codex source-root attestation is invalid");
    }
    return attestation;
  }

  async issuePairingCredential(input: PairingChallenge): Promise<{ credential: string; expiresAt: string; pairingId?: string }> {
    if (input.activationStillCurrent?.() === false) throw new Error("Pairing activation was superseded");
    const credential = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.credentialTtlMs).toISOString();
    if (this.durable) {
      this.durable.transaction(() => {
        const scope = {
          tenantId: input.tenantId,
          ownerId: input.ownerId,
          agentSessionId: input.agentSessionId,
        };
        const binding = {
          installationId: input.installationId,
          sourceAdapter: "codex-app-server",
          selectedSourceRootId: input.sourceRootId,
          credentialHash: hashSecret(credential),
          nonceHash: hashSecret(input.nonce),
          expiresAt: Date.parse(expiresAt),
          status: "active",
        } as const;
        if (input.retainExisting === true) {
          this.durable!.bridgeBindings.activateConcurrent(scope, binding);
        } else {
          this.durable!.bridgeBindings.activateExclusive(scope, binding, {
            replaceExisting: input.replaceExisting === true,
            ...(input.expectedSourceRootId === undefined ? {} : {
              expectedSelectedSourceRootId: input.expectedSourceRootId,
            }),
            ...(input.expectedActiveBinding === undefined ? {} : {
              expectedActiveBinding: {
                tenantId: input.expectedActiveBinding.tenantId,
                ownerId: input.expectedActiveBinding.ownerId,
                agentSessionId: input.expectedActiveBinding.agentSessionId,
                selectedSourceRootId: input.expectedActiveBinding.sourceRootId,
              },
            }),
          });
        }
        this.durable!.audit.append({
          tenantId: input.tenantId,
          ownerId: input.ownerId,
          agentSessionId: input.agentSessionId,
          action: input.replaceExisting === true ? "bridge.pairing.switched" : "bridge.pairing.issued",
          actorType: "local-session",
          actorId: `local-${hashSecret(input.ownerId).slice(0, 32)}`,
          metadata: {
            installationDigest: hashSecret(input.installationId),
            expiry: Date.parse(expiresAt),
          },
        });
      });
    }
    const revokeFailedActivation = (): void => {
      if (this.durable) {
        this.durable.bridgeBindings.revokeActive({
          tenantId: input.tenantId,
          ownerId: input.ownerId,
          agentSessionId: input.agentSessionId,
        }, input.installationId, input.sourceRootId);
      }
    };
    // The local switch endpoint may expose the selected scope immediately and
    // let its first verified snapshot arrive in the background. A failed
    // activation still compensates the exact durable binding. Other pairing
    // callers retain the strict await-before-success contract.
    if (input.deferRuntimeActivation === true) {
      setImmediate(() => {
        void Promise.resolve()
          .then(async () => this.onCredentialIssued?.(input))
          .catch(() => revokeFailedActivation());
      });
      return { credential, expiresAt, pairingId: input.pairingId };
    }
    try {
      await this.onCredentialIssued?.(input);
    } catch (error) {
      revokeFailedActivation();
      throw error;
    }
    return { credential, expiresAt, pairingId: input.pairingId };
  }

  async close(): Promise<void> {
    await this.client?.close?.();
  }

  private requireClient(): ReadOnlyCodexBridgeClient {
    if (!this.client) throw new Error("Codex bridge is not paired");
    if (this.client.gate?.status !== "accepted") throw new Error("Codex bridge adapter is not accepted");
    return this.client;
  }
}

export interface ProductionCompositionOptions {
  readonly databaseFilename?: string;
  /** Durable-store security/lifecycle settings supplied by deployment config. */
  readonly storeOptions?: Omit<StoreOptions, "filename" | "database">;
  readonly durableStore?: DurableStore;
  readonly bridge?: ReadOnlyCodexBridgeOptions;
  readonly mcpResource?: UiResourceConfig;
  /** Trusted verifier context supplied by the MCP HTTP transport. */
  readonly mcpAuthContextProvider?: AuthContextProvider;
  readonly expectedResource?: string;
  /** Optional read-only Codex runtime lifecycle. No runtime is created by default. */
  readonly codexRuntime?: ProductionCodexRuntimeOptions;
  /** Alias retained for callers that name the subsystem simply `runtime`. */
  readonly runtime?: ProductionCodexRuntimeOptions;
  /** Runtime options are explicit; when supplied the service starts by default. */
  readonly startRuntime?: boolean;
  readonly server?: Omit<ServerOptions, "store" | "bridge" | "mcp" | "mcpApplicationFactory">;
}

export interface ProductionComposition {
  readonly app: ReturnType<typeof createApp>;
  readonly store: DurableStore;
  readonly storePort: DurableStorePort;
  readonly bridge: ReadOnlyCodexBridgeAdapter;
  readonly mcp: McpPort;
  readonly mcpApplication: McpApplication;
  /** Return a fresh McpServer for every Streamable HTTP session/transport. */
  readonly mcpApplicationFactory: () => McpApplication;
  readonly runtimeService?: CodexRuntimeService;
  readonly runtimeManager?: CodexRuntimeManager;
  readonly runtimeStart?: Promise<CodexRuntimeServiceStatus>;
  close(): Promise<void>;
}

/** Build the standalone server with durable persistence and MCP descriptors. */
export function createProductionComposition(options: ProductionCompositionOptions = {}): ProductionComposition {
  const store = options.durableStore ?? new DurableStore({
    filename: options.databaseFilename ?? ":memory:",
    ...(options.storeOptions ?? {}),
  });
  const storePort = new DurableStorePort(store);
  const configuredRuntimeOptions = options.codexRuntime ?? options.runtime;
  const runtimeOptions = configuredRuntimeOptions === undefined ||
      configuredRuntimeOptions.installationId === undefined ||
      configuredRuntimeOptions.bindingResolver !== undefined ||
      configuredRuntimeOptions.durableBindingLookup !== undefined ||
      configuredRuntimeOptions.durableBinding !== undefined
    ? configuredRuntimeOptions
    : {
        ...configuredRuntimeOptions,
        // Production browser/MCP sessions are created dynamically, so a
        // fixed tenant/session selector would be stale before pairing. Resolve
        // internally and fail closed unless exactly one active binding owns
        // this installation.
        bindingResolver: () => {
          const selected = store.bridgeBindings.resolveUniqueActive(configuredRuntimeOptions.installationId!);
          return selected === null ? null : {
            tenantId: selected.tenantId,
            ownerId: selected.ownerId,
            agentSessionId: selected.agentSessionId,
            installationId: selected.installationId,
            sourceRootId: selected.selectedSourceRootId,
            status: "active" as const,
          };
        },
      };
  const managedLocalRuntime = runtimeOptions !== undefined && options.server?.localMode === true;
  const runtimeManager = !managedLocalRuntime || runtimeOptions === undefined
    ? undefined
    : new CodexRuntimeManager(runtimeOptions, store);
  const runtimeService = runtimeOptions === undefined
    ? undefined
    : runtimeManager?.discoveryService ?? new CodexRuntimeService({ ...runtimeOptions, store });
  const runtimeClient = runtimeManager?.getReadOnlyClient() ?? runtimeService?.getReadOnlyClient();
  const sourceRootAuthority = runtimeService !== undefined && runtimeOptions?.installationId !== undefined
    ? createCodexSourceRootAuthority({
        client: runtimeClient!,
        installationId: runtimeOptions.installationId,
      })
    : options.bridge?.sourceRootAuthority;
  const bridge = new ReadOnlyCodexBridgeAdapter({
    ...options.bridge,
    ...(runtimeClient === undefined ? {} : { client: runtimeClient }),
    ...(sourceRootAuthority === undefined ? {} : { sourceRootAuthority }),
    ...(runtimeService === undefined ? {} : {
      runtimeReady: () => runtimeManager?.ready() ?? runtimeService.ready(),
      runtimeConnectionState: () => {
        if (runtimeManager?.ready() || runtimeService.ready()) return "connected" as const;
        if (runtimeService.attestationReady()) return "unverified" as const;
        return "disconnected" as const;
      },
      onCredentialIssued: async (input): Promise<void> => {
        if (runtimeManager !== undefined) {
          await runtimeManager.ensureExclusivePairing(input);
          return;
        }
        await runtimeService.retry();
        if (!runtimeService.ready()) throw new Error("runtime reconciliation unavailable");
      },
    }),
    durable: options.bridge?.durable ?? store,
  });
  storePort.setConnectionStateProvider((scope) => {
    const selected = store.bridgeBindings.list(scope).find((binding) =>
      binding.status === "active" && binding.expiresAt > store.now(),
    );
    return selected === undefined ? "unverified" : runtimeManager?.connectionStateForScope(scope) ?? bridge.connectionState();
  });
  if (runtimeClient?.readRolloutLocalDetail !== undefined) storePort.setLocalDetailReader((threadId) => runtimeClient.readRolloutLocalDetail!(threadId));
  const backend = createMcpBackend(storePort);
  // Production serves only the generated, self-contained artifact. Explicit
  // injection remains available to unit tests/dev callers and bypasses disk.
  const mcpResource = options.mcpResource ?? loadProductionMcpResource();
  const mcpApplicationFactory = (): McpApplication => createMcpApplication({
    backend,
    resource: mcpResource,
    ...(options.mcpAuthContextProvider === undefined ? {} : { authContextProvider: options.mcpAuthContextProvider }),
    ...(options.expectedResource === undefined ? {} : { expectedResource: options.expectedResource }),
  });
  // This instance is useful to callers that only need descriptors or an
  // in-process invocation. Streamable HTTP must call the factory instead.
  const mcpApplication = mcpApplicationFactory();
  const mcp = createMcpPort(backend, mcpApplication);
  const runtimeStart = runtimeService !== undefined && options.startRuntime !== false
    ? runtimeManager?.start() ?? runtimeService.start()
    : undefined;
  const app = createApp({
    ...(options.server ?? {}),
    store: storePort,
    bridge,
    mcp,
    // MCP protocol transports are ephemeral; this durable repository is the
    // identity continuity boundary across remounts and process restarts.
    mcpSession: {
      ...(options.server?.mcpSession ?? {}),
      grantSessionBindingStore: store.mcpGrantBindings,
    },
    // The Fastify transport must receive the factory, never the sample
    // application instance; each MCP connection owns its own SDK server.
    mcpApplicationFactory,
  });

  return {
    app,
    store,
    storePort,
    bridge,
    mcp,
    mcpApplication,
    mcpApplicationFactory,
    ...(runtimeService === undefined ? {} : { runtimeService }),
    ...(runtimeManager === undefined ? {} : { runtimeManager }),
    ...(runtimeStart === undefined ? {} : { runtimeStart }),
    async close(): Promise<void> {
      // Fastify owns the app-scoped MCP session manager. Closing the app first
      // runs its onClose hook, terminates active SDK transports, and prevents
      // the manager from retaining sessions after the durable store closes.
      if (runtimeManager) await runtimeManager.stop();
      else if (runtimeService) await runtimeService.stop();
      await app.close();
      await bridge.close();
      store.close();
    },
  };
}

function createMcpBackend(store: DurableStorePort): AgentFarmMcpBackend {
  return {
    async createAgentSession(request) {
      return store.createAgentSession({
        ownerId: request.ownerId,
        tenantId: request.tenantId,
        agentSessionId: request.agentSessionId,
        idempotencyKey: request.idempotencyKey,
        requestHash: hashSecret(JSON.stringify({ label: request.label ?? null })),
        payload: {
          ...(request.label === undefined ? {} : { label: request.label }),
          sourceAdapter: "mcp",
        },
      });
    },
    async getAgentHierarchy(request) {
      const page = await store.getHierarchy({
        ownerId: request.ownerId,
        tenantId: request.tenantId,
        agentSessionId: request.agentSessionId,
        page: cursorToPage(request.cursor),
        pageSize: Math.min(request.limit, 200),
      });
      if (!page) throw new Error("Agent Farm session was not found");
      return page;
    },
    async getAgentDetails(request) {
      const details = await store.getAgentDetails({
        ownerId: request.ownerId,
        tenantId: request.tenantId,
        agentSessionId: request.agentSessionId,
        agentId: request.agentId,
      });
      if (!details) throw new Error("Agent Farm agent was not found");
      return details;
    },
    async renderAgentHierarchy(request) {
      const page = await store.getHierarchy({
        ownerId: request.ownerId,
        tenantId: request.tenantId,
        agentSessionId: request.agentSessionId,
        page: 1,
        pageSize: 200,
      });
      if (!page) throw new Error("Agent Farm session was not found");
      return page;
    },
  };
}

function createMcpPort(backend: AgentFarmMcpBackend, application: McpApplication): McpPort {
  return {
    ready: () => true,
    async listTools(principal: Principal): Promise<readonly McpTool[]> {
      return application.descriptors
        .filter((descriptor) => principal.scopes.has(descriptor.scope))
        .map((descriptor) => ({
          name: descriptor.name,
          description: descriptor.description,
          requiredScope: descriptor.scope,
        }));
    },
    async callTool(name: string, args: Record<string, unknown>, principal: Principal): Promise<unknown> {
      const descriptor = getToolDescriptors(application.resourceUri).find((candidate) => candidate.name === name);
      if (!descriptor || !principal.scopes.has(descriptor.scope)) throw new Error("MCP tool is not authorized");
      switch (name) {
        case "create_agent_session":
          if (principal.agentSessionId === undefined) throw new Error("MCP authorization is not bound to a session");
          return backend.createAgentSession({
            ownerId: principal.ownerId,
            tenantId: principal.tenantId,
            agentSessionId: principal.agentSessionId,
            idempotencyKey: stringArg(args, "idempotencyKey"),
            ...(args.label === undefined ? {} : { label: stringArg(args, "label") }),
          });
        case "get_agent_hierarchy":
          return backend.getAgentHierarchy({
            ownerId: principal.ownerId,
            tenantId: principal.tenantId,
            agentSessionId: stringArg(args, "agentSessionId"),
            limit: numberArg(args, "limit", 200),
            ...(args.cursor === undefined ? {} : { cursor: stringArg(args, "cursor") }),
          });
        case "get_agent_details":
          return backend.getAgentDetails({
            ownerId: principal.ownerId,
            tenantId: principal.tenantId,
            agentSessionId: stringArg(args, "agentSessionId"),
            agentId: stringArg(args, "agentId"),
          });
        case "render_agent_hierarchy":
          return backend.renderAgentHierarchy?.({
            ownerId: principal.ownerId,
            tenantId: principal.tenantId,
            agentSessionId: stringArg(args, "agentSessionId"),
            ...(args.branchAgentId === undefined ? {} : { branchAgentId: stringArg(args, "branchAgentId") }),
            mode: args.mode === "fullscreen" || args.mode === "standalone" ? args.mode : "inline",
          });
        default:
          throw new Error("Unknown MCP tool");
      }
    },
  };
}

function mapSession(session: AppSession, label?: string): AgentSessionRecord {
  return {
    ownerId: session.ownerId,
    tenantId: session.tenantId,
    agentSessionId: session.agentSessionId,
    status: session.status,
    ...(session.sourceAdapter === null ? {} : { sourceAdapter: session.sourceAdapter }),
    ...(label === undefined ? {} : { label }),
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    watermark: session.watermarkIngestOrdinal,
    capabilities: session.capabilities,
  };
}

function cursorToPage(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  const match = /^p_([1-9][0-9]{0,5})$/u.exec(cursor);
  if (!match) throw new Error("Invalid hierarchy cursor");
  const parsed = Number(match[1]);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000) throw new Error("Invalid hierarchy cursor");
  return parsed;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) throw new Error(`Invalid ${key}`);
  return value;
}

function decodeSignature(value: string): Buffer {
  if (/^[0-9a-f]+$/iu.test(value) && value.length % 2 === 0) return Buffer.from(value, "hex");
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
