import { describe, expect, it, vi } from 'vitest';

import { isSafeLocalDisplayName } from './normalize';
import { LocalPairingError, provisionLocalPairing, provisionLocalPairingSwitch, provisionLocalStandaloneSession, provisionLocalUnpair, provisionStandaloneSession, refreshLocalFocusState } from './standalone-bootstrap';

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

describe('standalone OAuth bootstrap', () => {
  it('uses an already provisioned public session without network access', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await provisionStandaloneSession({
      config: { agentSessionId: 'as_existing' },
      origin: 'https://agent-farm.example',
      fetchImpl,
    });
    expect(result.config.agentSessionId).toBe('as_existing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never enters OAuth bootstrap when local mode is explicitly enabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await provisionStandaloneSession({
      config: { localMode: true },
      origin: 'https://agent-farm.example',
      fetchImpl,
    });
    expect(result).toMatchObject({ unavailable: true, config: { localMode: true } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a same-origin login URL without forwarding credential-like query data', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ authenticated: false }, 401));
    const result = await provisionStandaloneSession({
      origin: 'https://agent-farm.example',
      returnTo: '/hierarchy?token=secret#fragment',
      fetchImpl,
    });
    expect(result.loginUrl).toBe('/auth/login?returnTo=%2Fhierarchy');
    expect(result.loginUrl).not.toContain('secret');
  });

  it('provisions a durable browser view using cookie auth and a CSRF header', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      return requests.length === 1
        ? json({ authenticated: true, csrfToken: 'csrf_token_1234567890' })
        : json({ agentSessionId: 'as_browser_1' }, 201);
    };
    const result = await provisionStandaloneSession({
      config: { apiBaseUrl: 'https://agent-farm.example' },
      origin: 'https://agent-farm.example',
      returnTo: '/',
      fetchImpl,
    });
    expect(result.config.agentSessionId).toBe('as_browser_1');
    expect(requests.map((request) => request.url)).toEqual([
      'https://agent-farm.example/auth/session',
      'https://agent-farm.example/api/v1/browser/session',
    ]);
    expect(requests[1]?.init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: expect.objectContaining({ 'x-csrf-token': 'csrf_token_1234567890' }),
    });
    expect(JSON.stringify(requests)).not.toMatch(/access[_-]?token|refresh[_-]?token|authorization/iu);
  });

  it('stays visibly unavailable when the standalone auth routes are absent or malformed', async () => {
    const absent = await provisionStandaloneSession({
      origin: 'https://agent-farm.example',
      fetchImpl: async () => json({ error: 'not found' }, 404),
    });
    expect(absent).toMatchObject({ unavailable: true, config: {} });

    const malformed = await provisionStandaloneSession({
      origin: 'https://agent-farm.example',
      fetchImpl: async () => json({ csrfToken: 'short' }),
    });
    expect(malformed).toMatchObject({ unavailable: true, config: {} });
  });

  it('stays unavailable when the local bootstrap route is absent or reports a non-local server', async () => {
    const absent = await provisionLocalStandaloneSession({
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => json({ error: 'not found' }, 404),
    });
    expect(absent).toMatchObject({ unavailable: true, config: {} });

    const notLocal = await provisionLocalStandaloneSession({
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => json({ localMode: false }),
    });
    expect(notLocal).toMatchObject({ unavailable: true, config: {} });
  });

  it('turns a local status network failure into an unavailable result', async () => {
    const result = await provisionLocalStandaloneSession({
      config: { localMode: true },
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => { throw new Error('loopback unavailable'); },
    });
    expect(result).toMatchObject({ unavailable: true, config: { localMode: true } });
  });

  it('rejects token-like local page query and fragment inputs before bootstrap', async () => {
    for (const returnTo of [
      '/?access_token=secret',
      '/?%41PI_KEY=secret',
      '/hierarchy#refresh_token=secret',
      '/hierarchy#token=abcdefgh.ijklmnop.qrstuvwx',
      '/hierarchy#safe=abcdefgh.ijklmnop.qrstuvwx',
    ]) {
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(provisionLocalStandaloneSession({
        origin: 'http://127.0.0.1:4210',
        returnTo,
        fetchImpl,
      })).rejects.toThrow('Local bootstrap URL is invalid');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('provisions a local session through bootstrap CSRF and authenticated status', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      if (requests.length === 1) return json({ localMode: true, csrfToken: 'csrf_bootstrap_1234567890' });
      if (requests.length === 2) return json({ agentSessionId: 'local_session_1', csrfToken: 'csrf_session_1234567890' }, 201);
      return json({ localMode: true, csrfToken: 'csrf_status_1234567890', orchestrationBudget: { solHigh: 10, lunaMax: 10, solMax: 3 } });
    };
    const result = await provisionLocalStandaloneSession({
      config: { apiBaseUrl: 'http://127.0.0.1:4210' },
      origin: 'http://127.0.0.1:4210',
      fetchImpl,
    });
    expect(result.config).toMatchObject({
      apiBaseUrl: 'http://127.0.0.1:4210',
      agentSessionId: 'local_session_1',
      localMode: true,
      orchestrationBudget: { solHigh: 10, lunaMax: 10, solMax: 3 },
      csrfToken: 'csrf_status_1234567890',
    });
    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:4210/api/v1/local/bootstrap',
      'http://127.0.0.1:4210/api/v1/local/session',
      'http://127.0.0.1:4210/api/v1/local/status',
    ]);
    expect(requests[1]?.init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(requests[1]?.init?.headers).toMatchObject({ 'x-csrf-token': 'csrf_bootstrap_1234567890' });
  });

  it('keeps a confirmed local boundary when local session creation is unavailable', async () => {
    let calls = 0;
    const result = await provisionLocalStandaloneSession({
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? json({ localMode: true, csrfToken: 'csrf_bootstrap_1234567890' })
          : json({ error: 'temporarily unavailable' }, 503);
      },
    });
    expect(result).toMatchObject({ unavailable: true, config: { localMode: true, csrfToken: 'csrf_bootstrap_1234567890' } });
    expect(result.loginUrl).toBeUndefined();
  });

  it('keeps a confirmed local boundary when local session creation throws', async () => {
    let calls = 0;
    const result = await provisionLocalStandaloneSession({
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return json({ localMode: true, csrfToken: 'csrf_bootstrap_1234567890' });
        throw new Error('loopback server closed');
      },
    });
    expect(result).toMatchObject({ unavailable: true, config: { localMode: true } });
  });

  it('drops an out-of-range server budget instead of displaying it', async () => {
    let calls = 0;
    const result = await provisionLocalStandaloneSession({
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? json({ localMode: true, csrfToken: 'csrf_bootstrap_1234567890' })
          : calls === 2
            ? json({ agentSessionId: 'local_session_2', csrfToken: 'csrf_session_1234567890' }, 201)
            : json({ localMode: true, csrfToken: 'csrf_status_1234567890', orchestrationBudget: { solHigh: 10, lunaMax: 10, solMax: 1 } });
      },
    });
    expect(result.config.localMode).toBe(true);
    expect(result.config.orchestrationBudget).toBeUndefined();
  });

  it('passes only sanitized candidate roots through local bootstrap', async () => {
    let calls = 0;
    const result = await provisionLocalStandaloneSession({
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? json({ localMode: true, csrfToken: 'csrf_bootstrap_1234567890' })
          : calls === 2
            ? json({ agentSessionId: 'local_session_1', csrfToken: 'csrf_session_1234567890' }, 201)
            : json({
            localMode: true,
            csrfToken: 'csrf_status_1234567890',
            paired: false,
            candidateRoots: [
              { selectionHandle: 'h'.repeat(43), displayName: 'Main Codex', lifecycle: 'ready', lastActivityAt: '2026-08-10T10:00:00Z', credential: 'must-not-leak' },
            ],
          });
      },
    });
    expect(result.config).toMatchObject({
      paired: false,
      candidateRoots: [{ selectionHandle: 'h'.repeat(43), displayName: 'Main Codex', lifecycle: 'ready', lastActivityAt: '2026-08-10T10:00:00.000Z' }],
    });
    expect(JSON.stringify(result.config)).not.toContain('must-not-leak');
  });

  it('preserves ordinary API titles while filtering API credential labels', async () => {
    let calls = 0;
    const result = await provisionLocalStandaloneSession({
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? json({ localMode: true, csrfToken: 'csrf_bootstrap_1234567890' })
          : calls === 2
            ? json({ agentSessionId: 'local_session_api', csrfToken: 'csrf_session_1234567890' }, 201)
            : json({
              localMode: true,
              csrfToken: 'csrf_status_1234567890',
              candidateRoots: [{
                selectionHandle: 'h'.repeat(43),
                displayName: 'Investigate Codex review API costs',
                chatTitle: 'Investigate Codex review API costs',
              }],
            });
      },
    });
    expect(result.config.candidateRoots).toEqual([{
      selectionHandle: 'h'.repeat(43),
      displayName: 'Investigate Codex review API costs',
      chatTitle: 'Investigate Codex review API costs',
    }]);
  });

  it('accepts ordinary titles containing code while rejecting credential-shaped labels', () => {
    expect(isSafeLocalDisplayName('can u please push code to my 2nd github account')).toBe(true);
    expect(isSafeLocalDisplayName('API key=secret_value')).toBe(false);
    expect(isSafeLocalDisplayName('Rotate API token')).toBe(false);
  });

  it('carries the server-derived active task label and ignores private-looking labels', async () => {
    let calls = 0;
    const result = await provisionLocalStandaloneSession({
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return json({ localMode: true, csrfToken: 'csrf_bootstrap_1234567890' });
        if (calls === 2) return json({ agentSessionId: 'local_session_active', csrfToken: 'csrf_session_1234567890' }, 201);
        return json({
          localMode: true,
          csrfToken: 'csrf_status_1234567890',
          paired: true,
          activeTask: { displayName: 'Beta task', lifecycle: 'idle', lastActivityAt: '2026-08-10T10:00:00Z' },
          candidateRoots: [
            { selectionHandle: 'a'.repeat(43), displayName: 'Alpha task', lifecycle: 'active' },
            { selectionHandle: 'b'.repeat(43), displayName: 'Beta task', lifecycle: 'idle' },
          ],
        });
      },
    });
    expect(result.config.activeTask).toEqual({ displayName: 'Beta task', lifecycle: 'idle', lastActivityAt: '2026-08-10T10:00:00.000Z' });

    calls = 0;
    const rejected = await provisionLocalStandaloneSession({
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return json({ localMode: true, csrfToken: 'csrf_bootstrap_1234567890' });
        if (calls === 2) return json({ agentSessionId: 'local_session_active', csrfToken: 'csrf_session_1234567890' }, 201);
        return json({ localMode: true, csrfToken: 'csrf_status_1234567890', paired: true, activeTask: { displayName: '/private/root' }, candidateRoots: [] });
      },
    });
    expect(rejected.config.activeTask).toBeUndefined();
  });

  it('fails closed when local status candidate roots are malformed', async () => {
    let calls = 0;
    const result = await provisionLocalStandaloneSession({
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? json({ localMode: true, csrfToken: 'csrf_bootstrap_1234567890' })
          : calls === 2
            ? json({ agentSessionId: 'local_session_1', csrfToken: 'csrf_session_1234567890' }, 201)
            : json({ localMode: true, csrfToken: 'csrf_status_1234567890', paired: false, candidateRoots: [{ selectionHandle: 42 }] });
      },
    });
    expect(result.config.candidateRoots).toEqual([]);
  });

  it('rejects non-canonical handle lengths and unsafe activity fields', async () => {
    let calls = 0;
    const result = await provisionLocalStandaloneSession({
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? json({ localMode: true, csrfToken: 'csrf_bootstrap_1234567890' })
          : calls === 2
            ? json({ agentSessionId: 'local_session_1', csrfToken: 'csrf_session_1234567890' }, 201)
            : json({
              localMode: true,
              csrfToken: 'csrf_status_1234567890',
              candidateRoots: [{ selectionHandle: 'h'.repeat(42), displayName: 'Main Codex', lastActivityAt: '/private/activity' }],
            });
      },
    });
    expect(result.config.candidateRoots).toEqual([]);
  });

  it('pairs a selected local handle with CSRF and never exposes the credential', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await provisionLocalPairing({
      config: { localMode: true, paired: false, agentSessionId: 'local_session_1', csrfToken: 'csrf_status_1234567890' },
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        return new Response(JSON.stringify({ agentSessionId: 'local_session_1', paired: true, activeTask: { displayName: 'Main Codex', lifecycle: 'ready' } }), { status: 201, headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf_pair_1234567890' } });
      },
    }, 'h'.repeat(43));
    expect(result.config).toMatchObject({ localMode: true, paired: true, agentSessionId: 'local_session_1' });
    expect(result.duplicate).toBeUndefined();
    expect(requests[0]?.url).toBe('http://127.0.0.1:4210/api/v1/local/pairing/root');
    expect(requests[0]?.init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(requests[0]?.init?.headers).toMatchObject({ 'x-csrf-token': 'csrf_status_1234567890' });
    expect(JSON.stringify(requests[0]?.init)).not.toContain('pairing-secret');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ selectionHandle: 'h'.repeat(43) });
  });

  it('carries a replacement CSRF config out of a failed pairing mutation', async () => {
    await expect(provisionLocalPairing({
      config: {
        localMode: true,
        agentSessionId: 'local_session_1',
        csrfToken: 'csrf_status_1234567890',
      },
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'PAIRING_UNAVAILABLE' } }), {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': 'csrf_replacement_1234567890',
        },
      }),
    }, 'h'.repeat(43))).rejects.toMatchObject({
      nextConfig: { csrfToken: 'csrf_replacement_1234567890' },
    });
  });

  it('treats duplicate local pairing as already paired', async () => {
    const result = await provisionLocalPairing({
      config: { localMode: true, paired: false, agentSessionId: 'local_session_1', csrfToken: 'csrf_status_1234567890' },
      origin: 'http://localhost:4210',
      fetchImpl: async () => json({ error: { code: 'PAIRING_ALREADY_COMPLETED' } }, 409),
    }, 'h'.repeat(43));
    expect(result).toMatchObject({ duplicate: true, config: { paired: true, agentSessionId: 'local_session_1' } });
  });

  it('keeps a second browser unpaired when the durable binding belongs to another session', async () => {
    await expect(provisionLocalPairing({
      config: {
        localMode: true,
        paired: false,
        agentSessionId: 'local_session_2',
        csrfToken: 'csrf_status_1234567890',
      },
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => json({ error: { code: 'PAIRING_UNAVAILABLE', message: 'must not reach UI' } }, 409, {
        'x-csrf-token': 'csrf_replacement_1234567890',
      }),
    }, 'h'.repeat(43))).rejects.toMatchObject({
      message: 'Local pairing is unavailable for this browser session',
      nextConfig: {
        paired: false,
        agentSessionId: 'local_session_2',
        csrfToken: 'csrf_replacement_1234567890',
      },
    });
  });

  it('returns a safe error for local pairing failures', async () => {
    await expect(provisionLocalPairing({
      config: { localMode: true, agentSessionId: 'local_session_1', csrfToken: 'csrf_status_1234567890' },
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => json({ error: 'internal credential leaked' }, 503),
    }, 'h'.repeat(43))).rejects.toThrow('Local pairing failed (HTTP 503)');
    await expect(provisionLocalPairing({
      config: { localMode: true, agentSessionId: 'local_session_1', csrfToken: 'csrf_status_1234567890' },
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async () => json({ error: 'internal credential leaked' }, 503),
    }, 'h'.repeat(43))).rejects.not.toThrow('credential leaked');
  });

  it('rejects local pairing outside a loopback origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(provisionLocalPairing({
      config: { localMode: true, agentSessionId: 'local_session_1' },
      origin: 'https://agent-farm.example',
      fetchImpl,
    }, 'h'.repeat(43))).rejects.toThrow('loopback origin');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('switches a local handle with explicit confirmation and carries CSRF rotation', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const oldHandle = 'a'.repeat(43);
    const nextHandle = 'h'.repeat(43);
    const result = await provisionLocalPairingSwitch({
      config: {
        localMode: true,
        paired: true,
        agentSessionId: 'local_session_1',
        csrfToken: 'csrf_status_1234567890',
        candidateRoots: [
          { selectionHandle: oldHandle, displayName: 'Alpha task', active: true, bound: true },
          { selectionHandle: nextHandle, displayName: 'Beta task', bound: true },
        ],
      },
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        return new Response(JSON.stringify({ agentSessionId: 'local_session_1', paired: true, syncing: true, activeTask: { displayName: 'Beta task', lifecycle: 'running' } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf_switch_1234567890' },
        });
      },
    }, nextHandle);
    expect(result.config).toMatchObject({
      paired: true,
      syncing: true,
      csrfToken: 'csrf_switch_1234567890',
      activeTask: { displayName: 'Beta task', lifecycle: 'running' },
      candidateRoots: [
        { selectionHandle: oldHandle, displayName: 'Alpha task', bound: true },
        { selectionHandle: nextHandle, displayName: 'Beta task', active: true, bound: true },
      ],
    });
    expect(result.config.candidateRoots?.[0]).not.toHaveProperty('active');
    expect(requests[0]?.url).toContain('/api/v1/local/pairing/switch');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ selectionHandle: nextHandle, confirmation: true });
  });

  it('polls current-chat focus without requesting a candidate snapshot', async () => {
    const requests: string[] = [];
    const result = await refreshLocalFocusState({
      config: { localMode: true, paired: true, agentSessionId: 'local_session_1' },
      origin: 'http://127.0.0.1:4210',
      fetchImpl: async (input) => {
        requests.push(String(input));
        return json({ focusVersion: 7, focusChangedAt: '2026-08-14T10:00:00.000Z', agentSessionId: 'local_session_2' });
      },
    });
    expect(result).toEqual({ focusVersion: 7, focusChangedAt: '2026-08-14T10:00:00.000Z', agentSessionId: 'local_session_2' });
    expect(requests).toEqual(['http://127.0.0.1:4210/api/v1/local/focus']);
  });

  it('carries rotated CSRF state when successful switch or unpair responses are malformed', async () => {
    const config = { localMode: true, paired: true, agentSessionId: 'local_session_1', csrfToken: 'csrf_status_1234567890' };
    for (const mutation of [
      () => provisionLocalPairingSwitch({
        config,
        origin: 'http://127.0.0.1:4210',
        fetchImpl: async () => json({ paired: true }, 200, { 'x-csrf-token': 'csrf_rotated_1234567890' }),
      }, 'h'.repeat(43)),
      () => provisionLocalUnpair({
        config,
        origin: 'http://127.0.0.1:4210',
        fetchImpl: async () => json({ paired: true }, 200, { 'x-csrf-token': 'csrf_rotated_1234567890' }),
      }),
    ]) {
      try {
        await mutation();
        throw new Error('expected malformed response to fail');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(LocalPairingError);
        expect((error as LocalPairingError).nextConfig.csrfToken).toBe('csrf_rotated_1234567890');
      }
    }
  });

  it('unpairs only from a confirmed local session and drops stale candidates', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await provisionLocalUnpair({
      config: {
        localMode: true,
        paired: true,
        agentSessionId: 'local_session_1',
        csrfToken: 'csrf_status_1234567890',
        candidateRoots: [{ selectionHandle: 'h'.repeat(43), displayName: 'Main Codex', lifecycle: 'ready' }],
      },
      origin: 'http://localhost:4210',
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        return new Response(JSON.stringify({ paired: false }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf_unpair_1234567890' },
        });
      },
    });
    expect(result.config).toMatchObject({ paired: false, csrfToken: 'csrf_unpair_1234567890', candidateRoots: [] });
    expect(result.config.agentSessionId).toBeUndefined();
    expect(requests[0]?.url).toContain('/api/v1/local/pairing/unpair');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ confirmation: true });
  });
});
