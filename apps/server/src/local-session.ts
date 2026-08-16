import {
  createHmac,
  randomBytes as cryptoRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { BrowserSessionAuthority } from "./browser-session.js";

/**
 * Local browser authentication is intentionally separate from OAuth.  The
 * service owns only installation key material on disk; sessions and CSRF
 * state live in memory, so a process restart invalidates every browser
 * session while preserving the installation identity used for future keys.
 */
export const LOCAL_SESSION_COOKIE_NAME = "agent-farm-local-session";
export const LOCAL_BOOTSTRAP_COOKIE_NAME = "agent-farm-local-bootstrap";
export const LOCAL_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
export const LOCAL_BOOTSTRAP_TTL_MS = 2 * 60 * 1_000;

const KEY_BYTES = 32;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u;
const TOKEN_VALUE = /^[A-Za-z0-9_-]{16,512}$/u;
const FOCUS_SOURCE_ROOT = /^[A-Za-z0-9._:-]{1,256}$/u;
const FOCUS_NONCE = /^[A-Za-z0-9_-]{22,86}$/u;
const FOCUS_SIGNATURE = /^[a-f0-9]{64}$/u;
const FOCUS_MAX_SKEW_MS = 30_000;

export type LocalSessionErrorCode =
  | "configuration_error"
  | "csrf_failed"
  | "not_authenticated";

export class LocalSessionError extends Error {
  readonly code: LocalSessionErrorCode;
  readonly statusCode: number;

  constructor(code: LocalSessionErrorCode, message = "Authentication failed") {
    super(message);
    this.name = "LocalSessionError";
    this.code = code;
    this.statusCode = code === "configuration_error"
      ? 500
      : code === "csrf_failed"
        ? 403
        : 401;
  }
}

export interface LocalSessionOptions {
  readonly dataDirectory: string;
  readonly sessionTtlMs?: number;
  readonly bootstrapTtlMs?: number;
  readonly cookieName?: string;
  readonly bootstrapCookieName?: string;
  readonly clock?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array;
}

export interface LocalSessionView {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface LocalBootstrapIssue {
  readonly csrfToken: string;
  readonly setCookie: string;
  readonly expiresAt: number;
}

export interface LocalSessionIssue {
  readonly session: LocalSessionView;
  readonly csrfToken: string;
  readonly setCookie: string;
}

export interface LocalCsrfValidation {
  readonly session: LocalSessionView;
  /** A fresh one-time token. The supplied token is invalid after validation. */
  readonly csrfToken: string;
}

interface SessionRecord extends LocalSessionView {
  tokenDigest: string;
  csrfDigest: Buffer;
  csrfToken: string;
}

interface BootstrapRecord {
  readonly expiresAt: number;
  readonly csrfDigest: Buffer;
}

/**
 * Process-scoped local session authority. It deliberately does not expose
 * cookie values, installation secrets, signing keys, or filesystem paths.
 */
export class LocalBrowserSessionService implements BrowserSessionAuthority<LocalSessionView, LocalCsrfValidation> {
  readonly dataDirectory: string;
  readonly cookieName: string;
  readonly bootstrapCookieName: string;

  private readonly installationSecret: Buffer;
  private readonly signingKey: Buffer;
  private readonly sessionTtlMs: number;
  private readonly bootstrapTtlMs: number;
  private readonly clock: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly bootstraps = new Map<string, BootstrapRecord>();
  private readonly focusNonces = new Map<string, number>();

  constructor(options: LocalSessionOptions) {
    const dataDirectory = resolve(options.dataDirectory);
    if (!isAbsolute(options.dataDirectory) || dataDirectory.length === 0) {
      throw new LocalSessionError("configuration_error", "Local session data directory is invalid");
    }
    this.dataDirectory = dataDirectory;
    this.cookieName = normalizeCookieName(options.cookieName ?? LOCAL_SESSION_COOKIE_NAME);
    this.bootstrapCookieName = normalizeCookieName(options.bootstrapCookieName ?? LOCAL_BOOTSTRAP_COOKIE_NAME);
    this.sessionTtlMs = boundedPositive(options.sessionTtlMs ?? LOCAL_SESSION_TTL_MS, 24 * 60 * 60 * 1_000);
    this.bootstrapTtlMs = boundedPositive(options.bootstrapTtlMs ?? LOCAL_BOOTSTRAP_TTL_MS, 15 * 60 * 1_000);
    this.clock = options.clock ?? Date.now;
    this.randomBytes = options.randomBytes ?? ((length) => cryptoRandomBytes(length));
    ensureDataDirectory(dataDirectory);
    this.installationSecret = loadOrCreateKey(join(dataDirectory, "local-installation-secret"));
    this.signingKey = loadOrCreateKey(join(dataDirectory, "local-session-signing-key"));
  }

  /** Issue the one-time bootstrap material returned by the read-only status endpoint. */
  issueBootstrap(secure = false): LocalBootstrapIssue {
    this.cleanup();
    const binding = this.randomToken(32);
    const csrfToken = this.randomToken(32);
    const now = this.clock();
    const expiresAt = now + this.bootstrapTtlMs;
    this.bootstraps.set(this.digest(binding), {
      expiresAt,
      csrfDigest: this.digestBytes(csrfToken),
    });
    return {
      csrfToken,
      setCookie: serializeCookie(this.bootstrapCookieName, binding, this.bootstrapTtlMs, secure),
      expiresAt,
    };
  }

  /**
   * Consume a bootstrap cookie and matching CSRF value exactly once. A valid
   * existing session is rotated for browser reload. An unusable session
   * cookie is discard-only: it may be replaced only after this fresh
   * bootstrap proof validates and is consumed, and never contributes a
   * principal, scope, or CSRF value.
   */
  createSession(
    bootstrapCookieHeader: string | undefined,
    suppliedCsrfToken: unknown,
    sessionCookieHeader: string | undefined,
    secure: boolean,
  ): LocalSessionIssue {
    this.cleanup();
    let hasExistingSession = this.hasCookie(sessionCookieHeader, this.cookieName);
    if (hasExistingSession) {
      try {
        this.authenticate(sessionCookieHeader);
      } catch (error: unknown) {
        // Process-scoped sessions intentionally disappear on restart, and a
        // browser may retain a cookie signed by a previous installation.
        // Defer every unusable-cookie decision until the fresh bootstrap
        // proof below validates. This branch never adopts or inspects the
        // stale value beyond authentication failure classification.
        if (!(error instanceof LocalSessionError) || error.code !== "not_authenticated") throw error;
        hasExistingSession = false;
      }
    }
    const binding = this.readCookie(bootstrapCookieHeader, this.bootstrapCookieName);
    if (binding === undefined || !isToken(suppliedCsrfToken)) {
      throw new LocalSessionError("csrf_failed", "CSRF validation failed");
    }
    const bootstrapDigest = this.digest(binding);
    const record = this.bootstraps.get(bootstrapDigest);
    if (record === undefined || record.expiresAt <= this.clock()) {
      this.bootstraps.delete(bootstrapDigest);
      throw new LocalSessionError("csrf_failed", "CSRF validation failed");
    }
    if (!constantTimeEqual(record.csrfDigest, this.digestBytes(suppliedCsrfToken))) {
      throw new LocalSessionError("csrf_failed", "CSRF validation failed");
    }
    this.bootstraps.delete(bootstrapDigest);
    if (hasExistingSession) return this.rotateSession(sessionCookieHeader, secure);
    const sessionToken = this.randomToken(32);
    const csrfToken = this.randomToken(32);
    const now = this.clock();
    const session: SessionRecord = {
      sessionId: `local_${this.randomToken(18)}`,
      tokenDigest: this.digest(sessionToken),
      csrfDigest: this.digestBytes(csrfToken),
      csrfToken,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    };
    this.sessions.set(session.tokenDigest, session);
    return {
      session: view(session),
      csrfToken,
      setCookie: serializeCookie(this.cookieName, this.signedCookie(sessionToken), this.sessionTtlMs, secure),
    };
  }

  authenticate(cookieHeader: string | undefined): LocalSessionView {
    this.cleanup();
    const token = this.readCookie(cookieHeader, this.cookieName);
    if (token === undefined || !this.verifySignedCookie(token)) {
      throw new LocalSessionError("not_authenticated", "Authentication is required");
    }
    const session = this.sessions.get(this.digest(token.slice(0, token.indexOf("."))));
    if (session === undefined || session.expiresAt <= this.clock()) {
      if (session !== undefined) this.sessions.delete(session.tokenDigest);
      throw new LocalSessionError("not_authenticated", "Authentication is required");
    }
    return view(session);
  }

  authenticateCookie(cookieHeader?: string): LocalSessionView | null {
    try {
      return this.authenticate(cookieHeader);
    } catch (error: unknown) {
      if (error instanceof LocalSessionError && error.code === "not_authenticated") return null;
      throw error;
    }
  }

  /** Validate and rotate the session-bound CSRF token. */
  requireCsrf(cookieHeader: string | undefined, suppliedCsrfToken: unknown): LocalCsrfValidation {
    this.cleanup();
    const token = this.readCookie(cookieHeader, this.cookieName);
    if (token === undefined || !this.verifySignedCookie(token)) {
      throw new LocalSessionError("not_authenticated", "Authentication is required");
    }
    const session = this.sessions.get(this.digest(token.slice(0, token.indexOf("."))));
    if (session === undefined || session.expiresAt <= this.clock()) {
      if (session !== undefined) this.sessions.delete(session.tokenDigest);
      throw new LocalSessionError("not_authenticated", "Authentication is required");
    }
    if (!isToken(suppliedCsrfToken) || !constantTimeEqual(session.csrfDigest, this.digestBytes(suppliedCsrfToken))) {
      throw new LocalSessionError("csrf_failed", "CSRF validation failed");
    }
    const csrfToken = this.randomToken(32);
    session.csrfDigest = this.digestBytes(csrfToken);
    session.csrfToken = csrfToken;
    return { session: view(session), csrfToken };
  }

  /** Return the current session CSRF value for an authenticated read-only status response. */
  currentCsrfToken(cookieHeader: string | undefined): string {
    const token = this.readCookie(cookieHeader, this.cookieName);
    const session = this.authenticate(cookieHeader);
    if (token === undefined) throw new LocalSessionError("not_authenticated", "Authentication is required");
    const record = this.sessions.get(this.digest(token.slice(0, token.indexOf("."))));
    if (record === undefined) throw new LocalSessionError("not_authenticated", "Authentication is required");
    return record.csrfToken;
  }

  /** Verify a short-lived launcher-to-localhost current-chat handoff. */
  verifyFocusProof(input: { readonly sourceRootId: unknown; readonly issuedAt: unknown; readonly nonce: unknown; readonly signature: unknown }): boolean {
    this.cleanup();
    if (typeof input.sourceRootId !== "string" || !FOCUS_SOURCE_ROOT.test(input.sourceRootId) ||
      typeof input.issuedAt !== "number" || !Number.isSafeInteger(input.issuedAt) ||
      typeof input.nonce !== "string" || !FOCUS_NONCE.test(input.nonce) ||
      typeof input.signature !== "string" || !FOCUS_SIGNATURE.test(input.signature)) return false;
    const now = this.clock();
    if (Math.abs(now - input.issuedAt) > FOCUS_MAX_SKEW_MS) return false;
    const nonceDigest = this.digest(`focus-nonce:${input.nonce}`);
    if (this.focusNonces.has(nonceDigest)) return false;
    const message = JSON.stringify(["agent-farm-local-focus-v1", input.sourceRootId, input.issuedAt, input.nonce]);
    const expected = createHmac("sha256", this.installationSecret).update(message, "utf8").digest();
    const supplied = Buffer.from(input.signature, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    this.focusNonces.set(nonceDigest, now + FOCUS_MAX_SKEW_MS);
    while (this.focusNonces.size > 256) {
      const oldest = this.focusNonces.keys().next().value;
      if (typeof oldest !== "string") break;
      this.focusNonces.delete(oldest);
    }
    return true;
  }

  /** Rotate the opaque session cookie on a session-bound status refresh. */
  rotateSession(cookieHeader: string | undefined, secure: boolean): LocalSessionIssue {
    const token = this.readCookie(cookieHeader, this.cookieName);
    const session = this.authenticate(cookieHeader);
    if (token === undefined) throw new LocalSessionError("not_authenticated", "Authentication is required");
    const oldDigest = this.digest(token.slice(0, token.indexOf(".")));
    this.sessions.delete(oldDigest);
    const sessionToken = this.randomToken(32);
    const csrfToken = this.randomToken(32);
    const replacement: SessionRecord = {
      sessionId: session.sessionId,
      tokenDigest: this.digest(sessionToken),
      csrfDigest: this.digestBytes(csrfToken),
      csrfToken,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
    this.sessions.set(replacement.tokenDigest, replacement);
    return {
      session: view(replacement),
      csrfToken,
      setCookie: serializeCookie(this.cookieName, this.signedCookie(sessionToken), Math.max(0, replacement.expiresAt - this.clock()), secure),
    };
  }

  /** Test/support hook used only to express the documented restart policy. */
  invalidateProcessSessions(): void {
    this.sessions.clear();
    this.bootstraps.clear();
  }

  private signedCookie(token: string): string {
    const signature = createHmac("sha256", this.signingKey).update(token, "ascii").digest("base64url");
    return `${token}.${signature}`;
  }

  private verifySignedCookie(value: string): boolean {
    if (!COOKIE_VALUE.test(value)) return false;
    const separator = value.indexOf(".");
    const token = value.slice(0, separator);
    const supplied = Buffer.from(value.slice(separator + 1), "ascii");
    const expected = createHmac("sha256", this.signingKey).update(token, "ascii").digest();
    return supplied.length === expected.toString("base64url").length
      && constantTimeEqual(supplied, Buffer.from(expected.toString("base64url"), "ascii"));
  }

  private digest(value: string): string {
    return createHmac("sha256", this.installationSecret).update(value, "utf8").digest("hex");
  }

  private digestBytes(value: string): Buffer {
    return createHmac("sha256", this.installationSecret).update(value, "utf8").digest();
  }

  private randomToken(length: number): string {
    const bytes = this.randomBytes(length);
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
      throw new LocalSessionError("configuration_error", "Local session randomness is invalid");
    }
    return Buffer.from(bytes).toString("base64url");
  }

  private readCookie(header: string | undefined, name: string): string | undefined {
    if (typeof header !== "string") return undefined;
    let found: string | undefined;
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator <= 0 || part.slice(0, separator).trim() !== name) continue;
      if (found !== undefined) throw new LocalSessionError("not_authenticated", "Authentication is required");
      const value = part.slice(separator + 1).trim();
      if (value.length === 0 || value.length > 512) return undefined;
      try {
        found = decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
    return found;
  }

  private hasCookie(header: string | undefined, name: string): boolean {
    if (typeof header !== "string") return false;
    return header.split(";").some((part) => {
      const separator = part.indexOf("=");
      return separator > 0 && part.slice(0, separator).trim() === name;
    });
  }

  private cleanup(): void {
    const now = this.clock();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
    for (const [key, bootstrap] of this.bootstraps) {
      if (bootstrap.expiresAt <= now) this.bootstraps.delete(key);
    }
    for (const [key, expiresAt] of this.focusNonces) {
      if (expiresAt <= now) this.focusNonces.delete(key);
    }
  }
}

function ensureDataDirectory(directory: string): void {
  if (existsSync(directory)) {
    let stat;
    try {
      stat = lstatSync(directory);
    } catch {
      throw new LocalSessionError("configuration_error", "Local session data directory is unavailable");
    }
    if (!stat.isDirectory()) throw new LocalSessionError("configuration_error", "Local session data directory is invalid");
    if ((stat.mode & 0o777) !== 0o700) {
      throw new LocalSessionError("configuration_error", "Local session data directory permissions are unsafe");
    }
    assertOwner(stat.uid, "Local session data directory");
  } else {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch {
      throw new LocalSessionError("configuration_error", "Local session data directory is unavailable");
    }
  }
  try {
    // mkdir's mode is subject to umask; normalize only a directory created by
    // this process, while an existing unsafe directory fails closed above.
    chmodSync(directory, 0o700);
    const normalized = lstatSync(directory);
    const mode = normalized.mode & 0o777;
    if (mode !== 0o700) throw new Error("unsafe permissions");
    assertOwner(normalized.uid, "Local session data directory");
  } catch {
    throw new LocalSessionError("configuration_error", "Local session data directory is unavailable");
  }
}

function loadOrCreateKey(path: string): Buffer {
  try {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error: unknown) {
      if (isMissingPath(error)) stat = undefined;
      else throw error;
    }
    if (stat !== undefined) {
      return readExistingKey(path, stat);
    }
    const value = Buffer.from(cryptoRandomBytes(KEY_BYTES));
    const temporaryPath = `${path}.${Buffer.from(cryptoRandomBytes(12)).toString("hex")}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      const written = writeSync(descriptor, value);
      if (written !== value.length) throw new Error("partial key write");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        // Hard-link publication is atomic and never overwrites a key another
        // process won between lstat and publication. A concurrent loser loads
        // and validates the winner below.
        linkSync(temporaryPath, path);
      } catch (error: unknown) {
        if (!isExistingPath(error)) throw error;
        return readExistingKey(path, lstatSync(path));
      } finally {
        try { unlinkSync(temporaryPath); } catch { /* already absent */ }
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporaryPath); } catch { /* already renamed or absent */ }
    }
    chmodSync(path, 0o600);
    const created = lstatSync(path);
    if (!created.isFile() || (created.mode & 0o777) !== 0o600) throw new Error("unsafe key material");
    assertOwner(created.uid, "Local session key material");
    return value;
  } catch {
    throw new LocalSessionError("configuration_error", "Local session key material is unavailable");
  }
}

function readExistingKey(path: string, stat: Stats): Buffer {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid key file");
  if ((stat.mode & 0o777) !== 0o600) throw new Error("unsafe key permissions");
  assertOwner(stat.uid, "Local session key material");
  const value = readFileSync(path);
  if (value.length !== KEY_BYTES) throw new Error("invalid key length");
  return value;
}

function isExistingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertOwner(uid: number, label: string): void {
  const getuid = process.getuid;
  if (typeof getuid === "function" && uid !== getuid()) {
    throw new LocalSessionError("configuration_error", `${label} ownership is unsafe`);
  }
}

function normalizeCookieName(value: string): string {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u.test(value) || value.startsWith("__Host-")) {
    throw new LocalSessionError("configuration_error", "Local session cookie name is invalid");
  }
  return value;
}

function boundedPositive(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new LocalSessionError("configuration_error", "Local session lifetime is invalid");
  }
  return value;
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_VALUE.test(value);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function serializeCookie(name: string, value: string, maxAgeMs: number, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor(maxAgeMs / 1_000));
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function view(session: LocalSessionView): LocalSessionView {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}
