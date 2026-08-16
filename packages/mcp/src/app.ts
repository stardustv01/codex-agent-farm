import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AGENT_FARM_SCOPES,
  AuthorizationError,
  type AgentFarmScope,
  authContextFromAuthInfo,
  type AuthContext,
  type AuthContextProvider,
  requireAuthContext,
  requireBoundSession,
  requireScope,
} from "./auth-context.js";
import {
  CreateAgentSessionInputSchema,
  CreateAgentSessionOutputSchema,
  DetailsOutputSchema,
  GetAgentDetailsInputSchema,
  GetAgentHierarchyInputSchema,
  HierarchyOutputSchema,
  InlineSummarySchema,
  MAX_AGENTS,
  MAX_INLINE_PREVIEW,
  RenderAgentHierarchyInputSchema,
  RenderOutputSchema,
  type AgentFarmMcpBackend,
  type ToolName,
  type UiResourceConfig,
  type CreateAgentSessionInput,
  type CreateAgentSessionOutput,
  type DetailsOutput,
  type HierarchyOutput,
  type RenderAgentHierarchyInput,
  type RenderOutput,
} from "./types.js";

export const AGENT_HIERARCHY_RESOURCE_URI = "ui://agent-farm/hierarchy.html";
export const APP_RESOURCE_MIME_TYPE = RESOURCE_MIME_TYPE;

type SdkExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ToolDescriptor {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly scope: AgentFarmScope;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
  readonly _meta: Record<string, unknown>;
}

export interface McpApplicationOptions {
  readonly backend: AgentFarmMcpBackend;
  readonly name?: string;
  readonly version?: string;
  readonly resource?: UiResourceConfig;
  readonly authContextProvider?: AuthContextProvider;
  readonly expectedResource?: string;
}

export interface McpToolResult {
  readonly [key: string]: unknown;
  readonly content: [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
}

export interface McpApplication {
  readonly server: McpServer;
  readonly resourceUri: string;
  readonly descriptors: readonly ToolDescriptor[];
  readonly invoke: (
    name: ToolName,
    argumentsValue: unknown,
    extra?: SdkExtra,
  ) => Promise<McpToolResult>;
}

const secureToolMeta = (scope: AgentFarmScope): Record<string, unknown> => ({
  securitySchemes: [{ type: "oauth2", scopes: [scope] }],
});

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function getToolDescriptors(resourceUri = AGENT_HIERARCHY_RESOURCE_URI): readonly ToolDescriptor[] {
  return [
    {
      name: "create_agent_session",
      title: "Create Agent Farm view session",
      description:
        "Create an authenticated Agent Farm visualization session. This does not create or control a Codex agent.",
      scope: AGENT_FARM_SCOPES.create,
      inputSchema: CreateAgentSessionInputSchema,
      outputSchema: CreateAgentSessionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: secureToolMeta(AGENT_FARM_SCOPES.create),
    },
    {
      name: "get_agent_hierarchy",
      title: "Get Agent Farm hierarchy",
      description: "Read a bounded, owner-scoped Agent Farm hierarchy projection.",
      scope: AGENT_FARM_SCOPES.read,
      inputSchema: GetAgentHierarchyInputSchema,
      outputSchema: HierarchyOutputSchema,
      annotations: readOnlyAnnotations,
      _meta: secureToolMeta(AGENT_FARM_SCOPES.read),
    },
    {
      name: "get_agent_details",
      title: "Get Agent Farm agent details",
      description: "Read bounded details and verified identity evidence for one Agent Farm node.",
      scope: AGENT_FARM_SCOPES.readDetails,
      inputSchema: GetAgentDetailsInputSchema,
      outputSchema: DetailsOutputSchema,
      annotations: readOnlyAnnotations,
      _meta: secureToolMeta(AGENT_FARM_SCOPES.readDetails),
    },
    {
      name: "render_agent_hierarchy",
      title: "Render Agent Farm hierarchy",
      description: "Render a bounded inline summary or navigable fullscreen Agent Farm tree.",
      scope: AGENT_FARM_SCOPES.render,
      inputSchema: RenderAgentHierarchyInputSchema,
      outputSchema: RenderOutputSchema,
      annotations: readOnlyAnnotations,
      _meta: {
        ...secureToolMeta(AGENT_FARM_SCOPES.render),
        ui: { resourceUri },
      },
    },
  ];
}

export function createMcpApplication(options: McpApplicationOptions): McpApplication {
  const resourceUri = options.resource?.resourceUri ?? AGENT_HIERARCHY_RESOURCE_URI;
  const server = new McpServer({
    name: options.name ?? "agent-farm",
    version: options.version ?? "0.1.0",
  });
  const descriptors = getToolDescriptors(resourceUri);
  const provider =
    options.authContextProvider ??
    ((extra?: { readonly authInfo?: SdkExtra["authInfo"] }): AuthContext => {
      const authOptions =
        options.expectedResource === undefined ? {} : { expectedResource: options.expectedResource };
      return authContextFromAuthInfo(extra?.authInfo, authOptions);
    });

  const resourceMeta = buildResourceMeta(options.resource, resourceUri);
  const html = options.resource?.html ?? DEFAULT_RESOURCE_HTML;
  registerAppResource(
    server,
    "agent-farm-hierarchy-ui",
    resourceUri,
    {
      title: "Agent Farm hierarchy UI",
      description: "Bounded Agent Farm hierarchy component; server data remains authoritative.",
      mimeType: APP_RESOURCE_MIME_TYPE,
      _meta: resourceMeta,
    },
    async (uri) => ({
      contents: [{ uri: uri.toString(), mimeType: APP_RESOURCE_MIME_TYPE, text: html }],
    }),
  );

  const idempotency = new Map<string, { payload: string; result: CreateAgentSessionOutput }>();
  const registered = new Set<ToolName>();

  for (const descriptor of descriptors) {
    registerAppTool(
      server,
      descriptor.name,
      {
        title: descriptor.title,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        outputSchema: descriptor.outputSchema,
        annotations: descriptor.annotations,
        _meta: descriptor._meta,
      },
      async (args, extra) => invokeTool(descriptor.name, args, extra),
    );
    registered.add(descriptor.name);
  }

  async function invokeTool(
    name: ToolName,
    argumentsValue: unknown,
    extra?: SdkExtra,
  ): Promise<McpToolResult> {
    if (!registered.has(name)) throw new Error("Unknown Agent Farm tool");
    const descriptor = descriptors.find((entry) => entry.name === name);
    if (descriptor === undefined) throw new Error("Unknown Agent Farm tool");
    const context = requireAuthContext(await provider(extra));
    requireScope(context, descriptor.scope);
    const output = await executeTool(
      name,
      descriptor.inputSchema.parse(argumentsValue),
      context,
      options.backend,
      idempotency,
    );
    const parsedOutput = descriptor.outputSchema.parse(output) as Record<string, unknown>;
    const meta =
      name === "render_agent_hierarchy"
        ? componentSafeRenderMeta(parsedOutput as RenderOutput, resourceUri)
        : undefined;
    return {
      content: [{ type: "text", text: summarizeForModel(name, parsedOutput) }],
      structuredContent: parsedOutput,
      ...(meta === undefined ? {} : { _meta: meta }),
    };
  }

  // The set of registrations is deliberately returned only through the four
  // frozen descriptors above; no mutation route is added to this application.
  return { server, resourceUri, descriptors, invoke: invokeTool };
}

async function executeTool(
  name: ToolName,
  input: unknown,
  context: AuthContext,
  backend: AgentFarmMcpBackend,
  idempotency: Map<string, { payload: string; result: CreateAgentSessionOutput }>,
): Promise<unknown> {
  switch (name) {
    case "create_agent_session": {
      const args = CreateAgentSessionInputSchema.parse(input);
      // One OAuth authorization grant represents one Agent Farm view session.
      // The authorization server reserves this opaque ID before token issue;
      // neither the model nor tool arguments may select a different session.
      const agentSessionId = requireBoundSession(context);
      const cacheKey = `${context.tenantId}:${context.ownerId}:${agentSessionId}:${args.idempotencyKey}`;
      const payload = JSON.stringify({ label: args.label ?? null });
      const previous = idempotency.get(cacheKey);
      if (previous !== undefined) {
        if (previous.payload !== payload) {
          throw new Error("Idempotency key was already used with a different request");
        }
        return previous.result;
      }
      const raw = await backend.createAgentSession({
        ownerId: context.ownerId,
        tenantId: context.tenantId,
        agentSessionId,
        idempotencyKey: args.idempotencyKey,
        ...(args.label === undefined ? {} : { label: args.label }),
      });
      const result = CreateAgentSessionOutputSchema.parse(normalizeSession(raw));
      if (result.agentSessionId !== agentSessionId) {
        throw new AuthorizationError("Agent Farm session is not authorized", {
          status: 403,
          code: "invalid_session",
        });
      }
      idempotency.set(cacheKey, { payload, result });
      if (idempotency.size > 1024) {
        const oldest = idempotency.keys().next().value;
        if (oldest !== undefined) idempotency.delete(oldest);
      }
      return result;
    }
    case "get_agent_hierarchy": {
      const args = GetAgentHierarchyInputSchema.parse(input);
      const agentSessionId = requireBoundSession(context, args.agentSessionId);
      const raw = await backend.getAgentHierarchy({
        ownerId: context.ownerId,
        tenantId: context.tenantId,
        agentSessionId,
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        limit: args.limit ?? MAX_AGENTS,
      });
      return normalizeHierarchy(raw, agentSessionId);
    }
    case "get_agent_details": {
      const args = GetAgentDetailsInputSchema.parse(input);
      const agentSessionId = requireBoundSession(context, args.agentSessionId);
      const raw = await backend.getAgentDetails({
        ownerId: context.ownerId,
        tenantId: context.tenantId,
        agentSessionId,
        agentId: args.agentId,
      });
      return normalizeDetails(raw, agentSessionId);
    }
    case "render_agent_hierarchy": {
      const args = RenderAgentHierarchyInputSchema.parse(input);
      const agentSessionId = requireBoundSession(context, args.agentSessionId);
      const raw = backend.renderAgentHierarchy
        ? await backend.renderAgentHierarchy({
            ownerId: context.ownerId,
            tenantId: context.tenantId,
            agentSessionId,
            ...(args.branchAgentId === undefined ? {} : { branchAgentId: args.branchAgentId }),
            mode: args.mode,
          })
        : await backend.getAgentHierarchy({
            ownerId: context.ownerId,
            tenantId: context.tenantId,
            agentSessionId,
            limit: MAX_AGENTS,
          });
      return normalizeRender(raw, agentSessionId, args.mode);
    }
  }
}

function buildResourceMeta(resource: UiResourceConfig | undefined, resourceUri: string): Record<string, unknown> {
  const connectDomains = [...(resource?.connectDomains ?? [])].slice(0, 8);
  const resourceDomains = [...(resource?.resourceDomains ?? [])].slice(0, 8);
  const frameDomains = [...(resource?.frameDomains ?? [])].slice(0, 8);
  return {
    ui: {
      resourceUri,
      csp: { connectDomains, resourceDomains, frameDomains },
    },
    "openai/widgetCSP": {
      connect_domains: connectDomains,
      resource_domains: resourceDomains,
      frame_domains: frameDomains,
      redirect_domains: [],
    },
  };
}

function componentSafeRenderMeta(output: RenderOutput, resourceUri: string): Record<string, unknown> {
  const summary = output.inlineSummary ?? {
    mode: "inline" as const,
    counts: output.counts,
    connection: output.connection,
    branchPreview: output.branchPreview.slice(0, MAX_INLINE_PREVIEW),
    canExpand: output.mode === "inline" || output.nodes.length > 0,
  };
  return {
    ui: {
      resourceUri,
      mode: output.mode,
      presentationMode: output.mode === "inline" ? "inline-summary" : "fullscreen-tree",
      supportsFullscreen: true,
      canExpand: summary.canExpand,
      summary: {
        counts: output.counts,
        connection: output.connection,
        branchPreview: summary.branchPreview,
      },
    },
  };
}

function summarizeForModel(name: ToolName, output: Record<string, unknown>): string {
  if (name === "render_agent_hierarchy") {
    const mode = typeof output.mode === "string" ? output.mode : "inline";
    return `Agent Farm ${mode} hierarchy is ready.`;
  }
  if (name === "create_agent_session") return "Agent Farm view session is ready.";
  if (name === "get_agent_details") return "Agent Farm agent details are ready.";
  return "Agent Farm hierarchy projection is ready.";
}

function normalizeSession(raw: unknown): CreateAgentSessionOutput {
  const record = asRecord(raw);
  const nested = asRecord(record.session);
  const source = Object.keys(nested).length > 0 ? nested : record;
  return {
    agentSessionId: readString(source, ["agentSessionId", "id", "sessionId"], "unknown-session"),
    status: mapSessionStatus(readString(source, ["status", "state"], "ready")),
    createdAt: readString(source, ["createdAt", "created_at"], new Date(0).toISOString()),
  };
}

function normalizeHierarchy(raw: unknown, sessionId: string): HierarchyOutput {
  const parsed = HierarchyOutputSchema.parse(raw);
  if (parsed.agentSessionId !== sessionId) {
    throw new AuthorizationError("Agent Farm session is not authorized", { status: 403, code: "invalid_session" });
  }
  return parsed;
}

function normalizeDetails(raw: unknown, sessionId: string): DetailsOutput {
  const parsed = DetailsOutputSchema.parse(raw);
  if (parsed.agentSessionId !== sessionId) {
    throw new AuthorizationError("Agent Farm session is not authorized", { status: 403, code: "invalid_session" });
  }
  return parsed;
}

function normalizeRender(
  raw: unknown,
  sessionId: string,
  mode: RenderAgentHierarchyInput["mode"],
): RenderOutput {
  const hierarchy = normalizeHierarchy(raw, sessionId);
  const branchPreview = hierarchy.nodes.slice(0, MAX_INLINE_PREVIEW);
  const inlineSummary = InlineSummarySchema.parse({
    mode: "inline",
    counts: hierarchy.counts,
    connection: hierarchy.connection,
    branchPreview,
    canExpand: mode === "inline" ? hierarchy.hasMore || hierarchy.nodes.length > branchPreview.length : true,
  });
  return RenderOutputSchema.parse({
    schemaVersion: hierarchy.schemaVersion,
    agentSessionId: sessionId,
    watermark: hierarchy.watermark,
    generatedAt: hierarchy.generatedAt,
    snapshotState: hierarchy.snapshotState,
    ...(hierarchy.partialReason === undefined ? {} : { partialReason: hierarchy.partialReason }),
    connection: hierarchy.connection,
    mode,
    rootAgentId: hierarchy.rootAgentId,
    counts: hierarchy.counts,
    inlineSummary: mode === "inline" ? inlineSummary : null,
    branchPreview,
    nodes: mode === "inline" ? [] : hierarchy.nodes,
    edges: mode === "inline" ? [] : hierarchy.edges,
    total: hierarchy.total,
    page: hierarchy.page,
    pageSize: hierarchy.pageSize,
    nextCursor: hierarchy.nextCursor,
    hasMore: hierarchy.hasMore,
    storyMilestones: hierarchy.storyMilestones,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(source: Record<string, unknown>, keys: readonly string[], fallback: string): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim().slice(0, 512);
  }
  return fallback;
}

function mapSessionStatus(value: string): CreateAgentSessionOutput["status"] {
  const normalized = value.toLowerCase();
  if (["created", "new"].includes(normalized)) return "created";
  if (["active", "running"].includes(normalized)) return "active";
  if (["ready", "connected"].includes(normalized)) return "ready";
  return "unknown";
}

const DEFAULT_RESOURCE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Farm</title></head>
<body><main id="agent-farm-app" aria-live="polite">Agent Farm hierarchy</main></body></html>`;
