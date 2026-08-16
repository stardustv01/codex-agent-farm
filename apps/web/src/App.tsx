import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { StandaloneAdapter } from './adapters';
import { createStandaloneRuntime, emptyAgentFarmSnapshot } from './mcp-host';
import { getChildren } from './normalize';
import { createInitialState, agentFarmReducer } from './reducer';
import { provisionLocalPairing, provisionLocalPairingSwitch, refreshLocalFocusState, refreshLocalRuntimeConfig } from './standalone-bootstrap';
import ProductionHierarchy from './production-hierarchy';
import type {
  AgentFarmState,
  AgentFarmRuntimeConfig,
  AgentHierarchyInput,
  AgentHierarchySnapshot,
  AgentStatus,
  ConnectionState,
  Density,
  HostAdapter,
  PresentationMode,
} from './types';
import './styles.css';

export interface AgentFarmAppProps {
  adapter?: HostAdapter;
  snapshot?: AgentHierarchyInput | AgentHierarchySnapshot;
  mode?: PresentationMode;
  density?: Density;
  onExpand?: () => void;
  title?: string;
  className?: string;
  runtimeConfig?: AgentFarmRuntimeConfig;
  /** Launcher-owned standalone adapters may be replaced after local pairing. */
  managedAdapter?: boolean;
}

const statusLabel: Record<AgentStatus, string> = {
  queued: 'Active', running: 'Active', waiting: 'Waiting', completed: 'Complete',
  failed: 'Blocked', cancelled: 'Blocked', disconnected: 'Blocked',
  unverified: 'Status unavailable', unknown: 'Status unavailable',
};

const connectionLabel: Record<ConnectionState, string> = {
  connected: 'Live', reconnecting: 'Reconnecting', stale: 'Stale',
  disconnected: 'Disconnected', error: 'Connection error', unverified: 'Status unavailable',
};

// React Strict Mode may fully remount the app while a one-time local selection
// request is in flight. Keep that request at page-module scope so both mounts
// observe one server consumption and the surviving mount receives the result.
const localAutoMountRequests = new Map<string, ReturnType<typeof provisionLocalPairing>>();
const localFocusRequests = new Map<string, ReturnType<typeof provisionLocalPairing>>();

function statusCounts(snapshot: AgentHierarchySnapshot): Record<'active' | 'waiting' | 'complete' | 'blocked', number> {
  const result = { active: 0, waiting: 0, complete: 0, blocked: 0 };
  for (const node of Object.values(snapshot.agents)) {
    if (node.status === 'queued' || node.status === 'running') result.active += 1;
    else if (node.status === 'waiting') result.waiting += 1;
    else if (node.status === 'completed') result.complete += 1;
    else result.blocked += 1;
  }
  return result;
}

function InlineSummary({ state, onExpand, title }: { state: AgentFarmState; onExpand: () => void; title: string }): ReactNode {
  const root = state.snapshot.rootAgentId ? state.snapshot.agents[state.snapshot.rootAgentId] : undefined;
  const children = root ? getChildren(state.snapshot, root.id).slice(0, 3) : [];
  const counts = statusCounts(state.snapshot);
  const viewer = state.snapshot.connection.state === 'connected' ? 'Live' : connectionLabel[state.snapshot.connection.state];
  return <section className="af-inline" aria-label="Agent Farm summary">
    <header className="af-topbar"><div className="af-heading"><h1>{title}</h1><p>{state.snapshot.sessionId}</p></div><span className={`af-inline-viewer af-inline-viewer-${state.snapshot.connection.state}`} role="status">{viewer}</span></header>
    <main className="af-inline-body"><span className="af-eyebrow">Hierarchy</span><h2>{root?.name ?? 'No active Codex task'}</h2><div className="af-inline-counts"><span><strong>{counts.active}</strong> Active</span><span><strong>{counts.waiting}</strong> Waiting</span><span><strong>{counts.complete}</strong> Complete</span><span><strong>{counts.blocked}</strong> Blocked</span></div>{children.map((child) => <div className="af-inline-branch" key={child.id}><strong>{child.name}</strong><span>{statusLabel[child.status]}</span></div>)}<button className="af-primary af-expand-button" type="button" onClick={onExpand}>Open hierarchy <span aria-hidden="true">↗</span></button></main>
  </section>;
}

export function AgentFarmApp({ adapter, snapshot, mode, density, onExpand, title = 'Agent Farm', className = '', runtimeConfig, managedAdapter = false }: AgentFarmAppProps): ReactNode {
  const fallbackSnapshot = useMemo(() => emptyAgentFarmSnapshot('standalone'), []);
  const baseHost: HostAdapter = useMemo(() => adapter ?? new StandaloneAdapter({ snapshot: snapshot ?? fallbackSnapshot, mode: mode ?? 'standalone' }), [adapter, snapshot, mode, fallbackSnapshot]);
  const [hostOverride, setHostOverride] = useState<HostAdapter | undefined>();
  const host: HostAdapter = hostOverride ?? baseHost;
  const initial = useMemo(() => createInitialState(snapshot ?? fallbackSnapshot, mode ?? baseHost.mode ?? 'standalone'), [snapshot, fallbackSnapshot, mode, baseHost.mode]);
  const [state, dispatch] = useReducer(agentFarmReducer, initial);
  const [localConfig, setLocalConfig] = useState<AgentFarmRuntimeConfig | undefined>(runtimeConfig);
  const [userSwitching, setUserSwitching] = useState(false);
  const observedFocusVersionRef = useRef<number | undefined>(undefined);
  const userSelectionEpochRef = useRef(0);
  const detailAbortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => { setLocalConfig(runtimeConfig); }, [runtimeConfig]);
  useEffect(() => {
    // A caller-provided adapter owns its lifecycle. Only a pairing-created
    // replacement is scoped to this component and should be dropped when the
    // base host changes.
    setHostOverride(undefined);
  }, [baseHost]);
  const applyLocalConfig = useCallback((nextConfig: AgentFarmRuntimeConfig): void => {
    const previousSession = localConfig?.agentSessionId;
    setLocalConfig(nextConfig);
    if ((adapter === undefined || managedAdapter) && nextConfig.localMode === true && nextConfig.paired === true && (nextConfig.agentSessionId !== previousSession || hostOverride === undefined)) {
      // Pairing changes the server-issued session route. Rebuild the local
      // adapter so its fetch/revision/detail closures use that new session;
      // refreshing the old empty adapter cannot mount the selected task.
      const runtime = createStandaloneRuntime(nextConfig);
      // Never present the previous task's agents below the newly selected chat
      // title while its first authoritative snapshot is loading.
      dispatch({ type: 'snapshot.received', snapshot: runtime.snapshot });
      setHostOverride(runtime.adapter);
    }
  }, [adapter, hostOverride, localConfig?.agentSessionId, managedAdapter]);
  const applyUserLocalConfig = useCallback((nextConfig: AgentFarmRuntimeConfig, options?: { readonly selectionStarted?: boolean }): void => {
    userSelectionEpochRef.current += 1;
    if (typeof nextConfig.focusVersion === 'number') {
      observedFocusVersionRef.current = Math.max(observedFocusVersionRef.current ?? 0, nextConfig.focusVersion);
    }
    // Record user intent before the network switch begins. Otherwise an
    // already-running focus poll can finish during a slow switch and move the
    // server pointer back to the launcher chat even though the clicked task
    // is rendered in the browser.
    if (options?.selectionStarted === true) {
      detailAbortRef.current?.abort();
      detailAbortRef.current = undefined;
      setUserSwitching(true);
      return;
    }
    setUserSwitching(false);
    applyLocalConfig(nextConfig);
  }, [applyLocalConfig]);
  useEffect(() => {
    if (host.kind !== 'standalone' || localConfig?.localMode !== true || localConfig.paired !== false) return;
    const roots = localConfig.candidateRoots ?? [];
    const launchTargets = roots.filter((root) => root.launchTarget === true);
    const selectedRoot = launchTargets.length === 1 ? launchTargets[0] : roots.length === 1 ? roots[0] : undefined;
    if (!selectedRoot || Object.keys(state.snapshot.agents).length > 0) return;
    const selectionHandle = selectedRoot.selectionHandle;
    if (!selectionHandle) return;
    const requestKey = `${localConfig.agentSessionId ?? 'unavailable'}:${selectionHandle}`;
    const existingRequest = localAutoMountRequests.get(requestKey);
    const request = existingRequest ?? provisionLocalPairing({ config: localConfig, origin: window.location.origin, fetchImpl: fetch }, selectionHandle).catch(async (error: unknown) => {
      if (!(error instanceof Error) || !/HTTP 403|unavailable for this browser session/u.test(error.message)) throw error;
      const refreshed = await refreshLocalRuntimeConfig({ config: localConfig, origin: window.location.origin, fetchImpl: fetch });
      const refreshedTargets = (refreshed.candidateRoots ?? []).filter((candidate) => candidate.launchTarget === true);
      if (refreshedTargets.length !== 1 || !refreshedTargets[0]?.selectionHandle) throw error;
      return provisionLocalPairing({ config: refreshed, origin: window.location.origin, fetchImpl: fetch }, refreshedTargets[0].selectionHandle);
    });
    if (!existingRequest) {
      if (localAutoMountRequests.size >= 32) localAutoMountRequests.clear();
      localAutoMountRequests.set(requestKey, request);
    }
    void request
      .then(async (result) => {
        // The server has consumed a one-time trusted selection handle and
        // returned its authoritative mounted session. Apply that result even
        // if Strict Mode ran its diagnostic effect cleanup in the meantime;
        // React safely ignores this setter after a genuine unmount.
        applyLocalConfig(result.config);
        if (adapter !== undefined && !managedAdapter) dispatch({ type: 'snapshot.received', snapshot: await host.getSnapshot() });
      })
      .catch(() => undefined);
    // Strict Mode reuses the same one-time request after its intentional
    // cleanup/remount cycle, including when the request settles between those
    // two effects. Keep the result until pairing changes localConfig; clearing
    // it on settlement would strand a successfully consumed opaque handle.
    return undefined;
  }, [adapter, applyLocalConfig, host, localConfig, managedAdapter, state.snapshot.agents]);
  useEffect(() => {
    // A manual selection owns the viewed-chat pointer until its binding
    // request settles. Starting a launcher-focus poll during that window can
    // switch the browser back to the launcher chat while the newly selected
    // chat is still performing its first reconciliation.
    if (userSwitching || host.kind !== 'standalone' || localConfig?.localMode !== true || localConfig.focusVersion === undefined) return;
    let alive = true;
    let polling = false;
    if (observedFocusVersionRef.current === undefined) {
      observedFocusVersionRef.current = Date.parse(localConfig.focusChangedAt ?? '') > Date.now() - 10_000
        ? Math.max(0, (localConfig.focusVersion ?? 0) - 1)
        : (localConfig.focusVersion ?? 0);
    }
    const pollFocus = async (): Promise<void> => {
      if (!alive || polling) return;
      polling = true;
      const userSelectionEpoch = userSelectionEpochRef.current;
      try {
        const focus = await refreshLocalFocusState({ config: localConfig, origin: window.location.origin, fetchImpl: fetch });
        if (!alive || userSelectionEpoch !== userSelectionEpochRef.current) return;
        // A failed background first-sync rolls the server pointer back to the
        // prior verified session. Detect that lightweight signal and refresh
        // the full safe config once, instead of leaving this tab on a 404.
        if (localConfig.syncing === true && focus.agentSessionId !== undefined && focus.agentSessionId !== localConfig.agentSessionId) {
          const restored = await refreshLocalRuntimeConfig({ config: localConfig, origin: window.location.origin, fetchImpl: fetch });
          if (!alive || userSelectionEpoch !== userSelectionEpochRef.current || restored.agentSessionId !== focus.agentSessionId) return;
          applyLocalConfig({ ...restored, syncing: false });
          return;
        }
        const observedVersion = observedFocusVersionRef.current ?? 0;
        if (!alive || focus.focusVersion <= observedVersion) return;
        const refreshed = await refreshLocalRuntimeConfig({ config: localConfig, origin: window.location.origin, fetchImpl: fetch });
        if (!alive || userSelectionEpoch !== userSelectionEpochRef.current) return;
        const focusVersion = refreshed.focusVersion ?? 0;
        if (!alive || focusVersion <= (observedFocusVersionRef.current ?? 0)) return;
        const targets = (refreshed.candidateRoots ?? []).filter((candidate) => candidate.launchTarget === true);
        if (targets.length !== 1 || !targets[0]) return;
        const target = targets[0];
        if (target.active === true) {
          observedFocusVersionRef.current = focusVersion;
          applyLocalConfig(refreshed);
          return;
        }
        const requestKey = `${focusVersion}:${target.chatHandle ?? target.selectionHandle}`;
        const existing = localFocusRequests.get(requestKey);
        const provision = refreshed.paired === true ? provisionLocalPairingSwitch : provisionLocalPairing;
        const request = existing ?? provision({ config: refreshed, origin: window.location.origin, fetchImpl: fetch }, target.selectionHandle).catch((error: unknown) => {
          localFocusRequests.delete(requestKey);
          throw error;
        });
        if (!existing) {
          if (localFocusRequests.size >= 32) localFocusRequests.clear();
          localFocusRequests.set(requestKey, request);
        }
        const result = await request;
        if (!alive || userSelectionEpoch !== userSelectionEpochRef.current) return;
        observedFocusVersionRef.current = focusVersion;
        applyLocalConfig(result.config);
      } catch {
        // A missing/ambiguous root or a transient runtime gate must remain
        // fail-closed. The next bounded poll may retry the same focus version.
      } finally {
        polling = false;
      }
    };
    void pollFocus();
    const interval = window.setInterval(() => void pollFocus(), 2_000);
    return () => { alive = false; window.clearInterval(interval); };
  }, [applyLocalConfig, host.kind, localConfig, userSwitching]);
  useEffect(() => {
    let alive = true;
    const abort = new AbortController();
    dispatch({ type: 'loading.changed', loading: true });
    void host.getSnapshot(abort.signal).then((next) => { if (alive) dispatch({ type: 'snapshot.received', snapshot: next }); }).catch((error: unknown) => { if (alive && !(error instanceof DOMException && error.name === 'AbortError')) dispatch({ type: 'error.changed', error: error instanceof Error ? error.message : 'Unable to load hierarchy' }); }).finally(() => { if (alive) dispatch({ type: 'loading.changed', loading: false }); });
    const unsubscribe = host.subscribe((event) => { if (alive) dispatch({ type: 'event.received', event }); });
    return () => { alive = false; abort.abort(); unsubscribe(); host.dispose?.(); };
  }, [host]);
  useEffect(() => { if (snapshot !== undefined) dispatch({ type: 'snapshot.received', snapshot }); }, [snapshot]);
  useEffect(() => { if (density && density !== state.density) dispatch({ type: 'density.changed', density }); }, [density, state.density]);
  useEffect(() => {
    if (userSwitching) return;
    if (!host.getLocalAgentDetail) return;
    const orderedIds = [
      state.selectedId,
      state.snapshot.rootAgentId,
      ...Object.keys(state.snapshot.agents),
    ].filter((id, index, values): id is string => Boolean(id) && values.indexOf(id) === index).slice(0, 32);
    const missingIds = orderedIds.filter((id) => state.localDetails[id] === undefined);
    if (missingIds.length === 0) return;
    let alive = true;
    let cursor = 0;
    const abort = new AbortController();
    detailAbortRef.current = abort;
    const loadNext = async (): Promise<void> => {
      while (alive && cursor < missingIds.length) {
        const id = missingIds[cursor++];
        if (!id) continue;
        try {
          const detail = await host.getLocalAgentDetail!(id, abort.signal);
          if (alive) dispatch({ type: 'local-detail.received', id, detail: detail ?? null });
        } catch (error: unknown) {
          if (alive && !(error instanceof DOMException && error.name === 'AbortError')) {
            dispatch({ type: 'local-detail.received', id, detail: null });
          }
        }
      }
    };
    // Keep one prioritized detail stream (selected agent, then root, then the
    // remaining hierarchy). Multiple concurrent detail reads can occupy every
    // browser connection on large tasks and strand a higher-priority chat
    // switch behind them for tens of seconds.
    void loadNext();
    return () => { alive = false; abort.abort(); if (detailAbortRef.current === abort) detailAbortRef.current = undefined; };
  }, [host, state.selectedId, state.snapshot, userSwitching]);
  const expand = useCallback(() => {
    const result = host.requestFullscreen?.();
    if (result instanceof Promise) void result.then((accepted) => { if (accepted) dispatch({ type: 'mode.changed', mode: 'fullscreen' }); });
    else if (result !== false || host.kind === 'standalone') dispatch({ type: 'mode.changed', mode: 'fullscreen' });
    onExpand?.();
  }, [host, onExpand]);
  if (state.mode === 'inline') return <div className={`af-root ${className}`}><InlineSummary state={state} onExpand={expand} title={title} /></div>;
  return <div className={`af-root ${className}`}><ProductionHierarchy state={state} dispatch={dispatch} title={localConfig?.activeTask?.displayName ?? title} onExpand={state.mode === 'fullscreen' ? undefined : expand} runtimeConfig={localConfig} onConfig={applyUserLocalConfig} /></div>;
}

export default AgentFarmApp;
