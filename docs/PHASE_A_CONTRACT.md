# Phase A Contract

Status: Phase A passed two Sol High critic reviews. Phase B/C implementation and
the real local runtime/REST/MCP topology+identity gate are PASS. Live OAuth,
external HTTPS, and ChatGPT host/browser acceptance remain explicit HOLD gates.

Captured: 2026-08-09 IST.

## 1. Non-negotiable boundaries

- Never modify, patch, re-sign, or replace `/Applications/ChatGPT.app`.
- Never inspect, copy from, modify, or depend on unrelated third-party local applications.
- Use only the supported Codex app-server and ChatGPT MCP Apps surfaces.
- V1 exposes no Codex thread or agent mutation capability. Agent Farm may
  create/update/delete its own authenticated view sessions and sanitized
  projection rows under their documented lifecycle rules.
- Agent narrative, labels, config defaults, fixture data, and UI display names
  are not runtime identity evidence.
- The public MCP surface contains exactly four tools. All are read-only with
  respect to Codex; `create_agent_session` provisions only an Agent Farm view
  session and never spawns a Codex agent.

The earlier installed-bundle report is historical reconnaissance for a
different direction. It is not authority for this standalone MCP-backed
application.

## 2. Authoritative evidence

### Codex app-server

The retained local `codex-cli 0.145.0` supports `codex app-server` over stdio,
Unix sockets, and WebSocket. V1 production uses the explicitly pinned stdio
form. The CLI generated its own experimental JSON Schema and TypeScript
protocol bundle under a temporary directory.

A real read-only handshake succeeded:

1. `initialize` returned Codex user agent, Codex home, Unix platform family,
   and macOS platform.
2. `initialized` completed negotiation.
3. `thread/list` with `useStateDbOnly: true` returned a stored thread.
4. A redacted `thread/read(includeTurns: true)` returned counts/statuses and
   item type names without retaining transcript content.

The returned thread included `id`, `sessionId`, `parentThreadId`,
`forkedFromId`, `modelProvider`, `status`, `cliVersion`, `source`,
`agentNickname`, and `agentRole`. Generated contracts establish:

- `Thread.id` is the thread identity.
- `Thread.sessionId` groups threads in one session tree.
- `Thread.parentThreadId` is set for a subagent.
- `SubAgentSource.thread_spawn` carries parent thread, depth, path, nickname,
  and role.
- `forkedFromId` is fork lineage and must not be treated as a spawn parent.
- `collabAgentToolCall` carries sender, receivers, operation, requested model,
  requested reasoning effort, status, and known agent states.
- `ThreadSettings` carries effective model, provider, and effort settings.
- `model/rerouted` records from/to model for a turn.
- `turn/started`, `turn/completed`, `item/started`, `item/completed`, and
  `thread/status/changed` supply lifecycle evidence.
- App-server notifications have no guaranteed source sequence cursor.
  Reconnection therefore requires list/read reconciliation and idempotent
  event reduction.
- `thread/read` is an unpaginated one-shot response. The bridge accepts real
  responses only under an 8 MiB line cap; `thread/list` uses bounded pages.

The installed standalone CLI is 0.145.0 while an existing stored thread reports
a newer embedded CLI. Every connection records the handshake user agent and
thread `cliVersion`, capability-detects methods, tolerates unknown fields, and
rejects any binary/schema/user-agent tuple outside the tested adapter allowlist.

See [the retained runtime probe](../evidence/phase-a/RUNTIME_PROBE.md),
[schema/binary hashes](../evidence/phase-a/SCHEMA_HASHES.txt), and
[the real bridge smoke](../evidence/phase-b/REAL_BRIDGE_SMOKE.md). The
end-to-end local runtime/REST/MCP result is
[REAL_RUNTIME_ACCEPTANCE.md](../evidence/phase-f/REAL_RUNTIME_ACCEPTANCE.md).

### ChatGPT MCP App

Official ChatGPT Apps documentation establishes:

- UI resources are linked using `_meta.ui.resourceUri`.
- MCP Apps communicate with the host using the `ui/*` JSON-RPC bridge over
  `postMessage`.
- Tool input and results arrive through `ui/notifications/tool-input` and
  `ui/notifications/tool-result`.
- A component calls tools through `tools/call` and sends model-visible context
  through supported bridge messages.
- Fullscreen is a host presentation mode; the ChatGPT composer remains
  available.
- Business and cross-session data belongs on the server. Widget state belongs
  only to one rendered component instance.
- Data tools are separate from render tools; only the render tool links the UI
  resource.
- `structuredContent` is visible to both model and component; tool-result
  `_meta` is component-only but still untrusted UI input.
- Tool outputs declare schemas, and the UI treats received structured content
  as untrusted input.
- Widget connection, resource, and frame domains are declared through
  `_meta.ui.csp`; redirect destinations additionally require
  `_meta["openai/widgetCSP"].redirect_domains`.

References: [Add UI to an MCP server](https://developers.openai.com/plugins/build/chatgpt-ui),
[Apps reference](https://developers.openai.com/plugins/reference), and
[UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines).

## 3. Selected architecture

### One local runtime client

The production composition creates one `CodexRuntimeController` and one
read-only app-server client before pairing. The controller's accepted adapter
gate is sufficient for bounded source-root attestation, but notification
ingestion and reconciliation are disabled until a durable active pairing
binding resolves to the installation/root/session.

The signed pairing challenge carries the server-generated installation, exact
source root, source session, short-lived attestation digest and expiry. The
server rejects missing, expired, mismatched, or caller-invented attestation
values before accepting the bridge signature. Issuing the pairing credential
activates the already-running client; no second process/client is created.
Every event rechecks the durable binding. Revocation, expiry, close, or an
ambiguous installation fails closed and stops ingestion. The same narrow
read-only facade is shared by pairing and reconciliation; it does not expose a
generic RPC method.

### Local bridge and source-root authority

The bridge allowlists only `initialize`, `initialized`, `thread/list`,
`thread/read`, and `model/list`. All mutation, process/filesystem/account,
configuration-write, remote-control, resume, turn-start, steer, and interrupt
methods are rejected before transport. WebSocket is not a V1 production
transport.

Root selection happens locally with explicit user consent. The authority lists
and reads bounded sanitized thread metadata, validates one global root/session
lineage, and returns only metadata plus a digest. Reconciliation chooses the
configured root and reads that selected subtree breadth-first. It discovers
additional children only from sanitized `subagentActivity` or collaboration
references; unrelated global `thread/list` debris is ignored. A malformed,
conflicting, cyclic, or orphaned reference inside the selected tree fails
closed. Unselected threads, raw user messages, reasoning, commands, paths, file
changes, tool arguments, tokens, and approvals never leave the Mac. A final
result summary is opt-in, locally redacted, bounded, and attributable.

The complete enforcement contract is
[BRIDGE_SECURITY_CONTRACT.md](BRIDGE_SECURITY_CONTRACT.md).

### Durable backend

The backend stores an append-only sanitized event log and deterministic
projections:

- `app_sessions`: server-generated `agentSessionId`, owner, tenant, status,
  source adapter, schema version, selected root/session, watermark, and
  capabilities.
- `agents` and `agent_edges`: one verified spawn parent per non-root node.
- `identity_evidence`: requested and observed model/effort/provider with
  source, timestamp, hash, and trust class.
- `sanitized_events` and `event_quarantine`: connection epoch, backend
  `ingestOrdinal` (arrival order only), source identity, sanitized payload hash,
  redacted payload, correlation, authority, and redaction version.
- `bridge_bindings`, idempotency, and audit records.
- Optional rollout identity is read only from the absolute configured sessions
  root. The reader may additionally inspect only that root's
  `session_index.jsonl` sibling for a bounded, sanitized title fallback. It
  retains only provider/model/effort, structural spawn task labels, and the
  matched title after exact correlation; it never persists source IDs, prompts,
  messages, paths, function-call arguments, credentials, or secrets.
- `mcp_grant_session_bindings`: schema v2 mapping represented only by a keyed
  digest of owner/tenant/subject/resource/refresh-stable OAuth `sid` to a
  server-generated Agent Farm session. Raw bearer, `sid`, and `jti` values are
  never persisted.

The Agent Farm `agentSessionId` is the public projection boundary. ChatGPT
conversation identifiers, MCP protocol session IDs, raw Codex paths, and JWT
`jti` values are never authorization boundaries.

### API and MCP tools

Exactly four public tools are registered:

- `create_agent_session` — creates only the bound Agent Farm visualization
  session, with server-generated identity and owner-scoped idempotency.
- `get_agent_hierarchy` — paginated, schema-validated hierarchy.
- `get_agent_details` — one sanitized agent record.
- `render_agent_hierarchy` — bounded render projection and UI resource link.

The first tool has a server-side persistence effect, but no Codex side effect.
`control_agent` is absent from registration, advertisement, routing, and the
resource. Supplied owner, tenant, source-root, or Agent Farm session values are
ignored or rejected; the verified MCP grant and manager-selected binding are
authoritative.

### MCP grant/session continuity

The stateful Streamable HTTP manager creates one fresh SDK application and
protocol transport per MCP connection. At initialize it requires verified
owner, tenant, subject, resource, refresh-stable `sid`, and current `jti`.
The manager generates an opaque MCP protocol session ID and a candidate Agent
Farm session ID, then atomically resolves the durable grant digest. A remount,
refresh with a rotated `jti`, or process restart returns the same Agent Farm
session for the same grant. A different grant is non-enumerably rejected on an
existing MCP session and receives a different mapping when initialized.

The manager keeps only the verified identity tuple and SDK transport in memory;
it never retains `AuthInfo`/bearer material. MCP DELETE or idle eviction closes
the protocol transport but does not erase grant continuity. Explicit deletion
of an Agent Farm projection revokes mappings pointing at that session, so a
later remount cannot resurrect deleted data.

### Rollout identity supplement

`AGENT_FARM_CODEX_SESSIONS_ROOT` is an absolute production trust-root setting,
but rollout identity is optional evidence rather than topology authority. Each
candidate path is constrained below the realpath-checked, non-symlink root and
bounded by a 256 MiB default file limit and a 512 MiB absolute cap, with file,
line, record, observed-history, spawn-count, path, symlink-component, and
argument-byte limits. The reader accepts only a metadata segment whose
`session_meta.payload.id` matches the selected raw thread ID, plus turn IDs at
or after that thread's creation time. Missing, inherited,
malformed, ambiguous, or unavailable evidence leaves identity unverified; it
does not invalidate an otherwise valid selected tree.
The local title supplement is constrained to the sibling
`session_index.jsonl`, bounded to an 8 MiB default read, and used only when
app-server thread metadata does not contain a title. Unsafe, malformed,
oversized, missing, or symlinked index data leaves the title unavailable.

### Standalone OAuth BFF

The standalone bootstrap first calls same-origin `/auth/session`. An
unauthenticated browser is redirected to `/auth/login?returnTo=...`, with
query/fragment/credential-like data stripped. The BFF performs authorization
code + PKCE, validates state/nonce and token issuer/audience/resource, rotates
refresh tokens, sets secure HttpOnly SameSite cookies, enforces CSRF on
mutations, and supports logout/revocation. `/api/v1/browser/session` derives an
owner-scoped idempotency key from a server-only browser-session ID and returns
only the public Agent Farm session ID.

The BFF's current session registry is process-local. Restart or multi-instance
deployment requires re-authentication until an equivalent shared durable
registry is supplied. Component tests use a fake provider; a live OAuth
callback and public HTTPS origin remain HOLD gates.

### React frontend

Components depend on a protocol-neutral `HostAdapter`. Standalone and MCP
adapters provide the same versioned snapshots/events to a normalized store. The
tree detects cycles, missing parents, backend delivery/version
discontinuities, unknown values, and stale connections rather than silently
flattening or dropping them. It never claims to detect app-server source gaps.

The UI keeps connection state separate from agent lifecycle and identity
verification. It exposes recursive tree semantics, keyboard navigation,
search/filter/focus, stable selection, responsive tree/details layouts,
fullscreen requests, and explicit disconnected/unverified states.

Inline ChatGPT presentation is a bounded, non-scrolling summary with counts,
connection truth, one branch preview, and an Expand action. Recursive
navigation and the details inspector run only in fullscreen or standalone
layouts. The generated MCP resource is self-contained and integrity-checked.

The local MCP protocol/resource/fullscreen path is covered by the runtime
acceptance. Real ChatGPT host rendering, ChatGPT fullscreen navigation, and
built-in-browser interaction remain separate external gates.

## 4. Invariants

1. Exactly one root is selected per Agent Farm session.
2. Every verified non-root node has one parent in the same session.
3. Self-parent, cycles, cross-session edges, and duplicate source identities are
   rejected or quarantined.
4. Parent terminal state does not silently terminate descendants.
5. Spawn edges require app-server parent/child evidence; unresolved nodes remain
   visibly unattached or unverified.
6. Requested identity comes from the authenticated spawn event. Runtime
   identity comes from thread settings and reroute evidence.
7. Requested values are never overwritten by observed values.
8. Missing or conflicting runtime evidence is displayed as unverified or
   mismatch.
9. Thread lifecycle is reusable: a thread may move between idle and active.
   Terminality belongs to a turn generation keyed by thread and turn IDs.
   Reconciliation may correct an earlier derived display state.
10. A projection rebuilt from sanitized events plus the same reconciliation
    snapshot must match the live projection at the same backend watermark.
11. Unknown fields are discarded before hashing, persistence, or logging.
    Unknown enum values render as Unknown.
12. Refresh/remount reads the same server Agent Farm session for the same OAuth
    grant and never creates one implicitly by client-supplied ID.
13. MCP protocol IDs, OAuth `jti`, conversation IDs, and UI state cannot select
    or authorize an Agent Farm session.
14. A grant digest is owner/tenant/subject/resource/`sid` scoped, expires
    boundedly, and is revoked when its explicitly bound Agent Farm projection
    is deleted.
15. Source-root pairing requires a fresh server attestation digest/session/
    expiry and exact installation/root match.
16. One accepted pre-pair runtime client is activated after durable pairing;
    no second client/process is introduced by pairing.
17. Runtime events recheck active durable binding before ingestion; revocation,
    expiry, ambiguity, or adapter quarantine fails closed.
18. `thread/read` is one-shot/unpaginated and bounded by the 8 MiB bridge line
    cap. Production restart reconciliation requests metadata only
    (`includeTurns:false`); it never risks an unbounded turn response or assumes
    a source cursor that Codex does not provide.
19. Production selected-tree topology is authoritative `thread/list` parentage
    validated by metadata-only reads. The generic reconciler may add a child
    only from sanitized structural activity when bounded turn evidence is
    explicitly available; unrelated global graph debris is ignored, while
    selected-tree malformed, conflicting, cyclic, or orphaned references fail
    closed.
20. Rollout identity is optional evidence and remains unverified when bounded
    exact-thread/turn correlation cannot be established.
21. Production startup requires a durable database, HTTPS trust metadata,
    explicit origin/host allowlists, pinned Codex executable/SHA/installation,
    the absolute `AGENT_FARM_CODEX_SESSIONS_ROOT`, remote token status, BFF
    settings, and the MCP grant digest key.

## 5. Authentication and isolation

- Standalone users authenticate through the application BFF and receive a
  secure, short-lived web session cookie. Tokens remain server-side.
- ChatGPT uses OAuth 2.1 authorization code with PKCE, protected-resource and
  authorization-server metadata, exact resource/audience binding, per-tool
  scopes, bearer verification on every request, and required `jti`.
- The widget cannot authorize itself with ChatGPT metadata, tool arguments,
  conversation IDs, user-agent values, or component state.
- The server derives owner, tenant, and Agent Farm session from verified grant
  context and rejects a pre-bound caller session.
- The bridge uses an outbound, device-bound credential obtained through
  one-time user-authorized pairing. Pairing binds one installation, owner,
  server-attested source root/session, and Agent Farm session; replay,
  reassignment, or revoked credentials fail closed.
- Every database row, query, stream topic, cache key, and audit event is scoped
  by tenant, owner, and `agentSessionId`.
- Tokens never appear in URLs, widget state, tool results, logs, durable grant
  rows, or browser local storage.
- CSP, origin checks, schemas, size limits, pagination, output escaping, rate
  limits, and reconnect caps fail closed.
- Missing and unauthorized sessions use non-enumerating errors.

Per-principal flows, tool annotations, scopes, inline/fullscreen rules, and CSP
surfaces are frozen in [AUTH_AND_TOOL_MATRIX.md](AUTH_AND_TOOL_MATRIX.md).

## 6. Phase A decision and remaining gates

Phase B/C implementation and the local runtime milestone were authorized because
the contract:

- uses version-gated app-server bindings;
- enforces method and field allowlists before transport/transfer;
- has explicit local root consent, redaction, retention, and deletion rules;
- treats backend sequence as ingestion order rather than source order;
- binds bridge installation, owner, attested root, and Agent Farm session
  securely;
- separates requested and observed identity;
- treats app-server reconciliation as authoritative after reconnect;
- provides no Codex control surface;
- keeps server state authoritative; and
- preserves session isolation; the local runtime/REST/MCP hierarchy and
  requested-vs-observed identity are now proven by
  [REAL_RUNTIME_ACCEPTANCE.md](../evidence/phase-f/REAL_RUNTIME_ACCEPTANCE.md)
  and [REAL_RUNTIME_ACCEPTANCE_RUN.json](../evidence/phase-f/REAL_RUNTIME_ACCEPTANCE_RUN.json);
  real ChatGPT host acceptance remains a later gate.

### Local runtime milestone (PASS)

The phase-F run used one pinned local app-server client and proves an evolving
83-agent/82-edge selected projection through authenticated REST and the
official stateful MCP hierarchy tool. The required branch remains exact:

```text
Main
└── Dirac
    ├── Rhea
    │   └── Noether
    └── Kuhn
```

| Agent | Parent | Requested | Runtime observed | Provider | Verification |
|---|---|---|---|---|---|
| Main | — | — | Sol XHigh | OpenAI | Unverified (no model requested) |
| Dirac | Main | Sol High | Sol High | OpenAI | Verified |
| Rhea | Dirac | Luna Max | Luna Max | OpenAI | Verified |
| Kuhn | Dirac | Sol Medium | Sol Medium | OpenAI | Verified |
| Noether | Rhea | Sol Low | Sol Low | OpenAI | Verified |

The required branch contains four exact edges inside the larger projection;
both REST and MCP reconcile 83 agents and 82 edges, and MCP provisioned a
visualization session through a genuine successful `create_agent_session`
call. Source IDs, prompts, messages, paths, function-call arguments,
credentials, and OAuth values are intentionally absent.

The following remain unclaimed HOLD gates:

- two independent live OAuth principals, live authorization-server
  callback/refresh/revocation, and a public HTTPS deployment;
- real ChatGPT host tool invocation, ChatGPT fullscreen rendering, and
  built-in-browser interaction/console evidence;
- screen-reader/keyboard acceptance on standalone and MCP fullscreen surfaces;
  and
- 25-active/200-completed pagination and latency under a real browser/host.
