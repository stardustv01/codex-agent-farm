import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_BUDGET = {
  solHigh: 10,
  lunaMax: 10,
  solMax: 3,
};

const LIMITS = {
  solHigh: [0, 10],
  lunaMax: [0, 10],
  solMax: [2, 3],
};

const CODEX_BINARY_HASH_PATTERN =
  /(?:export\s+)?const\s+PHASE_A_BINARY_SHA256\s*=\s*["']([a-f0-9]{64})["']/iu;
const CODEX_BINARY_HASH_PREFIX_LENGTH = 16;

function parseVersion(version) {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function extractVersion(output) {
  const match = /(?<!\d)(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?!\d)/.exec(
    output,
  );
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function isVersionAtLeast(actual, minimum) {
  const actualParts = parseVersion(actual);
  const minimumParts = parseVersion(minimum);
  for (let index = 0; index < minimumParts.length; index += 1) {
    const actualPart = actualParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (actualPart > minimumPart) return true;
    if (actualPart < minimumPart) return false;
  }
  return true;
}

function resolvePinnedCodexHash(repoRoot) {
  const candidatePaths = [
    join(repoRoot, "packages", "codex-bridge", "src", "gate.ts"),
    join(repoRoot, "packages", "codex-bridge", "dist", "gate.js"),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      if (!existsSync(candidatePath)) continue;
      const match = CODEX_BINARY_HASH_PATTERN.exec(readFileSync(candidatePath, "utf8"));
      if (match) return match[1].toLowerCase();
    } catch {
      // Try the built fallback before reporting that the pin is unavailable.
    }
  }

  return null;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function hashPrefix(hash) {
  return `sha256:${hash.slice(0, CODEX_BINARY_HASH_PREFIX_LENGTH)}...`;
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwner(stat, path) {
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`${path} is owned by uid ${stat.uid}, not the current user. Refusing to modify it.`);
  }
}

export function ensureSecureConfigDirectory(configDirectory) {
  if (!existsSync(configDirectory)) {
    mkdirSync(configDirectory, { mode: 0o700 });
  }
  let stat;
  try {
    stat = lstatSync(configDirectory);
  } catch (error) {
    throw new Error(`Cannot inspect local configuration directory ${configDirectory}: ${describeError(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${configDirectory} must be a real directory, not a symlink or file.`);
  }
  assertOwner(stat, configDirectory);
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(`${configDirectory} must have mode 0700; repair permissions explicitly before setup.`);
  }
  return stat;
}

function assertSecureConfigFile(filePath) {
  if (!existsSync(filePath)) return null;
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${filePath} must be a regular owner-only file, not a symlink or special file.`);
  }
  assertOwner(stat, filePath);
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`${filePath} must have mode 0600; repair permissions explicitly before setup.`);
  }
  return stat;
}

export function atomicWriteOwnerFile(filePath, contents) {
  assertSecureConfigFile(filePath);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const bytes = Buffer.from(contents, "utf8");
  let fd;
  try {
    fd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(written) || written <= 0) throw new Error(`short write while creating ${filePath}`);
      offset += written;
    }
    if (offset !== bytes.length) throw new Error(`short write while creating ${filePath}`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
    assertSecureConfigFile(filePath);
  } catch (error) {
    if (typeof fd === "number") {
      try { closeSync(fd); } catch { /* best effort cleanup */ }
    }
    try {
      // The temporary name is unique and inside the validated config dir.
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch { /* preserve the original failure */ }
    throw error;
  }
}

async function verifyCodexBinary(repoRoot, codexPath) {
  const pinnedHash = resolvePinnedCodexHash(repoRoot);
  if (!pinnedHash) {
    return {
      failure:
        "The pinned Codex hash could not be resolved from packages/codex-bridge. Only the pinned, hash-verified Codex CLI (0.145.0; see PHASE_A_BINARY_SHA256) is supported.",
    };
  }

  let actualHash;
  try {
    actualHash = await sha256File(codexPath);
  } catch (error) {
    return {
      failure: `Codex CLI hash preflight could not read ${codexPath}: ${describeError(error)}. Only the pinned, hash-verified Codex CLI (0.145.0; see PHASE_A_BINARY_SHA256) is supported.`,
    };
  }

  if (actualHash !== pinnedHash) {
    return {
      failure: `Codex CLI at ${codexPath} does not match the pinned, tested binary. Expected ${hashPrefix(pinnedHash)}; found ${hashPrefix(actualHash)}. Only the pinned, hash-verified Codex CLI (0.145.0; see PHASE_A_BINARY_SHA256) is supported.`,
    };
  }

  return { codexPath, codexHash: actualHash };
}

async function checkPrerequisites(repoRoot) {
  const failures = [];

  if (!isVersionAtLeast(process.versions.node, "22.17.0")) {
    failures.push(
      `Node.js 22.17.0 or newer is required. Found ${process.versions.node}.`,
    );
  }

  const pnpm = spawnSync("pnpm", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (pnpm.error || pnpm.status !== 0) {
    failures.push(
      "pnpm is required but was not found. Install pnpm 11.16.0 and try again.",
    );
  } else {
    const pnpmVersion = extractVersion(
      `${pnpm.stdout ?? ""}\n${pnpm.stderr ?? ""}`,
    );
    if (!pnpmVersion || !isVersionAtLeast(pnpmVersion, "11.16.0")) {
      failures.push(
        `pnpm 11.16.0 or newer is required. Found ${pnpmVersion ?? "unknown"}. Install with: corepack enable && corepack prepare pnpm@11.16.0 --activate`,
      );
    }
  }

  const codexPath = join(homedir(), ".local", "bin", "codex");
  let codexAccessible = false;
  let codexVerification;
  try {
    accessSync(codexPath, constants.X_OK);
    codexAccessible = true;
  } catch {
    failures.push(
      `Codex CLI is required and must be executable at ${codexPath}.`,
    );
  }
  if (codexAccessible) {
    codexVerification = await verifyCodexBinary(repoRoot, codexPath);
    if (codexVerification.failure) failures.push(codexVerification.failure);
  }

  if (process.platform !== "darwin" && process.platform !== "linux") {
    failures.push(
      `Agent Farm local mode supports macOS and Linux. Found ${process.platform}.`,
    );
  }

  if (failures.length > 0) {
    console.error("Agent Farm local setup cannot continue:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return false;
  }

  return codexVerification;
}

function validateBudget(budget) {
  for (const [name, value] of Object.entries(budget)) {
    const [minimum, maximum] = LIMITS[name];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      return `${name} must be an integer from ${minimum} to ${maximum}.`;
    }
  }

  const total = budget.solHigh + budget.lunaMax + budget.solMax;
  if (total > 25) return `The combined budget must be 25 or less. Found ${total}.`;
  return null;
}

function parseBudgetArgument(value) {
  const parts = value.split(",");
  if (parts.length !== 3 || parts.some((part) => !/^-?\d+$/.test(part.trim()))) {
    throw new Error("--budget must contain three integers, for example --budget=10,10,3.");
  }

  const budget = {
    solHigh: Number.parseInt(parts[0], 10),
    lunaMax: Number.parseInt(parts[1], 10),
    solMax: Number.parseInt(parts[2], 10),
  };
  const validationError = validateBudget(budget);
  if (validationError) throw new Error(validationError);
  return budget;
}

export function parseExistingBudget(filePath) {
  const text = readFileSync(filePath, "utf8");
  const values = {};
  const keyMap = [
    ["AGENT_FARM_BUDGET_SOL_HIGH", "solHigh"],
    ["AGENT_FARM_BUDGET_LUNA_MAX", "lunaMax"],
    ["AGENT_FARM_BUDGET_SOL_MAX", "solMax"],
  ];
  for (const [environmentKey, budgetKey] of keyMap) {
    const pattern = new RegExp(`^${environmentKey}=(?:"([0-9]+)"|([0-9]+))$`, "m");
    const match = pattern.exec(text);
    if (!match) throw new Error(`${filePath} is missing ${environmentKey}; refusing to overwrite it blindly.`);
    values[budgetKey] = Number.parseInt(match[1] ?? match[2], 10);
  }
  const validationError = validateBudget(values);
  if (validationError) throw new Error(`${filePath} is invalid: ${validationError}`);
  return values;
}

function parseArguments(argumentsList) {
  let budgetValue;
  let acceptDefaults = false;
  let separatorSeen = false;

  for (const argument of argumentsList) {
    // pnpm forwards an optional conventional `--` separator. Accept one so
    // both documented forms remain deterministic when invoked through pnpm.
    if (argument === "--" && !separatorSeen) {
      separatorSeen = true;
    } else if (argument === "--yes") {
      acceptDefaults = true;
    } else if (argument.startsWith("--budget=")) {
      budgetValue = argument.slice("--budget=".length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (budgetValue !== undefined) return parseBudgetArgument(budgetValue);
  if (acceptDefaults) return { ...DEFAULT_BUDGET };
  return null;
}

function createPromptSession() {
  const readline = createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean(stdin.isTTY && stdout.isTTY),
    crlfDelay: Infinity,
  });
  const lines = readline[Symbol.asyncIterator]();

  return {
    async question(prompt) {
      stdout.write(prompt);
      const nextLine = await lines.next();
      return nextLine.done ? { eof: true } : { eof: false, value: nextLine.value };
    },
    close() {
      readline.close();
    },
  };
}

async function promptForInteger(promptSession, label, key) {
  const [minimum, maximum] = LIMITS[key];
  while (true) {
    const answer = await promptSession.question(
      `${label} (${minimum}-${maximum}) [${DEFAULT_BUDGET[key]}]: `,
    );
    if (answer.eof) return { eof: true };

    const normalized = answer.value.trim();
    const value = normalized === "" ? DEFAULT_BUDGET[key] : Number(normalized);
    if (Number.isInteger(value) && value >= minimum && value <= maximum) {
      return { eof: false, value };
    }
    console.error(`Please enter an integer from ${minimum} to ${maximum}.`);
  }
}

async function promptForBudget() {
  const promptSession = createPromptSession();
  try {
    while (true) {
      console.log("Choose the maximum concurrent agents for each model tier.");
      const solHigh = await promptForInteger(promptSession, "Sol High", "solHigh");
      if (solHigh.eof) return { ...DEFAULT_BUDGET };
      const lunaMax = await promptForInteger(promptSession, "Luna Max", "lunaMax");
      if (lunaMax.eof) return { ...DEFAULT_BUDGET };
      const solMax = await promptForInteger(promptSession, "Sol Max", "solMax");
      if (solMax.eof) return { ...DEFAULT_BUDGET };

      const budget = {
        solHigh: solHigh.value,
        lunaMax: lunaMax.value,
        solMax: solMax.value,
      };
      const validationError = validateBudget(budget);
      if (!validationError) return budget;
      console.error(`${validationError} Please choose the budget again.`);
    }
  } finally {
    promptSession.close();
  }
}

export function writeConfiguration(repoRoot, budget, codexVerification) {
  const configDirectory = resolve(repoRoot, ".agent-farm");
  const budgetPath = join(configDirectory, "budget.env");
  const readmePath = join(configDirectory, "README.txt");

  ensureSecureConfigDirectory(configDirectory);
  assertSecureConfigFile(budgetPath);
  assertSecureConfigFile(readmePath);
  atomicWriteOwnerFile(
    budgetPath,
    [
      'AGENT_FARM_LOCAL_MODE="1"',
      `AGENT_FARM_BUDGET_SOL_HIGH="${budget.solHigh}"`,
      `AGENT_FARM_BUDGET_LUNA_MAX="${budget.lunaMax}"`,
      `AGENT_FARM_BUDGET_SOL_MAX="${budget.solMax}"`,
      "",
    ].join("\n"),
  );
  atomicWriteOwnerFile(
    readmePath,
    [
      "This directory contains generated, repository-local Agent Farm configuration.",
      "After first start it may also contain private signing keys and the local SQLite projection.",
      "Do not share this directory, and back up local.sqlite before an update or explicit cleanup.",
      "Run pnpm run setup to create it again.",
      "",
    ].join("\n"),
  );

  console.log("\nLocal configuration created:");
  console.log(`- ${budgetPath}`);
  console.log(`- ${readmePath}`);
  console.log(`- Codex CLI verified: ${codexVerification.codexPath}`);
  console.log(`- Codex CLI hash: ${hashPrefix(codexVerification.codexHash)}`);
  console.log("\nAgent budget:");
  console.log("Model      Limit");
  console.log(`Sol High   ${budget.solHigh}`);
  console.log(`Luna Max   ${budget.lunaMax}`);
  console.log(`Sol Max    ${budget.solMax}`);
  console.log(`Total      ${budget.solHigh + budget.lunaMax + budget.solMax}`);
}

async function main() {
  const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
  const repoRoot = resolve(scriptDirectory, "..");
  const codexVerification = await checkPrerequisites(repoRoot);
  if (!codexVerification) return;

  let budget;
  try {
    budget = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`Agent Farm local setup failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (!budget) {
    const configDirectory = resolve(repoRoot, ".agent-farm");
    const budgetPath = join(configDirectory, "budget.env");
    if (existsSync(configDirectory)) {
      try {
        ensureSecureConfigDirectory(configDirectory);
        if (existsSync(budgetPath)) {
          assertSecureConfigFile(budgetPath);
          budget = parseExistingBudget(budgetPath);
          console.log(`Preserving the existing valid budget in ${budgetPath}.`);
        }
      } catch (error) {
        console.error(`Agent Farm local setup failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
    }
  }
  if (!budget) budget = await promptForBudget();
  try {
    writeConfiguration(repoRoot, budget, codexVerification);
  } catch (error) {
    console.error(`Agent Farm local setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
