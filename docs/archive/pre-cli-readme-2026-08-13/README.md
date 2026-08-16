# Agent Farm

Agent Farm is a read-only companion for viewing recursive Codex subagent
hierarchies. The same React surface is used as:

- a standalone responsive web application; and
- a ChatGPT MCP App component, including fullscreen presentation.

It does not patch, replace, re-sign, or depend on `/Applications/ChatGPT.app`,
and it does not use unrelated third-party local applications. V1 cannot create, resume, steer, interrupt,
archive, delete, or otherwise control a Codex thread. `create_agent_session`
creates only an Agent Farm visualization session; it never spawns a Codex
agent.

## Local install and run

Local mode requires Node.js 22.17.0 or newer, pnpm 11.16.0, and an executable
Codex CLI at `~/.local/bin/codex`. The setup preflight also hashes that binary
against the retained Phase-A pin. Agent Farm local mode requires the pinned,
hash-verified Codex CLI (0.145.0; see `PHASE_A_BINARY_SHA256`). Other Codex
versions cannot pass this setup preflight; if setup is bypassed, they fail
pairing/hierarchy. Anyone with those prerequisites can install and run this
checkout directly:

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm run setup
pnpm doctor:local
pnpm start:local
```

`pnpm run setup` writes repository-local configuration under `.agent-farm/`
and prompts for the Sol High, Luna Max, and Sol Max concurrency budgets.
Defaults are `10/10/3`; the combined budget cannot exceed 25. These values are
advisory display metadata only: Agent Farm does not modify or enforce Codex
concurrency. The explicit `run` is required because `pnpm setup` is a pnpm
command, not a package-script shortcut. Setup creates a real 0700
`.agent-farm/` directory and owner-only 0600 generated files; an existing valid
budget is preserved when setup is rerun without `--budget`. Symlinks, unsafe
ownership, and unsafe modes fail closed rather than being repaired implicitly.

`pnpm doctor:local` is read-only and checks the pinned Node/pnpm/Codex
preflight, configuration permissions, local key/database permissions, build
manifest freshness, and optional loopback readiness. `pnpm build` writes a
source/output hash manifest; `pnpm start:local` uses only the verified built
server, rejects stale or missing assets, preflights the exact loopback port,
and waits for `/healthz` before reporting readiness. It never falls back to a
TypeScript source entry point. Doctor accepts pnpm's single optional leading
separator (for example, `pnpm doctor:local -- --json`); repeated or misplaced
separators and unknown arguments fail closed.

Reset/uninstall are guarded and never target the checkout configuration by
default. Use an explicit isolated absolute data directory, confirmation, and
the successful-unpair acknowledgement only after copying evidence. Each
cleanup package script accepts at most one pnpm separator immediately after
its fixed reset/uninstall mode; leading, duplicate, or misplaced separators,
conflicting cleanup modes, and unknown arguments are rejected:

```sh
pnpm reset:local -- --data-dir=/private/tmp/agent-farm-g8/.agent-farm --yes --unpaired
# or: pnpm uninstall:local -- --data-dir=/private/tmp/agent-farm-g8/.agent-farm --yes --unpaired
```

The current G3 implementation binds local mode to the exact configured
loopback `Host` and port. A read-only `/api/v1/local/bootstrap` request issues
one short-lived HttpOnly bootstrap cookie and a separate one-time CSRF value;
`/api/v1/local/session` consumes both and issues an opaque
`agent-farm-local-session` cookie (`HttpOnly; SameSite=Strict; Path=/`). Status
and hierarchy reads require that server-issued session, and every local
mutation (including MCP POST/DELETE handling) requires the session-bound CSRF
header. Every validated mutation consumes that token and returns a replacement,
including handler failures, and a browser reload rotates a still-valid session
cookie instead of adopting or invalidating it. The default loopback transport
is HTTP, so `Secure` is omitted only on that exact local boundary; HTTPS
transport adds `Secure`. Installation secret and independent signing key files
are generated below `.agent-farm/local-auth` with owner-only permissions;
in-memory sessions intentionally expire on process restart while the durable G4
binding remounts only through the server-owned claim policy. Production OAuth
remains fail-closed and unchanged. G4 opaque selection, G5 public-v1
hierarchy, G6 visual spec, and G7 production renderer are implemented with
targeted evidence; fresh G8 host/runtime/browser/accessibility/cleanup
acceptance remains HOLD.

## Current truth

The local implementation has component and integration evidence for the bridge,
durable SQLite projection, MCP transport, OAuth/session boundaries, standalone
bootstrap, recursive UI, source-root pairing, and the runtime lifecycle. The
real local runtime milestone now passes topology and identity through both the
authenticated REST hierarchy and the official stateful MCP hierarchy tool:
[REAL_RUNTIME_ACCEPTANCE.md](evidence/phase-f/REAL_RUNTIME_ACCEPTANCE.md), with
the machine-readable run record in
[REAL_RUNTIME_ACCEPTANCE_RUN.json](evidence/phase-f/REAL_RUNTIME_ACCEPTANCE_RUN.json).

The retained Phase-F acceptance run contains 83 agents and 82 edges. A later
Phase-G recovery run contains 89 agents and 88 edges; both are immutable,
timestamped snapshots of an evolving task. The required branch remains exact:

```text
Main
└── Dirac
    ├── Rhea
    │   └── Noether
    └── Kuhn
```

| Agent | Parent | Requested | Runtime observed | Verification |
|---|---|---|---|---|
| Main | — | — | Sol XHigh | Unverified (no model requested) |
| Dirac | Main | Sol High | Sol High | Verified |
| Rhea | Dirac | Luna Max | Luna Max | Verified |
| Kuhn | Dirac | Sol Medium | Sol Medium | Verified |
| Noether | Rhea | Sol Low | Sol Low | Verified |

This is a local runtime/REST/MCP PASS, not a release claim. Real dropped-
transport recovery also passes in
[REAL_RUNTIME_RECOVERY.md](evidence/phase-g/REAL_RUNTIME_RECOVERY.md). The live
OAuth provider, external HTTPS deployment, and accessibility remain HOLD
gates. The local MCP protocol/resource/fullscreen contract is tested, but real
ChatGPT host rendering, ChatGPT fullscreen, and built-in-browser acceptance
remain separate HOLD gates. See [the evidence ledger](docs/EVIDENCE_LEDGER.md)
for the boundary.

## Source hierarchy

The supported Codex app-server is the only source authority. Both frontends
consume the same authenticated, server-owned projection:

```text
Codex app-server -> one local read-only client -> durable SQLite projection
                  -> authenticated REST/MCP transport -> React UI
```

The production runtime creates one app-server client before pairing. Its
accepted adapter gate can attest a selected source root, but ingestion stays
disabled until a signed pairing challenge has been verified and a durable
binding is active. Pairing then activates that same client; it does not spawn a
second client. Revocation immediately returns the runtime to an unpaired,
non-ingesting state.

The source root is server-attested from the allowlisted app-server snapshot.
The short-lived attestation digest, source session, installation, and exact
root are included in the signed pairing challenge. Caller-supplied root,
owner, tenant, or Agent Farm session values cannot substitute for these
server-owned values. Reconciliation first selects the configured root and then
walks that selected subtree breadth-first. It may discover additional children
only from sanitized `subagentActivity`/collaboration references; unrelated
global `thread/list` debris is ignored. A malformed, conflicting, cyclic, or
orphaned reference inside the selected tree fails closed instead of being
guessed.

The app-server `thread/read` method is one-shot and unpaginated. The bridge
uses an 8 MiB maximum line cap for real responses and small bounded pages for
`thread/list`; this is a transport safety bound, not a claim that Codex offers
read pagination.

## Identity and remount semantics

MCP protocol sessions and Agent Farm visualization sessions are different
identities. During MCP initialization, the server requires verified owner,
tenant, subject, a refresh-stable OAuth `sid`, and the current token `jti`. It
generates the Agent Farm session ID itself. A caller-supplied `agentSessionId`
claim is rejected; tool arguments cannot select another session.

The durable SQLite store keeps only a keyed digest of
`owner + tenant + subject + resource + sid`; it never stores the bearer token,
raw `sid`, or `jti`. The same grant reuses the same server-generated Agent Farm
session across MCP remounts, refreshes with a rotated `jti`, and a process
restart. A different grant receives a different session. Closing an MCP
transport does not delete that mapping; explicit Agent Farm projection deletion
revokes mappings that point at the deleted session.

Rollout files are an optional identity supplement to topology. Production
requires an absolute `AGENT_FARM_CODEX_SESSIONS_ROOT` trust root, and the
reader reads only bounded, realpath-checked, non-symlink files under that root.
The per-file reader default is **64 MiB**, with an absolute **128 MiB** cap;
line, record, history, spawn, argument, path, and symlink-component limits are
enforced before parsing or correlation.
Only provider/model/effort and structural spawn task labels are retained after
exact selected-thread/turn correlation. Missing, malformed, ambiguous, or
inherited rollout evidence leaves identity `Unverified`; it never changes the
selected topology. No source IDs, prompts, messages, function-call arguments,
paths, credentials, or secret values are exposed in the public projection or
the acceptance artifact.

The public MCP surface is exactly four tools:

1. `create_agent_session` — provisions the bound Agent Farm view session only;
2. `get_agent_hierarchy` — paginated hierarchy data;
3. `get_agent_details` — one agent's sanitized details; and
4. `render_agent_hierarchy` — bounded render data and the UI resource link.

All four are read-only with respect to Codex. `control_agent` and every other
mutation/control descriptor are absent from discovery and routing.

## Standalone browser

The standalone UI uses an OAuth authorization-code + PKCE backend-for-frontend
(BFF). Access and refresh tokens stay server-side. The browser receives only a
secure, short-lived HttpOnly session cookie and a CSRF token for mutations.
`/api/v1/browser/session` provisions an owner-scoped Agent Farm view session
and returns only its public ID; the opaque browser-session ID never leaves the
server. Login, callback, refresh, logout, revocation, CSRF, and token/resource
validation are implemented and locally tested with a fake provider.

The BFF session registry is currently process-local. A process restart or a
multi-instance deployment requires the user to authenticate again unless the
registry is replaced with an equivalent shared durable session store. Do not
present this as a horizontally scalable deployment boundary yet.

## Production configuration

Production startup is fail-closed. It requires a durable SQLite filename,
explicit HTTPS OAuth/resource metadata, exact allowed origins/hosts, remote
token-status verification, standalone BFF settings, a pinned Codex runtime, and
the secret used to digest OAuth grant bindings.

Required environment names are:

```text
AGENT_FARM_DATABASE
AGENT_FARM_JWKS_URI
AGENT_FARM_ISSUER
AGENT_FARM_AUDIENCE
AGENT_FARM_RESOURCE
AGENT_FARM_AUTHORIZATION_SERVER
AGENT_FARM_BROWSER_AUTHORIZATION_ENDPOINT
AGENT_FARM_BROWSER_TOKEN_ENDPOINT
AGENT_FARM_BROWSER_CLIENT_ID
AGENT_FARM_BROWSER_REDIRECT_URI       # exact same origin + /auth/callback
AGENT_FARM_CODEX_EXECUTABLE           # absolute path
AGENT_FARM_CODEX_BINARY_SHA256        # retained Phase-A SHA, exact allowlist
AGENT_FARM_CODEX_INSTALLATION_ID
AGENT_FARM_CODEX_SESSIONS_ROOT         # absolute trusted rollout root
AGENT_FARM_MCP_GRANT_DIGEST_KEY       # printable secret, at least 32 chars
AGENT_FARM_TOKEN_STATUS_URL
AGENT_FARM_TOKEN_STATUS_SECRET
AGENT_FARM_ALLOWED_ORIGINS             # explicit comma-separated origins
AGENT_FARM_ALLOWED_HOSTS               # explicit comma-separated hosts
```

Production allowed origins must use `https://`; the parser rejects an
`http://` origin outside explicit development mode. `AGENT_FARM_DEV_MODE=1`
may infer or accept a loopback HTTP origin for local work only. The server does
not trust `X-Forwarded-Proto`, `X-Forwarded-Host`, or other proxy headers to
relax this policy. For deployment, terminate TLS at an operator-managed edge,
forward only over a private authenticated hop, preserve the public `Host` and
`Origin` values expected by the configured allowlists, and configure the exact
public HTTPS origin here.

The runtime arguments are fixed to `codex app-server --stdio`; arbitrary
runtime arguments are not accepted from configuration. Optional settings
include `AGENT_FARM_BROWSER_REVOCATION_ENDPOINT`, token-status bounds,
`AGENT_FARM_WEB_DIST`, `HOST`, and `PORT`. `AGENT_FARM_DEV_MODE=1` supplies
only local development defaults (including a local sessions root) and must not
be used as production policy. The rollout reader itself is semantically
optional: a missing or rejected individual rollout file leaves topology usable
and identity unverified, while the production trust root setting remains
required and bounded.

## Build and local checks

From this checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm doctor:local -- --json
node --import tsx evidence/phase-e/production-preflight.mts
```

The production preflight is offline and secret-safe: it parses the complete
production configuration shape using synthetic placeholders, checks that
production rejects HTTP origins, and verifies the built standalone assets plus
the self-contained MCP resource manifest/hash. It never opens a socket or
prints environment values.

`pnpm check` runs typechecks, package tests, integration tests, and the
self-contained web/MCP build. The real local bridge smoke is opt-in and
read-only:

```sh
AGENT_FARM_REAL_CODEX_SMOKE=1 \
  node --import tsx --test packages/codex-bridge/test/real-app-server.smoke.test.ts
```

The smoke fingerprint is retained in
[evidence/phase-a/RUNTIME_PROBE.md](evidence/phase-a/RUNTIME_PROBE.md) and
[evidence/phase-b/REAL_BRIDGE_SMOKE.md](evidence/phase-b/REAL_BRIDGE_SMOKE.md).
The real topology/identity REST+MCP acceptance is retained in
[evidence/phase-f/REAL_RUNTIME_ACCEPTANCE.md](evidence/phase-f/REAL_RUNTIME_ACCEPTANCE.md).
The local MCP protocol PASS does not prove external ChatGPT host/fullscreen or
built-in-browser acceptance.

## Deployment and rollback

Use [DEPLOYMENT_AND_ROLLBACK.md](docs/DEPLOYMENT_AND_ROLLBACK.md) for the
operator checklist. In short: back up the SQLite file and environment
secrets, deploy a build whose Codex executable and schema fingerprints are
allowlisted, verify `/healthz` and `/ready`, then exercise authenticated
REST/MCP smoke calls before exposing the service. On rollback, stop the new
process, preserve the database and evidence, restore the last known-good build
and its matching pinned Codex binary/schema, and do not downgrade the schema
without an explicit migration. A failed host/runtime gate is a HOLD, not a
reason to weaken the trust boundaries.

## Governing documents

- [Local V1 release plan](docs/LOCAL_V1_RELEASE_PLAN.md) — authoritative
  gated plan for stabilizing and completing the installable local product.
- [Phase A contract](docs/PHASE_A_CONTRACT.md) — authority, invariants, and
  security boundaries.
- [Authentication and tool matrix](docs/AUTH_AND_TOOL_MATRIX.md) — principals,
  scopes, tool annotations, and negative tests.
- [Evidence ledger](docs/EVIDENCE_LEDGER.md) — verified local evidence versus
  external HOLD gates.
- [Bridge security contract](docs/BRIDGE_SECURITY_CONTRACT.md) — local root,
  redaction, pairing, and retention rules.
- [External ChatGPT acceptance](docs/archive/future-remote/EXTERNAL_CHATGPT_ACCEPTANCE.md) — live
  HTTPS, OAuth, ChatGPT host, fullscreen, accessibility, scale, security, and
  rollback gate.
