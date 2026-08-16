import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AgentFarmApp from './App';
import {
  connectMcpAppsHost,
  createStandaloneRuntime,
  emptyAgentFarmSnapshot,
  isMcpAppsHostEnvironment,
} from './mcp-host';
import type { AgentFarmRuntimeConfig, HostAdapter } from './types';
import {
  provisionLocalStandaloneSession,
  provisionStandaloneSession,
  safeRuntimeConfig,
  type StandaloneBootstrapResult,
} from './standalone-bootstrap';

function isLoopbackBrowserOrigin(): boolean {
  const hostname = window.location.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

const root = document.getElementById('root');
if (root) {
  const isG6Fixture = import.meta.env?.DEV === true && new URLSearchParams(window.location.search).get('fixture') === 'g6';
  const isG7ProductionFixture = import.meta.env?.DEV === true && new URLSearchParams(window.location.search).get('fixture') === 'g7-production';
  if (isG7ProductionFixture) {
    // This is a browser-review harness for the real production public-v1
    // renderer, never a production/demo activation path.
    void import('./g7-production-fixture').then(({ default: G7ProductionFixture }) => {
      createRoot(root).render(<StrictMode><G7ProductionFixture /></StrictMode>);
    });
  } else if (isG6Fixture) {
    // Keep the visual-spec fixture and its CSS out of the production entry
    // graph. Vite replaces DEV with false for production and eliminates this
    // dynamic branch.
    void import('./g6-fixture').then(({ default: G6VisualFixture }) => {
      createRoot(root).render(<StrictMode><G6VisualFixture /></StrictMode>);
    });
  } else {
  const render = (adapter: HostAdapter, snapshot: ReturnType<typeof emptyAgentFarmSnapshot>, mode: 'inline' | 'fullscreen' | 'standalone', runtimeConfig?: AgentFarmRuntimeConfig, managedAdapter = false): void => {
    const configProp = runtimeConfig === undefined ? {} : { runtimeConfig };
    // The production runtime consumes one-time local selection capabilities.
    // React StrictMode deliberately remounts effects and can race or replay
    // those capabilities, so keep StrictMode on deterministic fixtures only.
    createRoot(root).render(<AgentFarmApp adapter={adapter} snapshot={snapshot} mode={mode} managedAdapter={managedAdapter} {...configProp} />);
  };

  const bootstrap = async (): Promise<void> => {
    if (isMcpAppsHostEnvironment()) {
      try {
        const host = await connectMcpAppsHost();
        render(host, emptyAgentFarmSnapshot('mcp'), host.mode);
        return;
      } catch {
        // An iframe without an MCP host must remain usable as a standalone
        // view; the app starts unverified rather than showing demo data.
      }
    }
    const configured = safeRuntimeConfig(window.__AGENT_FARM_CONFIG__ ?? {});
    const loopbackOrigin = isLoopbackBrowserOrigin();
    let resolved: StandaloneBootstrapResult;

    // Probe the loopback server before OAuth. A local server is a separate
    // trust boundary: it must never be sent through /auth/session or
    // redirected to /auth/login, even when session creation later fails.
    try {
      resolved = await provisionLocalStandaloneSession({
        config: configured,
        origin: window.location.origin,
        returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}`,
        fetchImpl: fetch,
      });
    } catch {
      resolved = { config: configured, unavailable: true };
    }

    if (loopbackOrigin && resolved.config.localMode !== true) {
      // A loopback browser is local-only even when the status route is down.
      // Prevent an injected remote API origin from becoming a fallback read.
      resolved = { ...resolved, config: { ...resolved.config, localMode: true } };
    }

    // A loopback browser origin is local-only even when the injected config or
    // status response is unavailable. Keep it unverified instead of invoking
    // the OAuth redirect path.
    if (resolved.config.localMode !== true && !loopbackOrigin) {
      try {
        resolved = await provisionStandaloneSession({
          config: configured,
          origin: window.location.origin,
          returnTo: window.location.pathname,
        });
      } catch {
        // Static/dev deployments without either bootstrap route remain visibly
        // unverified instead of receiving a synthetic session.
        resolved = { config: configured, unavailable: true };
      }
    }
    if ('loginUrl' in resolved && typeof resolved.loginUrl === 'string' && resolved.config.localMode !== true && !loopbackOrigin) {
      window.location.assign(resolved.loginUrl);
      return;
    }
    const standalone = createStandaloneRuntime(resolved.config);
    render(standalone.adapter, standalone.snapshot, 'standalone', standalone.config, true);
  };

    void bootstrap();
  }
}
