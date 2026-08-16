import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OWNED_FILES = new Set(["budget.env", "README.txt", "local.sqlite", "local.sqlite-wal", "local.sqlite-shm"]);
const OWNED_DIRECTORIES = new Set(["local-auth"]);
const README_MARKER = "generated, repository-local Agent Farm configuration";

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwned(stat, path) {
  const current = uid();
  if (current !== null && stat.uid !== current) throw new Error(`${path} is not owned by the current user; refusing cleanup.`);
}

function assertRegular(path, mode) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${path} must be an owner-only regular file.`);
  assertOwned(stat, path);
  if ((stat.mode & 0o777) !== mode) throw new Error(`${path} must have mode ${mode.toString(8).padStart(4, "0")}; repair it before cleanup.`);
  return stat;
}

function assertDirectory(path, mode) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${path} must be a real owner-only directory.`);
  assertOwned(stat, path);
  if ((stat.mode & 0o777) !== mode) throw new Error(`${path} must have mode ${mode.toString(8).padStart(4, "0")}; repair it before cleanup.`);
  return stat;
}

function assertNoSymlinkComponents(path) {
  let current = resolve(path);
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Cleanup path contains a symlink component (${current}); refusing cleanup.`);
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
}

function readActiveBindingCount(repoRoot, databasePath) {
  if (!existsSync(databasePath)) return 0;
  const requireFromStore = createRequire(join(repoRoot, "packages", "store", "package.json"));
  let Database;
  try {
    Database = requireFromStore("better-sqlite3");
  } catch (error) {
    throw new Error(`Cannot inspect local.sqlite safely because better-sqlite3 is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let db;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'bridge_bindings'").get();
    if (!table) return 0;
    const row = db.prepare("SELECT COUNT(*) AS count FROM bridge_bindings WHERE source_adapter = 'codex-app-server' AND status = 'active' AND expires_at > ?").get(Date.now());
    return Number(row?.count ?? 0);
  } catch (error) {
    throw new Error(`Cannot inspect local.sqlite safely; preserve it and repair/reopen with a compatible Agent Farm release: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { db?.close(); } catch { /* preserve the original failure */ }
  }
}

export function parseCleanupArgs(argumentsList) {
  const options = { mode: undefined, dataDirectory: undefined, confirmed: false, unpaired: false };
  let separatorSeen = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    // The package script contributes its fixed cleanup mode before pnpm's
    // optional conventional separator. Accept one only immediately after
    // that sole mode; leading, repeated, or later separators are malformed.
    if (argument === "--" && !separatorSeen && index === 1 && options.mode !== undefined) separatorSeen = true;
    else if (argument === "--reset" || argument === "--uninstall") {
      if (options.mode !== undefined) throw new Error("Choose exactly one cleanup mode: --reset or --uninstall.");
      options.mode = argument === "--reset" ? "reset" : "uninstall";
    }
    else if (argument === "--yes") options.confirmed = true;
    else if (argument === "--unpaired") options.unpaired = true;
    else if (argument === "--data-dir" || argument === "--data-directory") options.dataDirectory = argumentsList[++index];
    else if (argument.startsWith("--data-dir=")) options.dataDirectory = argument.slice("--data-dir=".length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.mode) throw new Error("Choose exactly one cleanup mode: --reset or --uninstall.");
  if (!options.dataDirectory || !isAbsolute(options.dataDirectory)) throw new Error("Cleanup requires --data-dir with an absolute path; the user checkout .agent-farm is never an implicit target.");
  if (!options.confirmed || !options.unpaired) throw new Error("Cleanup requires both --yes and --unpaired after a successful explicit unpair.");
  return { ...options, dataDirectory: resolve(options.dataDirectory) };
}

export function inspectCleanupTarget(repoRoot, dataDirectory) {
  const target = resolve(dataDirectory);
  if (!isAbsolute(dataDirectory)) throw new Error("Cleanup target must be an absolute path.");
  if (basename(target) !== ".agent-farm") throw new Error("Cleanup target basename must be .agent-farm.");
  const forbiddenTargets = new Set([resolve(repoRoot), homedir(), process.cwd(), resolve(repoRoot, ".agent-farm")]);
  if (forbiddenTargets.has(target)) throw new Error("Refusing to clean a checkout, home directory, current directory, or the user checkout .agent-farm; use an isolated temporary data directory.");
  assertNoSymlinkComponents(target);
  assertDirectory(target, 0o700);
  const readme = join(target, "README.txt");
  assertRegular(readme, 0o600);
  if (!readFileSync(readme, "utf8").includes(README_MARKER)) throw new Error("Cleanup target is missing the Agent Farm ownership marker.");
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Cleanup target contains a symlink (${entry.name}); refusing to follow or remove it.`);
    if (entry.isFile() && !OWNED_FILES.has(entry.name)) throw new Error(`Cleanup target contains an unknown file (${entry.name}); refusing cleanup.`);
    if (entry.isDirectory() && !OWNED_DIRECTORIES.has(entry.name)) throw new Error(`Cleanup target contains an unknown directory (${entry.name}); refusing cleanup.`);
    if (!entry.isFile() && !entry.isDirectory()) throw new Error(`Cleanup target contains a special entry (${entry.name}); refusing cleanup.`);
  }
  const localAuth = join(target, "local-auth");
  if (existsSync(localAuth)) {
    assertDirectory(localAuth, 0o700);
    for (const entry of readdirSync(localAuth, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isFile() || !["local-installation-secret", "local-session-signing-key"].includes(entry.name)) {
        throw new Error(`local-auth contains an unexpected entry (${entry.name}); refusing cleanup.`);
      }
      assertRegular(join(localAuth, entry.name), 0o600);
    }
  }
  const databasePath = join(target, "local.sqlite");
  return { target, databasePath };
}

export function cleanupLocal({ repoRoot, dataDirectory, mode }) {
  const inspected = inspectCleanupTarget(repoRoot, dataDirectory);
  const activeBindings = readActiveBindingCount(repoRoot, inspected.databasePath);
  if (activeBindings > 0) throw new Error("Cleanup is guarded: durable pairing is still active. Unpair successfully, then retry with --unpaired.");
  for (const name of OWNED_FILES) {
    const path = join(inspected.target, name);
    if (existsSync(path)) {
      assertRegular(path, 0o600);
      rmSync(path, { force: false });
    }
  }
  const localAuth = join(inspected.target, "local-auth");
  if (existsSync(localAuth)) {
    assertDirectory(localAuth, 0o700);
    rmSync(localAuth, { recursive: true, force: false });
  }
  // Both reset and uninstall intentionally remove only this exact generated
  // directory. Leave unknown siblings and all source/evidence untouched.
  rmdirSync(inspected.target);
  return { mode, removed: inspected.target };
}

async function main() {
  const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
  const repoRoot = resolve(scriptDirectory, "..");
  try {
    const options = parseCleanupArgs(process.argv.slice(2));
    const result = cleanupLocal({ repoRoot, dataDirectory: options.dataDirectory, mode: options.mode });
    console.log(`Local ${result.mode} cleanup removed the explicitly authorized generated directory: ${result.removed}`);
  } catch (error) {
    console.error(`Local cleanup refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
