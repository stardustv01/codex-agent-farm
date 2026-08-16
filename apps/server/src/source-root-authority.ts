import { createHash, randomBytes } from "node:crypto";

import type {
  AdapterGateResult,
  JsonObject,
  JsonValue,
  SanitizedThread,
  SanitizedThreadPage,
  SanitizedThreadRead,
} from "@agent-farm/codex-bridge";
import { CODEX_DISCOVERY_SOURCE_KINDS } from "@agent-farm/codex-bridge";

/**
 * The only Codex surface this authority can see.  AppServerClient satisfies
 * this interface directly; the raw JSON-RPC `call` method is deliberately not
 * part of it.  Both methods return the bridge minimizer's Sanitized* records.
 */
export interface CodexSourceRootClient {
  readonly gate?: AdapterGateResult | undefined;
  /** Optional process-local provenance supplied by a trusted bridge adapter. */
  readonly installationId?: string | undefined;
  listThreads(params?: JsonObject): Promise<SanitizedThreadPage>;
  readThread(params: JsonObject): Promise<SanitizedThreadRead>;
}

export interface SourceRootAuthorityLimits {
  /** Maximum thread/list pages traversed for one attestation. */
  readonly maxListPages?: number;
  /** Maximum sanitized thread entries accepted across all pages. */
  readonly maxListItems?: number;
  /** Request page size sent to the allowlisted bridge. */
  readonly listPageSize?: number;
}

export interface SourceRootAuthorityOptions {
  readonly client: CodexSourceRootClient;
  /** Trusted installation identity configured by the server/bridge host. */
  readonly installationId: string;
  readonly limits?: SourceRootAuthorityLimits;
  /** Clock hook used for deterministic expiry tests. */
  readonly now?: () => Date;
  /** Short-lived attestation lifetime. The default is one minute. */
  readonly attestationTtlMs?: number;
  /** Alias accepted for small host integrations. */
  readonly ttlMs?: number;
}

export interface SourceRootAttestationRequest {
  /** Compared to the configured installation; never used as authority. */
  readonly installationId: string;
  /** Exact source thread id selected by the caller. */
  readonly sourceRootId: string;
  /** Optional correlation assertion supplied by a pairing caller. */
  readonly sourceSessionId?: string;
}

/**
 * This is metadata only.  No prompt, turn item, raw app-server response, or
 * filesystem path crosses this boundary.  `attestationDigest` is intended to
 * be copied into a pairing challenge and consumed by that challenge's
 * existing one-use ledger.
 */
export interface SourceRootAttestation {
  readonly version: "source-root-attestation-v1";
  readonly installationId: string;
  readonly sourceRootId: string;
  readonly sourceSessionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly attestationDigest: string;
  /** Short alias for hosts that call the field simply `digest`. */
  readonly digest: string;
}

export type SourceRootAuthorityErrorCode =
  | "INVALID_REQUEST"
  | "INSTALLATION_MISMATCH"
  | "CROSS_INSTALL"
  | "ADAPTER_QUARANTINED"
  | "MALFORMED_PAGE"
  | "MALFORMED_SESSION"
  | "ROOT_NOT_FOUND"
  | "DUPLICATE_ID"
  | "DUPLICATE_THREAD"
  | "DESCENDANT_AS_ROOT"
  | "SESSION_MISMATCH"
  | "CURSOR_LOOP"
  | "LIST_PAGE_LIMIT"
  | "LIST_ITEM_LIMIT"
  | "LIST_FAILED"
  | "READ_FAILED"
  | "THREAD_MISMATCH"
  | "ATTESTATION_CLOCK";

/** Stable, secret-free failure classification for the server boundary. */
export class SourceRootAuthorityError extends Error {
  readonly code: SourceRootAuthorityErrorCode;

  constructor(code: SourceRootAuthorityErrorCode) {
    super(code);
    this.name = "SourceRootAuthorityError";
    this.code = code;
  }
}

/** Compatibility name for callers that use the longer Codex-prefixed noun. */
export class CodexSourceRootAuthorityError extends SourceRootAuthorityError {}

interface ValidatedThread {
  readonly sourceThreadId: string;
  readonly sessionId?: string;
  readonly parentThreadId?: string;
  readonly status: SanitizedThread["status"];
}

interface ValidatedPage {
  readonly threads: readonly ValidatedThread[];
  readonly nextCursor?: string;
}

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,256}$/u;
const SESSION_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u;
const CURSOR = /^[A-Za-z0-9._~+=:-]{1,512}$/u;
const AGENT_PATH_MAX_CHARS = 512;
const AGENT_PATH_MAX_DEPTH = 64;
const LIFECYCLES = new Set<SanitizedThread["status"]>([
  "idle",
  "active",
  "completed",
  "failed",
  "interrupted",
  "unknown",
]);
const THREAD_KEYS = new Set([
  "sourceThreadId",
  "chatTitle",
  "workspaceName",
  "sessionId",
  "parentThreadId",
  "forkedFromId",
  "modelProvider",
  "status",
  "cliVersion",
  "sourceKind",
  "agentNickname",
  "agentRole",
  "agentPath",
  "agentTaskName",
  "createdAt",
  "updatedAt",
  "recencyAt",
]);
const PAGE_KEYS = new Set(["threads", "nextCursor"]);
const READ_KEYS = new Set(["thread", "turns", "nextCursor"]);
const REQUEST_KEYS = new Set(["installationId", "sourceRootId", "sourceSessionId"]);

const DEFAULT_LIMITS: Required<SourceRootAuthorityLimits> = {
  maxListPages: 64,
  maxListItems: 10_000,
  // Real thread metadata can make a 200-record JSON-RPC line exceed the
  // bridge's absolute framing cap. Keep attestation pages intentionally small.
  listPageSize: 20,
};
const DEFAULT_ATTESTATION_TTL_MS = 60_000;
const MAX_ATTESTATION_TTL_MS = 10 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;
}

function safeSessionIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && SESSION_IDENTIFIER.test(value) ? value : undefined;
}

function safeCursor(value: unknown): string | undefined {
  return typeof value === "string" && CURSOR.test(value) ? value : undefined;
}

function safeAgentPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > AGENT_PATH_MAX_CHARS || !value.startsWith("/")) return undefined;
  const segments = value.slice(1).split("/");
  if (segments.length === 0 || segments.length > AGENT_PATH_MAX_DEPTH || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || !/^[A-Za-z0-9._:@+-]{1,128}$/u.test(segment))) return undefined;
  return value;
}

function safeAgentTaskName(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:@+-]{1,128}$/u.test(value) ? value : undefined;
}

function taskNameFromPath(value: string): string | undefined {
  const taskName = value.slice(value.lastIndexOf("/") + 1);
  return safeAgentTaskName(taskName);
}

function boundedPositive(
  value: number | undefined,
  fallback: number,
  ceiling: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new SourceRootAuthorityError("INVALID_REQUEST");
  }
  return value;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  code: SourceRootAuthorityErrorCode = "MALFORMED_PAGE",
): void {
  if ([...Object.keys(value)].some((key) => !keys.has(key))) {
    throw new SourceRootAuthorityError(code);
  }
}

function optionalSafeString(
  source: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  maxLength: number,
): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  // A raw app-server root commonly spells the absence of a parent as null;
  // the bridge minimizer normally drops that field.  Treat both forms as the
  // same V1 global-root value while continuing to reject null session IDs.
  if (key === "parentThreadId" && value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !pattern.test(value)) {
    throw new SourceRootAuthorityError(key === "sessionId" ? "MALFORMED_SESSION" : "MALFORMED_PAGE");
  }
  return value;
}

function validateThread(value: unknown): ValidatedThread {
  if (!isRecord(value)) throw new SourceRootAuthorityError("MALFORMED_PAGE");
  assertAllowedKeys(value, THREAD_KEYS);
  const sourceThreadId = safeIdentifier(value.sourceThreadId);
  if (sourceThreadId === undefined) throw new SourceRootAuthorityError("MALFORMED_PAGE");
  const sessionId = optionalSafeString(value, "sessionId", SESSION_IDENTIFIER, 128);
  const parentThreadId = optionalSafeString(value, "parentThreadId", IDENTIFIER, 256);
  const pathPresent = Object.prototype.hasOwnProperty.call(value, "agentPath") && value.agentPath !== undefined;
  const taskNamePresent = Object.prototype.hasOwnProperty.call(value, "agentTaskName") && value.agentTaskName !== undefined;
  const agentPath = pathPresent ? safeAgentPath(value.agentPath) : undefined;
  const agentTaskName = taskNamePresent ? safeAgentTaskName(value.agentTaskName) : agentPath === undefined ? undefined : taskNameFromPath(agentPath);
  if ((pathPresent && agentPath === undefined) || (taskNamePresent && agentTaskName === undefined)) {
    throw new SourceRootAuthorityError("MALFORMED_PAGE");
  }
  if (agentPath !== undefined && agentTaskName !== taskNameFromPath(agentPath)) {
    throw new SourceRootAuthorityError("MALFORMED_PAGE");
  }
  const status = value.status;
  if (typeof status !== "string" || !LIFECYCLES.has(status as SanitizedThread["status"])) {
    throw new SourceRootAuthorityError("MALFORMED_PAGE");
  }
  // Rebuild the object rather than retaining a bridge object with a mutable
  // prototype or future fields.  Only fields needed for root correlation are
  // carried further.
  return {
    sourceThreadId,
    status: status as SanitizedThread["status"],
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
  };
}

function validateListPage(value: unknown): ValidatedPage {
  if (!isRecord(value)) throw new SourceRootAuthorityError("MALFORMED_PAGE");
  assertAllowedKeys(value, PAGE_KEYS);
  if (!Array.isArray(value.threads)) throw new SourceRootAuthorityError("MALFORMED_PAGE");
  for (let index = 0; index < value.threads.length; index += 1) {
    if (!(index in value.threads)) throw new SourceRootAuthorityError("MALFORMED_PAGE");
  }
  const threads = value.threads.map((thread) => validateThread(thread));
  if (value.nextCursor !== undefined && value.nextCursor !== null && safeCursor(value.nextCursor) === undefined) {
    throw new SourceRootAuthorityError("MALFORMED_PAGE");
  }
  const nextCursor = value.nextCursor === undefined || value.nextCursor === null ? undefined : value.nextCursor as string;
  return nextCursor === undefined ? { threads } : { threads, nextCursor };
}

function validateReadPage(value: unknown): { readonly thread: ValidatedThread } {
  if (!isRecord(value)) throw new SourceRootAuthorityError("MALFORMED_PAGE");
  assertAllowedKeys(value, READ_KEYS);
  // Turns are intentionally ignored after checking that a host did not send a
  // malformed non-array value.  The authority never exports or hashes them.
  if (value.turns !== undefined && !Array.isArray(value.turns)) {
    throw new SourceRootAuthorityError("MALFORMED_PAGE");
  }
  if (value.nextCursor !== undefined && value.nextCursor !== null) {
    // Root correlation requests a single metadata page.  A continuation here
    // would indicate an unexpected/raw read shape, so fail closed.
    throw new SourceRootAuthorityError("MALFORMED_PAGE");
  }
  return { thread: validateThread(value.thread) };
}

function canonicalAttestationInput(input: {
  readonly version: SourceRootAttestation["version"];
  readonly installationId: string;
  readonly sourceRootId: string;
  readonly sourceSessionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}): string {
  // Fields are written in a fixed order.  The nonce remains private to this
  // module; only the digest is handed to the pairing ledger.
  return [
    input.version,
    input.installationId,
    input.sourceRootId,
    input.sourceSessionId,
    input.issuedAt,
    input.expiresAt,
    input.nonce,
  ].join("\n");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nowDate(now: () => Date): Date {
  let value: Date;
  try {
    value = now();
  } catch {
    throw new SourceRootAuthorityError("ATTESTATION_CLOCK");
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new SourceRootAuthorityError("ATTESTATION_CLOCK");
  }
  return value;
}

/**
 * Resolve one exact Codex source root and create metadata-only attestation
 * material for pairing.  This class has no generic RPC, process, or filesystem
 * method by design.
 */
export class CodexSourceRootAuthority {
  private readonly client: CodexSourceRootClient;
  private readonly installationId: string;
  private readonly limits: Required<SourceRootAuthorityLimits>;
  private readonly now: () => Date;
  private readonly attestationTtlMs: number;

  constructor(options: SourceRootAuthorityOptions) {
    if (!isRecord(options) || !isRecord(options.client)) {
      throw new SourceRootAuthorityError("INVALID_REQUEST");
    }
    const installationId = safeIdentifier(options.installationId);
    if (installationId === undefined) throw new SourceRootAuthorityError("INVALID_REQUEST");
    this.client = options.client;
    this.installationId = installationId;
    const requestedLimits = options.limits ?? {};
    this.limits = {
      maxListPages: boundedPositive(requestedLimits.maxListPages, DEFAULT_LIMITS.maxListPages, 256),
      maxListItems: boundedPositive(requestedLimits.maxListItems, DEFAULT_LIMITS.maxListItems, 100_000),
      listPageSize: boundedPositive(requestedLimits.listPageSize, DEFAULT_LIMITS.listPageSize, 200),
    };
    this.now = options.now ?? (() => new Date());
    const ttl = options.attestationTtlMs ?? options.ttlMs ?? DEFAULT_ATTESTATION_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_ATTESTATION_TTL_MS) {
      throw new SourceRootAuthorityError("INVALID_REQUEST");
    }
    this.attestationTtlMs = ttl;
  }

  /** The trusted configured installation identifier. */
  get configuredInstallationId(): string {
    return this.installationId;
  }

  /**
   * Find and correlate an exact root.  The caller's installation is only an
   * assertion checked against configuration; it never selects an installation
   * or alters the bridge request.
   */
  async attestSourceRoot(request: SourceRootAttestationRequest): Promise<SourceRootAttestation> {
    this.validateRequest(request);
    this.assertAdapterAccepted();
    this.assertClientInstallation();

    const listed = await this.collectList();
    const root = listed.get(request.sourceRootId);
    if (root === undefined) throw new SourceRootAuthorityError("ROOT_NOT_FOUND");
    if (root.parentThreadId !== undefined) {
      throw new SourceRootAuthorityError("DESCENDANT_AS_ROOT");
    }
    const sourceSessionId = this.requireSession(root.sessionId);
    if (request.sourceSessionId !== undefined && request.sourceSessionId !== sourceSessionId) {
      throw new SourceRootAuthorityError("SESSION_MISMATCH");
    }

    const read = await this.readRoot(request.sourceRootId);
    if (read.sourceThreadId !== request.sourceRootId) {
      throw new SourceRootAuthorityError("THREAD_MISMATCH");
    }
    if (read.parentThreadId !== undefined) {
      throw new SourceRootAuthorityError("DESCENDANT_AS_ROOT");
    }
    const readSessionId = this.requireSession(read.sessionId);
    if (readSessionId !== sourceSessionId) {
      throw new SourceRootAuthorityError("SESSION_MISMATCH");
    }

    const issued = nowDate(this.now);
    const expires = new Date(issued.getTime() + this.attestationTtlMs);
    if (!Number.isFinite(expires.getTime()) || expires.getTime() <= issued.getTime()) {
      throw new SourceRootAuthorityError("ATTESTATION_CLOCK");
    }
    const issuedAt = issued.toISOString();
    const expiresAt = expires.toISOString();
    const nonce = randomBytes(32).toString("base64url");
    const attestationDigest = digest(canonicalAttestationInput({
      version: "source-root-attestation-v1",
      installationId: this.installationId,
      sourceRootId: request.sourceRootId,
      sourceSessionId,
      issuedAt,
      expiresAt,
      nonce,
    }));
    return {
      version: "source-root-attestation-v1",
      installationId: this.installationId,
      sourceRootId: request.sourceRootId,
      sourceSessionId,
      issuedAt,
      expiresAt,
      attestationDigest,
      digest: attestationDigest,
    };
  }

  private validateRequest(request: SourceRootAttestationRequest): void {
    if (!isRecord(request)) throw new SourceRootAuthorityError("INVALID_REQUEST");
    assertAllowedKeys(request, REQUEST_KEYS, "INVALID_REQUEST");
    if (request.installationId !== this.installationId) {
      throw new SourceRootAuthorityError("INSTALLATION_MISMATCH");
    }
    if (safeIdentifier(request.sourceRootId) === undefined) {
      throw new SourceRootAuthorityError("INVALID_REQUEST");
    }
    if (request.sourceSessionId !== undefined && safeSessionIdentifier(request.sourceSessionId) === undefined) {
      throw new SourceRootAuthorityError("MALFORMED_SESSION");
    }
  }

  private assertAdapterAccepted(): void {
    if (this.client.gate?.status !== "accepted") {
      throw new SourceRootAuthorityError("ADAPTER_QUARANTINED");
    }
  }

  private assertClientInstallation(): void {
    if (this.client.installationId !== undefined && this.client.installationId !== this.installationId) {
      throw new SourceRootAuthorityError("CROSS_INSTALL");
    }
  }

  private async collectList(): Promise<ReadonlyMap<string, ValidatedThread>> {
    const byId = new Map<string, ValidatedThread>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let itemCount = 0;
    for (let page = 0; page < this.limits.maxListPages; page += 1) {
      const params: JsonObject = {
        // Root authority must see JSONL-backed exec/sub-agent sessions as well
        // as the interactive state DB. Root selection remains restricted to
        // non-archived roots; reconciliation separately repairs archived
        // descendants. Keep the source filter explicit and bounded so a
        // future enum value cannot widen pairing authority.
        archived: false,
        useStateDbOnly: false,
        sourceKinds: CODEX_DISCOVERY_SOURCE_KINDS as unknown as JsonValue,
        limit: this.limits.listPageSize,
        ...(cursor === undefined ? {} : { cursor }),
      };
      let raw: SanitizedThreadPage;
      try {
        raw = await this.client.listThreads(params);
      } catch {
        throw new SourceRootAuthorityError("LIST_FAILED");
      }
      const value = validateListPage(raw);
      itemCount += value.threads.length;
      if (itemCount > this.limits.maxListItems) {
        throw new SourceRootAuthorityError("LIST_ITEM_LIMIT");
      }
      for (const thread of value.threads) {
        if (byId.has(thread.sourceThreadId)) {
          // Even byte-identical repeats are rejected.  A repeated id can be a
          // split-brain installation and must never become pairing authority.
          throw new SourceRootAuthorityError("DUPLICATE_ID");
        }
        byId.set(thread.sourceThreadId, thread);
      }
      if (value.nextCursor === undefined) return byId;
      if (value.nextCursor === cursor || seenCursors.has(value.nextCursor)) {
        throw new SourceRootAuthorityError("CURSOR_LOOP");
      }
      seenCursors.add(value.nextCursor);
      cursor = value.nextCursor;
    }
    throw new SourceRootAuthorityError("LIST_PAGE_LIMIT");
  }

  private async readRoot(sourceRootId: string): Promise<ValidatedThread> {
    let raw: SanitizedThreadRead;
    try {
      raw = await this.client.readThread({
        threadId: sourceRootId,
        includeTurns: false,
      });
    } catch {
      throw new SourceRootAuthorityError("READ_FAILED");
    }
    return validateReadPage(raw).thread;
  }

  private requireSession(value: unknown): string {
    const sessionId = safeSessionIdentifier(value);
    if (sessionId === undefined) throw new SourceRootAuthorityError("MALFORMED_SESSION");
    return sessionId;
  }
}

/** Narrow factory for composition roots that prefer a function over `new`. */
export function createCodexSourceRootAuthority(
  options: SourceRootAuthorityOptions,
): CodexSourceRootAuthority {
  return new CodexSourceRootAuthority(options);
}

/** Short compatibility alias; no broader RPC surface is added. */
export { CodexSourceRootAuthority as SourceRootAuthority };
