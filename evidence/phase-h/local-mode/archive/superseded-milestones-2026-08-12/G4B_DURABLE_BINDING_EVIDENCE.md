# G4B durable local pairing evidence

Status: **G4B targeted implementation PASS after independent correction; fresh runtime/browser acceptance and the aggregate milestone gate remain HOLD**.

This bounded patch keeps G4A's opaque selection contract and adds the durable
pairing lifecycle. Existing `bridge_bindings` and append-only `audit_records`
SQLite tables are reused without a schema-version bump. Activation expires
stale rows, refuses a second installation owner by default, and supports an
explicit already-authorized switch only through one SQLite transaction. A
switch is a compare-and-replace bound to exactly one previously observed
owner/session/root; a stale switch cannot revoke a newer or foreign binding.
The new binding and sanitized audit record are committed together; a forced
audit failure rolls the replacement back. Revocation and its audit append have
the same forced-failure rollback coverage. Direct legacy `upsert` remains available
for historical ambiguity fixtures, while production bridge issuance uses
`activateExclusive`.

Local browser sessions derive an Agent Farm principal from their in-memory
session by default. On process start, one cached claim resolution validates
exactly one unambiguous active installation binding before a synchronous
one-winner browser claim. The first new
authenticated browser session can attach to the existing durable Agent Farm
session without caller-supplied tenant, owner, or session identifiers. Same-
cookie rotation retains the override; subsequent simultaneous sessions remain
on isolated derived principals. If the durable session is missing, claim fails
closed rather than creating a phantom remount, including on retries and
concurrent requests. `/api/v1/local/status` computes `paired` only from the
durable resolver and current effective scope, never from bridge readiness;
resolver failure returns a generic 503 rather than a false unpaired state.

Switch requires CSRF and `{selectionHandle, confirmation:true}`. The handle is
consumed before attestation/issuance, and `issuePairingCredential` performs the
replacement atomically so a failed switch leaves the previous binding active.
Unpair requires CSRF and `{confirmation:true}`; the bridge must report a
successful durable revocation before in-memory authority is cleared. The
browser helper also removes the revoked Agent Farm session identifier. Revoke
and its sanitized append-only audit record share one transaction. Responses
remain non-enumerating and contain no credential, raw source root, path,
installation id, snapshot digest/version, or pairing secret.

## Targeted command matrix

| Command | Result |
|---|---|
| `pnpm --filter @agent-farm/store build` | PASS |
| `pnpm --filter @agent-farm/store exec vitest run tests/store.test.ts` | PASS — 1 file / 20 tests |
| `pnpm --filter @agent-farm/server exec tsc --noEmit` | PASS |
| `pnpm --filter @agent-farm/server exec vitest run tests/server.test.ts tests/composition.test.ts` | PASS — 2 files / 32 tests |
| `pnpm --filter @agent-farm/server exec vitest run tests/production-entrypoint.e2e.test.ts` | PASS — 1 file / 1 test |
| `pnpm --filter @agent-farm/web exec tsc --noEmit` | PASS |
| `pnpm --filter @agent-farm/web exec vitest run src/standalone-bootstrap.test.ts` | PASS — 1 file / 22 tests |
| `node --import tsx --test tests/integration/agent-farm-local.e2e.test.ts` | PASS — 10 tests |
| `pnpm check:privacy` | PASS — private Codex source identifier scan |

The server matrix includes concurrent first-claim/restart remount,
claimed-cookie rotation, persistent missing-session failure, second-session
404 isolation, durable status authority, confirmation
and CSRF failures, switch rollback/success, unpair false/throw rollback, and
non-enumerating already-unpaired behavior. Composition coverage verifies
durable resolver/revocation, forced revocation-audit rollback, and that audit
JSON contains only installation digests and bounded counts. Store coverage
proves stale/foreign compare-and-replace rejection and activation-audit
rollback. The file-backed integration test reopens the same
SQLite database, remounts the unique binding, isolates a second browser,
unpairs, and verifies a later reopen does not remount a revoked binding.

## Privacy and stale-code scan

Raw source-root identifiers remain server-private in bridge/store/attestation
code only. Browser status, pairing, switch, unpair, runtime config, tests, and
evidence assertions contain only opaque handles and safe labels. A final
`pnpm check:privacy` pass found no private Codex source identifier leak. No
generated `apps/server/.agent-farm` test directory or key material remains in
the checkout; the ignored repository `.agent-farm/` budget files are the
existing local configuration and were not modified. No stale fixed-principal
local branch or `bridge.ready()`-based pairing status remains.

## Changed files

- `apps/server/src/index.ts`
- `apps/server/src/contracts.ts`
- `apps/server/src/composition.ts`
- `apps/server/src/fakes.ts`
- `apps/server/tests/server.test.ts`
- `apps/server/tests/composition.test.ts`
- `apps/web/src/standalone-bootstrap.ts`
- `apps/web/src/standalone-bootstrap.test.ts`
- `packages/store/src/store.ts`
- `packages/store/tests/store.test.ts`
- `tests/integration/agent-farm-local.e2e.test.ts`
- `docs/EVIDENCE_LEDGER.md`

## Source digest

The evidence file itself is excluded to avoid self-reference.

```text
fba6f7ca6e2d36bc4fbd1c11f5c317eeeac1783ebcdcc309c001f7f792dff71f  apps/server/src/index.ts
e09cd6c9406b741fce4aaa1960d0b48c249c4c166c7c743fd9cff1e73fd111b7  apps/server/src/contracts.ts
4828a238bb708c762f49039939cb91e6b8a55a44665e2519831dd64c42afcc9f  apps/server/src/composition.ts
e200c164e02aff843842922850b7b948effd88061d2436e58685c211d6116b13  apps/server/src/fakes.ts
767ee9a7757b1711162efe343a20d9e9195a984f05d45dbef0eb69e2da0e95e3  apps/server/tests/server.test.ts
d3ab175d0f97c7c375ebb5c2abe4fc3f38452f9878dfb6a92e864a9e815bff24  apps/server/tests/composition.test.ts
8e0691c1bd242c28eab9d2024600993696f6a920cb1af42bc41c67e051c32013  apps/server/tests/production-entrypoint.e2e.test.ts
acd9380df95ef6e4de7233e9ae09f5e8ef56fdd8a2d1a23ae4c5e7261b0c7961  apps/web/src/standalone-bootstrap.ts
3447492de04276c6e6037ac713a43bf8c0a592820b13950233d7e6d606733c12  apps/web/src/standalone-bootstrap.test.ts
af21457fe380d9e6c99556de589a5be44804b0deb445b1b25b02e769b9c16dfc  packages/store/src/store.ts
3d0b6fa3b48a59ea9ae8844d20602f47a86a3b5501d475daa56356e9969c5057  packages/store/tests/store.test.ts
50f915da8b1b4373ecbca0c07f1edd028eebf5efae398a9e8f73a34a250f67e4  tests/integration/agent-farm-local.e2e.test.ts
dcb9790102cc465164fcf3e43aa346ae9ec027eac7672b2b463eca281b4ab8e0  docs/EVIDENCE_LEDGER.md
```

## Explicit boundaries and HOLDs

The user waived the initial commit for this review. No commit, push, or
release was performed. G5 public contract/schema expansion and G6 visual/UI
specification are **HOLD** and were not started. The server routes and explicit
browser helpers establish the G4B programmatic lifecycle; user-facing switch/
unpair controls and visual confirmation remain a G6/G7 UI HOLD. Fresh supported-Mac/browser
acceptance, the full aggregate milestone gate, and any production release
claim remain outside this targeted evidence.
