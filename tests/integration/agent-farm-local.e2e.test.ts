import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DurableStore } from "@agent-farm/store";

import {
  InMemoryStore,
  TestBridge,
  createApp,
  type SourceRootCandidate,
} from "../../apps/server/src/index.ts";
import { DurableStorePort, ReadOnlyCodexBridgeAdapter } from "../../apps/server/src/composition.ts";

const LOOPBACK_HEADERS = { host: "127.0.0.1:8787" };
const FOREIGN_HEADERS = { host: "evil.test" };
const apps: Array<{ close(): Promise<void> }> = [];
const localDataDirectories: string[] = [];
const durableStores: DurableStore[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
  while (localDataDirectories.length > 0) rmSync(localDataDirectories.pop()!, { recursive: true, force: true });
  while (durableStores.length > 0) durableStores.pop()?.close();
});

type RootListingBridge = TestBridge & {
  listSourceRoots: () => Promise<readonly SourceRootCandidate[]>;
};

function rootsBridge(
  verify: (input: Parameters<TestBridge["verifyPairingSignature"]>[0]) => boolean | Promise<boolean> = () => true,
): RootListingBridge {
  return new TestBridge(verify) as RootListingBridge;
}

async function localApp(options: Parameters<typeof createApp>[0] = {}) {
  const localDataDirectory = options.localDataDirectory ?? mkdtempSync(join(tmpdir(), "agent-farm-local-e2e-"));
  if (options.localDataDirectory === undefined) localDataDirectories.push(localDataDirectory);
  const app = createApp({
    localMode: true,
    store: new InMemoryStore(),
    bridge: rootsBridge(),
    localDataDirectory,
    ...options,
  });
  apps.push(app);
  await app.ready();
  return app;
}

function setCookie(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const match = values.find((value) => value.startsWith(`${name}=`));
  assert.ok(match, `missing ${name} cookie`);
  return match!.split(";", 1)[0]!;
}

type LocalClient = { cookie: string; csrfToken: string; agentSessionId: string; selectionHandle?: string; origin: string; host: string };

async function createLocalSession(app: Awaited<ReturnType<typeof localApp>>, host = LOOPBACK_HEADERS.host, remoteAddress = "127.0.0.1"): Promise<LocalClient> {
  const origin = `http://${host}`;
  const bootstrap = await app.inject({ method: "GET", url: "/api/v1/local/bootstrap", remoteAddress, headers: { host } });
  assert.equal(bootstrap.statusCode, 200);
  const bootstrapBody = bootstrap.json<{ csrfToken: string }>();
  const bootstrapCookie = setCookie(bootstrap, "agent-farm-local-bootstrap");
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/local/session",
    remoteAddress,
    headers: { host, origin, cookie: bootstrapCookie, "x-csrf-token": bootstrapBody.csrfToken },
    payload: {},
  });
  assert.ok(response.statusCode === 201 || response.statusCode === 200);
  const body = response.json<{ agentSessionId: string; session: { agentSessionId: string }; csrfToken: string }>();
  assert.match(body.agentSessionId, /^as_[0-9a-f-]{36}$/u);
  assert.equal(body.session.agentSessionId, body.agentSessionId);
  const cookie = setCookie(response, "agent-farm-local-session");
  const status = await app.inject({ method: "GET", url: "/api/v1/local/status", remoteAddress, headers: { host, cookie } });
  assert.equal(status.statusCode, 200);
  const statusBody = status.json<{ csrfToken: string; candidateRoots?: Array<{ selectionHandle?: string }> }>();
  return {
    host,
    origin,
    cookie,
    csrfToken: statusBody.csrfToken,
    agentSessionId: body.agentSessionId,
    ...(typeof statusBody.candidateRoots?.[0]?.selectionHandle === "string" ? { selectionHandle: statusBody.candidateRoots[0].selectionHandle } : {}),
  };
}

function mutationHeaders(client: LocalClient): Record<string, string> {
  return { host: client.host, origin: client.origin, cookie: client.cookie, "x-csrf-token": client.csrfToken };
}

function updateCsrf(client: LocalClient, response: { headers: Record<string, string | string[] | undefined> }): void {
  const raw = response.headers["x-csrf-token"];
  const next = Array.isArray(raw) ? raw[0] : raw;
  if (typeof next === "string") client.csrfToken = next;
}

function assertError(response: { statusCode: number; json<T>(): T }, statusCode: number, code: string): void {
  assert.equal(response.statusCode, statusCode);
  assert.equal((response.json<{ error: { code: string } }>()).error.code, code);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("local status exposes bounded roots, pairing state, and the configured orchestration budget", async () => {
  const app = await localApp({
    localInstallationId: "install-local-e2e",
    orchestrationBudget: { solHigh: 10, lunaMax: 10, solMax: 3 },
  });
  const client = await createLocalSession(app);
  const response = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
  assert.equal(response.statusCode, 200);
  const body = response.json<{
    localMode: boolean;
    csrfToken: string;
    orchestrationBudget: { solHigh: number; lunaMax: number; solMax: number };
    paired: boolean;
    sourceRootCount: number;
    candidateRoots: Array<Record<string, unknown>>;
  }>();
  assert.equal(body.localMode, true);
  assert.match(body.csrfToken, /^[A-Za-z0-9_-]{16,512}$/u);
  assert.deepEqual(body.orchestrationBudget, { solHigh: 10, lunaMax: 10, solMax: 3 });
  assert.equal(body.paired, false);
  assert.equal(body.sourceRootCount, 2);
  assert.equal(body.candidateRoots.length, 2);
  assert.equal(typeof body.candidateRoots[0]?.selectionHandle, "string");
  assert.equal(body.candidateRoots[0]?.displayName, "Planner");
  assert.equal(body.candidateRoots[0]?.lifecycle, "running");
  assert.equal(body.candidateRoots[0]?.lastActivityAt, "2026-08-10T10:00:00.000Z");
  for (const root of body.candidateRoots) {
    assert.equal(Object.hasOwn(root, "prompt"), false);
    assert.equal(Object.hasOwn(root, "turns"), false);
    assert.equal(Object.hasOwn(root, "raw"), false);
    assert.equal(Object.hasOwn(root, "sourceRootId"), false);
    assert.equal(Object.hasOwn(root, "agentPath"), false);
    assert.equal(Object.hasOwn(root, "installationId"), false);
    assert.equal(Object.hasOwn(root, "digest"), false);
    assert.equal(Object.hasOwn(root, "version"), false);
  }
});

test("local session creation binds the new session to the local principal for hierarchy reads", async () => {
  const app = await localApp();
  const client = await createLocalSession(app);
  const agentSessionId = client.agentSessionId;
  const hierarchy = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/${agentSessionId}/hierarchy`,
    headers: { host: client.host, cookie: client.cookie },
  });
  assert.equal(hierarchy.statusCode, 200);
  const body = hierarchy.json<{ agentSessionId: string; nodes: unknown[]; total: number }>();
  assert.equal(body.agentSessionId, agentSessionId);
  assert.deepEqual(body.nodes, []);
  assert.equal(body.total, 0);
});

test("local root pairing issues a credential once and rejects missing or unattested bindings", async () => {
  const bridge = rootsBridge(() => true);
  const app = await localApp({ bridge, localInstallationId: "install-pairing-e2e" });
  const client = await createLocalSession(app);
  const agentSessionId = client.agentSessionId;
  assert.ok(client.selectionHandle);
  const payload = { selectionHandle: client.selectionHandle };
  const issued = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(client),
    payload,
  });
  assert.equal(issued.statusCode, 201);
  const credential = issued.json<{ agentSessionId: string; paired: boolean; expiresAt: string; credential?: string; sourceRootId?: string }>();
  assert.equal(credential.agentSessionId, agentSessionId);
  assert.equal(credential.paired, true);
  assert.equal(typeof credential.credential, "undefined");
  assert.equal(typeof credential.sourceRootId, "undefined");
  assert.ok(Date.parse(credential.expiresAt) > Date.now());
  updateCsrf(client, issued);

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(client),
    payload,
  });
  assertError(replay, 403, "INVALID_SELECTION");
  assert.equal(bridge.issued.length, 1);
  updateCsrf(client, replay);

  const missingSession = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(client),
    payload: { selectionHandle: "invalid-handle" },
  });
  assertError(missingSession, 403, "INVALID_SELECTION");

  class RejectingRootBridge extends TestBridge {
    override async attestSourceRoot(): Promise<never> {
      throw new Error("unattested root");
    }
  }
  const rejectingApp = await localApp({ bridge: new RejectingRootBridge() });
  const rejectingClient = await createLocalSession(rejectingApp);
  const rejectingSelection = rejectingClient.selectionHandle;
  const unattested = await rejectingApp.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(rejectingClient),
    payload: { selectionHandle: rejectingSelection },
  });
  assertError(unattested, 403, "SOURCE_ROOT_NOT_ATTESTED");
});

test("another browser can attach to the active chat but cannot activate a different chat", async () => {
  const bridge = rootsBridge(() => true);
  const app = await localApp({ bridge, localInstallationId: "install-two-browser-e2e" });
  const first = await createLocalSession(app);
  const second = await createLocalSession(app);
  assert.notEqual(first.agentSessionId, second.agentSessionId);
  assert.ok(first.selectionHandle);
  assert.ok(second.selectionHandle);

  const paired = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(first),
    payload: { selectionHandle: first.selectionHandle },
  });
  assert.equal(paired.statusCode, 201);
  updateCsrf(first, paired);

  const isolatedStatus = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: second.host, cookie: second.cookie } });
  const isolatedStatusBody = isolatedStatus.json<{ paired: boolean; activeTask?: unknown; candidateRoots: Array<{ selectionHandle?: string }> }>();
  assert.equal(isolatedStatusBody.paired, false);
  assert.equal(isolatedStatusBody.activeTask, undefined);
  const freshSecondSelection = isolatedStatusBody.candidateRoots[0]?.selectionHandle;
  assert.ok(freshSecondSelection);
  const isolatedCrossRead = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/${first.agentSessionId}/hierarchy`,
    headers: { host: second.host, cookie: second.cookie },
  });
  assert.equal(isolatedCrossRead.statusCode, 404);

  const attached = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(second),
    payload: { selectionHandle: freshSecondSelection },
  });
  assert.equal(attached.statusCode, 200);
  assert.deepEqual(attached.json(), {
    agentSessionId: first.agentSessionId,
    paired: true,
    activeTask: { displayName: "Planner", lifecycle: "running", lastActivityAt: "2026-08-10T10:00:00.000Z" },
  });
  assert.equal(JSON.stringify(attached.json()).includes("sourceRootId"), false);
  assert.equal(JSON.stringify(attached.json()).includes("credential"), false);
  updateCsrf(second, attached);

  const firstStatus = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: first.host, cookie: first.cookie } });
  const secondStatus = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: second.host, cookie: second.cookie } });
  assert.equal(firstStatus.json<{ paired: boolean }>().paired, true);
  assert.equal(secondStatus.json<{ paired: boolean }>().paired, true);
  assert.equal(bridge.issued.length, 1);
  assert.equal(bridge.listActivePairings("install-two-browser-e2e").length, 1);

  const secondHierarchy = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/${first.agentSessionId}/hierarchy`,
    headers: { host: second.host, cookie: second.cookie },
  });
  assert.equal(secondHierarchy.statusCode, 200);
  assert.equal(secondHierarchy.json<{ total: number }>().total, 0);

  const third = await createLocalSession(app);
  const thirdStatus = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: third.host, cookie: third.cookie } });
  third.csrfToken = thirdStatus.json<{ csrfToken: string }>().csrfToken;
  const differentRootHandle = thirdStatus.json<{ candidateRoots: Array<{ displayName: string; selectionHandle: string }> }>()
    .candidateRoots.find((candidate) => candidate.displayName === "Builder")?.selectionHandle;
  const rejectedDifferentRoot = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(third),
    payload: { selectionHandle: differentRootHandle },
  });
  assertError(rejectedDifferentRoot, 409, "PAIRING_UNAVAILABLE");
  assert.equal(bridge.listActivePairings("install-two-browser-e2e").length, 1);
  assert.equal(bridge.listActivePairings("install-two-browser-e2e")[0]?.sourceRootId, "source-root-test-1");
});

test("local switch and unpair mutations preserve the durable binding on failure and replace it only after confirmation", async () => {
  class LifecycleBridge extends TestBridge {
    failNextIssue = false;
    failNextRevoke = false;

    override async issuePairingCredential(input: Parameters<TestBridge["issuePairingCredential"]>[0]) {
      if (this.failNextIssue) {
        this.failNextIssue = false;
        throw new Error("forced pairing replacement failure");
      }
      return super.issuePairingCredential(input);
    }

    override revokePairing(input: Parameters<TestBridge["revokePairing"]>[0]): boolean {
      if (this.failNextRevoke) {
        this.failNextRevoke = false;
        return false;
      }
      return super.revokePairing(input);
    }
  }

  const bridge = new LifecycleBridge(() => true);
  const app = await localApp({ bridge, localInstallationId: "install-switch-e2e" });
  const client = await createLocalSession(app);
  assert.ok(client.selectionHandle);

  const initialPair = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(client),
    payload: { selectionHandle: client.selectionHandle },
  });
  assert.equal(initialPair.statusCode, 201);
  updateCsrf(client, initialPair);
  const initial = bridge.resolveActivePairing("install-switch-e2e");
  assert.ok(initial);
  const initialRoot = initial!.sourceRootId;

  const invalidSwitch = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/switch",
    headers: mutationHeaders(client),
    payload: { selectionHandle: "sel_invalid_switch", confirmation: true },
  });
  assertError(invalidSwitch, 403, "INVALID_SELECTION");
  updateCsrf(client, invalidSwitch);
  assert.equal(bridge.resolveActivePairing("install-switch-e2e")?.sourceRootId, initialRoot);

  const candidateStatus = await app.inject({
    method: "GET",
    url: "/api/v1/local/status",
    headers: { host: client.host, cookie: client.cookie },
  });
  assert.equal(candidateStatus.statusCode, 200);
  const candidateBody = candidateStatus.json<{ candidateRoots: Array<{ selectionHandle?: string }> }>();
  const replacementHandle = candidateBody.candidateRoots[1]?.selectionHandle;
  assert.ok(replacementHandle);
  const csrfAfterStatus = candidateBody as unknown as { csrfToken?: string };
  if (typeof csrfAfterStatus.csrfToken === "string") client.csrfToken = csrfAfterStatus.csrfToken;

  bridge.failNextIssue = true;
  const failedSwitch = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/switch",
    headers: mutationHeaders(client),
    payload: { selectionHandle: replacementHandle, confirmation: true },
  });
  assert.equal(failedSwitch.statusCode, 200);
  assert.equal(failedSwitch.json<{ syncing?: boolean }>().syncing, true);
  updateCsrf(client, failedSwitch);
  await waitFor(() => bridge.failNextIssue === false, "deferred failed switch did not run");
  assert.equal(bridge.resolveActivePairing("install-switch-e2e")?.sourceRootId, initialRoot);
  const preserved = await app.inject({
    method: "GET",
    url: "/api/v1/local/status",
    headers: { host: client.host, cookie: client.cookie },
  });
  assert.equal(preserved.statusCode, 200);
  assert.equal(preserved.json<{ paired: boolean }>().paired, true);
  const freshCandidates = preserved.json<{ candidateRoots: Array<{ selectionHandle?: string }>; csrfToken: string }>();
  client.csrfToken = freshCandidates.csrfToken;
  const successfulReplacementHandle = freshCandidates.candidateRoots[1]?.selectionHandle;
  assert.ok(successfulReplacementHandle);

  const switched = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/switch",
    headers: mutationHeaders(client),
    payload: { selectionHandle: successfulReplacementHandle, confirmation: true },
  });
  assert.equal(switched.statusCode, 200);
  updateCsrf(client, switched);
  await waitFor(
    () => bridge.listActivePairings("install-switch-e2e").length === 1 &&
      bridge.listActivePairings("install-switch-e2e")[0]?.sourceRootId !== initialRoot,
    "exclusive switch did not publish the replacement binding",
  );
  const replaced = bridge.resolveActivePairing("install-switch-e2e");
  assert.ok(replaced);
  assert.notEqual(replaced!.sourceRootId, initialRoot);
  assert.equal(bridge.listActivePairings("install-switch-e2e").length, 1);

  bridge.failNextRevoke = true;
  const failedUnpair = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/unpair",
    headers: mutationHeaders(client),
    payload: { confirmation: true },
  });
  assertError(failedUnpair, 503, "PAIRING_UNAVAILABLE");
  updateCsrf(client, failedUnpair);
  assert.ok(bridge.resolveActivePairing("install-switch-e2e"));
  const afterFailedUnpair = await app.inject({
    method: "GET",
    url: "/api/v1/local/status",
    headers: { host: client.host, cookie: client.cookie },
  });
  assert.equal(afterFailedUnpair.statusCode, 200);
  assert.equal(afterFailedUnpair.json<{ paired: boolean }>().paired, true);
  const unpairBody = afterFailedUnpair.json<{ csrfToken: string }>();
  client.csrfToken = unpairBody.csrfToken;

  const unpaired = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/unpair",
    headers: mutationHeaders(client),
    payload: { confirmation: true },
  });
  assert.equal(unpaired.statusCode, 200);
  assert.equal(unpaired.json<{ paired: boolean }>().paired, false);
  assert.equal(bridge.resolveActivePairing("install-switch-e2e"), null);
  const finalStatus = await app.inject({
    method: "GET",
    url: "/api/v1/local/status",
    headers: { host: client.host, cookie: client.cookie },
  });
  // Successful unpair invalidates the old browser session. A new browser
  // session must observe the durable installation as unpaired rather than
  // inheriting the revoked scope.
  assert.equal(finalStatus.statusCode, 401);
  const afterUnpair = await createLocalSession(app);
  const afterUnpairStatus = await app.inject({
    method: "GET",
    url: "/api/v1/local/status",
    headers: { host: afterUnpair.host, cookie: afterUnpair.cookie },
  });
  assert.equal(afterUnpairStatus.statusCode, 200);
  assert.equal(afterUnpairStatus.json<{ paired: boolean }>().paired, false);
});

test("file-backed switch and unpair roll back atomically and finish with no active binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-farm-durable-lifecycle-"));
  localDataDirectories.push(directory);
  const durable = new DurableStore(join(directory, "agent-farm.sqlite"));
  durableStores.push(durable);
  const installationId = "installation-durable-lifecycle";
  const bridge = new ReadOnlyCodexBridgeAdapter({
    durable,
    client: {
      gate: { status: "accepted" },
      listThreads: async () => ({
        threads: [
          { sourceThreadId: "root-durable-one", status: "active", agentNickname: "First" },
          { sourceThreadId: "root-durable-two", status: "active", agentNickname: "Second" },
        ],
      }),
      readThread: async () => ({ thread: { sourceThreadId: "root-durable-one", status: "active" }, turns: [] }),
      listModels: async () => ({ models: [] }),
    } as never,
    sourceRootAuthority: {
      attestSourceRoot: async (input) => ({
        installationId: input.installationId,
        sourceRootId: input.sourceRootId,
        sourceSessionId: `session-${input.sourceRootId}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        attestationDigest: "b".repeat(64),
      }),
    },
    verifyPairingSignature: () => true,
  });
  const app = await localApp({
    localDataDirectory: join(directory, "local-auth"),
    localInstallationId: installationId,
    store: new DurableStorePort(durable),
    bridge,
  });
  const client = await createLocalSession(app);
  assert.ok(client.selectionHandle);

  const pair = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(client),
    payload: { selectionHandle: client.selectionHandle },
  });
  assert.equal(pair.statusCode, 201);
  updateCsrf(client, pair);
  const initial = await bridge.resolveActivePairing(installationId);
  assert.ok(initial);
  const scope = {
    tenantId: initial!.tenantId,
    ownerId: initial!.ownerId,
    agentSessionId: initial!.agentSessionId,
  };
  const activeBindings = () => durable.bridgeBindings.list(scope)
    .filter((binding) => binding.status === "active" && binding.expiresAt > durable.now());
  const activeInstallationBindings = () => {
    const selected = durable.bridgeBindings.resolveUniqueActive(installationId);
    return selected === null ? 0 : 1;
  };
  assert.equal(activeInstallationBindings(), 1);

  const status = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
  assert.equal(status.statusCode, 200);
  const statusBody = status.json<{ csrfToken: string; candidateRoots: Array<Record<string, unknown>> }>();
  client.csrfToken = statusBody.csrfToken;
  const replacementHandle = statusBody.candidateRoots[1]?.selectionHandle;
  assert.equal(typeof replacementHandle, "string");
  for (const candidate of statusBody.candidateRoots) {
    assert.ok(Object.keys(candidate).every((key) => [
      "active", "bound", "chatHandle", "chatTitle", "descendantCount", "displayName", "lastActivityAt",
      "launchTarget", "lifecycle", "selectionHandle", "workspaceName",
    ].includes(key)));
    assert.equal(Object.hasOwn(candidate, "sourceRootId"), false);
    assert.equal(Object.hasOwn(candidate, "agentPath"), false);
    assert.equal(Object.hasOwn(candidate, "credential"), false);
  }
  assert.equal(statusBody.candidateRoots.filter((candidate) => candidate.active === true).length, 1);

  const originalAppend = durable.audit.append.bind(durable.audit);
  let failedSwitchObserved = false;
  durable.audit.append = ((input) => {
    if (input.action === "bridge.pairing.switched") {
      failedSwitchObserved = true;
      throw new Error("forced switch audit failure");
    }
    return originalAppend(input);
  }) as typeof durable.audit.append;
  const failedSwitch = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/switch",
    headers: mutationHeaders(client),
    payload: { selectionHandle: replacementHandle, confirmation: true },
  });
  assert.equal(failedSwitch.statusCode, 200);
  assert.equal(failedSwitch.json<{ syncing?: boolean }>().syncing, true);
  updateCsrf(client, failedSwitch);
  await waitFor(() => failedSwitchObserved, "deferred durable switch failure did not run");
  assert.equal((await bridge.resolveActivePairing(installationId))?.sourceRootId, initial!.sourceRootId);
  assert.equal(activeInstallationBindings(), 1);

  durable.audit.append = originalAppend;
  const afterFailedSwitch = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
  assert.equal(afterFailedSwitch.statusCode, 200);
  const afterFailedSwitchBody = afterFailedSwitch.json<{ paired: boolean; csrfToken: string; candidateRoots: Array<{ selectionHandle?: string }> }>();
  assert.equal(afterFailedSwitchBody.paired, true);
  client.csrfToken = afterFailedSwitchBody.csrfToken;
  const freshReplacementHandle = afterFailedSwitchBody.candidateRoots[1]?.selectionHandle;
  assert.ok(freshReplacementHandle);
  const switched = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/switch",
    headers: mutationHeaders(client),
    payload: { selectionHandle: freshReplacementHandle, confirmation: true },
  });
  assert.equal(switched.statusCode, 200);
  updateCsrf(client, switched);
  await waitFor(
    async () => (await bridge.resolveActivePairing(installationId))?.sourceRootId !== initial!.sourceRootId,
    "deferred durable switch did not publish the replacement binding",
  );
  const replaced = await bridge.resolveActivePairing(installationId);
  assert.ok(replaced);
  assert.notEqual(replaced!.sourceRootId, initial!.sourceRootId);
  assert.equal(activeInstallationBindings(), 1);

  durable.audit.append = ((input) => {
    if (input.action === "bridge.pairing.unpaired") throw new Error("forced unpair audit failure");
    return originalAppend(input);
  }) as typeof durable.audit.append;
  const failedUnpair = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/unpair",
    headers: mutationHeaders(client),
    payload: { confirmation: true },
  });
  assertError(failedUnpair, 503, "PAIRING_UNAVAILABLE");
  updateCsrf(client, failedUnpair);
  assert.equal((await bridge.resolveActivePairing(installationId))?.sourceRootId, replaced!.sourceRootId);
  assert.equal(activeInstallationBindings(), 1);

  durable.audit.append = originalAppend;
  const afterFailedUnpair = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: client.host, cookie: client.cookie } });
  assert.equal(afterFailedUnpair.statusCode, 200);
  const afterFailedUnpairBody = afterFailedUnpair.json<{ paired: boolean; csrfToken: string }>();
  assert.equal(afterFailedUnpairBody.paired, true);
  client.csrfToken = afterFailedUnpairBody.csrfToken;
  const unpaired = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/unpair",
    headers: mutationHeaders(client),
    payload: { confirmation: true },
  });
  assert.equal(unpaired.statusCode, 200);
  assert.equal(unpaired.json<{ paired: boolean }>().paired, false);
  assert.equal(await bridge.resolveActivePairing(installationId), null);
  assert.equal(activeBindings().length, 0);
});

test("local selection handles reject evicted generations, substitution, expiry, raw fields, and concurrent replay", async () => {
  const app = await localApp();
  const first = await createLocalSession(app);
  const second = await createLocalSession(app, "localhost:8787");
  assert.ok(first.selectionHandle);
  assert.ok(second.selectionHandle);
  const staleHandle = first.selectionHandle;
  let refreshedHandle: string | undefined;
  for (let generation = 0; generation < 4; generation += 1) {
    const refreshed = await app.inject({
      method: "GET",
      url: "/api/v1/local/status",
      headers: { host: first.host, cookie: first.cookie },
    });
    assert.equal(refreshed.statusCode, 200);
    refreshedHandle = refreshed.json<{ candidateRoots: Array<{ selectionHandle: string }> }>().candidateRoots[0]?.selectionHandle;
  }
  assert.ok(refreshedHandle);
  const stale = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(first),
    payload: { selectionHandle: staleHandle },
  });
  assertError(stale, 403, "INVALID_SELECTION");
  updateCsrf(first, stale);

  const substituted = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(first),
    payload: { selectionHandle: second.selectionHandle },
  });
  assertError(substituted, 403, "INVALID_SELECTION");
  updateCsrf(first, substituted);

  const malformed = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(first),
    payload: { selectionHandle: "not-a-handle" },
  });
  assertError(malformed, 403, "INVALID_SELECTION");
  updateCsrf(first, malformed);

  const rawField = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(first),
    payload: { selectionHandle: refreshedHandle, sourceRootId: "private-root" },
  });
  assertError(rawField, 400, "INVALID_SELECTION");
  updateCsrf(first, rawField);

  const originalNow = Date.now;
  try {
    const freshStatus = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: first.host, cookie: first.cookie } });
    const expiryHandle = freshStatus.json<{ candidateRoots: Array<{ selectionHandle: string }> }>().candidateRoots[0]?.selectionHandle;
    assert.ok(expiryHandle);
    Date.now = () => originalNow() + 121_000;
    const expired = await app.inject({
      method: "POST",
      url: "/api/v1/local/pairing/root",
      headers: mutationHeaders(first),
      payload: { selectionHandle: expiryHandle },
    });
    assertError(expired, 403, "INVALID_SELECTION");
    updateCsrf(first, expired);
  } finally {
    Date.now = originalNow;
  }

  const concurrentStatus = await app.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: first.host, cookie: first.cookie } });
  const concurrentHandle = concurrentStatus.json<{ candidateRoots: Array<{ selectionHandle: string }> }>().candidateRoots[0]?.selectionHandle;
  assert.ok(concurrentHandle);
  const [one, two] = await Promise.all([
    app.inject({ method: "POST", url: "/api/v1/local/pairing/root", headers: mutationHeaders(first), payload: { selectionHandle: concurrentHandle } }),
    app.inject({ method: "POST", url: "/api/v1/local/pairing/root", headers: mutationHeaders(first), payload: { selectionHandle: concurrentHandle } }),
  ]);
  assert.deepEqual([one.statusCode, two.statusCode].sort((a, b) => a - b), [201, 403]);
});

test("local mode rejects foreign Host headers before exposing local endpoints", async () => {
  const app = await localApp();
  const status = await app.inject({
    method: "GET",
    url: "/api/v1/local/status",
    headers: FOREIGN_HEADERS,
  });
  const session = await app.inject({
    method: "POST",
    url: "/api/v1/local/session",
    headers: FOREIGN_HEADERS,
  });
  const pairing = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: FOREIGN_HEADERS,
    payload: { sourceRootId: "source-root-test-1", agentSessionId: "as_not-reached" },
  });
  assertError(status, 403, "LOCAL_MODE_LOOPBACK_REQUIRED");
  assertError(session, 403, "LOCAL_MODE_LOOPBACK_REQUIRED");
  assertError(pairing, 403, "LOCAL_MODE_LOOPBACK_REQUIRED");
});

test("local mode requires a loopback socket even when Host is localhost", async () => {
  const app = await localApp();
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/local/status",
    remoteAddress: "203.0.113.5",
    headers: { host: "localhost:8787" },
  });
  assertError(response, 403, "LOCAL_MODE_LOOPBACK_REQUIRED");
});

test("local mode accepts an IPv6 loopback socket with a bracketed Host header", async () => {
  const app = await localApp({
    allowedHosts: ["[::1]:8787"],
    allowedOrigins: ["http://[::1]:8787"],
  });
  const client = await createLocalSession(app, "[::1]:8787", "::1");
  const response = await app.inject({ method: "GET", url: "/api/v1/local/status", remoteAddress: "::1", headers: { host: client.host, cookie: client.cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ localMode: boolean }>().localMode, true);
});

test("local root pairing rejects an active durable binding before the first mint", async () => {
  const durable = new DurableStore(":memory:");
  const bridge = new ReadOnlyCodexBridgeAdapter({
    durable,
    sourceRootAuthority: {
      async attestSourceRoot(input) {
        return {
          installationId: input.installationId,
          sourceRootId: input.sourceRootId,
          sourceSessionId: "source-session-durable",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          attestationDigest: "a".repeat(64),
        };
      },
    },
  });
  bridge.listSourceRoots = async () => [{ sourceRootId: "source-root-test-1", status: "running" }];
  bridge.hasActivePairing = async () => true;
  const app = createApp({
    localMode: true,
    store: new DurableStorePort(durable),
    bridge,
    localInstallationId: "install-durable-e2e",
    localDataDirectory: (() => {
      const directory = mkdtempSync(join(tmpdir(), "agent-farm-local-durable-e2e-"));
      localDataDirectories.push(directory);
      return directory;
    })(),
  });
  apps.push({
    async close() {
      await app.close();
      durable.close();
    },
  });
  await app.ready();
  const client = await createLocalSession(app);
  const agentSessionId = client.agentSessionId;
  assert.ok(client.selectionHandle);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/local/pairing/root",
    headers: mutationHeaders(client),
    payload: { selectionHandle: client.selectionHandle },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json<{ error: { code: string } }>().error.code, "PAIRING_ALREADY_COMPLETED");
});

test("file-backed durable binding remounts once, isolates a second browser, and stays unpaired after unpair/reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-farm-durable-remount-"));
  localDataDirectories.push(directory);
  const databaseFilename = join(directory, "agent-farm.sqlite");
  const localDataDirectory = join(directory, "local-auth");
  const persistedScope = {
    tenantId: "tenant-durable-remount",
    ownerId: "owner-durable-remount",
    agentSessionId: "as_11111111-1111-4111-8111-111111111111",
  } as const;
  const createDurableBridge = (durable: DurableStore): ReadOnlyCodexBridgeAdapter => new ReadOnlyCodexBridgeAdapter({
    durable,
    client: {
      gate: { status: "accepted" },
      listThreads: async () => ({ threads: [{ sourceThreadId: "root-durable", status: "active" }] }),
      readThread: async () => ({ thread: { sourceThreadId: "root-durable", status: "active" }, turns: [] }),
      listModels: async () => ({ models: [] }),
    } as never,
    sourceRootAuthority: {
      attestSourceRoot: async (input) => ({
        installationId: input.installationId,
        sourceRootId: input.sourceRootId,
        sourceSessionId: "source-session-durable",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        attestationDigest: "a".repeat(64),
      }),
    },
    verifyPairingSignature: () => true,
  });

  const firstStore = new DurableStore(databaseFilename);
  durableStores.push(firstStore);
  firstStore.createAgentSession({ ...persistedScope, sourceAdapter: "codex-app-server" });
  const firstBridge = createDurableBridge(firstStore);
  await firstBridge.issuePairingCredential({
    pairingId: "pairing-durable-remount",
    nonce: "nonce-durable-remount",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ownerId: persistedScope.ownerId,
    tenantId: persistedScope.tenantId,
    installationId: "installation-durable-remount",
    publicKey: "fixture",
    sourceRootId: "root-durable",
    sourceSessionId: "source-session-durable",
    sourceRootAttestationDigest: "a".repeat(64),
    sourceRootAttestationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    agentSessionId: persistedScope.agentSessionId,
    requestedScopes: ["bridge:ingest"],
  });
  const firstApp = createApp({
    localMode: true,
    localDataDirectory,
    localInstallationId: "installation-durable-remount",
    store: new DurableStorePort(firstStore),
    bridge: firstBridge,
  });
  apps.push(firstApp);
  await firstApp.ready();
  const claimed = await createLocalSession(firstApp);
  assert.equal(claimed.agentSessionId, persistedScope.agentSessionId);
  const claimedStatus = await firstApp.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: claimed.host, cookie: claimed.cookie } });
  assert.equal(claimedStatus.json<{ paired: boolean; activeTask?: unknown }>().paired, true);
  assert.deepEqual(claimedStatus.json<{ activeTask?: unknown }>().activeTask, { displayName: "Chat · 01", lifecycle: "active" });
  const isolated = await createLocalSession(firstApp, "localhost:8787");
  assert.notEqual(isolated.agentSessionId, persistedScope.agentSessionId);
  const isolatedStatus = await firstApp.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: isolated.host, cookie: isolated.cookie } });
  assert.equal(isolatedStatus.json<{ paired: boolean }>().paired, false);
  const crossRead = await firstApp.inject({ method: "GET", url: `/api/v1/agent-sessions/${persistedScope.agentSessionId}/hierarchy`, headers: { host: isolated.host, cookie: isolated.cookie } });
  assert.equal(crossRead.statusCode, 404);
  await firstApp.close();
  apps.splice(apps.indexOf(firstApp), 1);
  firstStore.close();
  durableStores.splice(durableStores.indexOf(firstStore), 1);

  const secondStore = new DurableStore(databaseFilename);
  durableStores.push(secondStore);
  const secondBridge = createDurableBridge(secondStore);
  const secondApp = createApp({
    localMode: true,
    localDataDirectory,
    localInstallationId: "installation-durable-remount",
    store: new DurableStorePort(secondStore),
    bridge: secondBridge,
  });
  apps.push(secondApp);
  await secondApp.ready();
  const remounted = await createLocalSession(secondApp);
  assert.equal(remounted.agentSessionId, persistedScope.agentSessionId);
  const remountedStatus = await secondApp.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: remounted.host, cookie: remounted.cookie } });
  assert.equal(remountedStatus.json<{ paired: boolean; activeTask?: unknown }>().paired, true);
  assert.deepEqual(remountedStatus.json<{ activeTask?: unknown }>().activeTask, { displayName: "Chat · 01", lifecycle: "active" });
  const unpair = await secondApp.inject({ method: "POST", url: "/api/v1/local/pairing/unpair", headers: mutationHeaders(remounted), payload: { confirmation: true } });
  assert.equal(unpair.statusCode, 200);
  await secondApp.close();
  apps.splice(apps.indexOf(secondApp), 1);
  secondStore.close();
  durableStores.splice(durableStores.indexOf(secondStore), 1);

  const thirdStore = new DurableStore(databaseFilename);
  durableStores.push(thirdStore);
  const thirdApp = createApp({
    localMode: true,
    localDataDirectory,
    localInstallationId: "installation-durable-remount",
    store: new DurableStorePort(thirdStore),
    bridge: createDurableBridge(thirdStore),
  });
  apps.push(thirdApp);
  await thirdApp.ready();
  const afterUnpair = await createLocalSession(thirdApp);
  assert.notEqual(afterUnpair.agentSessionId, persistedScope.agentSessionId);
  const afterUnpairStatus = await thirdApp.inject({ method: "GET", url: "/api/v1/local/status", headers: { host: afterUnpair.host, cookie: afterUnpair.cookie } });
  assert.equal(afterUnpairStatus.json<{ paired: boolean }>().paired, false);
});

test("local status is absent when local mode is disabled", async () => {
  const app = createApp({ store: new InMemoryStore() });
  apps.push(app);
  await app.ready();
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/local/status",
    headers: LOOPBACK_HEADERS,
  });
  assertError(response, 404, "NOT_FOUND");
});
