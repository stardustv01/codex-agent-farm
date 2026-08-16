import type { AuthorizationError } from "./auth-context.js";

export interface ProtectedResourceMetadataOptions {
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly scopesSupported?: readonly string[];
  readonly resourceName?: string;
  readonly resourceDocumentation?: string;
}

/** RFC 9728 protected-resource metadata for the MCP HTTP endpoint. */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly bearer_methods_supported: readonly ["header"];
  readonly resource_name?: string;
  readonly resource_documentation?: string;
}

export function createProtectedResourceMetadata(
  options: ProtectedResourceMetadataOptions,
): ProtectedResourceMetadata {
  const resource = requireAbsoluteUrl(options.resource, "resource");
  const authorizationServers = uniqueUrls(options.authorizationServers, "authorization server");
  const scopes = uniqueBoundedStrings(options.scopesSupported ?? [], "scope");

  return {
    resource,
    authorization_servers: authorizationServers,
    scopes_supported: scopes,
    bearer_methods_supported: ["header"],
    ...(options.resourceName === undefined
      ? {}
      : { resource_name: bounded(options.resourceName, "resource name") }),
    ...(options.resourceDocumentation === undefined
      ? {}
      : {
          resource_documentation: requireAbsoluteUrl(
            options.resourceDocumentation,
            "resource documentation",
          ),
        }),
  };
}

export interface WwwAuthenticateChallengeOptions {
  readonly authorizationServer?: string;
  readonly resource?: string;
  readonly requiredScopes?: readonly string[];
  readonly error?: "invalid_token" | "insufficient_scope";
  readonly errorDescription?: string;
  readonly realm?: string;
}

/**
 * Builds a standards-compliant bearer challenge. Values are quoted and
 * validated so claims or tool arguments cannot inject response headers.
 */
export function buildWwwAuthenticateChallenge(
  options: WwwAuthenticateChallengeOptions = {},
): string {
  const params: string[] = [];
  if (options.realm !== undefined) params.push(`realm="${quote(options.realm, "realm")}"`);
  if (options.authorizationServer !== undefined) {
    params.push(`authorization_uri="${requireAbsoluteUrl(options.authorizationServer, "authorization server")}"`);
  }
  if (options.resource !== undefined) {
    params.push(`resource="${requireAbsoluteUrl(options.resource, "resource")}"`);
  }
  if (options.error !== undefined) params.push(`error="${options.error}"`);
  if (options.errorDescription !== undefined) {
    params.push(`error_description="${quote(options.errorDescription, "error description")}"`);
  }
  if (options.requiredScopes !== undefined && options.requiredScopes.length > 0) {
    params.push(`scope="${options.requiredScopes.map((scope) => bounded(scope, "scope")).join(" ")}"`);
  }
  return params.length === 0 ? "Bearer" : `Bearer ${params.join(", ")}`;
}

/** Challenge helper suitable for an HTTP error handler. */
export function challengeForAuthorizationError(
  error: AuthorizationError,
  options: Omit<WwwAuthenticateChallengeOptions, "requiredScopes" | "error"> = {},
): string {
  return buildWwwAuthenticateChallenge({
    ...options,
    requiredScopes: error.requiredScopes,
    error: error.code === "insufficient_scope" ? "insufficient_scope" : "invalid_token",
    errorDescription: error.message,
  });
}

// Names kept intentionally descriptive for consumers that expose HTTP helpers.
export const protectedResourceMetadata = createProtectedResourceMetadata;
export const wwwAuthenticateChallenge = buildWwwAuthenticateChallenge;
export const getProtectedResourceMetadata = createProtectedResourceMetadata;
export const buildAuthChallenge = buildWwwAuthenticateChallenge;

function uniqueUrls(values: readonly string[], label: string): readonly string[] {
  return [...new Set(values.map((value) => requireAbsoluteUrl(value, label)))].slice(0, 8);
}

function uniqueBoundedStrings(values: readonly string[], label: string): readonly string[] {
  return [...new Set(values.map((value) => bounded(value, label)))].slice(0, 64);
}

function requireAbsoluteUrl(value: string, label: string): string {
  const boundedValue = bounded(value, label);
  let parsed: URL;
  try {
    parsed = new URL(boundedValue);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError(`${label} must use HTTP(S)`);
  }
  return parsed.toString();
}

function bounded(value: string, label: string): string {
  if (value.length === 0 || value.length > 2048 || /[\r\n]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function quote(value: string, label: string): string {
  return bounded(value, label).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
