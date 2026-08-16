import { describe, expect, it } from "vitest";

import type {
  AdapterGateAccepted,
  JsonObject,
  SanitizedThread,
  SanitizedThreadPage,
  SanitizedThreadRead,
} from "@agent-farm/codex-bridge";

import {
  CodexSourceRootAuthority,
  SourceRootAuthorityError,
  type CodexSourceRootClient,
} from "../src/source-root-authority.js";

const gate: AdapterGateAccepted = {
  status: "accepted",
  adapterVersion: "fixture-v1",
  schemaVersion: "fixture-schema-v1",
  fingerprint: {
    reportedUserAgent: "Codex Desktop/fixture",
    schemaBundleSha256: "schema",
    connectionTime: new Date(0).toISOString(),
  },
};

const rootThread = (overrides: Partial<SanitizedThread> = {}): SanitizedThread => ({
  sourceThreadId: "thread:root",
  sessionId: "session:codex",
  status: "active",
  ...overrides,
});

function clientFor(
  pages: ReadonlyMap<string | undefined, SanitizedThreadPage>,
  reads: ReadonlyMap<string, SanitizedThreadRead> = new Map([["thread:root", { thread: rootThread(), turns: [] }]]),
  options: { readonly installationId?: string } = {},
): CodexSourceRootClient {
  return {
    gate,
    ...(options.installationId === undefined ? {} : { installationId: options.installationId }),
    async listThreads(params?: JsonObject): Promise<SanitizedThreadPage> {
      const cursor = typeof params?.cursor === "string" ? params.cursor : undefined;
      const page = pages.get(cursor);
      if (!page) throw new Error("missing fixture page");
      return page;
    },
    async readThread(params: JsonObject): Promise<SanitizedThreadRead> {
      const root = typeof params.threadId === "string" ? params.threadId : "";
      const read = reads.get(root);
      if (!read) throw new Error("missing fixture read");
      return read;
    },
  };
}

function authority(
  client: CodexSourceRootClient,
  options: Partial<ConstructorParameters<typeof CodexSourceRootAuthority>[0]> = {},
): CodexSourceRootAuthority {
  return new CodexSourceRootAuthority({ client, installationId: "install:trusted", ...options });
}

function expectCode(promise: Promise<unknown>, code: SourceRootAuthorityError["code"]): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code });
}

describe("Codex source-root authority", () => {
  it("rejects a caller-supplied unknown root without reading it", async () => {
    let reads = 0;
    const client = clientFor(new Map([[undefined, { threads: [rootThread()] }]]));
    const wrapped: CodexSourceRootClient = {
      ...client,
      async readThread(params) {
        reads += 1;
        return client.readThread(params);
      },
    };
    await expectCode(
      authority(wrapped).attestSourceRoot({ installationId: "install:trusted", sourceRootId: "thread:unknown" }),
      "ROOT_NOT_FOUND",
    );
    expect(reads).toBe(0);
  });

  it("treats the configured installation as authority and rejects mismatches", async () => {
    let listed = 0;
    const client = clientFor(new Map([[undefined, { threads: [rootThread()] }]]));
    const wrapped: CodexSourceRootClient = {
      ...client,
      async listThreads(params) {
        listed += 1;
        return client.listThreads(params);
      },
    };
    await expectCode(
      authority(wrapped).attestSourceRoot({ installationId: "install:caller", sourceRootId: "thread:root" }),
      "INSTALLATION_MISMATCH",
    );
    expect(listed).toBe(0);

    await expectCode(
      authority(clientFor(new Map([[undefined, { threads: [rootThread()] }]]), undefined, { installationId: "install:other" }))
        .attestSourceRoot({ installationId: "install:trusted", sourceRootId: "thread:root" }),
      "CROSS_INSTALL",
    );
  });

  it("fails closed on duplicate ids across cursor pages", async () => {
    const pages = new Map<string | undefined, SanitizedThreadPage>([
      [undefined, { threads: [rootThread()], nextCursor: "cursor:next" }],
      ["cursor:next", { threads: [rootThread()] }],
    ]);
    await expectCode(
      authority(clientFor(pages)).attestSourceRoot({ installationId: "install:trusted", sourceRootId: "thread:root" }),
      "DUPLICATE_ID",
    );
  });

  it("rejects a descendant selected as the global V1 root", async () => {
    const descendant = rootThread({ parentThreadId: "thread:parent" });
    await expectCode(
      authority(clientFor(new Map([[undefined, { threads: [descendant] }]]))).attestSourceRoot({
        installationId: "install:trusted",
        sourceRootId: "thread:root",
      }),
      "DESCENDANT_AS_ROOT",
    );
  });

  it("stops on a repeated continuation cursor", async () => {
    const pages = new Map<string | undefined, SanitizedThreadPage>([
      [undefined, { threads: [rootThread()], nextCursor: "cursor:loop" }],
      ["cursor:loop", { threads: [], nextCursor: "cursor:loop" }],
    ]);
    await expectCode(
      authority(clientFor(pages)).attestSourceRoot({ installationId: "install:trusted", sourceRootId: "thread:root" }),
      "CURSOR_LOOP",
    );
  });

  it("rejects an empty or malformed source session id", async () => {
    const malformed = rootThread({ sessionId: "" });
    await expectCode(
      authority(clientFor(new Map([[undefined, { threads: [malformed] }]]))).attestSourceRoot({
        installationId: "install:trusted",
        sourceRootId: "thread:root",
      }),
      "MALFORMED_SESSION",
    );
  });

  it("accepts an exact root/read correlation and emits metadata-only attestation", async () => {
    const calls: JsonObject[] = [];
    const readCalls: JsonObject[] = [];
    const client = clientFor(new Map([[undefined, { threads: [rootThread()] }]]));
    const wrapped: CodexSourceRootClient = {
      ...client,
      async listThreads(params) {
        if (params) calls.push(params);
        return client.listThreads(params);
      },
      async readThread(params) {
        readCalls.push(params);
        return client.readThread(params);
      },
    };
    const now = new Date("2026-08-09T00:00:00.000Z");
    const result = await authority(wrapped, { now: () => now, attestationTtlMs: 5_000 }).attestSourceRoot({
      installationId: "install:trusted",
      sourceRootId: "thread:root",
    });
    expect(result).toMatchObject({
      version: "source-root-attestation-v1",
      installationId: "install:trusted",
      sourceRootId: "thread:root",
      sourceSessionId: "session:codex",
      issuedAt: now.toISOString(),
      expiresAt: "2026-08-09T00:00:05.000Z",
    });
    expect(result.attestationDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.digest).toBe(result.attestationDigest);
    expect(calls).toEqual([{
      archived: false,
      useStateDbOnly: false,
      sourceKinds: [
        "cli",
        "vscode",
        "exec",
        "appServer",
        "subAgent",
        "subAgentReview",
        "subAgentCompact",
        "subAgentThreadSpawn",
        "subAgentOther",
      ],
      limit: 20,
    }]);
    expect(Object.isFrozen(calls[0]?.sourceKinds)).toBe(true);
    expect(readCalls).toEqual([{ threadId: "thread:root", includeTurns: false }]);
  });

  it("accepts structural task-path fields but keeps them out of root attestation metadata", async () => {
    const structuralRoot = rootThread({ agentPath: "/root/dirac", agentTaskName: "dirac", agentNickname: "Dirac" });
    const pages = new Map<string | undefined, SanitizedThreadPage>([[undefined, { threads: [structuralRoot] }]]);
    const reads = new Map<string, SanitizedThreadRead>([["thread:root", { thread: structuralRoot, turns: [] }]]);
    const result = await authority(clientFor(pages, reads)).attestSourceRoot({
      installationId: "install:trusted",
      sourceRootId: "thread:root",
    });
    expect(result).not.toHaveProperty("agentPath");
    expect(result).not.toHaveProperty("agentTaskName");
    expect(result.attestationDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects malformed structural task paths at the authority boundary", async () => {
    const malformed = rootThread({ agentPath: "/root/../dirac", agentTaskName: "dirac" });
    await expectCode(
      authority(clientFor(new Map([[undefined, { threads: [malformed] }]]))).attestSourceRoot({
        installationId: "install:trusted",
        sourceRootId: "thread:root",
      }),
      "MALFORMED_PAGE",
    );
  });

  it("creates short-lived one-use inputs with expiry and no deterministic replay", async () => {
    const pages = new Map<string | undefined, SanitizedThreadPage>([[undefined, { threads: [rootThread()] }]]);
    let now = new Date("2026-08-09T00:00:00.000Z");
    const source = authority(clientFor(pages), { now: () => now, attestationTtlMs: 10 });
    const first = await source.attestSourceRoot({ installationId: "install:trusted", sourceRootId: "thread:root" });
    now = new Date("2026-08-09T00:00:01.000Z");
    const second = await source.attestSourceRoot({ installationId: "install:trusted", sourceRootId: "thread:root" });
    expect(Date.parse(first.expiresAt)).toBe(Date.parse(first.issuedAt) + 10);
    expect(second.attestationDigest).not.toBe(first.attestationDigest);
    expect(Date.parse(first.expiresAt)).toBeLessThan(Date.parse(second.issuedAt));
    // Replay/expiry consumption belongs to PairingLedger, which stores only
    // this digest + expiry and atomically marks the challenge used.
  });
});
