import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

type JsonObject = Record<string, any>;

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATE_PATH = join(REPOSITORY_ROOT, "evidence/phase-e/EXTERNAL_CHATGPT_ACCEPTANCE_RUN_TEMPLATE.json");
const VALIDATOR_PATH = join(REPOSITORY_ROOT, "evidence/phase-e/validate-external-acceptance.mts");
const EXACT_TOOLS = [
  "create_agent_session",
  "get_agent_details",
  "get_agent_hierarchy",
  "render_agent_hierarchy",
];

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function digest(label: string): string {
  return createHash("sha256").update(`agent-farm-synthetic-${label}`).digest("hex");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fillNulls(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) fillNulls(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as JsonObject)) {
    if (item === null) {
      (value as JsonObject)[key] = true;
    } else {
      fillNulls(item);
    }
  }
}

function setPath(root: JsonObject, path: string, value: unknown): void {
  const parts = path.split(".");
  const leaf = parts.pop();
  assert.ok(leaf);
  let current = root;
  for (const part of parts) {
    const next = current[part];
    assert.ok(next && typeof next === "object" && !Array.isArray(next), `fixture path ${path} must exist`);
    current = next;
  }
  current[leaf] = value;
}

function makePassRecord(): JsonObject {
  const record = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as JsonObject;
  // Fill template-only null placeholders, then overwrite each type-sensitive field
  // below. This keeps the fixture resilient to harmless additions to the template
  // while preserving explicit values for every validator invariant.
  fillNulls(record);

  Object.assign(record, {
    recordStatus: "final",
    overallStatus: "PASS",
    observedAt: "2026-08-10T00:00:00.000Z",
    operator: "synthetic-test-operator",
  });

  Object.assign(record.environment, {
    publicOrigin: "https://agent-farm.synthetic.example",
    releaseRevision: "synthetic-release-revision",
    executableSourceManifestSha256: digest("source-manifest"),
    mcpResourceSha256: digest("mcp-resource"),
    databaseSchemaVersion: 1,
    codexVersion: "0.145.0",
    codexBinarySha256: digest("codex-binary"),
    chatgptHostVersion: "synthetic-chatgpt-host",
    oauthProviderName: "synthetic-oauth-provider",
    builtInBrowserProduct: "Codex built-in browser",
    builtInBrowserVersion: "synthetic-browser-version",
    builtInBrowserProvenanceEvidenceRefs: ["synthetic/browser-provenance.json"],
  });

  record.privacyChecks.status = "PASS";
  for (const key of [
    "secretsAbsent",
    "cookiesAbsent",
    "authorizationCodesAbsent",
    "oauthSidOrJtiAbsent",
    "sourceIdsAbsent",
    "promptsOrMessagesAbsent",
    "localPathsAbsent",
    "toolArgumentsAbsent",
    "publicIdsStoredAsOneWayDigestsOnly",
  ]) {
    record.privacyChecks[key] = true;
  }
  record.privacyChecks.evidenceRefs = ["synthetic/privacy-scan.json"];

  Object.assign(record.principals.principalA, {
    standaloneAgentSessionDigest: digest("principal-a-standalone"),
    mcpAgentSessionDigest: digest("principal-a-agent-session"),
    mcpProtocolSessionDigest: digest("principal-a-protocol-session"),
    secureCookieAttributesPassed: true,
    tokenExposureScanPassed: true,
    evidenceRefs: ["synthetic/principal-a.json"],
  });
  Object.assign(record.principals.principalB, {
    standaloneAgentSessionDigest: digest("principal-b-standalone"),
    mcpAgentSessionDigest: digest("principal-b-agent-session"),
    mcpProtocolSessionDigest: digest("principal-b-protocol-session"),
    secureCookieAttributesPassed: true,
    tokenExposureScanPassed: true,
    evidenceRefs: ["synthetic/principal-b.json"],
  });

  for (const [gateName, gate] of Object.entries(record.gates as JsonObject)) {
    gate.status = "PASS";
    gate.evidenceRefs = [`synthetic/gates/${gateName}.json`];
  }

  Object.assign(record.gates.deploymentIdentityAndHttps, {
    healthzStatus: 200,
    readyStatus: 200,
    certificateHostnameValid: true,
    certificateExpiry: "2027-08-10T00:00:00.000Z",
    httpDowngradeRejected: true,
    originAndHostPolicyPassed: true,
  });
  record.gates.chatgptMcp.discoveredTools = [...EXACT_TOOLS];

  const expectedAgents: Record<string, Record<string, string>> = {
    Main: {
      parent: "NOT_APPLICABLE",
      parentReason: "Main is the selected root agent.",
      requestedModel: "NOT_APPLICABLE",
      requestedEffort: "NOT_APPLICABLE",
      requestedReason: "No explicit model or effort was requested for Main.",
      observedModel: "Sol",
      observedEffort: "XHigh",
      provider: "OpenAI",
      verification: "Unverified (no model requested)",
    },
    Dirac: {
      parent: "Main",
      requestedModel: "Sol",
      requestedEffort: "High",
      observedModel: "Sol",
      observedEffort: "High",
      provider: "OpenAI",
      verification: "Verified",
    },
    Rhea: {
      parent: "Dirac",
      requestedModel: "Luna",
      requestedEffort: "Max",
      observedModel: "Luna",
      observedEffort: "Max",
      provider: "OpenAI",
      verification: "Verified",
    },
    Kuhn: {
      parent: "Dirac",
      requestedModel: "Sol",
      requestedEffort: "Medium",
      observedModel: "Sol",
      observedEffort: "Medium",
      provider: "OpenAI",
      verification: "Verified",
    },
    Noether: {
      parent: "Rhea",
      requestedModel: "Sol",
      requestedEffort: "Low",
      observedModel: "Sol",
      observedEffort: "Low",
      provider: "OpenAI",
      verification: "Verified",
    },
  };
  for (const [agent, fields] of Object.entries(expectedAgents)) {
    Object.assign(record.gates.requiredHierarchyAndIdentity.agents[agent], fields);
  }

  Object.assign(record.gates.hostScale, {
    activeAgentCount: 25,
    completedAgentCount: 200,
    edgeCount: 224,
    firstUsefulInlineRenderMs: 120,
    fullscreenReadyMs: 240,
    searchFilterResponseMs: 20,
    branchExpandResponseMs: 30,
    detailsOpenResponseMs: 40,
    pageCount: 1,
    returnedAgentCount: 225,
    memorySnapshotMb: "NOT_EXPOSED",
    memorySnapshotReason: "Runtime host does not expose a stable per-widget memory metric.",
    missingPublicIds: 0,
    duplicatePublicIds: 0,
    unstableOrderingObserved: false,
    droppedFramesObserved: false,
    freezeOrCrashObserved: false,
    unboundedRequestLoopObserved: false,
    consoleErrors: [],
  });

  Object.assign(record.gates.liveRecovery, {
    duplicateEventDelta: 0,
    duplicateSourceDelta: 0,
    phantomActiveAgents: 0,
  });

  Object.assign(record.critic, {
    reviewedAt: "2026-08-10T00:05:00.000Z",
    verdict: "PASS",
    p0Count: 0,
    p1Count: 0,
    unresolvedFindings: [],
    evidenceRefs: ["synthetic/critic-review.json"],
  });
  Object.assign(record.rollback, {
    status: "PASS",
    tested: true,
    lastKnownGoodRevision: "synthetic-last-known-good",
    databaseBackupDigest: digest("database-backup"),
    credentialRevocationReady: true,
    evidenceRefs: ["synthetic/rollback.json"],
  });
  Object.assign(record.releaseVerdict, {
    status: "PASS",
    reason: "Synthetic sanitized record exercising the validator contract.",
    approvedBy: "synthetic-critic",
    approvedAt: "2026-08-10T00:10:00.000Z",
  });

  return record;
}

function runValidator(record: JsonObject | string, extraArgs: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "agent-farm-external-acceptance-"));
  temporaryDirectories.push(directory);
  const recordPath = join(directory, "record.json");
  if (typeof record === "string") {
    writeFileSync(recordPath, record, "utf8");
  } else {
    writeFileSync(recordPath, JSON.stringify(record, null, 2), "utf8");
  }
  return spawnSync(process.execPath, ["--import", "tsx", VALIDATOR_PATH, ...extraArgs, recordPath], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

function assertRejected(record: JsonObject, label: string): void {
  const result = runValidator(record);
  assert.notEqual(result.status, 0, `${label} must be rejected\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /EXTERNAL ACCEPTANCE INVALID:/, `${label} should explain the failed invariant`);
}

describe("external ChatGPT acceptance validator", () => {
  it("accepts the untouched template only in explicit --template HOLD mode", () => {
    const templateText = readFileSync(TEMPLATE_PATH, "utf8");
    const templateMode = runValidator(templateText, ["--template"]);
    assert.equal(templateMode.status, 0, templateMode.stderr);
    assert.match(templateMode.stdout, /TEMPLATE VALID \(still HOLD\)/);

    const withoutTemplateMode = runValidator(templateText);
    assert.notEqual(withoutTemplateMode.status, 0);
    assert.match(withoutTemplateMode.stderr, /recordStatus must be final|overallStatus must be PASS/);
  });

  it("rejects a trivial template relabel instead of treating HOLD evidence as PASS", () => {
    const relabeled = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as JsonObject;
    relabeled.recordStatus = "final";
    assertRejected(relabeled, "trivial recordStatus relabel");
  });

  it("accepts a fully populated, sanitized synthetic PASS record", () => {
    const result = runValidator(makePassRecord());
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /EXTERNAL CHATGPT ACCEPTANCE PASS \(validated\)/);
  });

  const failClosedMutations: Array<[string, (record: JsonObject) => void]> = [
    ["gate status HOLD", (record) => setPath(record, "gates.chatgptMcp.status", "HOLD")],
    ["gate invariant null", (record) => setPath(record, "gates.liveSecurity.tokenNegativesPassed", null)],
    ["extra MCP tool", (record) => record.gates.chatgptMcp.discoveredTools.push("control_agent")],
    ["missing MCP tool", (record) => record.gates.chatgptMcp.discoveredTools.pop()],
    ["hierarchy parent edge", (record) => setPath(record, "gates.requiredHierarchyAndIdentity.agents.Rhea.parent", "Main")],
    ["hierarchy observed identity", (record) => setPath(record, "gates.requiredHierarchyAndIdentity.agents.Rhea.observedModel", "Sol")],
    ["missing Main observed identity", (record) => setPath(record, "gates.requiredHierarchyAndIdentity.agents.Main.observedModel", "NOT_APPLICABLE")],
    ["active scale count", (record) => setPath(record, "gates.hostScale.activeAgentCount", 24)],
    ["completed scale count", (record) => setPath(record, "gates.hostScale.completedAgentCount", 199)],
    ["scale edge count", (record) => setPath(record, "gates.hostScale.edgeCount", 223)],
    ["returned scale count", (record) => setPath(record, "gates.hostScale.returnedAgentCount", 224)],
    ["browser provenance result", (record) => setPath(record, "gates.inlineAndFullscreen.builtInBrowserProvenancePassed", false)],
    ["browser provenance evidence", (record) => setPath(record, "environment.builtInBrowserProvenanceEvidenceRefs", [])],
    ["principal digest separation", (record) => setPath(record, "principals.principalB.standaloneAgentSessionDigest", record.principals.principalA.standaloneAgentSessionDigest)],
    ["privacy result", (record) => setPath(record, "privacyChecks.sourceIdsAbsent", false)],
    ["critic verdict", (record) => setPath(record, "critic.verdict", "REVISE")],
    ["critic unresolved finding", (record) => setPath(record, "critic.unresolvedFindings", ["synthetic finding"])],
    ["rollback status", (record) => setPath(record, "rollback.status", "HOLD")],
    ["rollback execution", (record) => setPath(record, "rollback.tested", false)],
    ["recovery invariant", (record) => setPath(record, "gates.liveRecovery.semanticProjectionStable", false)],
    ["recovery duplicate events", (record) => setPath(record, "gates.liveRecovery.duplicateEventDelta", 1)],
    ["security token negative", (record) => setPath(record, "gates.liveSecurity.tokenNegativesPassed", false)],
    ["security control discovery", (record) => setPath(record, "gates.liveSecurity.controlDiscoveryAndCallsRejected", false)],
  ];

  for (const [label, mutate] of failClosedMutations) {
    it(`fails closed for ${label}`, () => {
      const record = makePassRecord();
      mutate(record);
      assertRejected(record, label);
    });
  }
});
