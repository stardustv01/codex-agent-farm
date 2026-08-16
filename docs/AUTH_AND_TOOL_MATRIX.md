# Authentication and Tool Matrix

Agent Farm has independent trust paths. No browser, ChatGPT, MCP, widget, or
bridge caller can choose another principal or Agent Farm session by placing an
ID in a request.

## Local-only mode

`AGENT_FARM_LOCAL_MODE=1` is an explicit repository-local operating mode. G3
binds it to the exact loopback host/port and rejects foreign/malformed Host or
Origin values, forwarded headers, bearer headers, and token-like URL state. A
minimal `/api/v1/local/bootstrap` GET issues a short-lived HttpOnly bootstrap
cookie and one-time CSRF value. The session POST consumes both and issues an
opaque `agent-farm-local-session` cookie with `HttpOnly`, `SameSite=Strict`, and
`Path=/` (plus `Secure` when the transport is HTTPS). Status and reads require
that cookie; every local mutation, including generic REST and MCP POST/DELETE,
requires a matching session-bound CSRF header. Each validated mutation
consumes its CSRF token and returns a replacement even when the handler fails;
the standalone UI retains that replacement before a retry. A bootstrap-bound
browser reload rotates a valid session cookie and rejects the old cookie. The
generated launcher sets
`HOST=127.0.0.1`, stores SQLite at `.agent-farm/local.sqlite`, and stores
installation key material under `.agent-farm/local-auth/` with 0700/0600
permissions. A loopback network position alone does not authorize access.

Local session records are process-memory state and therefore invalidate on
restart; persisted installation/signing keys are never returned to the browser,
logged, placed in URLs, or copied into evidence. G4 opaque task selection and
raw source-root ID removal remain HOLD.

The current advisory budget display accepts
`AGENT_FARM_BUDGET_SOL_HIGH` (0-10), `AGENT_FARM_BUDGET_LUNA_MAX` (0-10), and
`AGENT_FARM_BUDGET_SOL_MAX` (2-3). Their combined value cannot exceed 25; the
generated defaults are `10`, `10`, and `3`. These settings contain no secrets,
and Agent Farm does not modify or enforce Codex concurrency.
Setup hashes `~/.local/bin/codex` against the retained Phase-A pin before
writing local configuration. Agent Farm local mode requires the pinned,
hash-verified Codex CLI (0.145.0; see `PHASE_A_BINARY_SHA256`). Other Codex
versions cannot pass this setup preflight; if setup is bypassed, they fail
pairing/hierarchy.
Production mode is unchanged and continues to require the OAuth, CSRF, origin,
host, identity, and secret boundaries documented below.

## Independent trust paths

| Path | Authentication | Server-owned authorization boundary |
|---|---|---|
| Standalone browser to backend | OAuth authorization-code + PKCE BFF; secure HttpOnly SameSite cookie; CSRF token on mutations | Verified owner/tenant plus browser session; `/api/v1/browser/session` derives an owner-scoped Agent Farm session idempotently |
| ChatGPT host to MCP | OAuth 2.1 authorization code + PKCE; protected-resource and authorization-server metadata | Verified signature, issuer, audience/resource, expiry, required `jti`, and per-tool scopes |
| MCP widget to tools | Host `tools/call`; no widget-owned credential | Same server verification as the host call; widget arguments and `_meta` never establish owner or session |
| MCP protocol session | SDK-issued opaque `Mcp-Session-Id` plus current verified grant | Stateful manager stores verified owner/tenant/subject/resource/`sid` tuple; rotated `jti` may continue the same grant |
| Local bridge to backend | One-time user-approved pairing and device-bound revocable credential | Owner + installation + server-attested source root/session + Agent Farm session; every event rechecks active binding |

ChatGPT metadata, conversation IDs, user-agent values, widget state, tool
arguments, and `_meta` values are untrusted hints and never authorize access.

## MCP grant/session binding

At MCP initialization, the server requires these verified values:

```text
owner, tenant, subject, resource, refresh-stable OAuth sid, current token jti
```

`jti` is required for the current token check but is intentionally not part of
the remount identity because a refresh may rotate it. The durable store writes
only an HMAC-SHA-256 digest of `owner + tenant + subject + resource + sid`,
plus the server-generated Agent Farm session id, lifecycle, expiry, and audit
timestamps. Raw bearer material, `sid`, `jti`, and AuthInfo are not persisted.

The MCP manager generates both the opaque protocol-session ID and a candidate
Agent Farm session ID. An atomic durable get-or-create selects the authoritative
Agent Farm ID. Therefore:

- the same grant reuses one Agent Farm session across remounts, rotated `jti`,
  and process restart;
- a different grant cannot attach to an existing protocol session and receives
  a different durable mapping;
- a caller-supplied `agentSessionId` claim is rejected, and tool arguments cannot
  select a different session; and
- MCP DELETE/idle eviction closes only the protocol transport. Explicit Agent
  Farm projection deletion revokes all mappings to that session, preventing
  resurrection on a later remount.

## MCP tool contract

Exactly four public tools are registered and advertised:

| Tool | Scope | Codex side effect | Agent Farm side effect | Annotation |
|---|---|---|---|---|
| `create_agent_session` | `agent-session:create` | None | Creates the bound view session; owner-scoped idempotency required | Not read-only for Agent Farm storage; read-only with respect to Codex |
| `get_agent_hierarchy` | `agent-session:read` | None | None | Read-only, paginated |
| `get_agent_details` | `agent-session:read-details` | None | None | Read-only |
| `render_agent_hierarchy` | `agent-session:render` | None | None; links `_meta.ui.resourceUri` | Read-only render/resource tool |

`control_agent` is not registered, advertised, routable, or present in V1.
There are no mutation, interrupt, steer, stop, resume, filesystem, or account
tools. All outputs are sanitized, bounded, schema-validated, and derived from
the server projection.

The MCP server publishes protected-resource metadata and per-tool
`securitySchemes`. ChatGPT receives a `WWW-Authenticate` challenge when
authorization is absent or insufficient. The authorization server echoes the
RFC 8707 resource into the token audience; the resource server verifies every
bearer token, required scopes, and current token status.

Official references:
[Authentication](https://developers.openai.com/plugins/build/auth) and
[Security and Privacy](https://developers.openai.com/plugins/guides/security-privacy).

## Pairing and source-root trust

The production runtime starts one accepted, read-only app-server client before
pairing. The source-root authority uses that same narrow client to validate a
bounded list/read snapshot and issue a short-lived metadata-only attestation.
The challenge binds installation, exact root, source session, attestation digest,
attestation expiry, owner/tenant, and Agent Farm session. Caller-invented or
stale root/session/digest values fail before signature acceptance. Credential
issuance activates the same client; revocation or ambiguity stops ingestion.

The selected-root reconciler reads the root subtree breadth-first. It may add a
child only from a sanitized `subagentActivity` or collaboration reference and
then requires the child's direct read to prove the expected parent. Unrelated
global `thread/list` records are ignored. A malformed, conflicting, cyclic, or
orphaned reference inside the selected tree fails closed. `thread/read` is a
one-shot unpaginated method; the bridge enforces an 8 MiB line cap while
`thread/list` uses bounded pages.

## Rollout identity supplement

Production requires the absolute `AGENT_FARM_CODEX_SESSIONS_ROOT` trust root.
Rollout identity remains optional evidence: the bounded reader checks realpath,
rejects symlink components, applies a 64 MiB default file bound and 128 MiB
absolute cap plus file/line/record/history/spawn/path/argument limits, and
correlates only the selected thread's matching session segment and
post-creation turn IDs. It retains only provider/model/effort and structural
spawn task labels. Missing, inherited, malformed, ambiguous, or unavailable
records leave identity unverified and never alter topology. Source IDs, prompts,
messages, paths, function-call arguments, credentials, and secrets are not
returned by the reader or public REST/MCP surfaces.

## Standalone browser BFF

The BFF exposes `/auth/login`, `/auth/callback`, `/auth/session`, `/auth/csrf`,
and `/auth/logout`. It validates state/nonce and PKCE, keeps access/refresh
tokens server-side, rotates refresh tokens, uses secure HttpOnly cookies, and
requires CSRF for browser mutations. `/api/v1/browser/session` never accepts a
client-generated session identity and returns only a public Agent Farm session
ID. The current BFF registry is process-local; restart/multi-instance
re-authentication is a documented limitation until a shared durable registry is
introduced. Local tests use a fake provider; live HTTPS/OAuth is still HOLD.

## UI presentation

Inline mode is a bounded summary with no nested scrolling or deep navigation.
It shows connection truth, counts, one short branch preview, and Expand.
Fullscreen and standalone modes provide the navigable recursive tree, search,
filters, branch focus, and details.

The generated UI resource is self-contained and integrity-checked. Its standard
component CSP uses `_meta.ui.csp` for connection, resource, and frame domains.
Any external redirect also requires the ChatGPT compatibility surface
`_meta["openai/widgetCSP"].redirect_domains`. Origins are exact and minimal;
postMessage handling validates source, origin, method, and schema.

The local MCP protocol/resource/fullscreen contract is PASS, including the
evolving 83-agent/82-edge REST/MCP projection and exact required branch
identity result recorded in
[REAL_RUNTIME_ACCEPTANCE.md](../evidence/phase-f/REAL_RUNTIME_ACCEPTANCE.md)
and [REAL_RUNTIME_ACCEPTANCE_RUN.json](../evidence/phase-f/REAL_RUNTIME_ACCEPTANCE_RUN.json).
External ChatGPT host invocation, ChatGPT fullscreen rendering, and
built-in-browser interaction remain HOLD gates.

## Required negative tests

- missing, expired, wrong-issuer, wrong-audience, wrong-resource, replayed,
  revoked, and wrong-scope tokens;
- missing `sid`/`jti`, rotated `jti` continuity, distinct-grant separation,
  durable remount after process restart, grant expiry, and grant revocation;
- forged owner, tenant, Agent Farm session, source root, source session,
  attestation digest, and bridge installation;
- caller-supplied `agentSessionId` claims and tool arguments attempting to switch
  sessions;
- widget arguments attempting to switch session or principal;
- cross-session hierarchy/detail/render calls and stream subscriptions;
- selected-tree BFS child discovery, unrelated global graph debris, malformed
  selected-tree activity, cycles, orphans, and conflicting parents;
- bridge nonce replay, root substitution, stale attestation, credential reuse,
  and reassignment;
- `create_agent_session` duplicate same-key/same-payload replay and same-key/
  different-payload conflict;
- explicit Agent Farm session deletion revoking its grant mappings;
- MCP DELETE/idle eviction followed by same-grant remount;
- control-tool discovery and invocation while V1 is active; and
- browser cookie fallback rules, CSRF failures, invalid bearer no-fallback,
  token-bearing return URLs, and logout/revocation behavior.

Local passes for these checks are retained in the package/server/integration
tests and the local runtime acceptance. They do not replace live OAuth,
external HTTPS, built-in ChatGPT browser, or real ChatGPT host acceptance.
