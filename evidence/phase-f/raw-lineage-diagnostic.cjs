const { spawn } = require("node:child_process");

const binary = process.env.AGENT_FARM_CODEX_BIN ?? "/Users/praveengupta/.local/bin/codex";
const suppliedRoot = process.env.AGENT_FARM_SOURCE_ROOT_ID;
const suppliedCwd = process.env.AGENT_FARM_SOURCE_CWD;
const expected = new Set(["dirac", "rhea", "kuhn", "noether"]);
const safeLabel = /^[A-Za-z0-9][A-Za-z0-9._: @+()/'-]{0,127}$/;
const safeWord = /^[A-Za-z0-9._:@+/-]{1,256}$/;
const safeId = /^[A-Za-z0-9._:-]{1,256}$/;
const sourceKinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"];
if (typeof suppliedRoot !== "string" || !safeId.test(suppliedRoot)) throw new Error("AGENT_FARM_SOURCE_ROOT_ID_REQUIRED");
let acceptanceInput;
try {
  acceptanceInput = JSON.parse(process.env.AGENT_FARM_ACCEPTANCE_THREADS ?? "");
} catch {
  throw new Error("AGENT_FARM_ACCEPTANCE_THREADS_REQUIRED");
}
if (!acceptanceInput || typeof acceptanceInput !== "object" || Array.isArray(acceptanceInput)) throw new Error("AGENT_FARM_ACCEPTANCE_THREADS_INVALID");
const requiredLabels = ["main", "dirac", "rhea", "noether", "kuhn"];
const acceptanceLabelsById = new Map();
for (const label of requiredLabels) {
  const threadId = acceptanceInput[label];
  if (typeof threadId !== "string" || !safeId.test(threadId) || acceptanceLabelsById.has(threadId)) throw new Error("AGENT_FARM_ACCEPTANCE_THREADS_INVALID");
  acceptanceLabelsById.set(threadId, label);
}
if (acceptanceLabelsById.get(suppliedRoot) !== "main") throw new Error("AGENT_FARM_ACCEPTANCE_ROOT_MISMATCH");
const child = spawn(binary, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
let buffer = "";
let nextId = 1;
const pending = new Map();

function call(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (!Number.isSafeInteger(value?.id)) continue;
    const waiter = pending.get(value.id);
    if (!waiter) continue;
    pending.delete(value.id);
    if (value.error) waiter.reject(new Error(`RPC_${Number(value.error.code) || "UNKNOWN"}`));
    else waiter.resolve(value.result);
  }
});

child.once("exit", () => {
  for (const waiter of pending.values()) waiter.reject(new Error("TRANSPORT_CLOSED"));
  pending.clear();
});

function text(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function sourceType(thread) {
  const source = thread.threadSource ?? thread.source;
  const value = typeof source === "string" ? source : source && typeof source === "object" ? source.type ?? source.kind : null;
  return text(value, safeWord);
}

function knownIdPaths(value, path = [], depth = 0, result = []) {
  if (depth > 7 || value === null || value === undefined) return result;
  if (typeof value === "string") {
    const label = acceptanceLabelsById.get(value);
    if (label) result.push({ label, path: path.join(".") });
    return result;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) knownIdPaths(value[index], [...path, "[]"], depth + 1, result);
    return result;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) knownIdPaths(nested, [...path, key], depth + 1, result);
  }
  return result;
}

function safeStructuralItems(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const result = [];
  for (const turn of turns) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (!item || typeof item !== "object") continue;
      const type = text(item.type, safeWord);
      if (type !== "collabAgentToolCall" && type !== "subAgentActivity") continue;
      result.push({
        type,
        keys: Object.keys(item).filter((key) => key !== "prompt").sort(),
        tool: text(item.tool, safeWord),
        status: text(item.status, safeWord),
        model: text(item.model, safeWord),
        reasoningEffort: text(item.reasoningEffort, safeWord),
        hasPrompt: typeof item.prompt === "string" && item.prompt.length > 0,
        knownReferences: knownIdPaths(item),
      });
    }
  }
  return result;
}

(async () => {
  const deadline = setTimeout(() => child.kill("SIGTERM"), 20_000);
  try {
    await call("initialize", {
      clientInfo: { name: "agent-farm-lineage-diagnostic", title: "Agent Farm Lineage Diagnostic", version: "1" },
      capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: [] },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const allById = new Map();
    const pagination = [];
    for (const archived of [false, true]) {
      let cursor;
      let itemCount = 0;
      let pageCount = 0;
      let exhausted = false;
      for (let page = 0; page < 2048; page += 1) {
        const result = await call("thread/list", {
          limit: 20,
          useStateDbOnly: false,
          sourceKinds,
          archived,
          ...(suppliedCwd ? { cwd: [suppliedCwd] } : {}),
          ...(cursor ? { cursor } : {}),
        });
        const pageItems = Array.isArray(result?.data) ? result.data : [];
        pageCount += 1;
        itemCount += pageItems.length;
        for (const thread of pageItems) {
          if (thread && typeof thread.id === "string") allById.set(thread.id, thread);
        }
        if (typeof result?.nextCursor !== "string") {
          exhausted = true;
          break;
        }
        cursor = result.nextCursor;
      }
      pagination.push({ archived, pageCount, itemCount, exhausted });
    }
    const all = [...allById.values()];
    const spawnMetadata = (thread) => {
      const source = thread?.source && typeof thread.source === "object" ? thread.source : null;
      const threadSource = thread?.threadSource && typeof thread.threadSource === "object" ? thread.threadSource : null;
      const subAgent = source?.subAgent ?? source?.subagent ?? threadSource?.subAgent ?? threadSource?.subagent;
      if (!subAgent || typeof subAgent !== "object") return null;
      const spawn = subAgent.threadSpawn ?? subAgent.thread_spawn ?? subAgent;
      return spawn && typeof spawn === "object" ? spawn : null;
    };
    const spawnPath = (thread) => {
      const spawn = spawnMetadata(thread);
      return typeof spawn?.agentPath === "string" ? spawn.agentPath : typeof spawn?.agent_path === "string" ? spawn.agent_path : "";
    };
    const spawnParent = (thread) => {
      const spawn = spawnMetadata(thread);
      return typeof spawn?.parentThreadId === "string" ? spawn.parentThreadId : typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id : null;
    };
    const expectedLabel = (thread) => {
      const path = spawnPath(thread);
      const pathLabel = path.split("/").filter(Boolean).at(-1)?.toLowerCase();
      if (expected.has(pathLabel)) return pathLabel;
      const candidates = [thread?.name, thread?.agentNickname]
        .filter((value) => typeof value === "string")
        .map((value) => value.toLowerCase());
      return [...expected].find((label) => candidates.some((value) => value === label || value.includes(label))) ?? null;
    };
    const matches = all.filter((thread) => expectedLabel(thread) !== null);
    const descendantIds = new Set([suppliedRoot]);
    for (let pass = 0; pass < all.length; pass += 1) {
      let changed = false;
      for (const thread of all) {
        if (descendantIds.has(thread.id)) continue;
        const nestedParent = spawnParent(thread);
        if (descendantIds.has(thread.parentThreadId) || descendantIds.has(thread.forkedFromId) || descendantIds.has(nestedParent)) {
          descendantIds.add(thread.id);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const namesById = new Map(matches.map((thread) => [thread.id, expectedLabel(thread)]));
    const output = matches.map((thread) => ({
      name: expectedLabel(thread),
      nickname: text(thread.agentNickname, safeLabel),
      role: text(thread.agentRole, safeLabel),
      status: text(thread.status, safeWord),
      sourceType: sourceType(thread),
      ephemeral: thread.ephemeral === true,
      descendantOfSuppliedRoot: descendantIds.has(thread.id),
      parent: (() => {
        const nestedParent = spawnParent(thread);
        const parent = thread.parentThreadId ?? nestedParent;
        return namesById.get(parent) ?? (parent === suppliedRoot ? "supplied-root" : parent ? "other" : null);
      })(),
      forkedFrom: namesById.get(thread.forkedFromId) ?? (thread.forkedFromId === suppliedRoot ? "supplied-root" : thread.forkedFromId ? "other" : null),
    }));
    const descendantMatches = output.filter((thread) => thread.descendantOfSuppliedRoot);
    const knownAcceptanceThreads = all
      .filter((thread) => acceptanceLabelsById.has(thread.id))
      .map((thread) => {
        const source = thread.source && typeof thread.source === "object" ? thread.source : null;
        const threadSource = thread.threadSource && typeof thread.threadSource === "object" ? thread.threadSource : null;
        const subAgent = source?.subAgent ?? source?.subagent ?? threadSource?.subAgent ?? threadSource?.subagent;
        const spawn = spawnMetadata(thread);
        return {
          label: acceptanceLabelsById.get(thread.id),
          keys: Object.keys(thread).sort(),
          sourceKeys: source ? Object.keys(source).sort() : [],
          threadSourceKeys: threadSource ? Object.keys(threadSource).sort() : [],
          subAgentKeys: subAgent && typeof subAgent === "object" ? Object.keys(subAgent).sort() : [],
          spawnKeys: spawn ? Object.keys(spawn).sort() : [],
          nickname: text(thread.agentNickname, safeLabel),
          role: text(thread.agentRole, safeLabel),
          parent: acceptanceLabelsById.get(thread.parentThreadId) ?? (thread.parentThreadId ? "other" : null),
          forkedFrom: acceptanceLabelsById.get(thread.forkedFromId) ?? (thread.forkedFromId ? "other" : null),
        };
      });
    const directlyReadableAcceptanceThreads = [];
    for (const [threadId, label] of acceptanceLabelsById) {
      try {
        const result = await call("thread/read", { threadId, includeTurns: true });
        const thread = result?.thread;
        const spawn = spawnMetadata(thread);
        const structuralReferences = knownIdPaths(thread?.turns ?? result?.turns ?? [])
          .filter((entry) => entry.label !== label)
          .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.label === entry.label && candidate.path === entry.path) === index);
        directlyReadableAcceptanceThreads.push({
          label,
          readable: Boolean(thread),
          ephemeral: thread?.ephemeral === true,
          status: text(thread?.status, safeWord),
          sessionPresent: typeof thread?.sessionId === "string" || typeof thread?.session_id === "string",
          sessionMatchesSuppliedRoot: (thread?.sessionId ?? thread?.session_id) === suppliedRoot,
          sessionMatchesThread: (thread?.sessionId ?? thread?.session_id) === threadId,
          cwdMatchesSupplied: suppliedCwd ? thread?.cwd === suppliedCwd : null,
          parent: acceptanceLabelsById.get(thread?.parentThreadId ?? spawnParent(thread)) ?? null,
          sourceKeys: thread?.source && typeof thread.source === "object" ? Object.keys(thread.source).sort() : [],
          spawnKeys: spawn ? Object.keys(spawn).sort() : [],
          structuralReferences,
          structuralItems: safeStructuralItems(thread),
        });
      } catch {
        directlyReadableAcceptanceThreads.push({ label, readable: false, parent: null, sourceKeys: [], spawnKeys: [] });
      }
    }
    process.stdout.write(`${JSON.stringify({ result: descendantMatches.length === 4 ? "MATCHED" : "INCOMPLETE", totalThreads: all.length, pagination, descendantMatches, allExpectedLabelMatches: output.length, knownAcceptanceThreads, directlyReadableAcceptanceThreads }, null, 2)}\n`);
    if (descendantMatches.length !== 4) process.exitCode = 2;
  } finally {
    clearTimeout(deadline);
    child.kill("SIGTERM");
  }
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "DIAGNOSTIC_FAILED"}\n`);
  process.exitCode = 1;
  child.kill("SIGTERM");
});
