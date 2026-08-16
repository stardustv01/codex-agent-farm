import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertBuildManifestFresh } from "./write-build-manifest.mjs";

const MIN_NODE = "22.17.0";
const MIN_PNPM = "11.16.0";
const CODEX_VERSION = "0.145.0";
const CODEX_HASH_PATTERN = /(?:export\s+)?const\s+PHASE_A_BINARY_SHA256\s*=\s*["']([a-f0-9]{64})["']/iu;
const BUDGET_KEYS = [
  "AGENT_FARM_BUDGET_SOL_HIGH",
  "AGENT_FARM_BUDGET_LUNA_MAX",
  "AGENT_FARM_BUDGET_SOL_MAX",
];
const BUDGET_BOUNDS = {
  AGENT_FARM_BUDGET_SOL_HIGH: [0, 10],
  AGENT_FARM_BUDGET_LUNA_MAX: [0, 10],
  AGENT_FARM_BUDGET_SOL_MAX: [2, 3],
};

function versionParts(value) {
  return String(value).split(".").map((part) => Number.parseInt(part, 10));
}

export function versionAtLeast(actual, minimum) {
  const a = versionParts(actual);
  const b = versionParts(minimum);
  for (let index = 0; index < b.length; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return true;
}

function extractVersion(output) {
  const match = /(?<!\d)(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?!\d)/.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function checkOwner(stat, path) {
  const current = uid();
  return current === null || stat.uid === current
    ? null
    : `${path} is owned by uid ${stat.uid}; current uid is ${current}.`;
}

function checkPath(path, kind, mode) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return { ok: false, detail: `${path} is not readable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (stat.isSymbolicLink()) return { ok: false, detail: `${path} must not be a symlink.` };
  if (kind === "directory" && !stat.isDirectory()) return { ok: false, detail: `${path} must be a directory.` };
  if (kind === "file" && !stat.isFile()) return { ok: false, detail: `${path} must be a regular file.` };
  const ownerFailure = checkOwner(stat, path);
  if (ownerFailure) return { ok: false, detail: ownerFailure };
  if (mode !== undefined && (stat.mode & 0o777) !== mode) {
    return { ok: false, detail: `${path} must have mode ${mode.toString(8).padStart(4, "0")}; found ${(stat.mode & 0o777).toString(8).padStart(4, "0")}.` };
  }
  return { ok: true, detail: `${path} is an owned ${kind} with safe permissions.` };
}

function parseEnvironmentFile(filePath) {
  const parsed = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`invalid line ${index + 1}`);
    const value = match[2].trim();
    parsed[match[1]] = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value;
  }
  return parsed;
}

function budgetCheck(budgetPath) {
  const parsed = parseEnvironmentFile(budgetPath);
  const values = {};
  for (const key of BUDGET_KEYS) {
    const raw = parsed[key];
    if (!/^\d+$/.test(raw ?? "")) throw new Error(`${key} must be an integer`);
    const value = Number.parseInt(raw, 10);
    const [minimum, maximum] = BUDGET_BOUNDS[key];
    if (value < minimum || value > maximum) throw new Error(`${key} must be from ${minimum} to ${maximum}`);
    values[key] = value;
  }
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  if (total > 25) throw new Error(`combined budget must be 25 or less; found ${total}`);
  return values;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function pinnedCodexHash(repoRoot) {
  for (const relativePath of ["packages/codex-bridge/src/gate.ts", "packages/codex-bridge/dist/gate.js"]) {
    const path = join(repoRoot, relativePath);
    if (!existsSync(path)) continue;
    const match = CODEX_HASH_PATTERN.exec(readFileSync(path, "utf8"));
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function codexCheck(repoRoot) {
  const path = join(homedir(), ".local", "bin", "codex");
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return { ok: false, detail: `Codex CLI is not executable at ${path}; install the pinned ${CODEX_VERSION} binary.` };
  }
  const version = spawnSync(path, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const actualVersion = extractVersion(`${version.stdout ?? ""}\n${version.stderr ?? ""}`);
  if (actualVersion !== CODEX_VERSION) return { ok: false, detail: `Codex CLI version ${actualVersion ?? "unknown"} does not match required ${CODEX_VERSION}.` };
  const expected = pinnedCodexHash(repoRoot);
  if (!expected) return { ok: false, detail: "Pinned Codex binary hash is unavailable in the checkout." };
  const actual = sha256File(path);
  if (actual !== expected) return { ok: false, detail: `Codex CLI hash does not match the pinned binary (expected sha256:${expected.slice(0, 16)}..., found sha256:${actual.slice(0, 16)}...).` };
  return { ok: true, detail: `Codex ${CODEX_VERSION} is executable and hash-verified (sha256:${actual.slice(0, 16)}...).` };
}

export function parseArgs(argumentsList) {
  const options = { dataDirectory: undefined, port: Number.parseInt(process.env.PORT ?? "8787", 10), json: false };
  let separatorSeen = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    // pnpm forwards an optional conventional `--` separator. Accept one
    // leading separator so the documented `pnpm doctor:local -- ...` form
    // reaches the same parser as direct `node scripts/doctor-local.mjs ...`.
    if (argument === "--" && !separatorSeen && index === 0) separatorSeen = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--data-dir" || argument === "--data-directory") {
      const value = argumentsList[++index];
      if (!value) throw new Error(`${argument} requires an absolute path`);
      options.dataDirectory = value;
    } else if (argument.startsWith("--data-dir=")) options.dataDirectory = argument.slice("--data-dir=".length);
    else if (argument.startsWith("--port=")) options.port = Number.parseInt(argument.slice("--port=".length), 10);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.dataDirectory !== undefined && !isAbsolute(options.dataDirectory)) throw new Error("--data-dir must be an absolute path");
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) throw new Error("--port must be an integer from 1 through 65535");
  return options;
}

async function optionalPortCheck(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(750) });
    return response.ok
      ? { ok: true, detail: `Agent Farm healthz is ready on 127.0.0.1:${port}.` }
      : { ok: false, detail: `A listener responded on 127.0.0.1:${port}, but healthz returned HTTP ${response.status}.` };
  } catch {
    return { ok: true, detail: `No local server is running on 127.0.0.1:${port}; readiness check skipped.` };
  }
}

export async function runDoctor({ repoRoot, dataDirectory, port }) {
  const checks = [];
  const add = (name, result) => checks.push({ name, ...result });
  add("node", versionAtLeast(process.versions.node, MIN_NODE)
    ? { ok: true, detail: `Node.js ${process.versions.node}.` }
    : { ok: false, detail: `Node.js ${process.versions.node} is below required ${MIN_NODE}.` });
  const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const pnpmVersion = extractVersion(`${pnpm.stdout ?? ""}\n${pnpm.stderr ?? ""}`);
  add("pnpm", pnpm.status === 0 && pnpmVersion !== null && versionAtLeast(pnpmVersion, MIN_PNPM)
    ? { ok: true, detail: `pnpm ${pnpmVersion}.` }
    : { ok: false, detail: `pnpm ${pnpmVersion ?? "unavailable"} is below required ${MIN_PNPM}.` });
  add("codex", codexCheck(repoRoot));

  const configDirectory = resolve(dataDirectory ?? join(repoRoot, ".agent-farm"));
  add("config-directory", checkPath(configDirectory, "directory", 0o700));
  const budgetPath = join(configDirectory, "budget.env");
  const readmePath = join(configDirectory, "README.txt");
  const budgetResult = checkPath(budgetPath, "file", 0o600);
  if (budgetResult.ok) {
    try {
      const values = budgetCheck(budgetPath);
      add("budget", { ok: true, detail: `Budget is valid (${Object.values(values).reduce((sum, value) => sum + value, 0)} total slots); values are not printed.` });
    } catch (error) {
      add("budget", { ok: false, detail: `Budget is invalid: ${error instanceof Error ? error.message : String(error)}.` });
    }
  } else add("budget", budgetResult);
  add("config-readme", checkPath(readmePath, "file", 0o600));

  const manifest = (() => {
    try {
      const value = assertBuildManifestFresh(repoRoot);
      return { ok: true, detail: `Built server/web outputs match source manifest sha256:${value.sourceDigest.slice(0, 16)}....` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  })();
  add("build-manifest", manifest);

  const localAuth = join(configDirectory, "local-auth");
  if (existsSync(localAuth)) {
    add("local-auth", checkPath(localAuth, "directory", 0o700));
    if (checkPath(localAuth, "directory", 0o700).ok) {
      for (const entry of ["local-installation-secret", "local-session-signing-key"]) {
        add(`local-auth/${entry}`, checkPath(join(localAuth, entry), "file", 0o600));
      }
    }
  } else add("local-auth", { ok: true, detail: "Installation key directory will be created by the first local server start." });
  const databasePath = join(configDirectory, "local.sqlite");
  if (existsSync(databasePath)) {
    add("database", checkPath(databasePath, "file", 0o600));
    try {
      const header = readFileSync(databasePath).subarray(0, 16).toString("utf8");
      if (header !== "SQLite format 3\u0000") add("database-format", { ok: false, detail: "local.sqlite does not have a valid SQLite header." });
      else add("database-format", { ok: true, detail: "local.sqlite has a valid SQLite header; contents are not printed." });
    } catch (error) {
      add("database-format", { ok: false, detail: `Cannot read local.sqlite: ${error instanceof Error ? error.message : String(error)}.` });
    }
  } else add("database", { ok: true, detail: "No durable local database yet; it will be created on first start." });
  add("readiness", await optionalPortCheck(port));
  return { ok: checks.every((check) => check.ok), checks };
}

async function main() {
  const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
  const repoRoot = resolve(scriptDirectory, "..");
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await runDoctor({ repoRoot, dataDirectory: options.dataDirectory, port: options.port });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log("Agent Farm local doctor");
      for (const check of report.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
      console.log(report.ok ? "Doctor result: PASS" : "Doctor result: FAIL (apply the listed remedy before local acceptance)");
    }
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Doctor cannot run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
