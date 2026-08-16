import { randomBytes } from "node:crypto";

import type { Principal, SourceRootCandidate } from "./contracts.js";
import { canonicalJson, sha256 } from "./security.js";

/**
 * The browser-facing shape of a local source-root candidate.  The opaque
 * handle is the only value that can be used to select a private source root;
 * raw bridge identifiers never leave this module.
 */
export interface LocalSelectionCandidate {
  readonly selectionHandle: string;
  /** Stable only inside this browser session; identifies a chat but grants no access. */
  readonly chatHandle: string;
  readonly displayName: string;
  readonly chatTitle?: string;
  readonly workspaceName?: string;
  readonly lifecycle: string;
  /** Server-derived from the current durable binding; never caller supplied. */
  readonly active?: true;
  /** This browser remembers a durable projection snapshot; active is separate. */
  readonly bound?: true;
  /** Matches the server-only task identity supplied by the trusted launcher. */
  readonly launchTarget?: true;
  readonly lastActivityAt?: string;
  readonly descendantCount?: number;
}

export interface LocalSelectionSnapshot {
  readonly version: number;
  readonly digest: string;
  readonly candidates: readonly LocalSelectionCandidate[];
}

export type LocalActiveTask = Omit<LocalSelectionCandidate, "selectionHandle" | "chatHandle" | "active" | "bound" | "descendantCount">;

export interface LocalSelectionBinding {
  readonly tenantId: string;
  readonly ownerId: string;
  /** A digest-backed local browser session binding; never returned to clients. */
  readonly sessionBinding: string;
  readonly installationId: string;
  readonly agentSessionId: string;
}

export type LocalSelectionErrorCode =
  | "invalid"
  | "expired"
  | "replayed"
  | "binding_mismatch"
  | "snapshot_mismatch";

export class LocalSelectionError extends Error {
  readonly code: LocalSelectionErrorCode;

  constructor(code: LocalSelectionErrorCode) {
    super("The selected local task is no longer available");
    this.name = "LocalSelectionError";
    this.code = code;
  }
}

interface HandleRecord {
  readonly handleDigest: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly sessionBinding: string;
  readonly installationId: string;
  readonly agentSessionId: string;
  readonly sourceRootId: string;
  readonly activeTask: LocalActiveTask;
  readonly launchTarget?: true;
  readonly snapshotVersion: number;
  readonly snapshotDigest: string;
  readonly expiresAt: number;
  used: boolean;
}

interface SessionSnapshotGeneration {
  version: number;
  digest: string;
  readonly handles: Set<string>;
}

interface SessionSnapshotState {
  version: number;
  readonly generations: SessionSnapshotGeneration[];
}

export interface LocalSelectionRegistryOptions {
  readonly ttlMs?: number;
  readonly maxCandidates?: number;
  readonly maxHandles?: number;
  readonly maxSnapshotGenerations?: number;
  readonly now?: () => number;
  readonly randomHandle?: () => string;
}

const DEFAULT_TTL_MS = 2 * 60 * 1_000;
const MAX_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_CANDIDATES = 100;
const DEFAULT_MAX_HANDLES = 1_000;
const DEFAULT_MAX_SNAPSHOT_GENERATIONS = 4;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * Server-owned, bounded selection-handle registry. A few recent snapshot
 * generations remain valid so a status refresh in another same-origin tab
 * cannot invalidate a click already in flight. Handles remain one-time,
 * session-bound, short-lived, and are consumed before attestation or
 * credential work, making concurrent submissions deterministic and replay-safe.
 */
export class LocalSelectionRegistry {
  private readonly ttlMs: number;
  private readonly maxCandidates: number;
  private readonly maxHandles: number;
  private readonly maxSnapshotGenerations: number;
  private readonly now: () => number;
  private readonly randomHandle: () => string;
  private readonly records = new Map<string, HandleRecord>();
  private readonly sessions = new Map<string, SessionSnapshotState>();

  constructor(options: LocalSelectionRegistryOptions = {}) {
    this.ttlMs = boundedPositive(options.ttlMs ?? DEFAULT_TTL_MS, DEFAULT_TTL_MS);
    this.maxCandidates = boundedPositiveInteger(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES, DEFAULT_MAX_CANDIDATES);
    // Never evict a freshly issued candidate from the bounded registry.
    this.maxHandles = Math.max(this.maxCandidates, boundedPositiveInteger(options.maxHandles ?? DEFAULT_MAX_HANDLES, DEFAULT_MAX_HANDLES));
    this.maxSnapshotGenerations = Math.max(1, Math.min(
      boundedPositiveInteger(options.maxSnapshotGenerations ?? DEFAULT_MAX_SNAPSHOT_GENERATIONS, DEFAULT_MAX_SNAPSHOT_GENERATIONS),
      8,
    ));
    this.now = options.now ?? (() => Date.now());
    this.randomHandle = options.randomHandle ?? (() => randomBytes(32).toString("base64url"));
  }

  issueSnapshot(binding: LocalSelectionBinding, roots: readonly SourceRootCandidate[], activeSourceRootId?: string, expectedSourceRootId?: string): LocalSelectionSnapshot {
    this.prune();
    const sessionKey = this.sessionKey(binding);
    const previous = this.sessions.get(sessionKey);
    const version = (previous?.version ?? 0) + 1;
    const boundedRoots = roots.slice(0, this.maxCandidates);
    const privateRootIds = boundedRoots
      .map((candidate) => candidate.sourceRootId)
      .filter(isSafeRootId);
    const identities = boundedRoots.map((candidate) => ({
      sourceRootId: candidate.sourceRootId,
      chatTitle: candidate.chatTitle ?? null,
      workspaceName: candidate.workspaceName ?? null,
      nickname: candidate.nickname ?? null,
      status: candidate.status,
      updatedAt: candidate.updatedAt ?? null,
      descendantCount: candidate.descendantCount ?? null,
    }));
    const digest = sha256(canonicalJson(identities));
    const handles = new Set<string>();
    const candidates: LocalSelectionCandidate[] = [];
    const seenRoots = new Set<string>();
    for (let index = 0; index < boundedRoots.length; index += 1) {
      const candidate = boundedRoots[index];
      if (candidate === undefined) continue;
      if (!isSafeRootId(candidate.sourceRootId) || seenRoots.has(candidate.sourceRootId)) continue;
      const lifecycle = safeLifecycle(candidate.status);
      if (lifecycle === undefined) continue;
      const handle = this.newHandle();
      const handleDigest = sha256(handle);
      const chatHandle = sha256(canonicalJson({
        purpose: "local-chat-reference-v1",
        sessionBinding: binding.sessionBinding,
        installationId: binding.installationId,
        sourceRootId: candidate.sourceRootId,
      }));
      const lastActivityAt = safeLastActivity(candidate.updatedAt);
      const descendantCount = safeDescendantCount(candidate.descendantCount);
      const chatTitle = safePublicLabel(candidate.chatTitle, privateRootIds);
      const workspaceName = safePublicLabel(candidate.workspaceName, privateRootIds);
      const activeTask: LocalActiveTask = {
        displayName: safeDisplayName(candidate.chatTitle ?? candidate.nickname, privateRootIds, index),
        ...(chatTitle === undefined ? {} : { chatTitle }),
        ...(workspaceName === undefined ? {} : { workspaceName }),
        lifecycle,
        ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
      };
      const record: HandleRecord = {
        handleDigest,
        tenantId: binding.tenantId,
        ownerId: binding.ownerId,
        sessionBinding: binding.sessionBinding,
        installationId: binding.installationId,
        agentSessionId: binding.agentSessionId,
        sourceRootId: candidate.sourceRootId,
        activeTask,
        ...(candidate.sourceRootId === expectedSourceRootId ? { launchTarget: true as const } : {}),
        snapshotVersion: version,
        snapshotDigest: digest,
        expiresAt: this.now() + this.ttlMs,
        used: false,
      };
      this.records.set(handleDigest, record);
      handles.add(handleDigest);
      seenRoots.add(candidate.sourceRootId);
      const safeCandidate = {
        selectionHandle: handle,
        chatHandle,
        ...activeTask,
        ...(candidate.sourceRootId === activeSourceRootId ? { active: true as const } : {}),
        ...(candidate.sourceRootId === expectedSourceRootId ? { launchTarget: true as const } : {}),
        ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
        ...(descendantCount === undefined ? {} : { descendantCount }),
      } satisfies LocalSelectionCandidate;
      candidates.push(safeCandidate);
    }
    const generations = [...(previous?.generations ?? []), { version, digest, handles }];
    while (generations.length > this.maxSnapshotGenerations) {
      const expiredGeneration = generations.shift();
      if (expiredGeneration !== undefined) {
        for (const handleDigest of expiredGeneration.handles) this.records.delete(handleDigest);
      }
    }
    this.sessions.set(sessionKey, { version, generations });
    this.prune();
    return { version, digest, candidates };
  }

  consume(handle: unknown, binding: LocalSelectionBinding, options: { readonly allowReplay?: boolean } = {}): { sourceRootId: string; agentSessionId: string; snapshotVersion: number; snapshotDigest: string; activeTask: LocalActiveTask; launchTarget?: true; replayed?: true } {
    if (typeof handle !== "string" || !HANDLE_PATTERN.test(handle)) {
      throw new LocalSelectionError("invalid");
    }
    this.prune();
    const record = this.records.get(sha256(handle));
    if (!record) throw new LocalSelectionError("invalid");
    const replayed = record.used;
    if (replayed && options.allowReplay !== true) throw new LocalSelectionError("replayed");
    if (record.expiresAt <= this.now()) throw new LocalSelectionError("expired");
    if (
      record.sessionBinding !== binding.sessionBinding ||
      record.installationId !== binding.installationId
    ) {
      throw new LocalSelectionError("binding_mismatch");
    }
    const snapshot = this.sessions.get(this.sessionKey(binding));
    const generation = snapshot?.generations.find((candidate) =>
      candidate.version === record.snapshotVersion && candidate.digest === record.snapshotDigest,
    );
    if (generation === undefined) {
      throw new LocalSelectionError("snapshot_mismatch");
    }
    // Mark only after the authenticated browser-session, installation, and
    // snapshot checks pass. The viewed projection's owner/session changes on
    // every chat switch, so it is deliberately not part of this local
    // browser capability boundary.
    record.used = true;
    return {
      sourceRootId: record.sourceRootId,
      agentSessionId: record.agentSessionId,
      snapshotVersion: record.snapshotVersion,
      snapshotDigest: record.snapshotDigest,
      activeTask: record.activeTask,
      ...(record.sourceRootId === this.expectedSourceRoot(binding) ? { launchTarget: true as const } : {}),
      ...(replayed ? { replayed: true as const } : {}),
    };
  }

  private expectedSourceRoot(binding: LocalSelectionBinding): string | undefined {
    const state = this.sessions.get(this.sessionKey(binding));
    if (!state) return undefined;
    const latest = state.generations[state.generations.length - 1];
    if (latest === undefined) return undefined;
    for (const digest of latest.handles) {
      const record = this.records.get(digest);
      if (record?.launchTarget === true) return record.sourceRootId;
    }
    return undefined;
  }

  invalidate(binding: LocalSelectionBinding): void {
    const key = this.sessionKey(binding);
    const state = this.sessions.get(key);
    if (!state) return;
    for (const generation of state.generations) {
      for (const digest of generation.handles) this.records.delete(digest);
    }
    this.sessions.delete(key);
  }

  private sessionKey(binding: LocalSelectionBinding): string {
    return sha256(canonicalJson({
      sessionBinding: binding.sessionBinding,
      installationId: binding.installationId,
    }));
  }

  private newHandle(): string {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const handle = this.randomHandle();
      if (HANDLE_PATTERN.test(handle) && !this.records.has(sha256(handle))) return handle;
    }
    throw new LocalSelectionError("invalid");
  }

  private prune(): void {
    const now = this.now();
    for (const [digest, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(digest);
    }
    while (this.records.size > this.maxHandles) {
      const first = this.records.keys().next().value;
      if (typeof first !== "string") break;
      this.records.delete(first);
    }
    // Keep the session index bounded by live handle records as well. Empty
    // generations do not need to remain because they have no capability that
    // could later be replayed.
    for (const [sessionKey, snapshot] of this.sessions) {
      for (const generation of snapshot.generations) {
        for (const digest of generation.handles) {
          if (!this.records.has(digest)) generation.handles.delete(digest);
        }
      }
      const liveGenerations = snapshot.generations.filter((generation) => generation.handles.size > 0);
      snapshot.generations.splice(0, snapshot.generations.length, ...liveGenerations);
      if (snapshot.generations.length === 0) this.sessions.delete(sessionKey);
    }
  }
}

function boundedPositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 && value <= MAX_TTL_MS ? Math.floor(value) : fallback;
}

function boundedPositiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= 10_000 ? value : fallback;
}

function isSafeRootId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeLifecycle(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  const normalized = value.trim().toLowerCase();
  const allowed = new Set(["queued", "running", "waiting", "completed", "failed", "cancelled", "disconnected", "idle", "ready", "pending", "active", "unknown"]);
  return allowed.has(normalized) ? normalized : "unknown";
}

function safeDisplayName(value: unknown, sourceRootIds: readonly string[], index: number): string {
  return safePublicLabel(value, sourceRootIds) ?? `Untitled chat · ${String(index + 1).padStart(2, "0")}`;
}

function safePublicLabel(value: unknown, sourceRootIds: readonly string[]): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  const trimmed = value.trim();
  const sensitiveLabel = /(?:^|[\s._-])(?:(?:access|refresh|id|auth|bearer|session|cookie|credential|secret|csrf|code|nonce|password|jwt|token)(?:[._-]?(?:token|id|key|secret|code))?|api[\s._-]?(?:token|id|key|secret|code))(?:$|[\s._=-])/iu;
  if (!trimmed || /[\\/]/u.test(trimmed) || sensitiveLabel.test(trimmed)) return undefined;
  const decoded = safelyDecodeURIComponent(trimmed);
  if (/[\\/]/u.test(decoded)) return undefined;
  const comparableLabels = [trimmed, decoded].map((candidate) => candidate.toLowerCase());
  const leaksPrivateRoot = sourceRootIds.some((sourceRootId) => {
    const comparableRoot = sourceRootId.toLowerCase();
    return comparableLabels.some((label) => label.includes(comparableRoot));
  });
  if (leaksPrivateRoot) return undefined;
  return trimmed;
}

function safelyDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeLastActivity(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function safeDescendantCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000 ? value as number : undefined;
}
