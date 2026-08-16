# G3 local security boundary evidence

Status: **G3 PASS — fresh browser acceptance pending**.

The current source replaces the pre-G3 fixed-principal shortcut with a
process-scoped local browser-session authority:

- `.agent-farm/local-auth/` (or the configured Agent Farm data directory) is
  created with mode `0700`; `local-installation-secret` and
  `local-session-signing-key` are independent 32-byte CSPRNG files with mode
  `0600` and current-process ownership checks. Creation uses fsync plus
  no-clobber hard-link publication. Key bytes never enter responses, logs,
  URLs, browser storage, or evidence.
- `GET /api/v1/local/bootstrap` is read-only and returns only `localMode`, a
  bounded one-time CSRF value, and expiry while setting a short-lived HttpOnly
  bootstrap cookie. `POST /api/v1/local/session` consumes both and issues an
  opaque `agent-farm-local-session` cookie with `Path=/`, `HttpOnly`, and
  `SameSite=Strict`; `Secure` is added for HTTPS transport and omitted only on
  the documented HTTP loopback boundary.
- Local status and hierarchy reads require the server-issued session. All local
  mutations, including generic REST and MCP POST/DELETE handling, require the
  session-bound `X-CSRF-Token`. Validation consumes the token before handler
  dispatch and returns its replacement in a response header even when the
  handler fails; the web client retains that replacement before allowing a
  retry. A valid session is rotated on browser reload while retaining its
  owner scope; the old cookie is rejected. Session principals and MCP auth-info
  tokens are server-derived digests, so two browser sessions cannot collapse
  into one owner scope. In-memory session state invalidates on restart.
- The pre-handler boundary requires the loopback socket, exact configured
  Host/port, and matching same-origin HTTP/HTTPS. It rejects foreign/malformed
  Origin, `Forwarded` and all `X-Forwarded-*` variants, Authorization/bearer
  headers, DNS-rebinding-style hosts, token-like URL parameters (including
  mixed-case/encoded API-key aliases), and fixation/replay attempts. Because
  URL fragments are not transmitted by HTTP, the standalone browser bootstrap
  inspects its page query and fragment before making a local request.

## Targeted command matrix

| Command | Result |
|---|---|
| `pnpm --filter @agent-farm/server exec vitest run tests/local-session.test.ts tests/server.test.ts tests/main-config.test.ts` | PASS — 3 files / 38 tests |
| `pnpm --filter @agent-farm/web exec vitest run src/standalone-bootstrap.test.ts src/App.test.tsx` | PASS — 2 files / 28 tests |
| `node --import tsx --test tests/integration/agent-farm-local.e2e.test.ts` | PASS — 8 tests |
| `pnpm --filter @agent-farm/store exec vitest run tests/store.test.ts -t "rebuilds an equivalent deterministic projection from events"` | PASS — 1 test (17 skipped) |
| `pnpm --filter @agent-farm/store typecheck` | PASS |
| `pnpm --filter @agent-farm/server typecheck` | PASS |
| `pnpm --filter @agent-farm/web typecheck` | PASS |

## Milestone aggregate boundary

The earlier aggregate failure was real nondeterminism, not a disposable test
flake: live edge ingestion used a fresh store clock value for `createdAt`, while
event replay used `event.observedAt`. Under parallel load those timestamps
diverged. The live projection now uses the event timestamp, and an
advancing-clock regression test proves equivalence. The final aggregate from
the corrected source state is **PASS**: `pnpm check` completed outside the
sandbox with exit 0, covering the privacy scan, every workspace typecheck,
store 18/18, MCP 19/19, web 69/69, server 137/137, integration 14/14,
external-acceptance validator 26/26, all builds, and production preflight. The
preceding sandboxed attempt stopped only because loopback listen was denied
with `EPERM 127.0.0.1`; the same MCP suite passed 19/19 in the permitted
execution environment.

The pre-existing production OAuth/browser-auth regression suites remain in the
server test set; no local defaults are composed in production mode. A fresh
supported-Mac install, real browser cookie inspection, and restart acceptance
remain unfilled Phase-H rows and are not inferred from these targeted tests.

## Final source digest (SHA-256)

This digest covers the G3 implementation, tests, and active docs at handoff;
the evidence file containing this table is intentionally excluded to avoid a
self-referential hash (no commit exists):

```text
c7a9138b643ea70f320c2c2a11c3acd0837203edc04cb6a75cbcfef77ec00f85  apps/server/src/browser-session.ts
78ca471639fec0a96ebf1759277afcc9bcdb4876857026fe62132715833e3f19  apps/server/src/index.ts
29a8dcf557bbdff8a76f1cb12126ef2c09904668d51077c6705f421d54909706  apps/server/src/main.ts
0243be549c3ed54b005f1fea83056ba6ef9960537bc315245c3ab2d5590491c6  apps/server/src/local-session.ts
7ba4471ca32b5312d84efa826744bd0ca0f667da5cd30ce6fba8276aa9303589  apps/server/src/browser-auth.ts
c8949891f3da0c89a34523652e666318603fc4638c3df6c2331d351982039757  apps/server/tests/server.test.ts
0a0dd9769db5b470bc188123c30b3fe634026f9a7f40e994aae8aa936e2c9ca5  apps/server/tests/local-session.test.ts
eb2ec640da9fce0a773f98efd0844db2fede683137269f727282fd396acebdad  apps/server/tests/main-config.test.ts
d77d6a7699cdc4a29cbba3d41a8e359b35000b286afe1923d40e18dec623bf08  apps/web/src/standalone-bootstrap.ts
d7b429c6863846558454121631a1d811a14267e57aa532ae8356efca24906ad5  apps/web/src/main.tsx
528903ea93d0f46416d2ca680f1ae6fdffeff556a71f26f67189682cafc6e791  apps/web/src/App.tsx
98c97ab3398f43215d9727cc44bf835723bc987a0a35ae965a35c192e363e619  apps/web/src/types.ts
24bf6fd4036e03dc9f47c9fe8bdd47695211b9ad6556b5328357d12f733cb2f7  apps/web/src/standalone-bootstrap.test.ts
81724740f86f7c787e585e86a3332cd72521ea3dfcdc78f38cd6560ef4c2ec15  apps/web/src/App.test.tsx
a0bf8349cb87e4f145e081a4146baa9e30796488f4584c19793285d6f42110e1  packages/store/src/store.ts
3865aa4bf534b182aa0af20c2f334143c686fe4f3dc395a2facb0c5a096b1d86  packages/store/tests/store.test.ts
9607cfbfb451f09725494f22e31224fbf7b2a9884ef764a86d523059007c643a  tests/integration/agent-farm-local.e2e.test.ts
2a2f272b48fa66e63330e49f541e311a6f2e59008e67f29035f7cdfb21629411  README.md
d91a3c94fb310b3d6a3356d91a50c51f890b18360e71077ddbaaee19ec7e20ba  docs/DEPLOYMENT_AND_ROLLBACK.md
e1763567063386dfd7e4da9c2411c5f3c69433e53ac49e3986ca3411f739e1f8  docs/AUTH_AND_TOOL_MATRIX.md
f7a545859afbea346a3f49deb7b5d8571ea0696ddc9ea49871e4efdbb80157e7  docs/EVIDENCE_LEDGER.md
63db061b69958c8647f10a6389109a60e65fed1f65efa8a7532159c0f746498b  evidence/phase-h/local-mode/README.md
8c37a3f313c3e9f1167010ae7742421e720868f53ae52c74163ca16a9f8e0a67  evidence/phase-h/local-mode/ACCEPTANCE_CHECKLIST.md
```

G4 opaque selection and removal of raw source-root identifiers from browser
responses remain **HOLD**. The user explicitly waived the initial commit for
this review; no commit was created and no release/push was performed.
