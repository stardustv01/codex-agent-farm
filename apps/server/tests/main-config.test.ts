import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PHASE_A_BINARY_SHA256 } from "@agent-farm/codex-bridge";

import { createApp } from "../src/index.js";
import {
  CODEX_RECONCILER_PAGE_SIZE,
  CODEX_RUNTIME_MAX_LINE_BYTES,
  EnvironmentConfigError,
  assertServerEnvironmentInvariants,
  parseServerEnvironment,
  startServer,
} from "../src/main.js";

const production = {
  AGENT_FARM_DATABASE: "/var/lib/agent-farm/agent-farm.sqlite",
  AGENT_FARM_JWKS_URI: "https://issuer.example/.well-known/jwks.json",
  AGENT_FARM_ISSUER: "https://issuer.example",
  AGENT_FARM_AUDIENCE: "agent-farm",
  AGENT_FARM_RESOURCE: "https://agent-farm.example",
  AGENT_FARM_AUTHORIZATION_SERVER: "https://issuer.example",
  AGENT_FARM_BROWSER_AUTHORIZATION_ENDPOINT: "https://issuer.example/authorize",
  AGENT_FARM_BROWSER_TOKEN_ENDPOINT: "https://issuer.example/token",
  AGENT_FARM_BROWSER_CLIENT_ID: "agent-farm-browser",
  AGENT_FARM_BROWSER_REDIRECT_URI: "https://agent-farm.example/auth/callback",
  AGENT_FARM_CODEX_EXECUTABLE: "/Users/praveengupta/.local/bin/codex",
  AGENT_FARM_CODEX_BINARY_SHA256: PHASE_A_BINARY_SHA256,
  AGENT_FARM_CODEX_INSTALLATION_ID: "codex-installation-production",
  AGENT_FARM_CODEX_SESSIONS_ROOT: "/var/lib/agent-farm/codex-sessions",
  AGENT_FARM_MCP_GRANT_DIGEST_KEY: "production-mcp-grant-digest-key-0123456789abcdef",
  AGENT_FARM_TOKEN_STATUS_URL: "https://issuer.example/token-status",
  AGENT_FARM_TOKEN_STATUS_SECRET: "service-secret",
  AGENT_FARM_ALLOWED_ORIGINS: "https://app.example",
  AGENT_FARM_ALLOWED_HOSTS: "app.example",
} as const;

const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe("server environment policy", () => {
  it("keeps real Codex response framing bounded while using small reconciliation pages", () => {
    expect(CODEX_RUNTIME_MAX_LINE_BYTES).toBe(8 * 1_048_576);
    expect(CODEX_RECONCILER_PAGE_SIZE).toBe(20);
  });

  it("requires every production trust and network boundary without mutating env", () => {
    const input = { ...production };
    const config = parseServerEnvironment(input);
    expect(config.devMode).toBe(false);
    expect(config.databaseFilename).toBe(production.AGENT_FARM_DATABASE);
    expect(config.allowedOrigins).toEqual(["https://app.example"]);
    expect(config.allowedHosts).toEqual(["app.example"]);
    expect(config.codexExecutable).toBe(production.AGENT_FARM_CODEX_EXECUTABLE);
    expect(config.codexBinarySha256).toBe(PHASE_A_BINARY_SHA256);
    expect(config.codexInstallationId).toBe(production.AGENT_FARM_CODEX_INSTALLATION_ID);
    expect(config.codexSessionsRoot).toBe(production.AGENT_FARM_CODEX_SESSIONS_ROOT);
    expect(config.mcpGrantDigestKey).toBe(production.AGENT_FARM_MCP_GRANT_DIGEST_KEY);
    expect(input).toEqual(production);

    const missing = { ...production };
    delete (missing as Record<string, string>).AGENT_FARM_TOKEN_STATUS_SECRET;
    expect(() => parseServerEnvironment(missing)).toThrowError(EnvironmentConfigError);
    try {
      parseServerEnvironment(missing);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EnvironmentConfigError);
      expect((error as EnvironmentConfigError).missing).toContain("AGENT_FARM_TOKEN_STATUS_SECRET");
    }

    const missingBrowserClient = { ...production };
    delete (missingBrowserClient as Record<string, string>).AGENT_FARM_BROWSER_CLIENT_ID;
    expect(() => parseServerEnvironment(missingBrowserClient)).toThrowError(EnvironmentConfigError);
    try {
      parseServerEnvironment(missingBrowserClient);
    } catch (error: unknown) {
      expect((error as EnvironmentConfigError).missing).toContain("AGENT_FARM_BROWSER_CLIENT_ID");
    }

    expect(() => parseServerEnvironment({
      ...production,
      AGENT_FARM_BROWSER_REDIRECT_URI: "https://agent-farm.example/wrong-callback",
    })).toThrowError(EnvironmentConfigError);
  });

  it("requires a pinned supported Codex executable, hash, and installation in production", () => {
    for (const name of [
      "AGENT_FARM_CODEX_EXECUTABLE",
      "AGENT_FARM_CODEX_BINARY_SHA256",
      "AGENT_FARM_CODEX_INSTALLATION_ID",
      "AGENT_FARM_CODEX_SESSIONS_ROOT",
      "AGENT_FARM_MCP_GRANT_DIGEST_KEY",
    ]) {
      const missing = { ...production } as Record<string, string>;
      delete missing[name];
      expect(() => parseServerEnvironment(missing)).toThrowError(EnvironmentConfigError);
      try {
        parseServerEnvironment(missing);
      } catch (error: unknown) {
        expect((error as EnvironmentConfigError).missing).toContain(name);
      }
    }

    for (const [name, value] of [
      ["AGENT_FARM_CODEX_EXECUTABLE", "relative/codex"],
      ["AGENT_FARM_CODEX_EXECUTABLE", "/tmp/\u0000codex"],
      ["AGENT_FARM_CODEX_BINARY_SHA256", "not-a-sha"],
      ["AGENT_FARM_CODEX_BINARY_SHA256", "0".repeat(64)],
      ["AGENT_FARM_CODEX_INSTALLATION_ID", "bad installation id"],
      ["AGENT_FARM_CODEX_SESSIONS_ROOT", "relative/codex-sessions"],
      ["AGENT_FARM_CODEX_SESSIONS_ROOT", "/tmp/\u0000codex-sessions"],
      ["AGENT_FARM_MCP_GRANT_DIGEST_KEY", "too-short"],
      ["AGENT_FARM_MCP_GRANT_DIGEST_KEY", "x".repeat(33) + "\u0000"],
    ] as const) {
      expect(() => parseServerEnvironment({ ...production, [name]: value })).toThrowError(EnvironmentConfigError);
      try {
        parseServerEnvironment({ ...production, [name]: value });
      } catch (error: unknown) {
        expect((error as EnvironmentConfigError).invalid).toContain(name);
      }
    }
  });

  it("allows explicit dev mode to choose a durable local sqlite path", () => {
    const config = parseServerEnvironment({ AGENT_FARM_DEV_MODE: "1" });
    expect(config.devMode).toBe(true);
    expect(config.databaseFilename).not.toBe(":memory:");
    expect(config.databaseFilename).toMatch(/sqlite$/u);
    expect(config.allowedHosts).toEqual(["127.0.0.1:8787"]);
    expect(config.codexExecutable).toMatch(/\.local\/bin\/codex$/u);
    expect(config.codexBinarySha256).toBe(PHASE_A_BINARY_SHA256);
    expect(config.codexInstallationId).toBe("codex-local-dev");
    expect(config.codexSessionsRoot).toMatch(/\.codex\/sessions$/u);
    expect(config.mcpGrantDigestKey.length).toBeGreaterThanOrEqual(32);
  });

  it("accepts a trusted current-task identity only in local mode", () => {
    const config = parseServerEnvironment({
      AGENT_FARM_LOCAL_MODE: "1",
      AGENT_FARM_EXPECTED_SOURCE_ROOT_ID: "root-current-task",
    });
    expect(config.expectedLocalSourceRootId).toBe("root-current-task");
    expect(() => parseServerEnvironment({ AGENT_FARM_DEV_MODE: "1", AGENT_FARM_EXPECTED_SOURCE_ROOT_ID: "root-dev" })).toThrowError(EnvironmentConfigError);
    expect(() => parseServerEnvironment({ AGENT_FARM_LOCAL_MODE: "1", AGENT_FARM_EXPECTED_SOURCE_ROOT_ID: "bad task id" })).toThrowError(EnvironmentConfigError);
  });

  it("synthesizes a header-safe loopback host for IPv6 local mode", () => {
    const config = parseServerEnvironment({
      AGENT_FARM_LOCAL_MODE: "1",
      HOST: "::1",
      PORT: "8787",
    });
    expect(config.localMode).toBe(true);
    expect(config.allowedHosts).toEqual(["[::1]:8787"]);
    expect(config.allowedOrigins).toEqual(["http://[::1]:8787"]);
    expect(() => assertServerEnvironmentInvariants(config)).not.toThrow();
  });

  it("keeps the documented local database path authoritative", () => {
    const config = parseServerEnvironment({ AGENT_FARM_LOCAL_MODE: "1" });
    expect(config.databaseFilename).toBe(join(process.cwd(), ".agent-farm/local.sqlite"));

    const equivalent = parseServerEnvironment({
      AGENT_FARM_LOCAL_MODE: "1",
      AGENT_FARM_DATABASE: "./.agent-farm/local.sqlite",
    });
    expect(equivalent.databaseFilename).toBe(config.databaseFilename);

    try {
      parseServerEnvironment({
        AGENT_FARM_LOCAL_MODE: "1",
        AGENT_FARM_DATABASE: "/tmp/x",
      });
      throw new Error("expected local database override to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EnvironmentConfigError);
      expect((error as EnvironmentConfigError).invalid).toEqual(
        expect.arrayContaining(["AGENT_FARM_DATABASE", "AGENT_FARM_LOCAL_MODE"]),
      );
    }
  });

  it("supports explicit loopback-only local mode without OAuth configuration", () => {
    const config = parseServerEnvironment({ AGENT_FARM_LOCAL_MODE: "1" });
    expect(config.localMode).toBe(true);
    expect(config.host).toBe("127.0.0.1");
    expect(config.databaseFilename).toMatch(/\.agent-farm\/local\.sqlite$/u);
    expect(config.allowedOrigins).toEqual(["http://127.0.0.1:8787"]);
    expect(config.allowedHosts).toEqual(["127.0.0.1:8787"]);
    expect(config.orchestrationBudget).toEqual({ solHigh: 10, lunaMax: 10, solMax: 3 });
    expect(config.jwksUri).toBeUndefined();
    expect(config.browserAuthorizationEndpoint).toBeUndefined();
    expect(config.tokenStatusUrl).toBeUndefined();
  });

  it("revalidates injected local startup environments before composition", async () => {
    const valid = parseServerEnvironment({ AGENT_FARM_LOCAL_MODE: "1" });
    expect(() => assertServerEnvironmentInvariants(valid)).not.toThrow();

    const arbitraryDatabase = { ...valid, databaseFilename: "/tmp/x" };
    await expect(startServer(arbitraryDatabase)).rejects.toMatchObject({
      invalid: expect.arrayContaining(["AGENT_FARM_DATABASE", "AGENT_FARM_LOCAL_MODE"]),
    });
    expect(() => assertServerEnvironmentInvariants(arbitraryDatabase)).toThrowError(EnvironmentConfigError);

    const bareIpv6 = {
      ...valid,
      host: "::1",
      allowedHosts: ["[::1]:8787"],
      allowedOrigins: ["http://[::1]:8787"],
    };
    expect(() => assertServerEnvironmentInvariants(bareIpv6)).not.toThrow();

    for (const allowedHosts of [["[::1]not-a-port"], ["localhost:not-a-port"]]) {
      const malformedHost = { ...valid, allowedHosts };
      expect(() => assertServerEnvironmentInvariants(malformedHost)).toThrowError(EnvironmentConfigError);
    }

    const remoteHost = { ...valid, host: "0.0.0.0" };
    expect(() => assertServerEnvironmentInvariants(remoteHost)).toThrowError(EnvironmentConfigError);
    await expect(startServer(remoteHost)).rejects.toMatchObject({
      invalid: expect.arrayContaining(["AGENT_FARM_LOCAL_MODE"]),
    });
    try {
      assertServerEnvironmentInvariants(remoteHost);
    } catch (error: unknown) {
      expect((error as EnvironmentConfigError).invalid).toContain("AGENT_FARM_LOCAL_MODE");
    }

    const oauthInjected = { ...valid, jwksUri: "https://issuer.example/jwks" };
    expect(() => assertServerEnvironmentInvariants(oauthInjected)).toThrowError(EnvironmentConfigError);
    await expect(startServer(oauthInjected)).rejects.toMatchObject({
      invalid: expect.arrayContaining(["AGENT_FARM_LOCAL_MODE"]),
    });
    try {
      assertServerEnvironmentInvariants(oauthInjected);
    } catch (error: unknown) {
      expect((error as EnvironmentConfigError).invalid).toContain("AGENT_FARM_LOCAL_MODE");
    }

    const invalidBudget = { ...valid, orchestrationBudget: { solHigh: 11, lunaMax: 10, solMax: 3 } };
    expect(() => assertServerEnvironmentInvariants(invalidBudget)).toThrowError(EnvironmentConfigError);
    try {
      assertServerEnvironmentInvariants(invalidBudget);
    } catch (error: unknown) {
      expect((error as EnvironmentConfigError).invalid).toContain("AGENT_FARM_BUDGET");
    }
  });

  it("rejects remote local-mode network boundaries", () => {
    for (const environment of [
      { AGENT_FARM_LOCAL_MODE: "1", HOST: "0.0.0.0" },
      { AGENT_FARM_LOCAL_MODE: "1", AGENT_FARM_ALLOWED_ORIGINS: "https://remote.example" },
      { AGENT_FARM_LOCAL_MODE: "1", AGENT_FARM_ALLOWED_HOSTS: "remote.example" },
    ]) {
      expect(() => parseServerEnvironment(environment)).toThrowError(EnvironmentConfigError);
      try {
        parseServerEnvironment(environment);
      } catch (error: unknown) {
        expect((error as EnvironmentConfigError).invalid).toContain("AGENT_FARM_LOCAL_MODE");
      }
    }
  });

  it("rejects OAuth and token-status configuration in local mode", () => {
    for (const [name, value] of [
      ["AGENT_FARM_JWKS_URI", "https://issuer.example/jwks"],
      ["AGENT_FARM_ISSUER", "https://issuer.example"],
      ["AGENT_FARM_BROWSER_REVOCATION_ENDPOINT", "https://issuer.example/revoke"],
      ["AGENT_FARM_TOKEN_STATUS_URL", "https://issuer.example/token-status"],
      ["AGENT_FARM_TOKEN_STATUS_TIMEOUT_MS", "1000"],
    ] as const) {
      try {
        parseServerEnvironment({ AGENT_FARM_LOCAL_MODE: "1", [name]: value });
        throw new Error("expected local mode configuration to fail");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(EnvironmentConfigError);
        expect((error as EnvironmentConfigError).invalid).toContain("AGENT_FARM_LOCAL_MODE");
      }
    }
  });

  it("parses the bounded orchestration budget atomically", () => {
    expect(parseServerEnvironment({
      AGENT_FARM_LOCAL_MODE: "1",
      AGENT_FARM_BUDGET_SOL_HIGH: "10",
      AGENT_FARM_BUDGET_LUNA_MAX: "10",
      AGENT_FARM_BUDGET_SOL_MAX: "3",
    }).orchestrationBudget).toEqual({ solHigh: 10, lunaMax: 10, solMax: 3 });
    expect(parseServerEnvironment({
      AGENT_FARM_LOCAL_MODE: "1",
      AGENT_FARM_BUDGET_SOL_HIGH: "0",
      AGENT_FARM_BUDGET_LUNA_MAX: "0",
      AGENT_FARM_BUDGET_SOL_MAX: "2",
    }).orchestrationBudget).toEqual({ solHigh: 0, lunaMax: 0, solMax: 2 });

    for (const budget of [
      { AGENT_FARM_BUDGET_SOL_HIGH: "11", AGENT_FARM_BUDGET_LUNA_MAX: "10", AGENT_FARM_BUDGET_SOL_MAX: "3" },
      { AGENT_FARM_BUDGET_SOL_HIGH: "10", AGENT_FARM_BUDGET_LUNA_MAX: "10", AGENT_FARM_BUDGET_SOL_MAX: "4" },
      { AGENT_FARM_BUDGET_SOL_HIGH: "10", AGENT_FARM_BUDGET_LUNA_MAX: "10", AGENT_FARM_BUDGET_SOL_MAX: "6" },
      { AGENT_FARM_BUDGET_SOL_HIGH: "10" },
    ]) {
      try {
        parseServerEnvironment({ AGENT_FARM_LOCAL_MODE: "1", ...budget });
        throw new Error("expected orchestration budget to fail");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(EnvironmentConfigError);
        expect((error as EnvironmentConfigError).invalid).toContain("AGENT_FARM_BUDGET");
      }
    }
  });

  it("requires HTTPS allowed origins in production while retaining explicit local HTTP in dev", () => {
    const secure = parseServerEnvironment(production);
    expect(secure.allowedOrigins).toEqual(["https://app.example"]);

    const insecure = { ...production, AGENT_FARM_ALLOWED_ORIGINS: "http://app.example" };
    expect(() => parseServerEnvironment(insecure)).toThrowError(EnvironmentConfigError);
    try {
      parseServerEnvironment(insecure);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EnvironmentConfigError);
      expect((error as EnvironmentConfigError).invalid).toContain("AGENT_FARM_ALLOWED_ORIGINS");
    }

    const explicitDev = parseServerEnvironment({
      AGENT_FARM_DEV_MODE: "1",
      HOST: "127.0.0.1",
      PORT: "43123",
      AGENT_FARM_ALLOWED_ORIGINS: "http://127.0.0.1:43123",
    });
    expect(explicitDev.allowedOrigins).toEqual(["http://127.0.0.1:43123"]);
    expect(parseServerEnvironment({ AGENT_FARM_DEV_MODE: "1" }).allowedOrigins).toEqual(["http://127.0.0.1:8787"]);

    for (const remoteDev of [
      {
        AGENT_FARM_DEV_MODE: "1",
        HOST: "127.0.0.1",
        AGENT_FARM_ALLOWED_ORIGINS: "http://dev.remote.example",
      },
      {
        AGENT_FARM_DEV_MODE: "1",
        HOST: "0.0.0.0",
        AGENT_FARM_ALLOWED_ORIGINS: "http://127.0.0.1:8787",
      },
    ]) {
      expect(() => parseServerEnvironment(remoteDev)).toThrowError(EnvironmentConfigError);
    }

    const ipv6Loopback = parseServerEnvironment({
      AGENT_FARM_DEV_MODE: "1",
      HOST: "::1",
      AGENT_FARM_ALLOWED_ORIGINS: "http://[::1]:8787",
    });
    expect(ipv6Loopback.allowedOrigins).toEqual(["http://[::1]:8787"]);
  });
});

describe("host and standalone static boundaries", () => {
  it("fails closed for missing/foreign hosts and permits only an explicit host", async () => {
    const app = createApp({ allowedHosts: ["example.test:443"] });
    apps.push(app);

    const missing = await app.inject({ method: "GET", url: "/healthz" });
    const foreign = await app.inject({ method: "GET", url: "/healthz", headers: { host: "evil.test:443" } });
    const allowed = await app.inject({ method: "GET", url: "/healthz", headers: { host: "EXAMPLE.TEST:443" } });
    expect(missing.statusCode).toBe(400);
    expect(foreign.statusCode).toBe(400);
    expect(allowed.statusCode).toBe(200);
  });

  it("serves the root build and safe SPA fallback without replacing API errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-farm-web-"));
    writeFileSync(join(root, "index.html"), "<!doctype html><html><body>standalone</body></html>");
    writeFileSync(join(root, "app.js"), "console.log('self');");
    const app = createApp({ staticRoot: root });
    apps.push(app);

    const home = await app.inject({ method: "GET", url: "/" });
    const route = await app.inject({ method: "GET", url: "/hierarchy/one", headers: { accept: "text/html" } });
    const api = await app.inject({ method: "GET", url: "/api/unknown", headers: { accept: "text/html" } });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain("standalone");
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain("standalone");
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe("NOT_FOUND");
  });
});
