import test from "node:test";
import assert from "node:assert/strict";
import {
  statSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureSecureConfigDirectory,
  parseExistingBudget,
  writeConfiguration,
} from "../../scripts/configure-local.mjs";
import { cleanupLocal, parseCleanupArgs, inspectCleanupTarget } from "../../scripts/cleanup-local.mjs";
import { parseArgs as parseDoctorArgs, versionAtLeast } from "../../scripts/doctor-local.mjs";
import { launcherExitCode } from "../../scripts/start-local.mjs";
import { sourceFiles } from "../../scripts/write-build-manifest.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("launcher-owned readiness failure cannot be replaced by a zero child exit", () => {
  assert.equal(launcherExitCode(0, null, null, true), 1);
  assert.equal(launcherExitCode(null, "SIGTERM", null, true), 1);

  assert.equal(launcherExitCode(0, null, null), 0);
  assert.equal(launcherExitCode(7, null, null), 7);
  assert.equal(launcherExitCode(null, "SIGINT", null), 130);
  assert.equal(launcherExitCode(null, null, "SIGTERM"), 143);
});

test("doctor version and argument guards are deterministic", () => {
  assert.equal(versionAtLeast("22.17.0", "22.17.0"), true);
  assert.equal(versionAtLeast("22.16.9", "22.17.0"), false);
  assert.equal(versionAtLeast("11.16.1", "11.16.0"), true);
  assert.throws(() => parseDoctorArgs(["--data-dir", "relative"]), /absolute path/iu);
  assert.deepEqual(parseDoctorArgs(["--json", "--port=8799"]), { dataDirectory: undefined, port: 8799, json: true });
  assert.deepEqual(parseDoctorArgs(["--", "--json", "--port=8799"]), { dataDirectory: undefined, port: 8799, json: true });
  assert.throws(() => parseDoctorArgs(["--", "--", "--json"]), /Unknown argument: --/u);
  assert.throws(() => parseDoctorArgs(["--json", "--"]), /Unknown argument: --/u);
  assert.throws(() => parseDoctorArgs(["--unknown"]), /Unknown argument: --unknown/u);
});

test("cleanup requires an explicit isolated target, confirmation, and unpaired acknowledgement", () => {
  assert.throws(() => parseCleanupArgs(["--reset"]), /--data-dir/iu);
  assert.throws(() => parseCleanupArgs(["--reset", "--data-dir=/tmp/farm"]), /--yes and --unpaired/iu);
  assert.throws(() => parseCleanupArgs(["--reset", "--data-dir=/tmp/farm", "--yes"]), /--yes and --unpaired/iu);
  assert.deepEqual(parseCleanupArgs(["--uninstall", "--data-dir=/tmp/farm", "--yes", "--unpaired"]), {
    mode: "uninstall",
    dataDirectory: "/tmp/farm",
    confirmed: true,
    unpaired: true,
  });
  assert.deepEqual(parseCleanupArgs(["--reset", "--data-dir", "/tmp/farm", "--yes", "--unpaired"]), {
    mode: "reset",
    dataDirectory: "/tmp/farm",
    confirmed: true,
    unpaired: true,
  });
  assert.deepEqual(parseCleanupArgs(["--reset", "--", "--data-dir=/tmp/farm", "--yes", "--unpaired"]), {
    mode: "reset",
    dataDirectory: "/tmp/farm",
    confirmed: true,
    unpaired: true,
  });
  assert.deepEqual(parseCleanupArgs(["--uninstall", "--", "--data-dir=/tmp/farm", "--yes", "--unpaired"]), {
    mode: "uninstall",
    dataDirectory: "/tmp/farm",
    confirmed: true,
    unpaired: true,
  });
  assert.throws(() => parseCleanupArgs(["--", "--uninstall", "--data-dir=/tmp/farm", "--yes", "--unpaired"]), /Unknown argument: --/u);
  assert.throws(() => parseCleanupArgs(["--uninstall", "--", "--", "--data-dir=/tmp/farm", "--yes", "--unpaired"]), /Unknown argument: --/u);
  assert.throws(() => parseCleanupArgs(["--uninstall", "--data-dir=/tmp/farm", "--", "--yes", "--unpaired"]), /Unknown argument: --/u);
  assert.throws(() => parseCleanupArgs(["--uninstall", "--unknown", "--data-dir=/tmp/farm", "--yes", "--unpaired"]), /Unknown argument: --unknown/u);
  assert.throws(() => parseCleanupArgs(["--reset", "--uninstall", "--data-dir=/tmp/farm", "--yes", "--unpaired"]), /exactly one cleanup mode/iu);
  assert.throws(() => parseCleanupArgs(["--reset", "--reset", "--data-dir=/tmp/farm", "--yes", "--unpaired"]), /exactly one cleanup mode/iu);
  assert.throws(() => inspectCleanupTarget(repoRoot, join(repoRoot, ".agent-farm")), /refusing to clean/iu);
  assert.throws(() => inspectCleanupTarget(repoRoot, homedir()), /basename must be \.agent-farm/iu);
});

test("setup accepts only an owned 0700 directory and parses an existing budget without changing it", () => {
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-farm-g8-config-")));
  try {
    const configDirectory = join(temporaryRoot, ".agent-farm");
    mkdirSync(configDirectory, { mode: 0o700 });
    chmodSync(configDirectory, 0o700);
    ensureSecureConfigDirectory(configDirectory);
    const budgetPath = join(configDirectory, "budget.env");
    writeFileSync(budgetPath, [
      'AGENT_FARM_LOCAL_MODE="1"',
      'AGENT_FARM_BUDGET_SOL_HIGH="4"',
      'AGENT_FARM_BUDGET_LUNA_MAX="5"',
      'AGENT_FARM_BUDGET_SOL_MAX="3"',
      "",
    ].join("\n"), { mode: 0o600 });
    assert.deepEqual(parseExistingBudget(budgetPath), { solHigh: 4, lunaMax: 5, solMax: 3 });
    writeConfiguration(temporaryRoot, { solHigh: 4, lunaMax: 5, solMax: 3 }, { codexPath: "/tmp/codex", codexHash: "a".repeat(64) });
    assert.equal(statSync(configDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(budgetPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(configDirectory, "README.txt")).mode & 0o777, 0o600);
    assert.equal(parseExistingBudget(budgetPath).solHigh, 4);
    chmodSync(configDirectory, 0o755);
    assert.throws(() => ensureSecureConfigDirectory(configDirectory), /mode 0700/iu);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("build source manifest excludes generated dist and dependency trees", () => {
  const files = sourceFiles(repoRoot).map((path) => path.replaceAll("\\", "/"));
  assert.ok(files.length > 10);
  assert.equal(files.some((path) => /(?:^|\/)(?:dist|node_modules)\//u.test(path)), false);
  const rootPackage = files.find((path) => path === `${repoRoot.replaceAll("\\", "/")}/package.json`);
  assert.ok(rootPackage);
  assert.equal(readFileSync(rootPackage, "utf8").includes('"packageManager": "pnpm@11.16.0"'), true);
});

test("guarded cleanup removes only a marked isolated directory", () => {
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-farm-g8-cleanup-")));
  const dataDirectory = join(temporaryRoot, ".agent-farm");
  try {
    mkdirSync(dataDirectory, { mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
    writeFileSync(join(dataDirectory, "README.txt"), "This directory contains generated, repository-local Agent Farm configuration.\n", { mode: 0o600 });
    writeFileSync(join(dataDirectory, "budget.env"), "AGENT_FARM_LOCAL_MODE=1\n", { mode: 0o600 });
    const result = cleanupLocal({ repoRoot, dataDirectory, mode: "reset" });
    assert.equal(result.mode, "reset");
    assert.equal(result.removed, resolve(dataDirectory));
    assert.throws(() => inspectCleanupTarget(repoRoot, dataDirectory), /ENOENT|no such file/iu);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("guarded cleanup rejects symlinked and permission-unsafe targets", () => {
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-farm-g8-unsafe-cleanup-")));
  const realParent = join(temporaryRoot, "real");
  const dataDirectory = join(realParent, ".agent-farm");
  const linkedParent = join(temporaryRoot, "linked");
  try {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
    writeFileSync(join(dataDirectory, "README.txt"), "This directory contains generated, repository-local Agent Farm configuration.\n", { mode: 0o600 });
    symlinkSync(realParent, linkedParent, "dir");
    assert.throws(() => inspectCleanupTarget(repoRoot, join(linkedParent, ".agent-farm")), /symlink component/iu);
    chmodSync(dataDirectory, 0o755);
    assert.throws(() => inspectCleanupTarget(repoRoot, dataDirectory), /mode 0700/iu);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("guarded cleanup refuses an active durable binding", () => {
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-farm-g8-active-")));
  const dataDirectory = join(temporaryRoot, ".agent-farm");
  const databasePath = join(dataDirectory, "local.sqlite");
  const requireFromStore = createRequire(join(repoRoot, "packages", "store", "package.json"));
  const Database = requireFromStore("better-sqlite3");
  let database;
  try {
    mkdirSync(dataDirectory, { mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
    writeFileSync(join(dataDirectory, "README.txt"), "This directory contains generated, repository-local Agent Farm configuration.\n", { mode: 0o600 });
    writeFileSync(join(dataDirectory, "budget.env"), "AGENT_FARM_LOCAL_MODE=1\n", { mode: 0o600 });
    database = new Database(databasePath);
    database.exec("CREATE TABLE bridge_bindings (source_adapter TEXT, status TEXT, expires_at INTEGER)");
    database.prepare("INSERT INTO bridge_bindings VALUES (?, ?, ?)").run("codex-app-server", "active", Date.now() + 60_000);
    database.close();
    database = undefined;
    chmodSync(databasePath, 0o600);
    assert.throws(() => cleanupLocal({ repoRoot, dataDirectory, mode: "uninstall" }), /durable pairing is still active/iu);
  } finally {
    try { database?.close(); } catch { /* best effort */ }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
