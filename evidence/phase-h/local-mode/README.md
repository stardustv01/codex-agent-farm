# Phase H local-only mode

Status: **Local V1 PASS under the approved standard**. The current authoritative
record is [`FINAL_LOCAL_V1_ACCEPTANCE.md`](FINAL_LOCAL_V1_ACCEPTANCE.md).
The earlier 22 PASS / 1 BLOCKED campaign is retained under
[`archive/superseded-pre-final-2026-08-12/`](archive/superseded-pre-final-2026-08-12/)
and is not current acceptance evidence. This directory records the
current local-only procedure, launcher hardening, and the completed replacement
campaign. Fresh install, exact-current real runtime/browser identity, restart,
and guarded cleanup were exercised and accepted.
macOS VoiceOver certification is explicitly deferred from Local V1 by the
product owner (2026-08-12) and is not represented as a PASS.
The historical fixed-principal procedure is superseded; the active server now
requires an automatic HttpOnly local session and CSRF protection for mutations.

## Scope

Local mode is an explicit repository-local operating mode enabled by
`AGENT_FARM_LOCAL_MODE=1`. The `pnpm start:local` launcher supplies that flag,
fixes the listener host to `127.0.0.1`, and serves the built web app at
`http://127.0.0.1:8787` by default. The durable database is
`.agent-farm/local.sqlite`.

Agent Farm remains a read-only hierarchy viewer. The launcher serves the built
web app at `http://127.0.0.1:8787` by default. A read-only
`/api/v1/local/bootstrap` request issues one short-lived bootstrap cookie and a
separate CSRF value; the session POST consumes both and sets an opaque local
session cookie. A later bootstrap-bound session POST rotates a still-valid
cookie for browser reload and rejects the old cookie. Status, hierarchy, and
pairing require the server-issued session, while every mutation consumes the
matching CSRF token and returns a replacement even when its handler fails.

## Security boundary

- The listener is loopback-only. The local launcher sets `HOST=127.0.0.1`;
  server configuration rejects a non-loopback host, origin, or explicit
  foreign `Host` header before authentication.
- A request must come from the loopback socket with the exact configured
  `Host`/port. Foreign/malformed origins, forwarded headers, bearer headers,
  and token-like query/fragment state (including encoded API-key aliases) are
  rejected before handlers or, for browser-only fragments, before bootstrap.
- OAuth and token-status settings are not part of local mode. Supplying those
  production settings with local mode is invalid configuration. CSRF is part
  of local mode: session creation consumes one-time bootstrap CSRF, and every
  later mutation requires the session-bound header.
- The default HTTP loopback boundary omits `Secure` only because it is not TLS;
  HTTPS transport adds `Secure`. Session records are process-memory state and
  invalidate on restart; persisted keys remain installation-owned only.
- The local database is durable SQLite under the repository-local
  `.agent-farm/` directory. The generated configuration contains model-budget
  values only; it is not a secret store.

## Environment and generated files

| Setting or file | Local-mode value or purpose |
|---|---|
| `AGENT_FARM_LOCAL_MODE` | `1`; explicit local-only switch |
| `HOST` | `127.0.0.1` (set by `pnpm start:local`) |
| `PORT` | `8787` by default; the launcher may use an explicitly supplied local port |
| `AGENT_FARM_DATABASE` | `.agent-farm/local.sqlite` |
| `AGENT_FARM_BUDGET_SOL_HIGH` | Integer from 0 through 10 |
| `AGENT_FARM_BUDGET_LUNA_MAX` | Integer from 0 through 10 |
| `AGENT_FARM_BUDGET_SOL_MAX` | Integer from 2 through 3 |
| combined budget | The three values must sum to 25 or less |
| `.agent-farm/budget.env` | Generated local-mode flag and budget values |
| `.agent-farm/README.txt` | Generated note explaining the repository-local configuration |
| `.agent-farm/local.sqlite` | Durable local projection created/used by the server |
| `.agent-farm/local-auth/` | 0700 Agent Farm data directory containing 0600 installation secret and independent signing key |

The setup defaults are Sol High 10, Luna Max 10, and Sol Max 3. The generated
budget file has this shape (the values depend on the selected budget):

```text
AGENT_FARM_LOCAL_MODE="1"
AGENT_FARM_BUDGET_SOL_HIGH="10"
AGENT_FARM_BUDGET_LUNA_MAX="10"
AGENT_FARM_BUDGET_SOL_MAX="3"
```

The `.agent-farm/` directory is repository-local and ignored by Git. Do not
copy it into a release artifact or use it as evidence that a real runtime gate
passed. Setup requires this directory to be a real owner-only 0700 directory;
the generated budget/readme and key files are owner-only 0600. Existing valid
budget values are preserved when setup is rerun without `--budget`; unsafe
symlinks, ownership, or modes fail closed. The user checkout configuration is
not a cleanup target.

## Exact commands

Run these commands from the repository root on a supported Mac with Node.js
22.17.0 or newer, pnpm 11.16.0, and an executable Codex CLI at
`~/.local/bin/codex`:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm run setup
pnpm doctor:local
pnpm start:local
```

`pnpm run setup` prompts for Sol High, Luna Max, and Sol Max limits. For a
non-interactive default-budget setup, use:

```sh
pnpm run setup --budget=10,10,3
```

For an acceptance campaign, pass the isolated absolute data directory
explicitly to doctor and cleanup. The normal repository checkout directory is
deliberately not an implicit destructive target:

```sh
pnpm doctor:local -- --data-dir=/private/tmp/agent-farm-g8/.agent-farm --json
pnpm reset:local -- --data-dir=/private/tmp/agent-farm-g8/.agent-farm --yes --unpaired
# or, after the same successful unpair guard:
pnpm uninstall:local -- --data-dir=/private/tmp/agent-farm-g8/.agent-farm --yes --unpaired
```

`pnpm build` writes an owner-only build manifest containing a source digest and
server/web output hashes. `pnpm start:local` refuses stale or missing outputs,
preflights the exact loopback port, starts only the verified built server, and
waits for `/healthz` before reporting readiness. It never falls back to a
TypeScript entry point.

If the web assets have already been installed but are absent, the launcher can
build them before starting (the resulting source/output manifest is still
required):

```sh
pnpm start:local --build
```

Open `http://127.0.0.1:8787` only after the launcher reports that the server is
running. Stop it with Ctrl-C. The commands above are the acceptance procedure,
not evidence by themselves; record the actual output and browser observations
in `FINAL_LOCAL_V1_ACCEPTANCE.md` when the gate is run.
