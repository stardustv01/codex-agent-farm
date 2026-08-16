import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_HIERARCHY_RESOURCE_URI,
  APP_RESOURCE_MIME_TYPE,
  type UiResourceConfig,
} from "@agent-farm/mcp";

/** The committed/generated artifact that production MCP must serve. */
export const DEFAULT_MCP_RESOURCE_HTML_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../web/dist/mcp-resource.html",
);
export const DEFAULT_MCP_RESOURCE_MANIFEST_PATH = resolve(
  dirname(DEFAULT_MCP_RESOURCE_HTML_PATH),
  "mcp-resource.json",
);

export interface McpResourceManifest {
  readonly resourceUri: string;
  readonly mimeType: string;
  readonly entrypoint: string;
  readonly inline: boolean;
  readonly sha256: string;
  readonly bytes: number;
}

export interface LoadedMcpResource {
  readonly html: string;
  readonly manifest: McpResourceManifest;
  readonly htmlPath: string;
  readonly manifestPath: string;
  readonly resource: UiResourceConfig;
}

export interface McpResourceLoadOptions {
  /** Override the artifact path in a test or an explicitly staged runtime. */
  readonly htmlPath?: string;
  /** Defaults to `mcp-resource.json` beside `htmlPath`. */
  readonly manifestPath?: string;
}

/** A stable error code lets startup diagnostics be asserted without path leaks. */
export class McpResourceArtifactError extends Error {
  readonly code = "MCP_RESOURCE_ARTIFACT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "McpResourceArtifactError";
  }
}

/**
 * Load and verify the production MCP Apps HTML artifact.
 *
 * This function intentionally does not synthesize HTML. A missing, stale, or
 * non-self-contained artifact is a startup error rather than a ready server.
 */
export function loadProductionMcpResource(options: McpResourceLoadOptions = {}): UiResourceConfig {
  return loadMcpResourceArtifact(options).resource;
}

/** Load the verified artifact and expose its evidence for diagnostics/tests. */
export function loadMcpResourceArtifact(options: McpResourceLoadOptions = {}): LoadedMcpResource {
  const htmlPath = resolve(options.htmlPath ?? DEFAULT_MCP_RESOURCE_HTML_PATH);
  const manifestPath = resolve(options.manifestPath ?? resolve(dirname(htmlPath), "mcp-resource.json"));

  const html = readRequiredFile(htmlPath, "HTML");
  const manifest = readManifest(manifestPath);
  validateMcpResourceArtifact({ html, manifest, htmlPath, manifestPath });

  return {
    html,
    manifest,
    htmlPath,
    manifestPath,
    resource: {
      resourceUri: AGENT_HIERARCHY_RESOURCE_URI,
      html,
      // The bundled app makes no network requests. Keep the policy explicit so
      // MCP hosts receive a deny-by-default resource CSP in resources/list.
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
    },
  };
}

export interface McpResourceArtifactInput {
  readonly html: string;
  readonly manifest: unknown;
  readonly htmlPath?: string;
  readonly manifestPath?: string;
}

/** Validate manifest identity and self-contained HTML invariants. */
export function validateMcpResourceArtifact(input: McpResourceArtifactInput): asserts input is McpResourceArtifactInput & {
  readonly manifest: McpResourceManifest;
} {
  const htmlPath = input.htmlPath ?? "mcp-resource.html";
  const manifestPath = input.manifestPath ?? "mcp-resource.json";
  const manifest = asManifest(input.manifest, manifestPath);
  const htmlBytes = Buffer.byteLength(input.html, "utf8");
  const digest = createHash("sha256").update(input.html, "utf8").digest("hex");

  if (manifest.resourceUri !== AGENT_HIERARCHY_RESOURCE_URI) {
    throw invalid(`manifest resourceUri must be ${AGENT_HIERARCHY_RESOURCE_URI}`);
  }
  if (manifest.mimeType !== APP_RESOURCE_MIME_TYPE) {
    throw invalid(`manifest mimeType must be ${APP_RESOURCE_MIME_TYPE}`);
  }
  if (manifest.entrypoint !== basename(htmlPath)) {
    throw invalid(`manifest entrypoint must match ${basename(htmlPath)}`);
  }
  if (manifest.inline !== true) {
    throw invalid("manifest inline must be true");
  }
  if (manifest.bytes !== htmlBytes) {
    throw invalid(`manifest byte length ${String(manifest.bytes)} does not match ${String(htmlBytes)}`);
  }
  if (manifest.sha256 !== digest) {
    throw invalid("manifest sha256 does not match the HTML artifact");
  }

  validateSelfContainedHtml(input.html);
}

function readRequiredFile(path: string, kind: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw invalid(`${kind} artifact is missing or unreadable`);
  }
}

function readManifest(path: string): McpResourceManifest {
  const contents = readRequiredFile(path, "manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw invalid("manifest is not valid JSON");
  }
  return asManifest(parsed, path);
}

function asManifest(value: unknown, _path: string): McpResourceManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("manifest must be an object");
  }
  const source = value as Record<string, unknown>;
  if (
    typeof source.resourceUri !== "string" ||
    typeof source.mimeType !== "string" ||
    typeof source.entrypoint !== "string" ||
    typeof source.inline !== "boolean" ||
    typeof source.sha256 !== "string" ||
    typeof source.bytes !== "number" ||
    !Number.isSafeInteger(source.bytes)
  ) {
    throw invalid("manifest is missing required resource identity fields");
  }
  if (!/^[a-f0-9]{64}$/u.test(source.sha256)) {
    throw invalid("manifest sha256 must be a lowercase SHA-256 digest");
  }
  return {
    resourceUri: source.resourceUri,
    mimeType: source.mimeType,
    entrypoint: source.entrypoint,
    inline: source.inline,
    sha256: source.sha256,
    bytes: source.bytes,
  };
}

function validateSelfContainedHtml(html: string): void {
  if (html.trim().length === 0 || !/<html\b[^>]*>/iu.test(html) || !/<body\b[^>]*>/iu.test(html)) {
    throw invalid("HTML artifact is not a document");
  }
  if (!/<meta\s+[^>]*name=["']agent-farm-resource["'][^>]*content=["']ui:\/\/agent-farm\/hierarchy\.html["'][^>]*>/iu.test(html)) {
    throw invalid("HTML artifact is missing the Agent Farm resource metadata marker");
  }
  if (!/<(?:div|main)\s+[^>]*id=["']root["'][^>]*>/iu.test(html)) {
    throw invalid("HTML artifact is missing the interactive root mount");
  }
  const inlineModule = /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bdata-agent-farm-asset=["']inline["'])[^>]*>([\s\S]*?)<\/script>/iu.exec(html);
  if (inlineModule === null || inlineModule[1]?.trim().length === 0) {
    throw invalid("HTML artifact is missing its inline module bundle");
  }

  // Any script/link reference would make the MCP resource depend on a second
  // fetch. Data URLs are deliberately rejected as well: the generated bundle
  // is expected to contain ordinary inline CSS/JS, not hidden external input.
  const references = /<(?:script|link|img|iframe|frame|source|audio|video|object|embed)\b[^>]*\b(?:src|href|data)\s*=\s*(["'])(.*?)\1[^>]*>/giu;
  for (const match of html.matchAll(references)) {
    const value = match[2]?.trim() ?? "";
    if (value.length > 0 && value !== "#") {
      throw invalid(`HTML artifact contains an external asset reference: ${value.slice(0, 128)}`);
    }
  }
  if (/<link\b[^>]*>/iu.test(html)) {
    throw invalid("HTML artifact contains an un-inlined link element");
  }
  if (/<script\b[^>]*\bsrc\s*=/iu.test(html)) {
    throw invalid("HTML artifact contains an external script reference");
  }
  if (/@import\s+(?:url\s*\()?[^;\n]+/iu.test(html)) {
    throw invalid("HTML artifact contains an external CSS import");
  }

  const inlineScript = inlineModule[1] ?? "";
  if (/(?:^|[;\n])\s*import\s+(?:(?:[^;\n]*?)\s+from\s+)?["'](?![./#]|data:)[^"']+["']/mu.test(inlineScript)) {
    throw invalid("HTML artifact contains a bare module import");
  }
  if (/\bfrom\s*["'](?![./#]|data:)[^"']+["']/mu.test(inlineScript)) {
    throw invalid("HTML artifact contains a bare module import");
  }

  // This is the old source fallback from packages/mcp. It renders no app and
  // must never silently become a production resource.
  if (/id=["']agent-farm-app["'][^>]*>\s*Agent Farm hierarchy\s*<\/main>/iu.test(html)) {
    throw invalid("HTML artifact is the placeholder resource");
  }
}

function invalid(reason: string): McpResourceArtifactError {
  return new McpResourceArtifactError(`MCP resource artifact invalid: ${reason}`);
}
