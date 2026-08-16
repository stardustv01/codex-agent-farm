import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_HIERARCHY_RESOURCE_URI,
  APP_RESOURCE_MIME_TYPE,
} from "@agent-farm/mcp";

import { createProductionComposition } from "../src/composition.js";
import type { RawTokenClaims } from "../src/contracts.js";

const compositions: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (compositions.length > 0) await compositions.pop()?.close();
});

const claims: RawTokenClaims = {
  sub: "resource-test-owner",
  ownerId: "resource-test-owner",
  tenantId: "resource-test-tenant",
  scope: "agent-session:create agent-session:read agent-session:read-details agent-session:render",
  exp: Math.floor(Date.now() / 1_000) + 3_600,
  aud: "agent-farm",
  resource: "https://agent-farm.local",
  jti: "resource-test-token",
  sid: "resource-test-grant",
};

async function postMcp(
  composition: ReturnType<typeof createProductionComposition>,
  id: number,
  body: unknown,
  mcpSessionId?: string,
) {
  return composition.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: "Bearer mcp-resource-test",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(mcpSessionId === undefined ? {} : { "mcp-session-id": mcpSessionId }),
    },
    payload: { jsonrpc: "2.0", id, ...(body as Record<string, unknown>) },
  });
}

describe("official MCP resource registration", () => {
  it("serves an interactive self-contained bundle from resources/read with CSP metadata", async () => {
    const composition = createProductionComposition({
      server: {
        auth: {
          audience: "agent-farm",
          resource: "https://agent-farm.local",
          verifyToken: () => claims,
        },
      },
    });
    compositions.push(composition);

    const initialized = await postMcp(composition, 1, {
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "resource-test", version: "1.0.0" },
      },
    });
    expect(initialized.statusCode).toBe(200);
    const mcpSessionId = initialized.headers["mcp-session-id"];
    expect(mcpSessionId).toEqual(expect.any(String));

    const listedResponse = await postMcp(
      composition,
      2,
      { method: "resources/list", params: {} },
      mcpSessionId,
    );
    expect(listedResponse.statusCode).toBe(200);
    const listed = listedResponse.json().result.resources.find(
      (resource: { uri: string }) => resource.uri === AGENT_HIERARCHY_RESOURCE_URI,
    );
    expect(listed).toMatchObject({
      uri: AGENT_HIERARCHY_RESOURCE_URI,
      mimeType: APP_RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          resourceUri: AGENT_HIERARCHY_RESOURCE_URI,
          csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
        },
        "openai/widgetCSP": {
          connect_domains: [],
          resource_domains: [],
          frame_domains: [],
          redirect_domains: [],
        },
      },
    });

    const readResponse = await postMcp(composition, 3, {
      method: "resources/read",
      params: { uri: AGENT_HIERARCHY_RESOURCE_URI },
    }, mcpSessionId);
    expect(readResponse.statusCode).toBe(200);
    const contents = readResponse.json().result.contents;
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({ uri: AGENT_HIERARCHY_RESOURCE_URI, mimeType: APP_RESOURCE_MIME_TYPE });
    const html = contents[0].text as string;
    expect(html).toContain('data-agent-farm-asset="inline"');
    expect(html).toContain('id="root"');
    expect(html).toContain(`name="agent-farm-resource" content="${AGENT_HIERARCHY_RESOURCE_URI}"`);
    expect(html).not.toMatch(/<(?:script|link)\b[^>]*(?:src|href)\s*=/iu);
    expect(html).not.toMatch(/\bfrom\s*["'][^./#"'][^"']*["']/iu);
    expect(html).not.toContain("Agent Farm hierarchy</main>");
  });
});
