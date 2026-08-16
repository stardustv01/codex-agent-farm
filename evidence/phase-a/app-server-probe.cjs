const { spawn } = require("node:child_process");

const codexBinary =
  process.env.AGENT_FARM_CODEX_BIN ??
  "/Users/praveengupta/.local/bin/codex";
const child = spawn(codexBinary, ["app-server", "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let firstThread = null;
let finished = false;

function send(message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  child.kill("SIGTERM");
}

child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;

    const message = JSON.parse(line);
    if (message.id === 1) {
      console.log(JSON.stringify({
        probe: "initialize",
        userAgent: message.result?.userAgent,
        platformFamily: message.result?.platformFamily,
        platformOs: message.result?.platformOs,
      }));
      send({ method: "initialized" });
      send({
        method: "thread/list",
        id: 2,
        params: { limit: 1, useStateDbOnly: true },
      });
      continue;
    }

    if (message.id === 2) {
      firstThread = message.result?.data?.[0] ?? null;
      console.log(JSON.stringify({
        probe: "thread/list-page-1",
        count: message.result?.data?.length ?? 0,
        hasNext: Boolean(message.result?.nextCursor),
        threadFields: firstThread ? Object.keys(firstThread).sort() : [],
      }));
      if (!firstThread) {
        finish();
        continue;
      }
      send({
        method: "thread/read",
        id: 3,
        params: { threadId: firstThread.id, includeTurns: true },
      });
      continue;
    }

    if (message.id === 3) {
      const thread = message.result?.thread;
      console.log(JSON.stringify({
        probe: "thread/read",
        sameThread: Boolean(thread && thread.id === firstThread?.id),
        turnCount: thread?.turns?.length ?? 0,
        turns: (thread?.turns ?? []).slice(0, 5).map((turn) => ({
          status: turn.status,
          itemCount: turn.items?.length ?? 0,
          itemTypes: [...new Set(
            (turn.items ?? []).map((item) => item.type),
          )].sort(),
          hasDuration: turn.durationMs != null,
          hasError: turn.error != null,
        })),
      }));
      send({
        method: "thread/list",
        id: 4,
        params: { limit: 1, useStateDbOnly: true },
      });
      continue;
    }

    if (message.id === 4) {
      console.log(JSON.stringify({
        probe: "thread/list-repeat",
        count: message.result?.data?.length ?? 0,
        sameFirst: Boolean(message.result?.data?.[0]?.id === firstThread?.id),
      }));
      finish();
    }
  }
});

child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
  finish();
});

send({
  method: "initialize",
  id: 1,
  params: {
    clientInfo: {
      name: "agent-farm-contract-probe",
      title: "Agent Farm Contract Probe",
      version: "0.0.0",
    },
    capabilities: {
      experimentalApi: false,
      requestAttestation: false,
      optOutNotificationMethods: [],
    },
  },
});

const deadline = setTimeout(() => {
  process.exitCode = 2;
  finish();
}, 10_000);
