import { isSafeLocalDisplayName, isSafeSelectionHandle, normalizeCandidateRoots, normalizeOrchestrationBudget } from './normalize';
import type { AgentFarmRuntimeConfig } from './types';

const SESSION_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{16,512}$/u;
const TOKEN_FIELD = /^(?:access|id|refresh|auth|bearer|session|cookie|credential|secret|csrf|code|nonce|password|jwt|token|api)(?:token|id|key|secret|code)?$/u;
const TOKEN_VALUE = /^(?:bearer\s+|[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?$)/iu;

export function isSafeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

function isLoopbackOrigin(origin: URL): boolean {
  const hostname = origin.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export function safeRuntimeConfig(config: AgentFarmRuntimeConfig): AgentFarmRuntimeConfig {
  const input = { ...(config as AgentFarmRuntimeConfig & Record<string, unknown>) };
  // Older launchers may still inject the private installation binding field;
  // never carry it into the browser runtime contract.
  delete input.installationId;
  const {
    agentSessionId,
    paired,
    syncing: rawSyncing,
    activeTask: rawActiveTask,
    localMode,
    demo,
    csrfToken,
    apiBaseUrl,
    snapshotPath,
    candidateRoots: rawCandidateRoots,
    orchestrationBudget: rawOrchestrationBudget,
    discoveryError: rawDiscoveryError,
    focusVersion: rawFocusVersion,
    focusChangedAt: rawFocusChangedAt,
    ...rest
  } = input;
  const candidateRoots = rawCandidateRoots === undefined ? undefined : normalizeCandidateRoots(rawCandidateRoots);
  const orchestrationBudget = normalizeOrchestrationBudget(rawOrchestrationBudget);
  const activeTask = normalizeActiveTask(rawActiveTask);
  return {
    ...rest,
    ...(isSafeSessionId(agentSessionId) ? { agentSessionId } : {}),
    ...(typeof paired === 'boolean' ? { paired } : {}),
    ...(typeof rawSyncing === 'boolean' ? { syncing: rawSyncing } : {}),
    ...(activeTask === undefined ? {} : { activeTask }),
    ...(typeof localMode === 'boolean' ? { localMode } : {}),
    ...(typeof demo === 'boolean' ? { demo } : {}),
    ...(typeof csrfToken === 'string' && CSRF_TOKEN.test(csrfToken) ? { csrfToken } : {}),
    ...(typeof apiBaseUrl === 'string' ? { apiBaseUrl } : {}),
    ...(typeof snapshotPath === 'string' ? { snapshotPath } : {}),
    ...(candidateRoots === undefined ? {} : { candidateRoots }),
    ...(orchestrationBudget === undefined ? {} : { orchestrationBudget }),
    ...(rawDiscoveryError === 'source_roots_unavailable' ? { discoveryError: rawDiscoveryError } : {}),
    ...(typeof rawFocusVersion === 'number' && Number.isSafeInteger(rawFocusVersion) && rawFocusVersion >= 0 ? { focusVersion: rawFocusVersion } : {}),
    ...(typeof rawFocusChangedAt === 'string' && Number.isFinite(Date.parse(rawFocusChangedAt)) ? { focusChangedAt: new Date(rawFocusChangedAt).toISOString() } : {}),
  };
}

function normalizeActiveTask(value: unknown): AgentFarmRuntimeConfig['activeTask'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const displayName = typeof candidate.displayName === 'string' && isSafeLocalDisplayName(candidate.displayName)
    ? candidate.displayName
    : undefined;
  if (!displayName) return undefined;
  const lifecycle = typeof candidate.lifecycle === 'string' && /^(?:queued|running|waiting|completed|failed|cancelled|disconnected|idle|ready|pending|active|unknown)$/u.test(candidate.lifecycle) ? candidate.lifecycle : undefined;
  const lastActivityAt = typeof candidate.lastActivityAt === 'string' && Number.isFinite(Date.parse(candidate.lastActivityAt)) ? new Date(candidate.lastActivityAt).toISOString() : undefined;
  const chatTitle = typeof candidate.chatTitle === 'string' && isSafeLocalDisplayName(candidate.chatTitle) ? candidate.chatTitle : undefined;
  const workspaceName = typeof candidate.workspaceName === 'string' && isSafeLocalDisplayName(candidate.workspaceName) ? candidate.workspaceName : undefined;
  if (candidate.lifecycle !== undefined && lifecycle === undefined) return undefined;
  if (candidate.lastActivityAt !== undefined && lastActivityAt === undefined) return undefined;
  if (candidate.chatTitle !== undefined && chatTitle === undefined) return undefined;
  if (candidate.workspaceName !== undefined && workspaceName === undefined) return undefined;
  return { displayName, ...(chatTitle === undefined ? {} : { chatTitle }), ...(workspaceName === undefined ? {} : { workspaceName }), ...(lifecycle === undefined ? {} : { lifecycle }), ...(lastActivityAt === undefined ? {} : { lastActivityAt }) };
}

export interface StandaloneBootstrapOptions {
  readonly config?: AgentFarmRuntimeConfig;
  readonly origin: string;
  readonly returnTo?: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

export interface StandaloneBootstrapResult {
  readonly config: AgentFarmRuntimeConfig;
  readonly loginUrl?: string;
  readonly unavailable?: true;
}

function safeOrigin(value: string): URL {
  const parsed = new URL(value);
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== value) {
    throw new Error('Standalone origin is invalid');
  }
  return parsed;
}

function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.length > 1_024) return '/';
  // OAuth codes and credential-like query fields are never forwarded through
  // another redirect. The standalone app only needs its route pathname.
  return value.split(/[?#]/u, 1)[0] || '/';
}

function hasTokenLikeBrowserLocation(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value.length > 2_048 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return true;
  let parsed: URL;
  try {
    parsed = new URL(value, 'http://agent-farm.invalid');
  } catch {
    return true;
  }
  for (const [rawKey, fieldValue] of parsed.searchParams) {
    const key = rawKey.toLowerCase().replace(/[._-]/gu, '');
    if (TOKEN_FIELD.test(key) || TOKEN_VALUE.test(fieldValue)) return true;
  }
  if (parsed.hash.length > 1) {
    let fragment: string;
    try {
      fragment = decodeURIComponent(parsed.hash.slice(1).replaceAll('+', ' '));
    } catch {
      return true;
    }
    for (const field of fragment.split(/[&;]/u)) {
      const separator = field.indexOf('=');
      const rawKey = separator < 0 ? field : field.slice(0, separator);
      const fieldValue = separator < 0 ? '' : field.slice(separator + 1);
      const key = rawKey.toLowerCase().replace(/[._-]/gu, '');
      if (TOKEN_FIELD.test(key) || TOKEN_VALUE.test(fieldValue)) return true;
    }
    if (TOKEN_VALUE.test(fragment)) return true;
  }
  return false;
}

async function safeJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:;|$)/iu.test(contentType)) return undefined;
  try {
    const value: unknown = await response.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a same-origin browser login into one durable Agent Farm view
 * session. OAuth/refresh tokens remain HttpOnly server state; the only value
 * returned to the UI is the public app-generated agentSessionId.
 */
export async function provisionStandaloneSession(
  options: StandaloneBootstrapOptions,
): Promise<StandaloneBootstrapResult> {
  const config = safeRuntimeConfig({ ...(options.config ?? {}) });
  if (config.localMode === true) return { config, unavailable: true };
  if (isSafeSessionId(config.agentSessionId)) return { config };
  const origin = safeOrigin(options.origin);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sessionResponse = await fetchImpl(new URL('/auth/session', origin), {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (sessionResponse.status === 401) {
    const login = new URL('/auth/login', origin);
    login.searchParams.set('returnTo', safeReturnTo(options.returnTo));
    return { config, loginUrl: `${login.pathname}${login.search}` };
  }
  if (!sessionResponse.ok) return { config, unavailable: true };
  const authSession = await safeJson(sessionResponse);
  const csrfToken = authSession?.csrfToken;
  if (typeof csrfToken !== 'string' || !CSRF_TOKEN.test(csrfToken)) return { config, unavailable: true };

  const provisioned = await fetchImpl(new URL('/api/v1/browser/session', origin), {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: '{}',
  });
  if (provisioned.status === 401) {
    const login = new URL('/auth/login', origin);
    login.searchParams.set('returnTo', safeReturnTo(options.returnTo));
    return { config, loginUrl: `${login.pathname}${login.search}` };
  }
  if (!provisioned.ok) return { config, unavailable: true };
  const body = await safeJson(provisioned);
  const agentSessionId = body?.agentSessionId;
  if (!isSafeSessionId(agentSessionId)) return { config, unavailable: true };
  return { config: { ...config, agentSessionId } };
}

/**
 * Provision a standalone session from the loopback-only local server. This
 * path deliberately does not request OAuth state. A minimal read-only
 * bootstrap endpoint issues one-time CSRF material; all subsequent local
 * mutations send that value while the browser carries HttpOnly cookies.
 */
export async function provisionLocalStandaloneSession(
  options: StandaloneBootstrapOptions,
): Promise<StandaloneBootstrapResult> {
  const config = safeRuntimeConfig({ ...(options.config ?? {}) });
  const origin = safeOrigin(options.origin);
  if (!isLoopbackOrigin(origin)) throw new Error('Local bootstrap requires a loopback origin');
  if (hasTokenLikeBrowserLocation(options.returnTo)) throw new Error('Local bootstrap URL is invalid');
  const fetchImpl = options.fetchImpl ?? fetch;
  let bootstrapResponse: Response;
  try {
    bootstrapResponse = await fetchImpl(new URL('/api/v1/local/bootstrap', origin), {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  } catch {
    return { config, unavailable: true };
  }
  if (!bootstrapResponse.ok) return { config, unavailable: true };
  const bootstrap = await safeJson(bootstrapResponse);
  const bootstrapCsrf = bootstrap?.csrfToken;
  if (bootstrap?.localMode !== true || typeof bootstrapCsrf !== 'string' || !CSRF_TOKEN.test(bootstrapCsrf)) {
    return { config, unavailable: true };
  }
  // Once the loopback status endpoint has identified a local server, retain
  // that boundary even if session creation is unavailable. The caller must
  // render an unverified local state rather than falling through to OAuth.
  const localConfig: AgentFarmRuntimeConfig = {
    ...config,
    localMode: true,
    csrfToken: bootstrapCsrf,
  };

  let provisioned: Response;
  try {
    provisioned = await fetchImpl(new URL('/api/v1/local/session', origin), {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-csrf-token': bootstrapCsrf,
      },
      body: '{}',
    });
  } catch {
    return { config: localConfig, unavailable: true };
  }
  if (!provisioned.ok) return { config: localConfig, unavailable: true };
  const body = await safeJson(provisioned);
  const agentSessionId = body?.agentSessionId;
  if (!isSafeSessionId(agentSessionId)) return { config: localConfig, unavailable: true };
  const sessionCsrf = typeof body?.csrfToken === 'string' && CSRF_TOKEN.test(body.csrfToken)
    ? body.csrfToken
    : bootstrapCsrf;
  let statusResponse: Response;
  try {
    statusResponse = await fetchImpl(new URL('/api/v1/local/status', origin), {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  } catch {
    return { config: { ...localConfig, agentSessionId, csrfToken: sessionCsrf }, unavailable: true };
  }
  if (!statusResponse.ok) return { config: { ...localConfig, agentSessionId, csrfToken: sessionCsrf }, unavailable: true };
  const status = await safeJson(statusResponse);
  if (status?.localMode !== true) return { config: localConfig, unavailable: true };
  const orchestrationBudget = normalizeOrchestrationBudget(status.orchestrationBudget) ?? normalizeOrchestrationBudget(config.orchestrationBudget);
  const candidateRoots = Object.prototype.hasOwnProperty.call(status, 'candidateRoots')
    ? normalizeCandidateRoots(status.candidateRoots)
    : normalizeCandidateRoots(config.candidateRoots);
  const activeTask = normalizeActiveTask(status.activeTask);
  const discoveryError = status.discoveryError === 'source_roots_unavailable' ? status.discoveryError : undefined;
  const paired = typeof status.paired === 'boolean' ? status.paired : config.paired;
  const statusCsrf = typeof status.csrfToken === 'string' && CSRF_TOKEN.test(status.csrfToken)
    ? status.csrfToken
    : statusResponse.headers.get('x-csrf-token');
  if (typeof statusCsrf !== 'string' || !CSRF_TOKEN.test(statusCsrf)) return { config: localConfig, unavailable: true };
  return {
    config: {
      ...localConfig,
      agentSessionId,
      csrfToken: statusCsrf,
      ...(paired === undefined ? {} : { paired }),
      ...(typeof status.focusVersion === 'number' && Number.isSafeInteger(status.focusVersion) && status.focusVersion >= 0 ? { focusVersion: status.focusVersion } : {}),
      ...(typeof status.focusChangedAt === 'string' && Number.isFinite(Date.parse(status.focusChangedAt)) ? { focusChangedAt: new Date(status.focusChangedAt).toISOString() } : {}),
      candidateRoots,
      ...(activeTask === undefined ? {} : { activeTask }),
      ...(discoveryError === undefined ? {} : { discoveryError }),
      ...(orchestrationBudget === undefined ? {} : { orchestrationBudget }),
    },
  };
}

export interface LocalPairingResult extends StandaloneBootstrapResult {
  readonly duplicate?: true;
}

/** Refresh local status to obtain a current set of one-time selection handles. */
export async function refreshLocalRuntimeConfig(options: StandaloneBootstrapOptions): Promise<AgentFarmRuntimeConfig> {
  const config = safeRuntimeConfig({ ...(options.config ?? {}) });
  const origin = safeOrigin(options.origin);
  if (!isLoopbackOrigin(origin)) throw new Error('Local status refresh requires a loopback origin');
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(new URL('/api/v1/local/status', origin), {
    method: 'GET', credentials: 'include', headers: { accept: 'application/json' }, ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) throw new Error(`Local status refresh failed (HTTP ${response.status})`);
  const status = await safeJson(response);
  if (status?.localMode !== true) throw new Error('Local status refresh returned an invalid response');
  const csrfToken = typeof status.csrfToken === 'string' && CSRF_TOKEN.test(status.csrfToken)
    ? status.csrfToken : response.headers.get('x-csrf-token');
  if (typeof csrfToken !== 'string' || !CSRF_TOKEN.test(csrfToken)) throw new Error('Local status refresh returned an invalid session');
  const activeTask = normalizeActiveTask(status.activeTask);
  const agentSessionId = isSafeSessionId(status?.agentSessionId) ? status.agentSessionId : config.agentSessionId;
  return safeRuntimeConfig({
    ...config,
    ...(agentSessionId === undefined ? {} : { agentSessionId }),
    syncing: false,
    csrfToken,
    ...(typeof status.paired === 'boolean' ? { paired: status.paired } : {}),
    ...(typeof status.focusVersion === 'number' && Number.isSafeInteger(status.focusVersion) && status.focusVersion >= 0 ? { focusVersion: status.focusVersion } : {}),
    ...(typeof status.focusChangedAt === 'string' && Number.isFinite(Date.parse(status.focusChangedAt)) ? { focusChangedAt: new Date(status.focusChangedAt).toISOString() } : {}),
    candidateRoots: normalizeCandidateRoots(status.candidateRoots),
    ...(activeTask === undefined ? {} : { activeTask }),
  });
}

export interface LocalFocusState {
  readonly focusVersion: number;
  readonly focusChangedAt: string;
  readonly agentSessionId?: string;
}

/** Poll only the trusted current-chat version; this never discovers roots or issues selection handles. */
export async function refreshLocalFocusState(options: StandaloneBootstrapOptions): Promise<LocalFocusState> {
  const origin = safeOrigin(options.origin);
  if (!isLoopbackOrigin(origin)) throw new Error('Local focus refresh requires a loopback origin');
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(new URL('/api/v1/local/focus', origin), {
    method: 'GET', credentials: 'include', headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Local focus refresh failed (HTTP ${response.status})`);
  const body = await safeJson(response);
  const focusVersion = body?.focusVersion;
  const focusChangedAt = body?.focusChangedAt;
  if (typeof focusVersion !== 'number' || !Number.isSafeInteger(focusVersion) || focusVersion < 0 ||
    typeof focusChangedAt !== 'string' || !Number.isFinite(Date.parse(focusChangedAt))) {
    throw new Error('Local focus refresh returned an invalid response');
  }
  const agentSessionId = isSafeSessionId(body?.agentSessionId) ? body.agentSessionId : undefined;
  return { focusVersion, focusChangedAt: new Date(focusChangedAt).toISOString(), ...(agentSessionId === undefined ? {} : { agentSessionId }) };
}

export class LocalPairingError extends Error {
  readonly nextConfig: AgentFarmRuntimeConfig;

  constructor(message: string, nextConfig: AgentFarmRuntimeConfig) {
    super(message);
    this.name = 'LocalPairingError';
    this.nextConfig = nextConfig;
  }
}

/** Pair one of the local server's advertised source roots without OAuth. */
export async function provisionLocalPairing(
  options: StandaloneBootstrapOptions,
  selectionHandle: string,
): Promise<LocalPairingResult> {
  const config = safeRuntimeConfig({ ...(options.config ?? {}) });
  const origin = safeOrigin(options.origin);
  if (!isLoopbackOrigin(origin)) throw new Error('Local pairing requires a loopback origin');
  if (!isSafeSelectionHandle(selectionHandle)) throw new Error('Local pairing selection is invalid');
  if (!isSafeSessionId(config.agentSessionId)) {
    throw new Error('Local pairing session is unavailable');
  }
  if (typeof config.csrfToken !== 'string' || !CSRF_TOKEN.test(config.csrfToken)) {
    throw new Error('Local pairing CSRF session is unavailable');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL('/api/v1/local/pairing/root', origin), {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-csrf-token': config.csrfToken,
      },
      body: JSON.stringify({ selectionHandle }),
    });
  } catch {
    throw new Error('Local pairing request failed');
  }
  const nextCsrf = response.headers.get('x-csrf-token');
  const nextConfig: AgentFarmRuntimeConfig = {
    ...config,
    ...(typeof nextCsrf === 'string' && CSRF_TOKEN.test(nextCsrf) ? { csrfToken: nextCsrf } : {}),
  };
  const body = await safeJson(response);
  if (response.status === 409) {
    const error = body?.error;
    const errorCode = typeof error === 'object' && error !== null && !Array.isArray(error)
      ? (error as Record<string, unknown>).code
      : undefined;
    // A conflict is not proof that this browser owns the durable binding.
    // Only the server's exact idempotent-completion code may advance the UI
    // to paired. PAIRING_UNAVAILABLE means another local session owns the
    // installation (or the binding cannot be resolved), so preserve the
    // browser's unpaired config and surface an explicit failure.
    if (errorCode === 'PAIRING_ALREADY_COMPLETED') {
      return {
        config: {
          ...nextConfig,
          paired: true,
        },
        duplicate: true,
      };
    }
    throw new LocalPairingError('Local pairing is unavailable for this browser session', nextConfig);
  }
  if (!response.ok) throw new LocalPairingError(`Local pairing failed (HTTP ${response.status})`, nextConfig);
  const agentSessionId = body?.agentSessionId;
  if (body && Object.prototype.hasOwnProperty.call(body, 'credential')) {
    throw new LocalPairingError('Local pairing returned an invalid response', nextConfig);
  }
  if (!isSafeSessionId(agentSessionId)) {
    throw new LocalPairingError('Local pairing returned an invalid session', nextConfig);
  }
  const activeTask = normalizeActiveTask(body?.activeTask);
  if (activeTask === undefined) throw new LocalPairingError('Local pairing returned an invalid task', nextConfig);
  const syncing = body?.syncing === true;
  return {
    config: {
      ...nextConfig,
      paired: true,
      syncing,
      agentSessionId,
      ...(activeTask === undefined ? {} : { activeTask }),
    },
  };
}

/** Switch the authenticated local binding using a fresh one-time selection handle. */
export async function provisionLocalPairingSwitch(
  options: StandaloneBootstrapOptions,
  selectionHandle: string,
): Promise<LocalPairingResult> {
  const config = safeRuntimeConfig({ ...(options.config ?? {}) });
  const origin = safeOrigin(options.origin);
  if (!isLoopbackOrigin(origin)) throw new Error('Local pairing requires a loopback origin');
  if (!isSafeSelectionHandle(selectionHandle)) throw new Error('Local pairing selection is invalid');
  if (!isSafeSessionId(config.agentSessionId)) throw new Error('Local pairing session is unavailable');
  if (typeof config.csrfToken !== 'string' || !CSRF_TOKEN.test(config.csrfToken)) throw new Error('Local pairing CSRF session is unavailable');
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL('/api/v1/local/pairing/switch', origin), {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': config.csrfToken },
      body: JSON.stringify({ selectionHandle, confirmation: true }),
    });
  } catch {
    throw new Error('Local pairing request failed');
  }
  const nextCsrf = response.headers.get('x-csrf-token');
  const nextConfig: AgentFarmRuntimeConfig = {
    ...config,
    ...(typeof nextCsrf === 'string' && CSRF_TOKEN.test(nextCsrf) ? { csrfToken: nextCsrf } : {}),
  };
  if (!response.ok) throw new LocalPairingError(`Local pairing switch failed (HTTP ${response.status})`, nextConfig);
  const body = await safeJson(response);
  if (body && Object.prototype.hasOwnProperty.call(body, 'credential')) throw new LocalPairingError('Local pairing returned an invalid response', nextConfig);
  const agentSessionId = body?.agentSessionId;
  if (!isSafeSessionId(agentSessionId)) throw new LocalPairingError('Local pairing returned an invalid session', nextConfig);
  const activeTask = normalizeActiveTask(body?.activeTask);
  if (activeTask === undefined) throw new LocalPairingError('Local pairing returned an invalid task', nextConfig);
  const syncing = body?.syncing === true;
  const candidateRoots = (config.candidateRoots ?? []).map((candidate) => {
    const { active: _previouslyActive, ...rest } = candidate;
    return candidate.selectionHandle === selectionHandle
      ? { ...rest, active: true as const, bound: true as const }
      : rest;
  });
  return {
    config: {
      ...nextConfig,
      paired: true,
      syncing,
      agentSessionId,
      ...(activeTask === undefined ? {} : { activeTask }),
      // Keep the sanitized catalog visible and immediately reflect the
      // successful user selection. Authoritative discovery still refreshes
      // handles and monitored-chat state when the switcher opens again.
      candidateRoots,
    },
  };
}

/** Deliberately unpair the current local binding after server-side confirmation. */
export async function provisionLocalUnpair(
  options: StandaloneBootstrapOptions,
): Promise<LocalPairingResult> {
  const config = safeRuntimeConfig({ ...(options.config ?? {}) });
  const origin = safeOrigin(options.origin);
  if (!isLoopbackOrigin(origin)) throw new Error('Local pairing requires a loopback origin');
  if (!isSafeSessionId(config.agentSessionId)) throw new Error('Local pairing session is unavailable');
  if (typeof config.csrfToken !== 'string' || !CSRF_TOKEN.test(config.csrfToken)) throw new Error('Local pairing CSRF session is unavailable');
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL('/api/v1/local/pairing/unpair', origin), {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': config.csrfToken },
      body: JSON.stringify({ confirmation: true }),
    });
  } catch {
    throw new Error('Local unpair request failed');
  }
  const nextCsrf = response.headers.get('x-csrf-token');
  const nextConfig: AgentFarmRuntimeConfig = {
    ...config,
    ...(typeof nextCsrf === 'string' && CSRF_TOKEN.test(nextCsrf) ? { csrfToken: nextCsrf } : {}),
  };
  if (!response.ok) throw new LocalPairingError(`Local unpair failed (HTTP ${response.status})`, nextConfig);
  const body = await safeJson(response);
  if (body && Object.prototype.hasOwnProperty.call(body, 'credential')) throw new LocalPairingError('Local unpair returned an invalid response', nextConfig);
  if (body?.paired !== false) throw new LocalPairingError('Local unpair returned an invalid response', nextConfig);
  const { agentSessionId: _revokedSession, ...unpairedConfig } = nextConfig;
  return { config: { ...unpairedConfig, paired: false, candidateRoots: [] } };
}
