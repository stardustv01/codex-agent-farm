import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { assertBuildManifestFresh } from "./write-build-manifest.mjs";

const BUDGET_KEYS = [
  "AGENT_FARM_BUDGET_SOL_HIGH",
  "AGENT_FARM_BUDGET_LUNA_MAX",
  "AGENT_FARM_BUDGET_SOL_MAX",
];

const STALE_SERVER_WARNING =
  "The built server appears older than its source. Run `pnpm run setup && pnpm build` (or `pnpm start:local --build`) before relying on local mode.";
const STALE_WEB_WARNING =
  "The built web assets appear older than their source. Run `pnpm run setup && pnpm build` (or `pnpm start:local --build`) before relying on local mode.";
const CODEX_THREAD_ID = /^[A-Za-z0-9._:-]{1,256}$/u;

function parseArguments(argumentsList) {
  let build = false;
  let separatorSeen = false;
  for (const argument of argumentsList) {
    // pnpm forwards an optional conventional `--` separator. Accept one so
    // the launcher behaves consistently when called with or without it.
    if (argument === "--" && !separatorSeen) separatorSeen = true;
    else if (argument === "--build") build = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { build };
}

function parseEnvironmentFile(filePath) {
  const parsed = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid line ${index + 1} in ${filePath}.`);
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else if (value.includes('"') || value.includes("'")) {
      throw new Error(`Invalid quoting on line ${index + 1} in ${filePath}.`);
    }
    parsed[key] = value;
  }

  return parsed;
}

function loadAndValidateBudget(filePath) {
  const parsed = parseEnvironmentFile(filePath);
  const values = {};
  const bounds = {
    AGENT_FARM_BUDGET_SOL_HIGH: [0, 10],
    AGENT_FARM_BUDGET_LUNA_MAX: [0, 10],
    AGENT_FARM_BUDGET_SOL_MAX: [2, 3],
  };

  for (const key of BUDGET_KEYS) {
    const value = parsed[key];
    if (!/^\d+$/.test(value ?? "")) {
      throw new Error(`${key} must be an integer in ${filePath}.`);
    }
    const numericValue = Number.parseInt(value, 10);
    const [minimum, maximum] = bounds[key];
    if (numericValue < minimum || numericValue > maximum) {
      throw new Error(`${key} must be from ${minimum} to ${maximum}.`);
    }
    values[key] = String(numericValue);
  }

  const total = BUDGET_KEYS.reduce((sum, key) => sum + Number(values[key]), 0);
  if (total > 25) throw new Error(`The combined local budget must be 25 or less. Found ${total}.`);
  return values;
}

function runBuild(repoRoot) {
  console.log("Running pnpm build because --build was provided.");
  const result = spawnSync("pnpm", ["build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm build exited with code ${result.status ?? "unknown"}.`);
  }
}

function newestSourceMtime(sourceDirectory) {
  let newestMtime = 0;
  const entries = readdirSync(sourceDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(sourceDirectory, entry.name);
    if (entry.isDirectory()) {
      newestMtime = Math.max(newestMtime, newestSourceMtime(entryPath));
      continue;
    }
    if (!entry.isFile()) continue;
    newestMtime = Math.max(newestMtime, statSync(entryPath).mtimeMs);
  }

  return newestMtime;
}

function newestMtimeForPaths(paths) {
  let newestMtime = 0;
  for (const filePath of paths) {
    if (!existsSync(filePath)) continue;
    const stats = statSync(filePath);
    newestMtime = Math.max(
      newestMtime,
      stats.isDirectory() ? newestSourceMtime(filePath) : stats.mtimeMs,
    );
  }
  return newestMtime;
}

export function isFresh(builtPath, sourcePaths) {
  const builtMtime = newestMtimeForPaths([builtPath]);
  const sourceMtime = newestMtimeForPaths(
    Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths],
  );
  return builtMtime >= sourceMtime;
}

function webSourcePaths(repoRoot) {
  // The web bundle imports workspace packages, so package source changes also
  // invalidate the generated assets even when apps/web/src is untouched.
  const webDirectory = join(repoRoot, "apps", "web");
  const paths = [
    join(repoRoot, "apps", "web", "src"),
    join(repoRoot, "apps", "web", "package.json"),
  ];

  for (const relativePath of ["index.html", "vite.config.ts", "public", "scripts"]) {
    const sourcePath = join(webDirectory, relativePath);
    if (existsSync(sourcePath)) paths.push(sourcePath);
  }

  return paths;
}

function serverSourcePaths(repoRoot) {
  return [
    join(repoRoot, "apps", "server", "src"),
    join(repoRoot, "apps", "server", "package.json"),
  ];
}

function assertWebDistFresh(repoRoot, webDistPath) {
  if (!isFresh(webDistPath, webSourcePaths(repoRoot))) {
    console.error(STALE_WEB_WARNING);
    throw new Error(
      "Refusing to start with stale web assets. Rebuild the web assets before starting local mode.",
    );
  }
}

function assertBuiltServerFresh(repoRoot) {
  const builtDirectory = join(repoRoot, "apps", "server", "dist");

  if (!isFresh(builtDirectory, serverSourcePaths(repoRoot))) {
    console.error(STALE_SERVER_WARNING);
    // Fail closed instead of silently switching to a development source
    // runner that may be absent from a production-style local install.
    throw new Error(
      "Refusing to start with a stale built server. Rebuild the server before starting local mode.",
    );
  }
}

function signalExitCode(signal) {
  return 128 + (osConstants.signals[signal] ?? 0);
}

export function launcherExitCode(code, signal, forwardedSignal, launcherOwnedFailure = false) {
  if (launcherOwnedFailure) return 1;
  if (code !== null) return code;
  return signalExitCode(signal ?? forwardedSignal ?? "SIGTERM");
}

function checkPortAvailable(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = net.createServer();
    const fail = (error) => {
      probe.close(() => rejectPromise(new Error(`Port ${port} is unavailable. Stop the process using http://127.0.0.1:${port} or choose another PORT.`)));
    };
    probe.once("error", fail);
    probe.listen({ host: "127.0.0.1", port }, () => probe.close(() => resolvePromise()));
  });
}

async function focusExistingServer(repoRoot, port) {
  const healthEndpoint = `http://127.0.0.1:${port}/healthz`;
  let health;
  try {
    health = await fetch(healthEndpoint, { signal: AbortSignal.timeout(750) });
  } catch {
    return false;
  }
  if (!health.ok) return false;
  const healthBody = await health.json().catch(() => null);
  if (healthBody?.service !== "agent-farm-server" || healthBody?.version !== "v1") return false;
  const sourceRootId = process.env.CODEX_THREAD_ID ?? "";
  if (!CODEX_THREAD_ID.test(sourceRootId)) {
    console.log(`Agent Farm is already running: http://127.0.0.1:${port}`);
    return true;
  }
  const keyPath = join(repoRoot, ".agent-farm", "local-auth", "local-installation-secret");
  if (!existsSync(keyPath)) throw new Error("The running Agent Farm installation cannot accept a trusted chat handoff.");
  const keyStat = statSync(keyPath);
  if (!keyStat.isFile() || (keyStat.mode & 0o777) !== 0o600) throw new Error("The local focus key has unsafe permissions.");
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error("The local focus key is invalid.");
  const issuedAt = Date.now();
  const nonce = randomBytes(24).toString("base64url");
  const message = JSON.stringify(["agent-farm-local-focus-v1", sourceRootId, issuedAt, nonce]);
  const signature = createHmac("sha256", key).update(message, "utf8").digest("hex");
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(new URL("/api/v1/local/focus", origin), {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ sourceRootId, issuedAt, nonce, signature }),
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) throw new Error(`The running Agent Farm rejected the current-chat handoff (HTTP ${response.status}).`);
  console.log(`Agent Farm focused the current Codex chat: http://127.0.0.1:${port}`);
  return true;
}

async function waitForReadiness(port, child) {
  const endpoint = `http://127.0.0.1:${port}/healthz`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("The local server exited before readiness. Check the server output above.");
    }
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
    } catch {
      // The listener may need another bounded retry while SQLite/app-server
      // initialization completes. Do not print response bodies or secrets.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Local server did not become ready at ${endpoint} within 15 seconds.`);
}

async function startServer(repoRoot, budget, webDistPath) {
  const builtServer = join(repoRoot, "apps", "server", "dist", "main.js");
  if (!existsSync(builtServer)) throw new Error("Built server is missing. Run pnpm build before starting local mode.");
  assertBuiltServerFresh(repoRoot);
  assertWebDistFresh(repoRoot, webDistPath);
  assertBuildManifestFresh(repoRoot);
  const port = Number(process.env.PORT || "8787");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer from 1 through 65535.");
  if (await focusExistingServer(repoRoot, port)) return;
  await checkPortAvailable(port);
  const nodeArguments = [builtServer];
  const childEnvironment = {
    ...process.env,
    ...budget,
    AGENT_FARM_LOCAL_MODE: "1",
    HOST: "127.0.0.1",
    PORT: String(port),
    AGENT_FARM_DATABASE: join(".agent-farm", "local.sqlite"),
    AGENT_FARM_WEB_DIST: webDistPath,
    ...(CODEX_THREAD_ID.test(process.env.CODEX_THREAD_ID ?? "")
      ? { AGENT_FARM_EXPECTED_SOURCE_ROOT_ID: process.env.CODEX_THREAD_ID }
      : {}),
  };

  console.log(`Starting Agent Farm at http://127.0.0.1:${port}`);
  console.log("Local mode is loopback-only and does not use OAuth.");
  console.log("Using the verified built server entry point.");

  const child = spawn(process.execPath, nodeArguments, {
    cwd: repoRoot,
    env: childEnvironment,
    stdio: "inherit",
  });
  let forwardedSignal = null;
  let launcherOwnedFailure = false;

  const forwardSignal = (signal) => {
    forwardedSignal = signal;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  child.once("error", (error) => {
    launcherOwnedFailure = true;
    console.error(`Failed to start Agent Farm: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.exitCode = launcherExitCode(code, signal, forwardedSignal, launcherOwnedFailure);
  });
  try {
    await waitForReadiness(Number(port), child);
    console.log(`Agent Farm is ready: http://127.0.0.1:${port}`);
  } catch (error) {
    // Readiness is launcher-owned. Preserve its failure even when terminating
    // an unhealthy child produces a normal (zero) child exit afterward.
    launcherOwnedFailure = true;
    process.exitCode = 1;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    throw error;
  }
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`Cannot start Agent Farm: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
  const repoRoot = resolve(scriptDirectory, "..");
  const budgetPath = join(repoRoot, ".agent-farm", "budget.env");
  if (!existsSync(budgetPath)) {
    console.error(`Local configuration is missing: ${budgetPath}`);
    console.error("Run pnpm run setup, then run pnpm start:local again.");
    process.exitCode = 1;
    return;
  }

  let budget;
  try {
    budget = loadAndValidateBudget(budgetPath);
  } catch (error) {
    console.error(`Cannot load local configuration: ${error.message}`);
    console.error("Run pnpm run setup to regenerate it.");
    process.exitCode = 1;
    return;
  }

  const webDistPath = join(repoRoot, "apps", "web", "dist");
  const webIndexPath = join(webDistPath, "index.html");
  if (options.build) {
    try {
      runBuild(repoRoot);
    } catch (error) {
      console.error(`Cannot start Agent Farm: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }
  if (!existsSync(webIndexPath)) {
    console.error(`Built web assets are missing: ${webIndexPath}`);
    console.error("Run pnpm install --frozen-lockfile && pnpm build first.");
    console.error("You can also run pnpm start:local --build after dependencies are installed.");
    process.exitCode = 1;
    return;
  }

  try {
    await startServer(repoRoot, budget, webDistPath);
  } catch (error) {
    console.error(`Cannot start Agent Farm: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
