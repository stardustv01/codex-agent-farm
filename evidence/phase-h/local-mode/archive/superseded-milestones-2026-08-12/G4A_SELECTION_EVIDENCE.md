# G4A opaque local selection evidence

Status: **G4A PASS after independent correction — G4B durable lifecycle HOLD**.

G4A replaces the local browser-facing source-root identity with a server-owned
opaque selection handle. Handles are 32-byte CSPRNG base64url values; only a
SHA-256 digest is retained in the bounded in-memory registry. Both live handle
records and their session snapshot index are pruned together, including empty
and expired snapshots. Each record is
bound to the local browser session digest, derived principal, installation,
Agent Farm view session, expiry, and the exact private candidate snapshot
digest/version. A status refresh advances that generation and invalidates all
previous handles for the session. Expired records are pruned and publication
is bounded so a newly returned candidate cannot be evicted immediately.

The consume operation validates binding, expiry, and snapshot generation before
marking a handle used. The mark occurs synchronously before attestation or
credential work, so concurrent submissions have one winner; foreign callers
cannot burn a rightful session's handle. Unknown, replayed, substituted,
cross-session, malformed, expired, and refreshed handles all use one
non-enumerating `INVALID_SELECTION` response at the HTTP boundary.

The local status response now contains only `selectionHandle`, a safe display
name/fallback (`Agent task NN`), allow-listed lifecycle, safe last-activity
timestamp, and an optional bounded descendant count. It contains no
`sourceRootId`, `agentPath`, installation identifier, snapshot digest/version,
credential, prompt, or raw bridge payload. Display names reject raw-ID echoes,
filesystem/URL-like values (including nested and percent-encoded paths),
control characters, other candidates' identifiers, and credential/token-like
labels; the web normalizer repeats the lifecycle/name/privacy checks and
canonicalizes the activity timestamp.

`POST /api/v1/local/pairing/root` accepts exactly `{selectionHandle}` after
CSRF authentication. Any caller-supplied root/session field is rejected before
attestation. Successful responses expose pairing state and expiry only; bridge
credentials remain server-side.

The independent review also found that the production raw-root pairing routes
were still registered in local mode. Those routes are now absent in local
mode, so a valid local cookie and CSRF token cannot bypass the handle-only
contract. The same routes remain registered in production/OAuth mode, with the
existing attestation and signed challenge path covered by the production
entrypoint regression.

## Targeted command matrix

| Command | Result |
|---|---|
| `pnpm --filter @agent-farm/server exec vitest run tests/local-selection.test.ts tests/server.test.ts tests/production-entrypoint.e2e.test.ts` | PASS — 3 files / 28 tests |
| `pnpm --filter @agent-farm/server exec tsc --noEmit -p tsconfig.json` | PASS |
| `pnpm --filter @agent-farm/web exec vitest run src/standalone-bootstrap.test.ts src/App.test.tsx src/mcp-host.test.ts` | PASS — 3 files / 47 tests |
| `pnpm --filter @agent-farm/web exec tsc --noEmit -p tsconfig.json` | PASS |
| `node --import tsx --test tests/integration/agent-farm-local.e2e.test.ts` | PASS — 9 tests |
| `pnpm check:privacy` | PASS — private Codex source identifier scan |

The targeted integration matrix covers status privacy, refresh invalidation,
cross-session substitution, malformed/expired handles, raw-field rejection,
and concurrent one-winner replay. Unit coverage additionally proves
installation/session binding, exact 32-byte-base64url handle shape, bounded
session-metadata pruning, safe-name/lifecycle fallback, and that a foreign
attempt does not consume the rightful handle. The server regression also
proves raw pairing routes are absent in local mode while the production
attestation route remains operational.

## Explicit boundary and HOLD

The durable bridge binding table and runtime remount path are unchanged by
this bounded G4A patch. Deliberate switch/unpair, confirmation/audit routes,
restart claim/remount, and durable binding lifecycle evidence remain **G4B
HOLD** and are not represented as implemented. No G5 hierarchy/schema work was
started. The user waived the initial commit for this review; no commit, push,
or release was performed.

## Privacy/stale-code scan

Raw root identity remains server-private in the handle registry and the
production attestation/challenge path only; that raw protocol is not
registered in local mode. A search of the touched web/UI
surfaces finds no `sourceRootId` or `agentPath` field; browser config drops any
legacy installation field. The status and pairing tests assert absence of raw
root, path, installation, digest/version, and credential fields.

## Source digest

The following SHA-256 values cover the G4A implementation/tests and this
evidence file is intentionally excluded from the list to avoid a
self-referential digest:

```text
7aedf458aafbb6910cb107a925fad54c639ed00335dd534f99532c7635b6ee4d  apps/server/src/index.ts
92ddecbe24455b9682bd864fce3539a60f3bae0dd72954808afcb694d0539932  apps/server/src/contracts.ts
28ebdac36efc7bdf339b114aba93a65a0c2d75a43bdf8e0b1b39d9d68b3c4aee  apps/server/src/local-selection.ts
a0fccf09417350fe049c993e03acf55377d374fcadee67719f4424094a7f5ca7  apps/server/tests/server.test.ts
1d1d8235c78ae21c051fd7bb310884d1b672e52f4f3c544261d19b44d8ef1b59  apps/server/tests/local-selection.test.ts
8e0691c1bd242c28eab9d2024600993696f6a920cb1af42bc41c67e051c32013  apps/server/tests/production-entrypoint.e2e.test.ts
756566f491c48a5bd5ab311e209e6ec838127b3b87653d607c56393bbd3d5fa4  apps/web/src/types.ts
a1194789a7a0087bc3bcd72316ea5276cb18dac19063bd902ec38ed7963bc397  apps/web/src/normalize.ts
698f084c1d511eafd5da6dd7b8a575a87de424a7a2b53ea30215a6ae2341089d  apps/web/src/standalone-bootstrap.ts
73ffc437ba2347afbfe85b9d5db4a78341d17201b3794107d1d9d0abb0e6c210  apps/web/src/standalone-bootstrap.test.ts
cfa5b69e6c70bd55a8b417ce985103aed113d8ad156a22ea483000cd75baf294  apps/web/src/App.tsx
6b1e26b33ce8a0414fb470b206ff1bece4d1a3d308d6435d6d312ec7b057abc3  apps/web/src/App.test.tsx
672a273ec0a44551794ea563cedee4e386d31f7fcec977547e470064f5f9ed6f  apps/web/src/mcp-host.test.ts
09785733c08880de23b701a94731674cab0bb27105aa42a0d0213f6c880f7df3  tests/integration/agent-farm-local.e2e.test.ts
```
