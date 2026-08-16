export {
  AGENT_FARM_SCOPES,
  AuthorizationError,
  authContextFromAuthInfo,
  makeAuthContext,
  requireAuthContext,
  requireBoundSession,
  requireScope,
} from "./auth-context.js";
export type {
  AgentFarmScope,
  AuthContext,
  AuthContextInit,
  AuthContextProvider,
  AuthContextProviderInput,
} from "./auth-context.js";

export {
  AGENT_HIERARCHY_RESOURCE_URI,
  APP_RESOURCE_MIME_TYPE,
  createMcpApplication,
  getToolDescriptors,
} from "./app.js";
export type {
  McpApplication,
  McpApplicationOptions,
  McpToolResult,
  ToolDescriptor,
} from "./app.js";

export {
  buildWwwAuthenticateChallenge,
  challengeForAuthorizationError,
  createProtectedResourceMetadata,
  getProtectedResourceMetadata,
  buildAuthChallenge,
  protectedResourceMetadata,
  wwwAuthenticateChallenge,
} from "./security.js";
export type {
  ProtectedResourceMetadata,
  ProtectedResourceMetadataOptions,
  WwwAuthenticateChallengeOptions,
} from "./security.js";

export {
  AGENT_FARM_MCP_TOOL_NAMES,
  McpHttpSessionManager,
  createMcpHttpSessionManager,
  handleMcpHttpRequest,
} from "./http.js";
export type {
  AgentFarmMcpToolName,
  McpAuthInfo,
  McpHttpApplicationFactory,
  McpHttpHandlerOptions,
  McpHttpSessionManagerOptions,
  McpGrantSessionBindingKey,
  McpGrantSessionBindingRecord,
  McpGrantSessionBindingRequest,
  McpGrantSessionBindingStore,
  McpNodeRequest,
} from "./http.js";

export * from "./types.js";
