# Local V1 final acceptance

Captured: 2026-08-12 (Asia/Kolkata)

Status: **historical renderer/runtime acceptance; superseded for current-task selection by the 2026-08-13 P0 HOLD**. No commit, tag, push,
publish, or release was performed. macOS VoiceOver certification is explicitly
deferred by the product owner and is not represented as a PASS.

## Exact candidate

- Checkout: `/Users/praveengupta/Desktop/Agent-farm V1/agent-farm`
- Build-manifest source digest:
  `fee341547c7bf9faf0dc7796890ef55bfa44e586625760e134dac3772e644285`
- Self-contained MCP resource SHA-256:
  `53092dc6d872750e7356cd82c47013540f06386f33027ff40fd1486666b841e9`
- Node.js 22.17.0; pnpm 11.16.0; pinned Codex 0.145.0, binary hash
  `sha256:1da3f4e0e96028b8...` verified by setup and doctor.

## Authoritative aggregate

`CI=true pnpm check` ran outside the restricted sandbox because socket-backed
tests require loopback access. It exited 0 and included privacy scanning,
workspace typechecking, tests, the exact build, and offline production
preflight.

| Gate | Result |
|---|---|
| Private-source identifier scan | PASS |
| Workspace TypeScript checks | PASS |
| Contracts | 20 / 20 PASS |
| Codex bridge | 37 PASS; 1 deliberate real-runtime test skipped |
| Durable store | 28 / 28 PASS |
| MCP | 20 / 20 PASS |
| Web | 100 / 100 PASS |
| Server | 171 / 171 PASS |
| Integration | 19 / 19 PASS |
| External acceptance validator | 26 / 26 PASS |
| Exact build and manifest | PASS |
| Offline production preflight | PASS |

The aggregate exposed and then closed one stale integration fixture: it was
still sending the MCP layer the former internal hierarchy shape. The accepted
fixture now exercises the canonical public-v1 projection and opaque public
agent IDs.

## Historical browser acceptance (not current-task provenance acceptance)

The parent reviewer accepted the exact built runtime with these observations,
but a later live campaign proved that the browser had mounted an older durable
binding rather than the Codex task that launched the test. These bullets remain
renderer evidence only and do not establish current-task provenance:

- Fresh browser first-claim remount connected with 7 agents and 6 edges.
- Runtime-observed identity persisted for all 7 agents.
- Rich messages and read-only tool activity were reachable; the 1,024-entry
  usage detail was collapsed by default and remained explicitly accessible.
- No credential-shaped values or automatic Codex controls appeared.
- Recursive cost stayed truthful: officially unpriced model aliases remained
  unavailable rather than being coerced or repriced. Every calculated amount
  is an **estimate** derived from recorded token usage and the pinned reviewed
  price snapshot; incomplete coverage is labelled partial and shows only the
  known subtotal.
- Desktop, 360 px, dark mode, and 200% text zoom had zero card overlap and zero
  document horizontal overflow.
- The Outline exposed 7 tree items with correct level/expanded/selected state;
  Home and End keyboard behavior returned to the root as expected.
- Browser console warning/error count was zero.
- Rendered light/dark contrast evidence remains in
  [`artifacts/row22-exact-built-rendered-contrast.json`](artifacts/row22-exact-built-rendered-contrast.json).

## Fresh isolated lifecycle acceptance

The exact source and built outputs were copied to the disposable checkout
`/private/tmp/agent-farm-final-acceptance.a2cshr/agent-farm`; the user
checkout's `.agent-farm` directory was not used or modified.

| Step | Result |
|---|---|
| `CI=true pnpm install --frozen-lockfile` | PASS; 484 packages reused, 0 downloaded |
| Setup with budget 10 / 10 / 3 | PASS; total 23 |
| Doctor before first start | PASS; exact manifest digest matched |
| First start on `127.0.0.1:43441` | PASS; `/healthz` 200 |
| Unpaired readiness | Truthful `/readyz` 503; not misreported as ready |
| Unauthenticated local status | 401; no local status disclosure |
| Generated permissions | PASS; directories 0700, files and SQLite 0600 |
| Doctor while running | PASS, including SQLite header and key permissions |
| Same-data restart | PASS; `/healthz` 200 and doctor PASS |
| Installation-key continuity | PASS; both key hashes unchanged across restart |
| Guarded uninstall | PASS from the authoritative cleanup tool against the explicit external target |
| Cleanup boundary | Generated `.agent-farm` absent; copied source remained present |

`readyz` remaining 503 before pairing is expected and truthful. Canonical
pairing, durable remount, hierarchy/detail enrichment, restart/replay, and
browser behavior were already accepted against the exact built runtime above.

## Release boundary

This record no longer authorizes the broad **local-only V1** current-task
acceptance claim. It remains evidence for the renderer/runtime checks listed
above, while current-task selection remains governed by
`docs/LIVE_TASK_MAP_UI_IMPLEMENTATION_PLAN.md` and its P0 HOLD. It does
not certify VoiceOver, a hosted/public deployment, live OAuth, publication,
registry install, or release promotion. Those remain separate future gates.

The release procedure and requirement-by-requirement coverage are recorded in
[`../../../docs/LOCAL_V1_RELEASE_PLAN.md`](../../../docs/LOCAL_V1_RELEASE_PLAN.md).
