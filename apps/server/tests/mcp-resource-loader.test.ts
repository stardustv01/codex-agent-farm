import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_HIERARCHY_RESOURCE_URI,
  APP_RESOURCE_MIME_TYPE,
} from "@agent-farm/mcp";

import {
  DEFAULT_MCP_RESOURCE_HTML_PATH,
  McpResourceArtifactError,
  loadMcpResourceArtifact,
  validateMcpResourceArtifact,
} from "../src/resource-loader.js";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function validHtml(): string {
  return `<!doctype html><html lang="en"><head><meta name="agent-farm-resource" content="${AGENT_HIERARCHY_RESOURCE_URI}"></head><body><div id="root"></div><script type="module" data-agent-farm-asset="inline">globalThis.agentFarmInteractive = true;</script></body></html>\n`;
}

function writeArtifact(html = validHtml(), manifestOverrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agent-farm-mcp-resource-"));
  tempDirectories.push(directory);
  const htmlPath = join(directory, "mcp-resource.html");
  const manifestPath = join(directory, "mcp-resource.json");
  const manifest = {
    resourceUri: AGENT_HIERARCHY_RESOURCE_URI,
    mimeType: APP_RESOURCE_MIME_TYPE,
    entrypoint: "mcp-resource.html",
    inline: true,
    sha256: createHash("sha256").update(html, "utf8").digest("hex"),
    bytes: Buffer.byteLength(html, "utf8"),
    ...manifestOverrides,
  };
  writeFileSync(htmlPath, html, "utf8");
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  return { htmlPath, manifestPath };
}

describe("production MCP resource artifact", () => {
  it("loads the generated web bundle with exact manifest identity", () => {
    const artifact = loadMcpResourceArtifact({ htmlPath: DEFAULT_MCP_RESOURCE_HTML_PATH });
    expect(artifact.manifest).toMatchObject({
      resourceUri: AGENT_HIERARCHY_RESOURCE_URI,
      mimeType: APP_RESOURCE_MIME_TYPE,
      entrypoint: "mcp-resource.html",
      inline: true,
      bytes: Buffer.byteLength(artifact.html, "utf8"),
    });
    expect(artifact.resource).toMatchObject({
      resourceUri: AGENT_HIERARCHY_RESOURCE_URI,
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
    });
    expect(artifact.html).toContain('data-agent-farm-asset="inline"');
    expect(artifact.html).toContain('id="root"');
  });

  it.each([
    ["resourceUri", { resourceUri: "ui://other/view.html" }],
    ["mimeType", { mimeType: "text/html+skybridge" }],
    ["sha256", { sha256: "0".repeat(64) }],
    ["bytes", { bytes: 1 }],
  ])("rejects a manifest with a mismatched %s", (_field, override) => {
    const { htmlPath, manifestPath } = writeArtifact(validHtml(), override);
    expect(() => loadMcpResourceArtifact({ htmlPath, manifestPath })).toThrow(McpResourceArtifactError);
  });

  it("rejects external assets, bare imports, and the placeholder resource", () => {
    const cases = [
      validHtml().replace('<div id="root"></div>', '<div id="root"></div><script src="/assets/app.js"></script>'),
      validHtml().replace("globalThis.agentFarmInteractive = true;", 'import x from "some-package"; void x;'),
      validHtml().replace(
        '<div id="root"></div><script type="module" data-agent-farm-asset="inline">globalThis.agentFarmInteractive = true;</script>',
        '<main id="agent-farm-app" aria-live="polite">Agent Farm hierarchy</main>',
      ),
    ];
    for (const html of cases) {
      const { htmlPath, manifestPath } = writeArtifact(html);
      expect(() => loadMcpResourceArtifact({ htmlPath, manifestPath })).toThrow(McpResourceArtifactError);
    }
  });

  it("fails clearly when either artifact file is absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-farm-mcp-resource-missing-"));
    tempDirectories.push(directory);
    expect(() => loadMcpResourceArtifact({ htmlPath: join(directory, "missing.html") })).toThrow(
      /MCP resource artifact invalid: HTML artifact is missing or unreadable/,
    );
    const { htmlPath, manifestPath } = writeArtifact();
    rmSync(manifestPath);
    expect(() => loadMcpResourceArtifact({ htmlPath, manifestPath })).toThrow(
      /MCP resource artifact invalid: manifest artifact is missing or unreadable/,
    );
  });

  it("keeps the validator usable for explicitly injected test resources", () => {
    const html = validHtml();
    const manifest = {
      resourceUri: AGENT_HIERARCHY_RESOURCE_URI,
      mimeType: APP_RESOURCE_MIME_TYPE,
      entrypoint: "mcp-resource.html",
      inline: true,
      sha256: createHash("sha256").update(html, "utf8").digest("hex"),
      bytes: Buffer.byteLength(html, "utf8"),
    };
    expect(() => validateMcpResourceArtifact({ html, manifest })).not.toThrow();
  });
});
