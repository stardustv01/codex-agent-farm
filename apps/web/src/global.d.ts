declare module '*.css';
declare module '*.css?raw' {
  const source: string;
  export default source;
}

type AgentFarmRuntimeConfig = import('./types').AgentFarmRuntimeConfig;

interface Window {
  /** Ephemeral runtime configuration injected by the standalone launcher. */
  __AGENT_FARM_CONFIG__?: AgentFarmRuntimeConfig;
}

interface ImportMeta {
  readonly env?: Record<string, unknown>;
}
