import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_BOOTSTRAP_COOKIE_NAME,
  LOCAL_SESSION_COOKIE_NAME,
  LocalBrowserSessionService,
  LocalSessionError,
} from "../src/local-session.js";

const temporaryDirectories: string[] = [];

function service(): LocalBrowserSessionService {
  const directory = mkdtempSync(join(tmpdir(), "agent-farm-local-session-"));
  temporaryDirectories.push(directory);
  return new LocalBrowserSessionService({ dataDirectory: directory });
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(";", 1)[0]!;
}

function cookieValue(setCookie: string, name: string): string {
  const value = cookieHeader(setCookie);
  const prefix = `${name}=`;
  expect(value.startsWith(prefix)).toBe(true);
  return decodeURIComponent(value.slice(prefix.length));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local browser session authority", () => {
  it("persists owner-only installation keys and issues a strict opaque cookie", () => {
    const auth = service();
    const bootstrap = auth.issueBootstrap();
    expect(bootstrap.setCookie).toContain(`${LOCAL_BOOTSTRAP_COOKIE_NAME}=`);
    expect(bootstrap.setCookie).toContain("HttpOnly");
    expect(bootstrap.setCookie).toContain("SameSite=Strict");
    expect(bootstrap.setCookie).not.toContain("Secure");
    const issued = auth.createSession(
      cookieHeader(bootstrap.setCookie),
      bootstrap.csrfToken,
      undefined,
      false,
    );
    expect(issued.setCookie).toContain(`${LOCAL_SESSION_COOKIE_NAME}=`);
    expect(issued.setCookie).toContain("HttpOnly");
    expect(issued.setCookie).toContain("SameSite=Strict");
    expect(issued.setCookie).toContain("Path=/");
    expect(issued.setCookie).not.toContain("Domain=");
    expect(issued.setCookie).not.toContain("Secure");
    expect(cookieValue(issued.setCookie, LOCAL_SESSION_COOKIE_NAME)).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u);

    const directory = auth.dataDirectory;
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const filename of ["local-installation-secret", "local-session-signing-key"]) {
      expect(statSync(join(directory, filename)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(directory, filename))).toHaveLength(32);
    }
  });

  it("consumes bootstrap material and rotates CSRF and session values", () => {
    const auth = service();
    const bootstrap = auth.issueBootstrap();
    const bootstrapHeader = cookieHeader(bootstrap.setCookie);
    const first = auth.createSession(bootstrapHeader, bootstrap.csrfToken, undefined, false);
    expect(() => auth.createSession(bootstrapHeader, bootstrap.csrfToken, undefined, false)).toThrowError(LocalSessionError);
    const oldCookie = cookieHeader(first.setCookie);
    const csrf = auth.requireCsrf(oldCookie, first.csrfToken);
    expect(csrf.csrfToken).not.toBe(first.csrfToken);
    expect(() => auth.requireCsrf(oldCookie, first.csrfToken)).toThrowError(LocalSessionError);

    const reloadBootstrap = auth.issueBootstrap();
    const reloadCookies = `${oldCookie}; ${cookieHeader(reloadBootstrap.setCookie)}`;
    const rotated = auth.createSession(reloadCookies, reloadBootstrap.csrfToken, reloadCookies, true);
    expect(rotated.setCookie).toContain("Secure");
    expect(() => auth.authenticate(oldCookie)).toThrowError(LocalSessionError);
    expect(auth.authenticate(cookieHeader(rotated.setCookie)).sessionId).toBe(first.session.sessionId);
  });

  it("accepts only fresh signed current-chat handoffs and rejects replay", () => {
    let now = 1_800_000_000_000;
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-local-focus-"));
    temporaryDirectories.push(directory);
    const auth = new LocalBrowserSessionService({ dataDirectory: directory, clock: () => now });
    const sourceRootId = "fixture-current-chat";
    const nonce = "n".repeat(32);
    const signature = createHmac("sha256", readFileSync(join(directory, "local-installation-secret")))
      .update(JSON.stringify(["agent-farm-local-focus-v1", sourceRootId, now, nonce]), "utf8")
      .digest("hex");
    const proof = { sourceRootId, issuedAt: now, nonce, signature };
    expect(auth.verifyFocusProof(proof)).toBe(true);
    expect(auth.verifyFocusProof(proof)).toBe(false);
    expect(auth.verifyFocusProof({ ...proof, nonce: "m".repeat(32), signature })).toBe(false);
    now += 30_001;
    expect(auth.verifyFocusProof({ ...proof, nonce: "q".repeat(32) })).toBe(false);
  });

  it("rejects missing, mismatched, expired, replayed, and duplicate bootstrap material", () => {
    let now = 1_800_000_000_000;
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-local-session-clock-"));
    temporaryDirectories.push(directory);
    const auth = new LocalBrowserSessionService({ dataDirectory: directory, clock: () => now });
    const first = auth.issueBootstrap();
    const firstCookie = cookieHeader(first.setCookie);
    expect(() => auth.createSession(undefined, first.csrfToken, undefined, false)).toThrowError(LocalSessionError);
    expect(() => auth.createSession(firstCookie, "csrf_wrong_1234567890", undefined, false)).toThrowError(LocalSessionError);
    now += 2 * 60 * 1_000 + 1;
    expect(() => auth.createSession(firstCookie, first.csrfToken, undefined, false)).toThrowError(LocalSessionError);
    const second = auth.issueBootstrap();
    const issued = auth.createSession(cookieHeader(second.setCookie), second.csrfToken, undefined, false);
    const sessionCookie = cookieHeader(issued.setCookie);
    expect(() => auth.createSession(cookieHeader(second.setCookie), second.csrfToken, sessionCookie, false)).toThrowError(LocalSessionError);
    expect(() => auth.authenticate(`${sessionCookie}; ${LOCAL_SESSION_COOKIE_NAME}=duplicate`)).toThrowError(LocalSessionError);
    now += 8 * 60 * 60 * 1_000 + 1;
    expect(() => auth.authenticate(sessionCookie)).toThrowError(LocalSessionError);
  });

  it("keeps two browser sessions isolated and invalidates them on restart", () => {
    const auth = service();
    const oneBootstrap = auth.issueBootstrap();
    const twoBootstrap = auth.issueBootstrap();
    const one = auth.createSession(cookieHeader(oneBootstrap.setCookie), oneBootstrap.csrfToken, undefined, false);
    const two = auth.createSession(cookieHeader(twoBootstrap.setCookie), twoBootstrap.csrfToken, undefined, false);
    const oneCookie = cookieHeader(one.setCookie);
    const twoCookie = cookieHeader(two.setCookie);
    expect(() => auth.requireCsrf(oneCookie, two.csrfToken)).toThrowError(LocalSessionError);
    expect(() => auth.requireCsrf(twoCookie, one.csrfToken)).toThrowError(LocalSessionError);
    expect(auth.authenticate(oneCookie).sessionId).not.toBe(auth.authenticate(twoCookie).sessionId);

    const replacement = new LocalBrowserSessionService({ dataDirectory: auth.dataDirectory });
    expect(() => replacement.authenticate(oneCookie)).toThrowError(LocalSessionError);
    expect(() => replacement.authenticate(twoCookie)).toThrowError(LocalSessionError);

    // A fresh bootstrap proof must not launder an unsigned or malformed
    // session cookie. It is discard-only and receives a new unrelated session.
    const forgedBootstrap = replacement.issueBootstrap();
    const forgedCookie = `${LOCAL_SESSION_COOKIE_NAME}=${"a".repeat(43)}.${"b".repeat(43)}`;
    const forgedReplacement = replacement.createSession(
      `${forgedCookie}; ${cookieHeader(forgedBootstrap.setCookie)}`,
      forgedBootstrap.csrfToken,
      `${forgedCookie}; ${cookieHeader(forgedBootstrap.setCookie)}`,
      false,
    );
    expect(forgedReplacement.session.sessionId).not.toBe(one.session.sessionId);
    expect(() => replacement.authenticate(forgedCookie)).toThrowError(LocalSessionError);

    // An arbitrary cookie without the one-time bootstrap proof still fails;
    // the recovery path cannot be used as a session-adoption endpoint.
    const missingProof = replacement.issueBootstrap();
    expect(() => replacement.createSession(
      forgedCookie,
      undefined,
      forgedCookie,
      false,
    )).toThrowError(LocalSessionError);
    // The unconsumed proof remains usable once with a fresh request.
    const recoveredAgain = replacement.createSession(
      cookieHeader(missingProof.setCookie),
      missingProof.csrfToken,
      forgedCookie,
      false,
    );
    expect(recoveredAgain.session.sessionId).not.toBe(forgedReplacement.session.sessionId);

    // A browser retains its signed cookie across a process restart. Once the
    // new bootstrap proof succeeds, that stale-but-valid installation cookie
    // must be replaceable so durable first-claim/remount can proceed.
    const restartBootstrap = replacement.issueBootstrap();
    const remounted = replacement.createSession(
      `${oneCookie}; ${cookieHeader(restartBootstrap.setCookie)}`,
      restartBootstrap.csrfToken,
      `${oneCookie}; ${cookieHeader(restartBootstrap.setCookie)}`,
      false,
    );
    expect(remounted.session.sessionId).not.toBe(one.session.sessionId);
    expect(() => replacement.authenticate(oneCookie)).toThrowError(LocalSessionError);
    const remountedCookie = cookieHeader(remounted.setCookie);
    expect(replacement.authenticate(remountedCookie).sessionId).toBe(remounted.session.sessionId);
    // Bootstrap CSRF is consumed once and never becomes session CSRF. The
    // replacement session accepts only its own freshly issued token.
    expect(() => replacement.createSession(
      `${oneCookie}; ${cookieHeader(restartBootstrap.setCookie)}`,
      restartBootstrap.csrfToken,
      `${oneCookie}; ${cookieHeader(restartBootstrap.setCookie)}`,
      false,
    )).toThrowError(LocalSessionError);
    expect(() => replacement.requireCsrf(remountedCookie, restartBootstrap.csrfToken)).toThrowError(LocalSessionError);
    expect(replacement.requireCsrf(remountedCookie, remounted.csrfToken).session.sessionId).toBe(remounted.session.sessionId);
  });

  it("replaces a prior-installation cookie only after an exact fresh bootstrap proof", () => {
    const prior = service();
    const priorBootstrap = prior.issueBootstrap();
    const priorSession = prior.createSession(cookieHeader(priorBootstrap.setCookie), priorBootstrap.csrfToken, undefined, false);
    const priorCookie = cookieHeader(priorSession.setCookie);

    // A separate data directory represents reinstall-generated keys. The old
    // host cookie is neither authenticatable nor adopted by the new service.
    const replacement = service();
    expect(() => replacement.authenticate(priorCookie)).toThrowError(LocalSessionError);
    expect(() => replacement.requireCsrf(priorCookie, priorSession.csrfToken)).toThrowError(LocalSessionError);

    const bootstrapA = replacement.issueBootstrap();
    const bootstrapB = replacement.issueBootstrap();
    const cookiesA = `${priorCookie}; ${cookieHeader(bootstrapA.setCookie)}`;
    const cookiesB = `${priorCookie}; ${cookieHeader(bootstrapB.setCookie)}`;

    // A valid bootstrap cookie and another bootstrap's CSRF value do not
    // consume either proof or authorize the stale cookie.
    expect(() => replacement.createSession(cookiesA, bootstrapB.csrfToken, cookiesA, false)).toThrowError(LocalSessionError);
    expect(() => replacement.authenticate(priorCookie)).toThrowError(LocalSessionError);

    const recovered = replacement.createSession(cookiesA, bootstrapA.csrfToken, cookiesA, false);
    const recoveredCookie = cookieHeader(recovered.setCookie);
    expect(recovered.session.sessionId).not.toBe(priorSession.session.sessionId);
    expect(recoveredCookie).not.toBe(priorCookie);
    expect(recovered.csrfToken).not.toBe(priorSession.csrfToken);
    expect(replacement.authenticate(recoveredCookie).sessionId).toBe(recovered.session.sessionId);
    expect(() => replacement.createSession(cookiesA, bootstrapA.csrfToken, cookiesA, false)).toThrowError(LocalSessionError);

    // The unrelated proof was not burned by the cross-CSRF attempt and can
    // independently create another isolated session once.
    const recoveredB = replacement.createSession(cookiesB, bootstrapB.csrfToken, cookiesB, false);
    expect(recoveredB.session.sessionId).not.toBe(recovered.session.sessionId);
    expect(replacement.authenticate(cookieHeader(recoveredB.setCookie)).sessionId).toBe(recoveredB.session.sessionId);
  });

  it("fails closed for malformed or unsafe persisted key material", () => {
    const auth = service();
    const keyPath = join(auth.dataDirectory, "local-session-signing-key");
    writeFileSync(keyPath, Buffer.alloc(1));
    expect(() => new LocalBrowserSessionService({ dataDirectory: auth.dataDirectory })).toThrowError(LocalSessionError);

    const unsafe = service();
    chmodSync(join(unsafe.dataDirectory, "local-installation-secret"), 0o644);
    expect(() => new LocalBrowserSessionService({ dataDirectory: unsafe.dataDirectory })).toThrowError(LocalSessionError);

    const nonFile = service();
    unlinkSync(join(nonFile.dataDirectory, "local-session-signing-key"));
    mkdirSync(join(nonFile.dataDirectory, "local-session-signing-key"));
    expect(() => new LocalBrowserSessionService({ dataDirectory: nonFile.dataDirectory })).toThrowError(LocalSessionError);

    const symlink = service();
    const symlinkKeyPath = join(symlink.dataDirectory, "local-session-signing-key");
    const targetPath = join(symlink.dataDirectory, "key-target");
    writeFileSync(targetPath, Buffer.alloc(32), { mode: 0o600 });
    unlinkSync(symlinkKeyPath);
    symlinkSync(targetPath, symlinkKeyPath);
    expect(() => new LocalBrowserSessionService({ dataDirectory: symlink.dataDirectory })).toThrowError(LocalSessionError);

    // Re-opening the same installation is idempotent and never replaces key
    // bytes. The hard-link EEXIST loser path is additionally fail-closed in
    // the implementation, but is not claimed as executed by this test.
    const reopened = service();
    const installation = readFileSync(join(reopened.dataDirectory, "local-installation-secret"));
    const signing = readFileSync(join(reopened.dataDirectory, "local-session-signing-key"));
    const reopenedAgain = new LocalBrowserSessionService({ dataDirectory: reopened.dataDirectory });
    expect(readFileSync(join(reopenedAgain.dataDirectory, "local-installation-secret"))).toEqual(installation);
    expect(readFileSync(join(reopenedAgain.dataDirectory, "local-session-signing-key"))).toEqual(signing);
  });
});
