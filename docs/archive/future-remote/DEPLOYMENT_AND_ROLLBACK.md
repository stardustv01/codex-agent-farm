# Deployment and rollback checklist

This is an operator checklist for the current Agent Farm boundary. It does
not authorize a public deployment or claim that the external OAuth provider,
HTTPS origin, built-in browser, or ChatGPT host has passed acceptance. The
external acceptance runbook is archived under
[`docs/archive/future-remote/EXTERNAL_CHATGPT_ACCEPTANCE.md`](archive/future-remote/EXTERNAL_CHATGPT_ACCEPTANCE.md)
and remains HOLD.

After deployment, follow the archived
[external ChatGPT acceptance runbook](archive/future-remote/EXTERNAL_CHATGPT_ACCEPTANCE.md) and fill
a fresh copy of its machine-readable evidence template. This deployment
checklist alone cannot change an external gate from HOLD to PASS.

## Local-only mode

Local mode is separate from this production deployment path. With
`AGENT_FARM_LOCAL_MODE=1`, the G3 server enforces an exact loopback host/port,
rejects forwarded or foreign origins, and requires an automatic opaque local
browser session. `/api/v1/local/bootstrap` issues one-time bootstrap material;
`/api/v1/local/session` consumes it and sets the HttpOnly SameSite-Strict
session cookie. Local status, hierarchy, pairing, generic mutations, and MCP
POST/DELETE handling require that session; mutations additionally require the
session-bound CSRF header. The server consumes that token before handler
dispatch and returns a replacement on both handler success and failure. A
bootstrap-bound browser reload rotates a valid session cookie and invalidates
the old cookie. The default HTTP loopback boundary omits `Secure`
only because it is not TLS; HTTPS transport adds `Secure`. Key material lives
under `.agent-farm/local-auth` with owner-only permissions, while in-memory
sessions invalidate on restart.

`pnpm run setup` writes the three advisory display settings
`AGENT_FARM_BUDGET_SOL_HIGH`,
`AGENT_FARM_BUDGET_LUNA_MAX`, and `AGENT_FARM_BUDGET_SOL_MAX` to the ignored
repository-local `.agent-farm/budget.env`; their configured sum cannot exceed
25. Agent Farm does not modify or enforce Codex concurrency.
`pnpm start:local` fixes `HOST=127.0.0.1` and uses
`.agent-farm/local.sqlite` for the database plus `.agent-farm/local-auth/` for
installation key material.
The setup preflight hashes `~/.local/bin/codex` against the retained Phase-A
pin. Agent Farm local mode requires the pinned, hash-verified Codex CLI
(0.145.0; see `PHASE_A_BINARY_SHA256`). Other Codex versions cannot pass this
setup preflight; if setup is bypassed, they fail pairing/hierarchy.

Local mode does not alter, relax, or replace any production requirement in
this checklist. Production startup remains fail-closed and requires its normal
OAuth, CSRF, HTTPS origin, host, runtime identity, and secret configuration.

## Before deployment

1. Keep the checkout isolated from unrelated third-party local applications and `/Applications/ChatGPT.app`.
2. Build from the intended branch and run `pnpm check`. Retain the test/build
   output, `git diff --check`, the web resource integrity hash, and the exact
   Codex bridge smoke evidence.
3. Provision a private durable SQLite path. Back it up before every schema or
   release change. The current durable schema is version 2; do not manually
   delete tables or edit rows to work around a failed migration.
4. Provision the production environment variables listed in
   [README.md](../README.md). In particular, pin:

   - the absolute Codex executable path;
   - the exact allowlisted `AGENT_FARM_CODEX_BINARY_SHA256`;
   - `AGENT_FARM_CODEX_INSTALLATION_ID`;
   - the absolute, operator-approved `AGENT_FARM_CODEX_SESSIONS_ROOT`; and
   - a secret `AGENT_FARM_MCP_GRANT_DIGEST_KEY` (at least 32 printable
     characters, stored in the deployment secret manager).

   The server fixes runtime arguments to `app-server --stdio`; do not add an
   arbitrary args environment variable or wrapper that changes the binary
   identity without a new adapter review.
5. Configure the exact HTTPS resource, issuer, JWKS, authorization server,
   audience, token-status endpoint/secret, allowed origins, and allowed hosts.
   Configure browser authorization/token endpoints, client ID, and a redirect
   URI whose origin exactly matches the protected resource and whose path is
   `/auth/callback`. Register the optional revocation endpoint only when it is
   HTTPS and supported by the provider.
   Production `AGENT_FARM_ALLOWED_ORIGINS` values must be HTTPS; the server
   does not trust forwarded-protocol or forwarded-host headers. Terminate TLS
   at an operator-managed edge, use a private authenticated upstream hop, and
   preserve the public `Host`/`Origin` values that match the exact allowlists.
6. Keep browser OAuth secrets and token-status secrets out of logs, widget
   state, URLs, source control, and SQLite. The BFF's current session registry
   is process-local; schedule re-authentication on restart and do not claim
   multi-instance continuity without a shared durable session registry.

7. `thread/read` is unpaginated, so retain the configured 8 MiB bridge line cap,
   bounded `thread/list` page size, and production metadata-only
   (`includeTurns:false`) reconciliation. The rollout reader is optional
   identity evidence, not topology authority, and is omitted from that
   metadata-only runtime facade: its sessions root is absolute and
   realpath/no-symlink checked, with a 64 MiB default file bound and 128 MiB
   absolute cap plus line/record/history/spawn/path/argument limits. Individual
   missing/malformed/inherited records must leave identity unverified rather
   than block a valid tree.
8. Run the offline packaging preflight after the build. It uses synthetic
   placeholders only, prints variable names/statuses rather than values, and
   verifies production parsing plus the standalone/MCP resource artifacts:

   ```sh
   node --import tsx evidence/phase-e/production-preflight.mts
   ```

## Start and smoke-check

The packaged server entry point is `apps/server/dist/main.js` after the build.
Start it only with the reviewed environment and operator-managed process
supervisor. Verify:

```text
GET /healthz  -> 200 only when dependencies are ready
GET /ready    -> 200 only when dependencies are ready
```

Then perform a fresh authenticated smoke sequence:

1. Browser: `/auth/login` -> provider callback -> `/auth/session` -> CSRF.
2. Browser: `POST /api/v1/browser/session` and confirm only the public
   `agentSessionId` is returned.
3. MCP: initialize a stateful transport, list exactly four tools, create the
   bound Agent Farm view session, read hierarchy/details, and render.
4. Confirm that a caller-supplied Agent Farm session claim, cross-principal
   transport, missing scope, invalid bearer, and `control_agent` all fail
   closed without enumeration.
5. Bridge: use the server-attested source root and signed pairing challenge;
   confirm that pairing activates the same pre-pair client and that revocation
   stops ingestion.
6. Confirm reconciliation reads the selected subtree breadth-first, discovers
   only sanitized structural child references, ignores unrelated global graph
   debris, and fails closed for selected-tree conflicts. Confirm that no source
   IDs, prompts, paths, arguments, credentials, or secrets appear in REST/MCP
   output or logs.

The local runtime/REST/MCP topology+identity gate is already PASS. Its evolving
83-agent/82-edge projection, exact required branch table, genuine MCP session
provisioning result, and private-field scan results are in
[REAL_RUNTIME_ACCEPTANCE.md](../evidence/phase-f/REAL_RUNTIME_ACCEPTANCE.md)
and [REAL_RUNTIME_ACCEPTANCE_RUN.json](../evidence/phase-f/REAL_RUNTIME_ACCEPTANCE_RUN.json).
The MCP protocol/resource/fullscreen path is locally PASS, but the sequence
still requires the live OAuth provider, public HTTPS origin, real ChatGPT host,
ChatGPT fullscreen, and built-in-browser interaction before those external
gates can be marked PASS.

## Rollback

Rollback is a controlled trust-boundary change, not a data reset:

1. Stop the new process and disable external traffic. Preserve logs, health
   results, pairing/audit evidence, and the exact release manifest.
2. Make a read-only copy of the SQLite file and verify its checksum. Preserve
   the live database; never run `rm`, `reset`, or an ad-hoc destructive cleanup
   against the workspace or database.
3. Restore the last known-good application build together with the matching
   pinned Codex executable, binary SHA, generated schema bundle, and tested
   adapter fingerprint. A different Codex binary is quarantined until a new
   adapter review and evidence update pass.
4. Keep the current database schema if the previous build understands it. If a
   prior build cannot read schema version 2, stop and create an explicit,
   reviewed migration/forward-fix; do not silently downgrade or drop
   `mcp_grant_session_bindings`.
5. Rotate compromised OAuth/BFF/token-status/bridge credentials through the
   provider and pairing revocation path. Do not delete durable projection rows
   merely to hide a security incident; retain the audit trail.
6. Start the restored build with the same exact origins/hosts/resource policy,
   verify `/healthz` and `/ready`, and repeat the authenticated smoke sequence.
7. Re-run the real bridge smoke only when the restored binary/hash/schema tuple
   matches the retained evidence. Keep any unresolved external host/runtime
   gate marked HOLD.

## Recovery boundaries

- Closing an MCP transport or restarting the process must not generate a new
  Agent Farm session for the same verified OAuth grant. Durable grant mappings
  are retained until expiry/revocation.
- Explicit Agent Farm projection deletion revokes grant mappings that point at
  the deleted session; a later remount must fail closed rather than resurrect
  data.
- A revoked/expired/ambiguous bridge binding stops runtime ingestion without
  deleting the projection. Re-pair only after the source-root attestation and
  owner/session binding are freshly verified.
- If the standalone BFF process restarts, users may need to authenticate again;
  this is expected with the current process-local registry.
- If a real host/runtime or accessibility gate fails, keep the implementation
  and evidence intact, mark the gate HOLD, and fix the underlying boundary.
  Do not weaken auth, CSP, source-root attestation, or mutation allowlists to
  make a screenshot or HTTP status pass.
