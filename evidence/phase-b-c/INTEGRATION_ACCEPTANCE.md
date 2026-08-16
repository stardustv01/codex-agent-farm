# Phase B-C integration acceptance

Date: 2026-08-09
Scope: `tests/integration/agent-farm.e2e.test.ts`

This note records only commands executed against the current checkout. The
integration test imports the real source contracts, durable SQLite store,
Fastify server composition root, and MCP application. It does not launch
Codex, mutate the installed ChatGPT application, or use unrelated third-party local applications.

## Executed commands

```text
node --import tsx --test tests/integration/agent-farm.e2e.test.ts
```

Observed result: **6/6 passed**.

The passing subtests cover:

1. Canonical recursive `Dirac -> Rhea -> Kuhn -> Noether` projection, verified
   edges, and requested-vs-observed identity (`Kuhn` mismatch, `Noether`
   verified).
2. DurableStore owner/tenant/session isolation across two sessions.
3. Reconnect epoch change, same-payload replay, conflicting replay quarantine,
   and deterministic snapshot rebuild equivalence.
4. Real MCP application hierarchy/details/render calls, bound-session rejection,
   exactly four read/view descriptors, and no control/interrupt/steer/stop
   descriptor; the Fastify MCP JSON-RPC surface also rejects
   `interrupt_agent` with method-not-found.
5. Fastify authenticated hierarchy access, non-enumerating cross-owner/tenant
   isolation, missing-token rejection, HTTP session-create idempotent replay,
   and idempotency conflict rejection.
6. DurableStore scale with exactly 25 active agents (the root plus 24 active
   children) and 200 completed agents, 225 total agents, and deterministic
   rebuild.

```text
./node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext \
  --moduleResolution NodeNext --strict --skipLibCheck \
  --allowImportingTsExtensions tests/integration/agent-farm.e2e.test.ts
```

Observed result: **passed with no diagnostics**.

## Remaining host/runtime gates

The following were not claimed by this local acceptance run and remain pending
for the parent integration/release gate:

- Real Codex app-server event ingestion through the bridge (the test uses
  versioned sanitized contract events).
- A public HTTPS deployment and ChatGPT developer-mode MCP connection.
- Built-in ChatGPT browser rendering, iframe/fullscreen navigation, and screen
  reader/keyboard acceptance.
- OAuth authorization-server callback, refresh, audience/resource enforcement
  against a live provider.
- Long-running reconnect behavior under a real dropped app-server transport.

No host-runtime failure was observed here; those gates simply require external
runtime/deployment state not present in this local test invocation.
