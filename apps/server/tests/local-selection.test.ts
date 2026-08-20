import { describe, expect, it } from "vitest";

import {
  LocalSelectionError,
  LocalSelectionRegistry,
  type LocalSelectionBinding,
} from "../src/local-selection.js";

const binding: LocalSelectionBinding = {
  tenantId: "tenant-a",
  ownerId: "owner-a",
  sessionBinding: "browser-session-a",
  installationId: "install-a",
  agentSessionId: "as_local_a",
};

const roots = [
  {
    sourceRootId: "private-root-a",
    nickname: "Planner",
    agentPath: "/private/path",
    status: "running",
    updatedAt: "2026-08-11T10:00:00Z",
  },
  {
    sourceRootId: "private-root-b",
    nickname: "private-root-b",
    status: "idle",
  },
] as const;

describe("LocalSelectionRegistry", () => {
  it("returns only safe labels and opaque one-time handles", () => {
    let counter = 0;
    const registry = new LocalSelectionRegistry({ randomHandle: () => `h${String(counter++).padStart(42, "0")}` });
    const snapshot = registry.issueSnapshot(binding, roots);
    expect(snapshot.candidates).toHaveLength(2);
    expect(snapshot.candidates[0]).toMatchObject({ displayName: "Planner", lifecycle: "running", lastActivityAt: "2026-08-11T10:00:00.000Z" });
    expect(snapshot.candidates[1]?.displayName).toBe("Chat · 02");
    expect(snapshot.candidates[0]).not.toHaveProperty("sourceRootId");
    expect(snapshot.candidates[0]).not.toHaveProperty("agentPath");
    expect(snapshot.candidates[0]?.selectionHandle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(snapshot.candidates[0]?.chatHandle).toMatch(/^[a-f0-9]{64}$/u);
    expect(registry.consume(snapshot.candidates[0]?.selectionHandle, binding)).toMatchObject({ sourceRootId: "private-root-a", agentSessionId: "as_local_a" });
    expect(() => registry.consume(snapshot.candidates[0]?.selectionHandle, binding)).toThrowError(LocalSelectionError);
    expect(registry.consume(snapshot.candidates[0]?.selectionHandle, binding, { allowReplay: true })).toMatchObject({ sourceRootId: "private-root-a", replayed: true });
  });

  it("marks only the server-selected active root and carries its safe label through consumption", () => {
    let counter = 0;
    const registry = new LocalSelectionRegistry({ randomHandle: () => `a${String(counter++).padStart(42, "0")}` });
    const snapshot = registry.issueSnapshot(binding, roots, "private-root-b");
    expect(snapshot.candidates.map((candidate) => candidate.active === true)).toEqual([false, true]);
    expect(snapshot.candidates[1]).toMatchObject({ displayName: "Chat · 02", lifecycle: "idle", active: true });
    const consumed = registry.consume(snapshot.candidates[1]?.selectionHandle, binding);
    expect(consumed).toMatchObject({ sourceRootId: "private-root-b", activeTask: { displayName: "Chat · 02", lifecycle: "idle" } });
    expect(JSON.stringify(snapshot)).not.toContain("private-root-b");
  });

  it("retains a bounded set of recent handles across concurrent status refreshes", () => {
    let counter = 0;
    const registry = new LocalSelectionRegistry({ maxSnapshotGenerations: 2, randomHandle: () => `h${String(counter++).padStart(42, "0")}` });
    const first = registry.issueSnapshot(binding, roots);
    const second = registry.issueSnapshot(binding, roots);
    expect(second.version).toBe(first.version + 1);
    expect(second.candidates[0]?.chatHandle).toBe(first.candidates[0]?.chatHandle);
    expect(second.candidates[0]?.selectionHandle).not.toBe(first.candidates[0]?.selectionHandle);
    expect(registry.consume(first.candidates[0]?.selectionHandle, binding).sourceRootId).toBe("private-root-a");
    expect(registry.consume(second.candidates[0]?.selectionHandle, binding).sourceRootId).toBe("private-root-a");
    const third = registry.issueSnapshot(binding, roots);
    const fourth = registry.issueSnapshot(binding, roots);
    expect(() => registry.consume(third.candidates[0]?.selectionHandle, binding)).not.toThrow();
    expect(() => registry.consume(fourth.candidates[0]?.selectionHandle, binding)).not.toThrow();
    expect(() => registry.consume(first.candidates[1]?.selectionHandle, binding)).toThrowError(LocalSelectionError);
  });

  it("rejects cross-session, malformed, expired, and substituted handles", () => {
    let now = 10_000;
    let counter = 0;
    const registry = new LocalSelectionRegistry({ now: () => now, ttlMs: 100, randomHandle: () => `x${String(counter++).padStart(42, "0")}` });
    const snapshot = registry.issueSnapshot(binding, roots);
    const handle = snapshot.candidates[0]?.selectionHandle;
    expect(() => registry.consume(handle, { ...binding, sessionBinding: "browser-session-b" })).toThrowError(LocalSelectionError);
    expect(registry.consume(handle, binding).sourceRootId).toBe("private-root-a");
    const secondHandle = registry.issueSnapshot(binding, roots).candidates[0]?.selectionHandle;
    expect(() => registry.consume("bad", binding)).toThrowError(LocalSelectionError);
    now += 101;
    expect(() => registry.consume(secondHandle, binding)).toThrowError(LocalSelectionError);
  });

  it("binds the capability to the browser installation while allowing the viewed projection to change", () => {
    let counter = 0;
    const registry = new LocalSelectionRegistry({ randomHandle: () => `m${String(counter++).padStart(42, "0")}` });
    const snapshot = registry.issueSnapshot(binding, roots);
    const firstHandle = snapshot.candidates[0]?.selectionHandle;
    const secondHandle = snapshot.candidates[1]?.selectionHandle;
    expect(() => registry.consume(firstHandle, { ...binding, installationId: "other-install" })).toThrowError(LocalSelectionError);
    expect(registry.consume(firstHandle, { ...binding, tenantId: "tenant-b", ownerId: "owner-b", agentSessionId: "as_other" }).sourceRootId).toBe("private-root-a");
    expect(registry.consume(secondHandle, binding).sourceRootId).toBe("private-root-b");
  });

  it("normalizes unknown lifecycle values and rejects credential/path-like labels", () => {
    let counter = 0;
    const registry = new LocalSelectionRegistry({ randomHandle: () => `q${String(counter++).padStart(42, "0")}` });
    const snapshot = registry.issueSnapshot(binding, [
      { sourceRootId: "root-safe", nickname: "access_token=secret", status: "private-state" },
      { sourceRootId: "root-safe-2", nickname: "/private/path", status: "running" },
      { sourceRootId: "root-safe-3", nickname: "Work/private/task", status: "running" },
      { sourceRootId: "private-other-root", nickname: "ROOT-SAFE", status: "running" },
      { sourceRootId: "root-safe-5", nickname: "%2Fprivate%2Fencoded", status: "running" },
    ]);
    expect(snapshot.candidates.map((candidate) => candidate.displayName)).toEqual([
      "Chat · 01",
      "Chat · 02",
      "Chat · 03",
      "Chat · 04",
      "Chat · 05",
    ]);
    expect(snapshot.candidates[0]?.lifecycle).toBe("unknown");
  });

  it("preserves ordinary API titles while rejecting API credential labels", () => {
    let counter = 0;
    const registry = new LocalSelectionRegistry({ randomHandle: () => `r${String(counter++).padStart(42, "0")}` });
    const snapshot = registry.issueSnapshot(binding, [
      { sourceRootId: "root-api-cost", chatTitle: "Investigate Codex review API costs", status: "running" },
      { sourceRootId: "root-api-key", chatTitle: "api_key=secret", status: "running" },
      { sourceRootId: "root-api-token", chatTitle: "Rotate API token", status: "running" },
    ]);
    expect(snapshot.candidates[0]).toMatchObject({
      displayName: "Investigate Codex review API costs",
      chatTitle: "Investigate Codex review API costs",
    });
    expect(snapshot.candidates[1]?.displayName).toBe("Chat · 02");
    expect(snapshot.candidates[1]).not.toHaveProperty("chatTitle");
    expect(snapshot.candidates[2]?.displayName).toBe("Chat · 03");
    expect(snapshot.candidates[2]).not.toHaveProperty("chatTitle");
  });

  it("keeps readable title text when URLs or a private thread id appear inside the title", () => {
    let counter = 0;
    const registry = new LocalSelectionRegistry({ randomHandle: () => `v${String(counter++).padStart(42, "0")}` });
    const snapshot = registry.issueSnapshot(binding, [
      { sourceRootId: "root-url", chatTitle: "can u please push code https://git.example/repo", status: "running" },
      { sourceRootId: "root-id", chatTitle: "root-id please continue from where it left", status: "running" },
      { sourceRootId: "root-path", chatTitle: "Review docs/AGENT_ROLES.md before release", status: "running" },
    ]);
    expect(snapshot.candidates[0]).toMatchObject({
      displayName: "can u please push code",
      chatTitle: "can u please push code",
    });
    expect(snapshot.candidates[1]).toMatchObject({
      displayName: "please continue from where it left",
      chatTitle: "please continue from where it left",
    });
    expect(snapshot.candidates[2]).toMatchObject({
      displayName: "Review before release",
      chatTitle: "Review before release",
    });
    expect(JSON.stringify(snapshot)).not.toContain("https://");
    expect(JSON.stringify(snapshot)).not.toContain("root-id");
    expect(JSON.stringify(snapshot)).not.toContain("AGENT_ROLES.md");
  });

  it("compacts long Codex-generated titles instead of hiding them behind an ordinal", () => {
    let counter = 0;
    const registry = new LocalSelectionRegistry({ randomHandle: () => `w${String(counter++).padStart(42, "0")}` });
    const title = `Review Chai Studio release readiness ${"with evidence ".repeat(20)}\nfull first-message body`;
    const snapshot = registry.issueSnapshot(binding, [{ sourceRootId: "root-long-title", chatTitle: title, status: "running" }]);
    expect(snapshot.candidates[0]?.chatTitle?.length).toBeLessThanOrEqual(96);
    expect(snapshot.candidates[0]?.chatTitle?.length).toBeGreaterThanOrEqual(90);
    expect(snapshot.candidates[0]?.chatTitle).toMatch(/^Review Chai Studio release readiness/);
    expect(snapshot.candidates[0]?.displayName).toBe(snapshot.candidates[0]?.chatTitle);
  });

  it("replaces generic untitled titles with a structural or ordinal chat label", () => {
    let counter = 0;
    const registry = new LocalSelectionRegistry({ randomHandle: () => `u${String(counter++).padStart(42, "0")}` });
    const snapshot = registry.issueSnapshot(binding, [
      { sourceRootId: "root-task-name", chatTitle: "Untitled chat · 01", agentTaskName: "Verify Agent Farm browser hierarchy", status: "running" },
      { sourceRootId: "root-nickname", chatTitle: "Untitled chat · 02", nickname: "Planning work", status: "running" },
      { sourceRootId: "root-no-name", chatTitle: "Untitled chat · 03", status: "running" },
    ]);
    expect(snapshot.candidates.map((candidate) => candidate.displayName)).toEqual([
      "Verify Agent Farm browser hierarchy",
      "Planning work",
      "Chat · 03",
    ]);
    expect(snapshot.candidates.every((candidate) => candidate.chatTitle === undefined)).toBe(true);
  });

  it("uses a safe structural task name before falling back to a generic chat label", () => {
    let counter = 0;
    const registry = new LocalSelectionRegistry({ randomHandle: () => `t${String(counter++).padStart(42, "0")}` });
    const snapshot = registry.issueSnapshot(binding, [
      { sourceRootId: "root-task-name", agentTaskName: "Verify Agent Farm browser hierarchy", status: "running" },
      { sourceRootId: "root-no-name", status: "running" },
    ]);
    expect(snapshot.candidates.map((candidate) => candidate.displayName)).toEqual([
      "Verify Agent Farm browser hierarchy",
      "Chat · 02",
    ]);
  });

  it("prunes expired session metadata together with bounded handle records", () => {
    let now = 10_000;
    let counter = 0;
    const registry = new LocalSelectionRegistry({ now: () => now, ttlMs: 10, randomHandle: () => `p${String(counter++).padStart(42, "0")}` });
    for (let index = 0; index < 25; index += 1) {
      registry.issueSnapshot({ ...binding, sessionBinding: `browser-${index}` }, roots.slice(0, 1));
    }
    const internals = registry as unknown as { records: Map<string, unknown>; sessions: Map<string, unknown> };
    expect(internals.records.size).toBe(25);
    expect(internals.sessions.size).toBe(25);
    now += 11;
    registry.issueSnapshot({ ...binding, sessionBinding: "browser-empty" }, []);
    expect(internals.records.size).toBe(0);
    expect(internals.sessions.size).toBe(0);
  });

  it("accepts only the exact 32-byte base64url handle shape", () => {
    const registry = new LocalSelectionRegistry({ randomHandle: () => "h".repeat(43) });
    const handle = registry.issueSnapshot(binding, roots.slice(0, 1)).candidates[0]?.selectionHandle;
    expect(handle).toBe("h".repeat(43));
    expect(() => registry.consume("h".repeat(42), binding)).toThrowError(LocalSelectionError);
    expect(() => registry.consume("h".repeat(44), binding)).toThrowError(LocalSelectionError);
    expect(registry.consume(handle, binding).sourceRootId).toBe("private-root-a");
  });

  it("consumes before caller-controlled asynchronous work, so concurrent attempts have one winner", () => {
    let counter = 0;
    const registry = new LocalSelectionRegistry({ randomHandle: () => `z${String(counter++).padStart(42, "0")}` });
    const snapshot = registry.issueSnapshot(binding, roots);
    const handle = snapshot.candidates[0]?.selectionHandle;
    const results = [0, 1].map(() => {
      try {
        return registry.consume(handle, binding).sourceRootId;
      } catch {
        return "rejected";
      }
    });
    expect(results.sort()).toEqual(["private-root-a", "rejected"]);
  });
});
