import { randomBytes, randomUUID } from "node:crypto";

import type {
  AgentDetails,
  AgentSessionRecord,
  BridgePort,
  CreateAgentSessionInput,
  HierarchyPage,
  PairingChallenge,
  PairingCredential,
  PairingSignatureInput,
  SourceRootCandidate,
  SourceRootAttestationRecord,
  SourceRootAttestationRequest,
  SessionScope,
  StorePort,
} from "./contracts.js";

/**
 * Safe defaults for smoke tests and local development.  Production wiring
 * should provide the durable StorePort and the authenticated bridge adapter.
 */
export class InMemoryStore implements StorePort {
  private readonly sessions = new Map<string, AgentSessionRecord>();
  private readonly idempotency = new Map<string, { hash: string; result: AgentSessionRecord }>();
  private readonly hierarchy = new Map<string, HierarchyPage>();
  private readonly details = new Map<string, AgentDetails>();

  async getLocalAgentDetails(scope: SessionScope & { readonly agentId: string }): Promise<unknown | null> {
    const details = this.details.get(`${scope.tenantId}:${scope.ownerId}:${scope.agentSessionId}:${scope.agentId}`);
    return details ?? null;
  }

  ready(): boolean {
    return true;
  }

  async createAgentSession(input: CreateAgentSessionInput): Promise<AgentSessionRecord> {
    const key = `${input.tenantId}:${input.ownerId}:${input.idempotencyKey}`;
    const prior = this.idempotency.get(key);
    if (prior) {
      if (prior.hash !== input.requestHash) {
        const conflict = new Error("idempotency conflict") as Error & { code?: string };
        conflict.code = "IDEMPOTENCY_CONFLICT";
        throw conflict;
      }
      return prior.result;
    }
    const now = new Date().toISOString();
    const result: AgentSessionRecord = {
      agentSessionId: input.agentSessionId,
      ownerId: input.ownerId,
      tenantId: input.tenantId,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      watermark: 0,
      ...(input.payload.sourceAdapter ? { sourceAdapter: input.payload.sourceAdapter } : {}),
      ...(input.payload.label ? { label: input.payload.label } : {}),
      ...(input.payload.capabilities ? { capabilities: input.payload.capabilities } : {}),
    };
    this.sessions.set(this.key(input), result);
    this.idempotency.set(key, { hash: input.requestHash, result });
    this.hierarchy.set(input.agentSessionId, {
      schemaVersion: "agent-farm.public.v1",
      agentSessionId: input.agentSessionId,
      watermark: 0,
      generatedAt: now,
      snapshotState: "complete",
      connection: { state: "unverified", reason: "missing-evidence", updatedAt: now },
      rootAgentId: null,
      nodes: [],
      edges: [],
      total: 0,
      counts: { total: 0, active: 0, completed: 0, failed: 0, disconnected: 0, unverified: 0 },
      storyMilestones: [],
      hasMore: false,
      page: 1,
      pageSize: 100,
    } as HierarchyPage);
    return result;
  }

  async getAgentSession(scope: SessionScope): Promise<AgentSessionRecord | null> {
    return this.sessions.get(this.key(scope)) ?? null;
  }

  async getSession(scope: SessionScope): Promise<AgentSessionRecord | null> {
    return this.getAgentSession(scope);
  }

  async getHierarchy(
    scope: SessionScope & { readonly page: number; readonly pageSize: number },
  ): Promise<HierarchyPage | null> {
    const session = await this.getAgentSession(scope);
    if (!session) return null;
    const value = this.hierarchy.get(scope.agentSessionId);
    if (!value) return null;
    // Keep the strict public pagination tuple coherent when a caller changes
    // the requested page size. An empty fake page can never have a next page.
    return {
      ...value,
      page: scope.page,
      pageSize: scope.pageSize,
      hasMore: false,
      nextCursor: null,
    } as unknown as HierarchyPage;
  }

  async getHierarchyRevision(scope: SessionScope): Promise<number | null> {
    const session = await this.getAgentSession(scope);
    if (!session) return null;
    return typeof session.watermark === "number" && Number.isSafeInteger(session.watermark) && session.watermark >= 0
      ? session.watermark
      : 0;
  }

  async getAgentDetails(
    scope: SessionScope & { readonly agentId: string },
  ): Promise<AgentDetails | null> {
    const session = await this.getAgentSession(scope);
    if (!session) return null;
    return this.details.get(`${scope.agentSessionId}:${scope.agentId}`) ?? null;
  }

  private key(scope: SessionScope): string {
    return `${scope.tenantId}:${scope.ownerId}:${scope.agentSessionId}`;
  }
}

/** A bridge default that can issue no credential until a real verifier is wired. */
export class DisabledBridge implements BridgePort {
  ready(): boolean {
    return false;
  }

  verifyPairingSignature(_input: PairingSignatureInput): boolean {
    return false;
  }

  async issuePairingCredential(_input: PairingChallenge): Promise<PairingCredential> {
    // This branch is unreachable because verification always fails, but keeps
    // the interface total without ever returning a usable secret by accident.
    throw new Error("bridge verifier is not configured");
  }
}

export class TestBridge implements BridgePort {
  readonly issued: PairingCredential[] = [];
  readonly verify: (input: PairingSignatureInput) => boolean | Promise<boolean>;
  protected activeBinding: {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId: string;
    readonly expiresAt: number;
  } | undefined;
  protected readonly activeBindings = new Map<string, NonNullable<TestBridge["activeBinding"]>>();

  protected setActiveExpiry(expiresAt: number): void {
    if (this.activeBinding !== undefined) {
      this.activeBinding = { ...this.activeBinding, expiresAt };
      this.activeBindings.set(this.activeBinding.sourceRootId, this.activeBinding);
    }
  }

  constructor(
    verify: (input: PairingSignatureInput) => boolean | Promise<boolean> = () => false,
  ) {
    this.verify = verify;
  }

  ready(): boolean {
    return true;
  }

  async listSourceRoots(): Promise<readonly SourceRootCandidate[]> {
    return [
      {
        sourceRootId: "source-root-test-1",
        nickname: "Planner",
        agentPath: "/root",
        status: "running",
        updatedAt: "2026-08-10T10:00:00.000Z",
      },
      {
        sourceRootId: "source-root-test-2",
        nickname: "Builder",
        status: "idle",
      },
    ];
  }

  async attestSourceRoot(input: SourceRootAttestationRequest): Promise<SourceRootAttestationRecord> {
    return {
      installationId: input.installationId,
      sourceRootId: input.sourceRootId,
      sourceSessionId: "source-session-test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      attestationDigest: "a".repeat(64),
    };
  }

  verifyPairingSignature(input: PairingSignatureInput): boolean | Promise<boolean> {
    return this.verify(input);
  }

  hasActivePairing(input: {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId: string;
  }): boolean {
    const active = this.activeBindings.get(input.sourceRootId);
    return active !== undefined && active.expiresAt > Date.now() &&
      active.tenantId === input.tenantId && active.ownerId === input.ownerId &&
      active.agentSessionId === input.agentSessionId && active.installationId === input.installationId &&
      active.sourceRootId === input.sourceRootId;
  }

  resolveActivePairing(installationId: string): {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId: string;
  } | null {
    const active = this.activeBinding;
    if (active === undefined || active.expiresAt <= Date.now() || active.installationId !== installationId) return null;
    return {
      tenantId: active.tenantId,
      ownerId: active.ownerId,
      agentSessionId: active.agentSessionId,
      installationId: active.installationId,
      sourceRootId: active.sourceRootId,
    };
  }

  listActivePairings(installationId: string): readonly {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId: string;
  }[] {
    return [...this.activeBindings.values()]
      .filter((active) => active.expiresAt > Date.now() && active.installationId === installationId)
      .map((active) => ({
        tenantId: active.tenantId,
        ownerId: active.ownerId,
        agentSessionId: active.agentSessionId,
        installationId: active.installationId,
        sourceRootId: active.sourceRootId,
      }));
  }

  revokePairing(input: {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly agentSessionId: string;
    readonly installationId: string;
    readonly sourceRootId?: string;
  }): boolean {
    const active = this.activeBinding;
    if (active === undefined || active.installationId !== input.installationId ||
      active.tenantId !== input.tenantId || active.ownerId !== input.ownerId ||
      active.agentSessionId !== input.agentSessionId ||
      (input.sourceRootId !== undefined && input.sourceRootId !== active.sourceRootId)) return false;
    this.activeBinding = undefined;
    this.activeBindings.delete(active.sourceRootId);
    return true;
  }

  async issuePairingCredential(input: PairingChallenge): Promise<PairingCredential> {
    if (input.activationStillCurrent?.() === false) throw new Error("Pairing activation was superseded");
    const liveForInstallation = [...this.activeBindings.values()].filter((binding) => {
      if (binding.expiresAt <= Date.now()) {
        this.activeBindings.delete(binding.sourceRootId);
        return false;
      }
      return binding.installationId === input.installationId;
    });
    if (input.retainExisting !== true) {
      if (input.replaceExisting === true) {
        const expected = input.expectedActiveBinding ?? (input.expectedSourceRootId === undefined ? undefined : {
          tenantId: input.tenantId,
          ownerId: input.ownerId,
          agentSessionId: input.agentSessionId,
          sourceRootId: input.expectedSourceRootId,
        });
        const exactExpected = expected === undefined ? [] : liveForInstallation.filter((binding) =>
          binding.tenantId === expected.tenantId && binding.ownerId === expected.ownerId &&
          binding.agentSessionId === expected.agentSessionId && binding.sourceRootId === expected.sourceRootId,
        );
        if (liveForInstallation.length !== 1 || exactExpected.length !== 1) {
          throw new Error("The installation pairing changed");
        }
      } else if (liveForInstallation.some((binding) =>
        binding.tenantId !== input.tenantId || binding.ownerId !== input.ownerId ||
        binding.agentSessionId !== input.agentSessionId || binding.sourceRootId !== input.sourceRootId,
      )) {
        throw new Error("The installation is already paired");
      }
      for (const binding of liveForInstallation) this.activeBindings.delete(binding.sourceRootId);
    }
    const result: PairingCredential = {
      credential: randomBytes(32).toString("base64url"),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      pairingId: input.pairingId,
    };
    this.issued.push(result);
    this.activeBinding = {
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      agentSessionId: input.agentSessionId,
      installationId: input.installationId,
      sourceRootId: input.sourceRootId,
      expiresAt: Date.parse(result.expiresAt),
    };
    this.activeBindings.set(input.sourceRootId, this.activeBinding);
    return result;
  }
}

export function createSessionId(): string {
  return `as_${randomUUID()}`;
}
