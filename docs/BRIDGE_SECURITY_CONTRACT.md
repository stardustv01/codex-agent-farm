# Bridge Security Contract

## Codex-side read-only definition

The bridge may observe and reconcile selected Codex records. It cannot invoke
any method that creates, loads, resumes, steers, interrupts, archives, deletes,
executes, writes, changes configuration, or controls a Codex thread or process.
Agent Farm database writes are separate and permitted.

## Transport and method enforcement

V1 launches the supported local app-server over stdio. WebSocket, daemon proxy,
remote control, UI scraping, rollout-file tailing, and installed-app internals
are outside V1.

Allowed outbound messages:

| Message | Purpose |
|---|---|
| `initialize` | Negotiate client identity and stable capabilities |
| `initialized` | Complete initialization |
| `thread/list` | Paginated selected-root discovery/reconciliation |
| `thread/read` | Read selected thread turns for local minimization |
| `model/list` | Resolve current model catalog labels/capabilities |

Every other method is rejected locally before serialization. Tests must prove
rejection of at least `thread/start`, `thread/resume`, `thread/fork`,
`thread/archive`, `thread/delete`, `turn/start`, `turn/steer`,
`turn/interrupt`, `command/exec`, `process/spawn`, filesystem writes,
configuration writes, account mutation, and remote-control calls.

Inbound notification parsers accept only versioned lifecycle shapes needed for
projection. Rejected method names may be counted; rejected payload values are
not logged.

## Version adapter gate

The connected binary path, binary SHA-256, reported user agent, stable schema
bundle SHA-256, and connection time are captured. The initial supported
fingerprint is recorded in the evidence folder.

The adapter uses stable, non-experimental method schemas. At startup it:

1. generates the current stable schema locally;
2. verifies required methods and fields;
3. compares the supported fingerprint;
4. selects an explicitly tested adapter version; or
5. quarantines the connection as incompatible.

`Thread.cliVersion` is provenance for that stored thread, not the connected
protocol version. Unknown fields are dropped before persistence. Field values
from incompatible schemas are never guessed.

## Root selection and pairing

The local bridge lists only minimal root candidates locally. The user explicitly
selects a Codex root and consents to the data categories to share. The bridge
creates a one-time pairing request containing an installation public identity,
nonce, expiry, selected private source-root mapping, and requested scopes.

After the authenticated user approves pairing in Agent Farm, the server issues
a revocable, short-lived device-bound credential. The binding is:

```text
owner + tenant + bridge installation + selected Codex root + agentSessionId
```

The private Codex root/session identifiers remain in the local mapping and are
not public authorization keys. Reassignment requires a new explicit pairing.
Revocation immediately stops ingestion and invalidates outstanding nonces and
credentials. Replays, expired nonces, root substitution, owner mismatch, and
cross-session events fail closed and create sanitized audit records.

## Data minimization before transfer

Allowed thread fields are limited to opaque source identity mapping, session and
parent linkage, fork linkage, model provider, lifecycle status, CLI version,
source kind, sanitized nickname/role, and timestamps.

Allowed turn/item fields are limited to turn ID/status/timestamps/duration,
collaboration operation/sender/receiver/requested model/requested effort/status,
subagent activity linkage, effective thread settings, model reroutes, and safe
error codes.

Prohibited transfer and persistence:

- user prompts and hook prompts;
- reasoning and private chain-of-thought;
- commands, terminal output, file paths, diffs, and Git metadata;
- tool arguments, raw tool results, approvals, tokens, credentials, and config;
- raw app-server payloads and unknown-field values;
- unrelated or unselected threads.

Final agent result summaries are disabled by default. When the user enables
them for the selected root, the bridge extracts only the bounded final agent
message, redacts it locally, attaches provenance, and sends the sanitized
summary. Raw content is never hashed, logged, queued, or uploaded.

## Ordering and reconciliation

App-server notifications do not provide a guaranteed source cursor. Each
connection receives a random `connectionEpoch`; each accepted observation gets
a backend `ingestOrdinal`. These express observed arrival order only.

Idempotency uses a canonical sanitized key from method, source thread, turn,
item, status, and typed timestamps where present. Duplicate keys with the same
sanitized payload are no-ops; conflicts are quarantined. Raw payloads are never
hashed.

Periodic paginated `thread/list` and selected `thread/read` form a snapshot
transaction. The backend applies a new watermark only after all pages validate.
Differences emit `projection.corrected` records attributed to reconciliation.
Agent Farm does not claim to detect events missed between snapshots.

Thread status is reusable and may move between idle and active. Turn generation
is keyed by thread ID and turn ID; completed, failed, or interrupted is terminal
for that turn only. Parent status never silently terminates descendants.

## Retention and deletion

Raw app-server responses exist only in bridge process memory during
minimization. Sanitized events use configurable retention with a short default.
Revoking a pairing stops ingestion. Deleting an Agent Farm session deletes its
projection, sanitized events, evidence, bridge binding, and credentials through
an audited, idempotent application operation; it never deletes Codex data.
