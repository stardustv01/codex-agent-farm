#!/usr/bin/env node
import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = join(packageRoot, "release", "runtime");
const metadata = JSON.parse(readFileSync(join(runtimeRoot, "release.json"), "utf8"));
const port = Number.parseInt(process.env.AGENT_FARM_PORT ?? "8799", 10);
const stateRoot = resolve(process.env.AGENT_FARM_DATA_HOME ?? join(homedir(), ".agent-farm"));
const stateParent = dirname(stateRoot);
const expectedStateRoot = join(stateParent, ".agent-farm");
const url = `http://127.0.0.1:${port}`;
const budgetPath = join(stateRoot, "budget.env");
const pidPath = join(stateRoot, "server.pid");
const logPath = join(stateRoot, "server.log");
const serverEntry = join(runtimeRoot, "server.mjs");
const webRoot = join(runtimeRoot, "web");
const CODEX_THREAD_ID = /^[A-Za-z0-9._:-]{1,256}$/u;

function fail(message, code = 1) { console.error(message); process.exitCode = code; }
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function versionAtLeast(actual, required) {
  const left = actual.split(".").map(Number);
  const right = required.split(".").map(Number);
  for (let index = 0; index < right.length; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}
function assertPort() {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_FARM_PORT must be an integer from 1 through 65535.");
}
function assertStatePath() {
  if (!isAbsolute(stateRoot) || stateRoot !== expectedStateRoot) {
    throw new Error("AGENT_FARM_DATA_HOME must resolve to an .agent-farm directory; arbitrary database paths are refused.");
  }
}
function secureDirectory() {
  assertStatePath();
  if (!existsSync(stateRoot)) mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const stat = statSync(stateRoot);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`${stateRoot} must be an owner-controlled directory with mode 0700.`);
  }
}
function writePrivate(path, value) { writeFileSync(path, value, { encoding: "utf8", mode: 0o600, flag: existsSync(path) ? "w" : "wx" }); }
function readBudget() {
  const text = readFileSync(budgetPath, "utf8");
  const values = {};
  for (const key of ["AGENT_FARM_BUDGET_SOL_HIGH", "AGENT_FARM_BUDGET_LUNA_MAX", "AGENT_FARM_BUDGET_SOL_MAX"]) {
    const value = new RegExp(`^${key}=[\"']?(\\d+)[\"']?$`, "m").exec(text)?.[1];
    if (!value) throw new Error(`Invalid local budget: ${key} is missing.`);
    values[key] = value;
  }
  if (+values.AGENT_FARM_BUDGET_SOL_HIGH > 10 || +values.AGENT_FARM_BUDGET_LUNA_MAX > 10 || +values.AGENT_FARM_BUDGET_SOL_MAX < 2 || +values.AGENT_FARM_BUDGET_SOL_MAX > 3 || Object.values(values).reduce((a, b) => a + +b, 0) > 25) {
    throw new Error("Invalid local budget limits.");
  }
  return values;
}
function codexCheck() {
  const path = join(homedir(), ".local", "bin", "codex");
  if (!existsSync(path)) return { ok: false, detail: `Codex is missing at ${path}.` };
  const result = spawnSync(path, ["--version"], { encoding: "utf8" });
  const version = /(?<!\d)(\d+\.\d+\.\d+)(?!\d)/u.exec(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)?.[1];
  if (result.status !== 0 || version !== metadata.requiredCodex) return { ok: false, detail: `Codex ${metadata.requiredCodex} is required; found ${version ?? "unknown"}.` };
  const actual = sha256(path);
  return actual === metadata.codexSha256
    ? { ok: true, detail: `Codex ${version} is hash-verified.` }
    : { ok: false, detail: "Codex binary does not match the pinned tested SHA-256." };
}
async function health() {
  try {
    const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(800) });
    const body = await response.json().catch(() => null);
    return response.ok && body?.service === "agent-farm-server" && body?.version === "v1";
  } catch { return false; }
}
async function focus() {
  const sourceRootId = process.env.CODEX_THREAD_ID ?? "";
  if (!CODEX_THREAD_ID.test(sourceRootId)) return;
  const keyPath = join(stateRoot, "local-auth", "local-installation-secret");
  const key = readFileSync(keyPath);
  if (key.length !== 32 || (statSync(keyPath).mode & 0o777) !== 0o600) throw new Error("The local focus key is invalid or unsafe.");
  const issuedAt = Date.now();
  const nonce = randomBytes(24).toString("base64url");
  const message = JSON.stringify(["agent-farm-local-focus-v1", sourceRootId, issuedAt, nonce]);
  const signature = createHmac("sha256", key).update(message).digest("hex");
  const response = await fetch(`${url}/api/v1/local/focus`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ sourceRootId, issuedAt, nonce, signature }), signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`Current-chat focus was rejected (HTTP ${response.status}).`);
}
async function install() {
  secureDirectory();
  const check = codexCheck();
  if (!check.ok) throw new Error(check.detail);
  if (!existsSync(budgetPath)) writePrivate(budgetPath, 'AGENT_FARM_LOCAL_MODE="1"\nAGENT_FARM_BUDGET_SOL_HIGH="10"\nAGENT_FARM_BUDGET_LUNA_MAX="10"\nAGENT_FARM_BUDGET_SOL_MAX="3"\n');
  const readme = join(stateRoot, "README.txt");
  if (!existsSync(readme)) writePrivate(readme, "Private Agent Farm state. Do not share this directory.\n");
  console.log(`Agent Farm ${metadata.version} installed locally.\nState: ${stateRoot}\nPort: ${port}\nPermissions: current user only; loopback only; no sudo or Codex config changes.`);
}
async function start() {
  secureDirectory();
  if (!existsSync(budgetPath)) throw new Error("Agent Farm is not configured. Run: agent-farm install");
  if (await health()) { await focus(); console.log(`Agent Farm is ready: ${url}`); return; }
  const budget = readBudget();
  const logFd = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [serverEntry], {
    cwd: stateParent, detached: true, stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ...budget, AGENT_FARM_LOCAL_MODE: "1", HOST: "127.0.0.1", PORT: String(port), AGENT_FARM_DATABASE: join(".agent-farm", "local.sqlite"), AGENT_FARM_WEB_DIST: webRoot, ...(CODEX_THREAD_ID.test(process.env.CODEX_THREAD_ID ?? "") ? { AGENT_FARM_EXPECTED_SOURCE_ROOT_ID: process.env.CODEX_THREAD_ID } : {}) },
  });
  child.unref(); closeSync(logFd); writePrivate(pidPath, `${child.pid}\n`);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await health()) { console.log(`Agent Farm is ready: ${url}`); return; } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`Agent Farm did not become ready. See ${logPath}`);
}
function ownedPid() {
  if (!existsSync(pidPath)) return null;
  const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("The Agent Farm PID file is invalid.");
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (ps.status !== 0) return null;
  if (!String(ps.stdout).includes(serverEntry)) throw new Error("PID ownership check failed; refusing to signal an unrelated process.");
  return pid;
}
async function stop() {
  const pid = ownedPid();
  if (!pid) { console.log("Agent Farm is not running."); return; }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    try { process.kill(pid, 0); } catch { unlinkSync(pidPath); console.log(`Stopped Agent Farm process ${pid}.`); return; }
  }
  // The server performs an asynchronous graceful close. If a verified owned
  // process retains the listener after the bounded grace period, terminate
  // only that same recorded process so `stop` has deterministic semantics.
  if (ownedPid() !== pid) throw new Error("PID ownership changed during shutdown; refusing forced termination.");
  process.kill(pid, "SIGKILL");
  unlinkSync(pidPath);
  console.log(`Stopped Agent Farm process ${pid} after the graceful shutdown deadline.`);
}
async function doctor(json = false) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add("node", versionAtLeast(process.versions.node, metadata.requiredNode), `Node.js ${process.versions.node}.`);
  const codex = codexCheck(); add("codex", codex.ok, codex.detail);
  add("release-server", sha256(serverEntry) === metadata.serverSha256, "Bundled server checksum.");
  add("release-web", sha256(join(webRoot, "index.html")) === metadata.webIndexSha256, "Bundled web checksum.");
  if (existsSync(stateRoot)) { const s = statSync(stateRoot); add("state", s.isDirectory() && (s.mode & 0o777) === 0o700, `${stateRoot} mode ${(s.mode & 0o777).toString(8)}.`); }
  else add("state", false, `${stateRoot} is missing; run agent-farm install.`);
  const healthy = await health();
  add("health", healthy, healthy ? `${url} is ready.` : `${url} is not running.`);
  const report = { ok: checks.filter((c) => c.name !== "health").every((c) => c.ok), checks };
  if (json) console.log(JSON.stringify(report, null, 2)); else { for (const c of checks) console.log(`${c.ok ? "PASS" : c.name === "health" ? "INFO" : "FAIL"} ${c.name}: ${c.detail}`); console.log(`Doctor result: ${report.ok ? "PASS" : "FAIL"}`); }
  if (!report.ok) process.exitCode = 1;
}

async function main() {
  assertPort(); assertStatePath();
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "install") await install();
  else if (command === "start") await start();
  else if (command === "doctor") await doctor(args.includes("--json"));
  else if (command === "status") console.log(JSON.stringify({ version: metadata.version, running: await health(), url, stateRoot }, null, 2));
  else if (command === "stop") await stop();
  else if (command === "open") { if (!(await health())) throw new Error("Agent Farm is not running. Run: agent-farm start"); const child = spawn("open", [url], { detached: true, stdio: "ignore" }); child.unref(); console.log(`Opened ${url}`); }
  else if (command === "update") fail(`Automatic update is not available in Agent Farm ${metadata.version}. Install an explicitly selected npm version instead.`, 2);
  else if (command === "uninstall") { await stop(); console.log(`Runtime stopped. Private data was preserved at ${stateRoot}. Remove the npm package explicitly after backing up or deleting that directory.`); }
  else { console.log("Usage: agent-farm <install|doctor|start|open|status|stop|update|uninstall>\n\nLocal-only. No cloud account, sudo, or generic MCP registration is required."); if (command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 1; }
}

main().catch((error) => fail(`Agent Farm: ${error instanceof Error ? error.message : String(error)}`));
