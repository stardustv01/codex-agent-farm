import { readFileSync } from "node:fs";

const EXACT_TOOLS = [
  "create_agent_session",
  "get_agent_details",
  "get_agent_hierarchy",
  "render_agent_hierarchy",
];

function fail(message: string): never {
  process.stderr.write(`EXTERNAL ACCEPTANCE INVALID: ${message}\n`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split(".")) {
    if (!isRecord(current) || !(part in current)) {
      fail(`missing field ${path}`);
    }
    current = current[part];
  }
  return current;
}

function requireTrue(root: unknown, paths: string[]): void {
  for (const path of paths) {
    if (at(root, path) !== true) fail(`${path} must be true`);
  }
}

function requireFalse(root: unknown, paths: string[]): void {
  for (const path of paths) {
    if (at(root, path) !== false) fail(`${path} must be false`);
  }
}

function requireZero(root: unknown, paths: string[]): void {
  for (const path of paths) {
    if (at(root, path) !== 0) fail(`${path} must be zero`);
  }
}

function requireNonEmpty(root: unknown, paths: string[]): void {
  for (const path of paths) {
    const value = at(root, path);
    if (typeof value !== "string" || value.trim() === "") {
      fail(`${path} must be a non-empty string`);
    }
  }
}

function requireEvidence(root: unknown, path: string): void {
  const value = at(root, path);
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    fail(`${path} must contain at least one sanitized evidence reference`);
  }
}

function assertTemplate(root: unknown): void {
  if (at(root, "recordStatus") !== "template") fail("--template requires recordStatus=template");
  if (at(root, "overallStatus") !== "HOLD") fail("template overallStatus must be HOLD");
  if (at(root, "releaseVerdict.status") !== "HOLD") fail("template release verdict must be HOLD");
  const gates = at(root, "gates");
  if (!isRecord(gates) || Object.values(gates).some((gate) => !isRecord(gate) || gate.status !== "HOLD")) {
    fail("every template gate must be HOLD");
  }
  process.stdout.write("EXTERNAL ACCEPTANCE TEMPLATE VALID (still HOLD)\n");
}

const [modeOrPath, maybePath] = process.argv.slice(2);
const templateMode = modeOrPath === "--template";
const filePath = templateMode ? maybePath : modeOrPath;
if (!filePath) fail("usage: validate-external-acceptance.mts [--template] <record.json>");

let record: unknown;
try {
  record = JSON.parse(readFileSync(filePath, "utf8"));
} catch {
  fail("record must be readable valid JSON");
}

if (at(record, "schemaVersion") !== 1) fail("unsupported schemaVersion");
if (templateMode) {
  assertTemplate(record);
  process.exit(0);
}

if (at(record, "recordStatus") !== "final") fail("recordStatus must be final");
if (at(record, "overallStatus") !== "PASS") fail("overallStatus must be PASS");
if (at(record, "releaseVerdict.status") !== "PASS") fail("releaseVerdict.status must be PASS");

requireNonEmpty(record, [
  "observedAt",
  "operator",
  "environment.publicOrigin",
  "environment.releaseRevision",
  "environment.executableSourceManifestSha256",
  "environment.mcpResourceSha256",
  "environment.codexVersion",
  "environment.codexBinarySha256",
  "environment.chatgptHostVersion",
  "environment.oauthProviderName",
  "environment.builtInBrowserProduct",
  "environment.builtInBrowserVersion",
  "principals.principalA.standaloneAgentSessionDigest",
  "principals.principalA.mcpAgentSessionDigest",
  "principals.principalA.mcpProtocolSessionDigest",
  "principals.principalB.standaloneAgentSessionDigest",
  "principals.principalB.mcpAgentSessionDigest",
  "principals.principalB.mcpProtocolSessionDigest",
  "gates.deploymentIdentityAndHttps.certificateExpiry",
  "gates.requiredHierarchyAndIdentity.agents.Main.observedModel",
  "gates.requiredHierarchyAndIdentity.agents.Main.observedEffort",
  "gates.requiredHierarchyAndIdentity.agents.Main.provider",
  "gates.requiredHierarchyAndIdentity.agents.Main.verification",
  "gates.requiredHierarchyAndIdentity.agents.Dirac.observedModel",
  "gates.requiredHierarchyAndIdentity.agents.Dirac.observedEffort",
  "gates.requiredHierarchyAndIdentity.agents.Dirac.provider",
  "gates.requiredHierarchyAndIdentity.agents.Dirac.verification",
  "gates.requiredHierarchyAndIdentity.agents.Rhea.observedModel",
  "gates.requiredHierarchyAndIdentity.agents.Rhea.observedEffort",
  "gates.requiredHierarchyAndIdentity.agents.Rhea.provider",
  "gates.requiredHierarchyAndIdentity.agents.Rhea.verification",
  "gates.requiredHierarchyAndIdentity.agents.Kuhn.observedModel",
  "gates.requiredHierarchyAndIdentity.agents.Kuhn.observedEffort",
  "gates.requiredHierarchyAndIdentity.agents.Kuhn.provider",
  "gates.requiredHierarchyAndIdentity.agents.Kuhn.verification",
  "gates.requiredHierarchyAndIdentity.agents.Noether.observedModel",
  "gates.requiredHierarchyAndIdentity.agents.Noether.observedEffort",
  "gates.requiredHierarchyAndIdentity.agents.Noether.provider",
  "gates.requiredHierarchyAndIdentity.agents.Noether.verification",
  "gates.hostScale.memorySnapshotReason",
  "critic.reviewedAt",
  "critic.verdict",
  "rollback.lastKnownGoodRevision",
  "rollback.databaseBackupDigest",
  "releaseVerdict.reason",
  "releaseVerdict.approvedBy",
  "releaseVerdict.approvedAt",
]);

if (!Number.isInteger(at(record, "environment.databaseSchemaVersion"))) {
  fail("environment.databaseSchemaVersion must be an integer");
}
try {
  const origin = new URL(String(at(record, "environment.publicOrigin")));
  if (origin.protocol !== "https:" || origin.origin !== origin.href.replace(/\/$/, "")) {
    fail("environment.publicOrigin must be an exact https origin without a path, query, or fragment");
  }
} catch {
  fail("environment.publicOrigin must be a valid exact https origin");
}
for (const path of [
  "environment.executableSourceManifestSha256",
  "environment.mcpResourceSha256",
  "environment.codexBinarySha256",
  "principals.principalA.standaloneAgentSessionDigest",
  "principals.principalA.mcpAgentSessionDigest",
  "principals.principalA.mcpProtocolSessionDigest",
  "principals.principalB.standaloneAgentSessionDigest",
  "principals.principalB.mcpAgentSessionDigest",
  "principals.principalB.mcpProtocolSessionDigest",
  "rollback.databaseBackupDigest",
]) {
  if (!/^[a-f0-9]{64}$/.test(String(at(record, path)))) fail(`${path} must be a lowercase SHA-256 digest`);
}

const gates = at(record, "gates");
if (!isRecord(gates) || Object.values(gates).some((gate) => !isRecord(gate) || gate.status !== "PASS")) {
  fail("every external gate must be PASS");
}
for (const gateName of Object.keys(gates)) requireEvidence(record, `gates.${gateName}.evidenceRefs`);
requireEvidence(record, "environment.builtInBrowserProvenanceEvidenceRefs");
requireEvidence(record, "privacyChecks.evidenceRefs");
requireEvidence(record, "principals.principalA.evidenceRefs");
requireEvidence(record, "principals.principalB.evidenceRefs");
requireEvidence(record, "critic.evidenceRefs");
requireEvidence(record, "rollback.evidenceRefs");

requireTrue(record, [
  "privacyChecks.secretsAbsent",
  "privacyChecks.cookiesAbsent",
  "privacyChecks.authorizationCodesAbsent",
  "privacyChecks.oauthSidOrJtiAbsent",
  "privacyChecks.sourceIdsAbsent",
  "privacyChecks.promptsOrMessagesAbsent",
  "privacyChecks.localPathsAbsent",
  "privacyChecks.toolArgumentsAbsent",
  "privacyChecks.publicIdsStoredAsOneWayDigestsOnly",
  "principals.principalA.secureCookieAttributesPassed",
  "principals.principalA.tokenExposureScanPassed",
  "principals.principalB.secureCookieAttributesPassed",
  "principals.principalB.tokenExposureScanPassed",
  "gates.deploymentIdentityAndHttps.certificateHostnameValid",
  "gates.deploymentIdentityAndHttps.httpDowngradeRejected",
  "gates.deploymentIdentityAndHttps.originAndHostPolicyPassed",
  "gates.liveOAuthStandalone.principalACompleted",
  "gates.liveOAuthStandalone.principalBCompleted",
  "gates.liveOAuthStandalone.pkceCallbackPassed",
  "gates.liveOAuthStandalone.refreshStableSessionPassed",
  "gates.liveOAuthStandalone.logoutRevocationPassed",
  "gates.liveOAuthStandalone.concurrentIsolationPassed",
  "gates.liveOAuthStandalone.nonEnumeratingFailuresPassed",
  "gates.chatgptMcp.developerModeEnabled",
  "gates.chatgptMcp.connectionRegistered",
  "gates.chatgptMcp.newChatTested",
  "gates.chatgptMcp.exactFourToolsPassed",
  "gates.chatgptMcp.controlToolsAbsent",
  "gates.chatgptMcp.principalACompleted",
  "gates.chatgptMcp.principalBCompleted",
  "gates.chatgptMcp.concurrentIsolationPassed",
  "gates.chatgptMcp.privateFieldScanPassed",
  "gates.requiredHierarchyAndIdentity.exactEdgesPassed",
  "gates.requiredHierarchyAndIdentity.restAndMcpTopologyMatched",
  "gates.inlineAndFullscreen.builtInBrowserProvenancePassed",
  "gates.inlineAndFullscreen.inlineRendered",
  "gates.inlineAndFullscreen.inlineNoNestedScrollOrClipping",
  "gates.inlineAndFullscreen.fullscreenRendered",
  "gates.inlineAndFullscreen.composerUsable",
  "gates.inlineAndFullscreen.statePreservedAcrossCloseReopen",
  "gates.inlineAndFullscreen.sessionStableAcrossRemount",
  "gates.inlineAndFullscreen.statusStatesDistinguishable",
  "gates.inlineAndFullscreen.consoleAndCspClean",
  "gates.inlineAndFullscreen.viewports.narrowMobilePassed",
  "gates.inlineAndFullscreen.viewports.tabletPassed",
  "gates.inlineAndFullscreen.viewports.desktopPassed",
  "gates.inlineAndFullscreen.themes.lightPassed",
  "gates.inlineAndFullscreen.themes.darkPassed",
  "gates.inlineAndFullscreen.textResize200PercentPassed",
  "gates.accessibility.surfaces.standalone.keyboardPassed",
  "gates.accessibility.surfaces.standalone.focusOrderAndRestorePassed",
  "gates.accessibility.surfaces.standalone.voiceOverPassed",
  "gates.accessibility.surfaces.standalone.liveStatusAnnouncementsPassed",
  "gates.accessibility.surfaces.standalone.wcagAaContrastPassed",
  "gates.accessibility.surfaces.standalone.textResize200PercentPassed",
  "gates.accessibility.surfaces.chatgptFullscreen.keyboardPassed",
  "gates.accessibility.surfaces.chatgptFullscreen.focusOrderAndRestorePassed",
  "gates.accessibility.surfaces.chatgptFullscreen.voiceOverPassed",
  "gates.accessibility.surfaces.chatgptFullscreen.liveStatusAnnouncementsPassed",
  "gates.accessibility.surfaces.chatgptFullscreen.wcagAaContrastPassed",
  "gates.accessibility.surfaces.chatgptFullscreen.textResize200PercentPassed",
  "gates.liveRecovery.codexChildDropPerformed",
  "gates.liveRecovery.disconnectedStateObserved",
  "gates.liveRecovery.newConnectionEpochObserved",
  "gates.liveRecovery.semanticProjectionStable",
  "gates.liveRecovery.refreshAndFullscreenRemountPerformed",
  "gates.liveRecovery.agentFarmServerRestartPerformed",
  "gates.liveRecovery.agentSessionStableAcrossRefreshRemountRestart",
  "gates.liveSecurity.tokenNegativesPassed",
  "gates.liveSecurity.callbackPkceNegativesPassed",
  "gates.liveSecurity.csrfNegativesPassed",
  "gates.liveSecurity.callerIdentitySubstitutionRejected",
  "gates.liveSecurity.crossPrincipalReuseRejected",
  "gates.liveSecurity.unknownAndMalformedIdsNonEnumerating",
  "gates.liveSecurity.originHostForwardedHeaderNegativesPassed",
  "gates.liveSecurity.controlDiscoveryAndCallsRejected",
  "gates.liveSecurity.tokenBearingWidgetUrlsRejected",
  "gates.liveSecurity.secretAndPrivateFieldScanPassed",
  "rollback.tested",
  "rollback.credentialRevocationReady",
]);

if (at(record, "privacyChecks.status") !== "PASS") fail("privacyChecks.status must be PASS");
if (at(record, "rollback.status") !== "PASS") fail("rollback.status must be PASS");
if (at(record, "critic.verdict") !== "PASS") fail("critic.verdict must be PASS");
requireZero(record, ["critic.p0Count", "critic.p1Count"]);
const findings = at(record, "critic.unresolvedFindings");
if (!Array.isArray(findings) || findings.length !== 0) fail("critic.unresolvedFindings must be empty");

if (at(record, "gates.deploymentIdentityAndHttps.healthzStatus") !== 200) fail("healthzStatus must be 200");
if (at(record, "gates.deploymentIdentityAndHttps.readyStatus") !== 200) fail("readyStatus must be 200");

const discovered = at(record, "gates.chatgptMcp.discoveredTools");
if (!Array.isArray(discovered) || JSON.stringify([...discovered].sort()) !== JSON.stringify(EXACT_TOOLS)) {
  fail("discoveredTools must contain exactly the four V1 tools");
}

const expectedAgents: Record<string, Record<string, string>> = {
  Main: {
    parent: "NOT_APPLICABLE",
    parentReason: "Main is the selected root agent.",
    requestedModel: "NOT_APPLICABLE",
    requestedEffort: "NOT_APPLICABLE",
    requestedReason: "No explicit model or effort was requested for Main.",
    provider: "OpenAI",
    verification: "Unverified (no model requested)",
  },
  Dirac: { parent: "Main", requestedModel: "Sol", requestedEffort: "High", observedModel: "Sol", observedEffort: "High", provider: "OpenAI", verification: "Verified" },
  Rhea: { parent: "Dirac", requestedModel: "Luna", requestedEffort: "Max", observedModel: "Luna", observedEffort: "Max", provider: "OpenAI", verification: "Verified" },
  Kuhn: { parent: "Dirac", requestedModel: "Sol", requestedEffort: "Medium", observedModel: "Sol", observedEffort: "Medium", provider: "OpenAI", verification: "Verified" },
  Noether: { parent: "Rhea", requestedModel: "Sol", requestedEffort: "Low", observedModel: "Sol", observedEffort: "Low", provider: "OpenAI", verification: "Verified" },
};
for (const [agent, fields] of Object.entries(expectedAgents)) {
  for (const [field, expected] of Object.entries(fields)) {
    if (at(record, `gates.requiredHierarchyAndIdentity.agents.${agent}.${field}`) !== expected) {
      fail(`${agent}.${field} must equal ${expected}`);
    }
  }
}
for (const path of [
  "gates.requiredHierarchyAndIdentity.agents.Main.observedModel",
  "gates.requiredHierarchyAndIdentity.agents.Main.observedEffort",
]) {
  if (["NOT_APPLICABLE", "NOT_EXPOSED"].includes(String(at(record, path)))) {
    fail(`${path} must contain the runtime-observed value even when Main has no requested identity`);
  }
}

for (const [path, expected] of [
  ["gates.hostScale.activeAgentCount", 25],
  ["gates.hostScale.completedAgentCount", 200],
  ["gates.hostScale.edgeCount", 224],
  ["gates.hostScale.returnedAgentCount", 225],
] as const) {
  if (at(record, path) !== expected) fail(`${path} must equal ${expected}`);
}
for (const path of [
  "gates.hostScale.firstUsefulInlineRenderMs",
  "gates.hostScale.fullscreenReadyMs",
  "gates.hostScale.searchFilterResponseMs",
  "gates.hostScale.branchExpandResponseMs",
  "gates.hostScale.detailsOpenResponseMs",
  "gates.hostScale.pageCount",
]) {
  const value = at(record, path);
  if (typeof value !== "number" || value < 0) fail(`${path} must be a non-negative measurement`);
}
if (at(record, "gates.hostScale.memorySnapshotMb") !== "NOT_EXPOSED") {
  const memory = at(record, "gates.hostScale.memorySnapshotMb");
  if (typeof memory !== "number" || memory < 0) fail("memorySnapshotMb must be non-negative or NOT_EXPOSED");
}
requireZero(record, [
  "gates.hostScale.missingPublicIds",
  "gates.hostScale.duplicatePublicIds",
  "gates.liveRecovery.duplicateEventDelta",
  "gates.liveRecovery.duplicateSourceDelta",
  "gates.liveRecovery.phantomActiveAgents",
]);
requireFalse(record, [
  "gates.hostScale.unstableOrderingObserved",
  "gates.hostScale.droppedFramesObserved",
  "gates.hostScale.freezeOrCrashObserved",
  "gates.hostScale.unboundedRequestLoopObserved",
]);
for (const path of ["gates.hostScale.consoleErrors"]) {
  const value = at(record, path);
  if (!Array.isArray(value) || value.length !== 0) fail(`${path} must be empty`);
}

const a = at(record, "principals.principalA");
const b = at(record, "principals.principalB");
if (!isRecord(a) || !isRecord(b)) fail("principal records must be objects");
for (const field of ["standaloneAgentSessionDigest", "mcpAgentSessionDigest", "mcpProtocolSessionDigest"]) {
  if (a[field] === b[field]) fail(`principal A and B ${field} values must differ`);
}

process.stdout.write("EXTERNAL CHATGPT ACCEPTANCE PASS (validated)\n");
