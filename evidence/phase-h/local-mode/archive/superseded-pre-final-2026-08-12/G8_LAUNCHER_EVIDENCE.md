# G8 launcher and local acceptance evidence

Status: **PARTIAL / final clean campaign complete with bounded HOLD rows**.

The user explicitly waived the initial repository commit. This record therefore
identifies the candidate by the final source-manifest digest and exact checkout
path, not by a commit hash. The clean replacement campaign completed install,
setup, build, doctor, launcher safeguards, live loopback security, opaque
pairing, restart remount, built-browser, and guarded-cleanup evidence. A later
bounded current-source row-21 closure also proves the strict public-v1 HTTP
adapter/browser scale path at 225 nodes/224 edges. It does not claim canonical
verified identity, real Codex-runtime 225-node output, or full rendered
contrast acceptance. VoiceOver certification is deferred from Local V1 by the
product owner.

Candidate checkout: `/private/tmp/agent-farm-g8-rows-MT52bB/checkout`.
The exact-source build and runtime were produced at source digest
`5ec764df439d98e67e3bb1dae3b05d03f390c5621af478f367a66d4a05c65edf`.
The MCP resource sha256 is
`fa7757349ad7cdf449248acbecbdab1fe01a03357aef12bfb61d9e77fa5871c1`.
The user checkout
`.agent-farm` was unchanged (recorded preservation sha256
`7de8de84b0c267ed9f303ced0864d3e8184140b39362bee9bbc0751b71f5e727`, mode
`drwxr-xr-x 501:20`).

The post-campaign production-component corrections were rebuilt at source
digest `1bf0d90cbe90f3a7077b21c639b2d12febf9981f29a9d8349c9414e4cd2b0d54`
with MCP resource sha256
`05ffd2800a1651fb27450f669ec6ef3ac96ab580450f77835041df40560d9936`.
Rows 20 and 22 below explicitly identify which evidence uses this later exact
build; the clean-install campaign rows retain their original 5ec764… digest.

## Bounded implementation

- `pnpm build` now runs package builds with an explicit recursive `run build`
  invocation, builds the web MCP artifact, and writes
  `apps/server/dist/.agent-farm-build.json` containing a source-entry digest and
  server/web output hashes.
- `pnpm start:local` refuses missing/stale output or manifest, refuses an
  occupied/invalid port, starts only `apps/server/dist/main.js`, waits for
  loopback `/healthz`, and terminates the child on readiness failure. There is
  no TypeScript source-entry fallback.
- `pnpm run setup` verifies the pinned Codex executable/hash, creates only a
  real 0700 `.agent-farm` directory, atomically writes owner-only 0600 budget
  and README files, preserves a valid existing budget when no override is
  supplied, and fails closed for symlinks, foreign ownership, unsafe modes, or
  malformed existing configuration.
- `pnpm doctor:local` is read-only and reports versions, Codex hash prefix,
  configuration/key/database permissions, build-manifest freshness, and
  optional readiness without printing secret contents.
- `pnpm reset:local` and `pnpm uninstall:local` require an explicit absolute
  isolated data directory, `--yes`, and `--unpaired`; they reject broad paths,
  symlink components, unknown entries, unsafe ownership/modes, and active
  durable bridge bindings. They remove only the marked generated directory.

## Targeted command matrix

| Command | Result | Evidence boundary |
|---|---|---|
| `node --check scripts/*.mjs` | PASS | Syntax only |
| `node --test tests/g8/launcher-doctor.test.mjs` | PASS, 8 tests after bounded launcher correction | Setup/manifest/doctor/cleanup component tests plus launcher-owned readiness-failure exit-code preservation; direct and one-separator argv plus duplicate/misplaced/unsafe guards; isolated temporary directories only |
| `CI=true pnpm install --frozen-lockfile` | PASS (escalated) | Configured offline store lacked the pinned `@types/node` tarball; network-enabled escalation completed the locked install without lockfile changes |
| `CI=true pnpm build` | PASS | Package/server/web build and manifest write; exact-source runtime digest `430ebbf…`, MCP resource sha256 `fa7757349ad7cdf449248acbecbdab1fe01a03357aef12bfb61d9e77fa5871c1` |
| `pnpm run setup` twice | PASS | Idempotent 10/10/3 (23 total) configuration; before/after config hashes and owner-only modes retained |
| `node scripts/doctor-local.mjs --json` and `pnpm doctor:local -- --json` | PASS | Direct and one-separator forms; sanitized JSON at `artifacts/doctor-direct.json` and `artifacts/doctor-separator.json` |
| `CI=true PORT=18932 pnpm start:local` + readiness | PASS | Exact-source runtime readiness after post-restart doctor; no API/session probes used before row16 evidence |
| Built-browser raw-fragment check through sanitized proxy on `127.0.0.1:18937` | PASS | Exact hash URL retained; proxy recorder observed only `/`, JS, CSS (all 200), every request `fragmentTransmitted:false`, and no bootstrap/session/status/hierarchy request. Browser rendered zero agents/unverified state with no token/private data, anchors, or console entries; screenshot `browser-fragment-proxy-final2.jpg` sha256 `d96e69…`. |
| Live HTTP/security probe | PASS | The original retained source/result covers forwarded headers, token-like query aliases, cookie variants, CSRF, and replay. Corrected retained source/result adds raw Host, foreign/null Origin, bearer Authorization, cross-session CSRF and cross-session hierarchy with method/route/status/generic code; all 9 added negative bodies passed the recursive forbidden-key privacy check. |
| Same-DB restart probe | PASS | Distinct pre/post doctor artifacts and live restart evidence: fresh session, paired status, hierarchy 200 with 3 nodes/2 edges/complete |
| Confirmed unpair + guarded reset | PASS | Durable active binding count 0 after unpair; checkout-local target refusal retained; relocated external `data/.agent-farm` removed only by exact documented cleanup command; checkout/artifacts retained |
| `node scripts/doctor-local.mjs --json` on the user checkout | FAIL as designed | Existing user `.agent-farm` is 0755/0644 and is intentionally not modified; build/Codex/version checks pass |
| Initial `pnpm build` before the recursive-script correction | BLOCKED by pnpm registry metadata/no-TTY module-purge tooling | Environment/tooling failure, not product evidence; corrected script then passed with `CI=true pnpm build` |

## Row 21 bounded current-source closure

The current source digest is
`1c2aeaaac61946a8bd85166711b11db8b01ca53ab1618dac8ce87ab761834acf`.
The exact rebuilt web outputs used for this closure are `index.html`
`752805c4c880b3a879992959b39736bb6b5fbd244c50dbd30544a91e42cafc9d`,
`assets/index-Cb7zabw1.js`
`38c227f4e8db3a4fe051b52964dfcae2ae01e7a3c1fa1083f9355e893e89cd84`, and
`assets/index-CsBENr-c.css`
`88f882d77072cb1bc5f3a4a20822a047f5972e13743dc158186ea58ef1384946`.
An earlier browser attempt was rejected as stale output because the built
bundle still overlaid `orchestrationBudget` before strict public-v1 parsing;
the rebuilt bundle removed that signature and passed the same HTTP flow.

The disposable loopback server at `/private/tmp/agent-farm-g8-row21-acceptance`
served the unchanged built web assets and strict public-v1 pages over HTTP; it
did not import the G6 fixture or directly call the mapper. The real
`StandaloneAdapter` requested two pages and returned 225 nodes/224 edges,
225/224 unique IDs, stable order, complete/connected state, and no private
fields. Before and after harness restart, the ordered public node digest was
`892d7c47157032f2c0e252efed740a8c5180268b6e35fc47a08b83638ebd709e` and edge
digest was `0ba2570203ca673f406303414ef6523083c92c3ba5c1f6a107e87d3986767589`.

The retained sanitized HTTP request log is
`row21-network-log.json` (sha256
`b2dcb2eb35f7938f45d6e69b69b4302ea9344dd986c0d27f92153fb79146070d`). It
records only method, path class, and status for static assets, bootstrap,
session, status, hierarchy pages 1 and 2, and the disposable observer posts;
it contains no headers, cookies, IDs, or response bodies.

The retained parent built-browser metrics are in
`row21-parent-browser-metrics.json` (sha256
`a1d76506fdf91d82ffcb2f3c157182377ad7fd7ac4ecf4bb27ce366467c91bb9`): useful
hierarchy paint upper bound 1,276 ms, search 70 ms, status filter 64 ms,
focus 354 ms, collapse/expand 331 ms, details 329 ms, 225 Outline rows,
Details Atlas present, document horizontal overflow 0, and zero console
entries. The retained interaction artifact is
`row21-browser-interactions.json` (sha256
`f9daa7e61f956b3265e00555000f0bc53d43abd87d3cd83f3f223545c6705825`); the
observer artifact records FCP 240 ms and no post-settle long tasks
(`row21-browser-metrics.json`, sha256
`9cd30233e7911f240500daa09e9f9d3286a121d3c82dc2439e666f24096b7422`). The
225-node screenshot `browser-outline-225.jpg` is sha256
`acf092abe32b0c52c6e782a91106b0be419d296b6a0e25d3c0f0a59940f0fae9`.

This closes row 21 for the strict public-v1 HTTP/browser production path. The
real Codex runtime in the clean campaign remains a separate 3-node/2-edge,
unverified-identity limitation under rows 8 and 11; it is not silently
reclassified as a 225-node runtime result.

## Retained campaign artifacts

These files are retained under
`/private/tmp/agent-farm-g8-rows-MT52bB/artifacts`. Their hashes were
recomputed during the final evidence review. The JSON files
contain status/count summaries only; the probe sources contain no captured
cookie, CSRF, selector-handle, installation-secret, or private source value.

| Artifact | SHA-256 |
|---|---|
| `artifacts/browser-fragment-rejected.jpg` | `d96e690a7dea1c4d3351d8bfa4c55519d78680034e640ce9b320d2fb5938785e` |
| `artifacts/doctor-pre-direct.json` / `doctor-pre-separator.json` | `d73e0a1eaf1af34092342e504573adc42ee1328b88bdc4d0f29cd38b19b7bd9e` |
| `artifacts/doctor-post-restart-direct.json` / `doctor-post-restart-separator.json` | `524ff41dcb0b252caa551f2225eaaf726a1f810ae972b6831a3a838458915d8a` |
| `artifacts/row18-stale-source.log` | `c0eec215617b872591f915d86bb805893fba3d6d3833c6e9c36a9805cbd4bf3a` |
| `artifacts/row18-missing-output.log` | `907fc260e3c52b86e77ff278e42bfa9981515d282bf0f95a2c4e7d7a75419ed3` |
| `artifacts/row18-occupied-holder-success.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `artifacts/row18-occupied-listener-refusal.log` | `6edba8051c0cad8380fc87b73e885b31b578bd56f957faa87b3c29127ab0f74b` |
| `artifacts/row18-build-readiness.log` | `308d5c9b98144cbb6d05d138f6a3cbb391db1b50f94355fbef6e4bebcd2d55a3` |
| `artifacts/row18-readiness-child-failure.log` | `69d2126c9f693ec403436e217358923b3acbccf5fe0f6cac9924da0d873d1c7e` |
| `artifacts/row18-readiness-child-failure.result` | `7793b32811f84538db8601a9c8b55acafdd09daac9ad686c2821168abb809398` |
| `artifacts/row18-unhealthy-harness.mjs` | `96ddf29cc95847a627d43ec2b852c0b010062d3937522567812c721a5c002963` |
| `artifacts/row18-unhealthy-harness.log` | `edfedb673cb1b195f293c05728e389a929441f4abf77c99e5804484d1d2764b1` |
| `artifacts/row18-unhealthy-launcher.log` | `4b0b844d5a375cd9a683025abe711728733c77447893b9b81da4cada8a5f10ac` |
| `artifacts/row18-unhealthy-launcher.result` | `fa3f5eb937c18f3a6d67af93ba8807a70f795fc10166aaa0d76077a8ae0676b3` |
| `artifacts/row19-sanitized-probe.mjs` | `4461a639b7e0b743d2529847c247aad17ddfb214c596e5b5d2e4c8b391368373` |
| `artifacts/row19-sanitized-result.json` | `0654e2d40b7b4bd37a61724ca729cdbce1b10362ab190ed98b20c6bb8d3e6806` |
| `artifacts/row19-host-raw.json` | `e0b2a7917d0af87f0e2636fc046add5cb83a2b712a55578e630ff77394841e62` |
| `artifacts/row19-cookie-variants.json` | `f3d2c3aacf7a915db21323038714a30159a961d6ceadeee8b65eeba2ea02c795` |
| `artifacts/row19-csrf-matrix.json` | `95edb94d82756f0399304cd76695da6c01afc929ffa9175f85192f390dcc764f` |
| `artifacts/row19-cross-session.json` | `3cd0885bad08cfddbf841e5f4a7f5d027323ac591d3f8b886cad20451eacf08d` |
| `artifacts/row19-browser-fragment-url.txt` | `49bff4176721d6d1789ee8885e34c9fdfa760d3228a21d6e042ed4efd80e70b5` |
| `artifacts/row19-complete-sanitized-probe.mjs` | `23056e0b2e77fc8c84f9487b8cb5d71eb25208c2b6f8cbdafc1ff899705b0a81` |
| `artifacts/row19-complete-probe.result` | `874bf20387ef7d0de5d03536fc15ca67e41710aa35ead99c7db6f3f278969477` |
| `artifacts/row19-fragment-proxy.mjs` | `d61636125f2500b0d3e5a83e8627c3d9aea9f9dc9a74bdea19522207ab4c8cd8` |
| `artifacts/row19-fragment-proxy.log` | `3ff15722904a52e7f5c78445a76ebb08e31103b10552a2f36f7ee0660965ec3f` |
| `artifacts/row19-fragment-proxy.result` | `432c8a43d09aa37f96d74f57a2f1c21690366260e3a2d0d0e87d07351cfc7e29` |
| `artifacts/row19-fragment-proxy-url.txt` | `c49ad79d0ce09077eb6529d386eaef58b4006386d0fbb1000b2a15dc4f35d241` |
| `artifacts/browser-fragment-proxy-final2.jpg` | `d96e690a7dea1c4d3351d8bfa4c55519d78680034e640ce9b320d2fb5938785e` |

Performance thresholds are locked in the acceptance checklist before any
measurement: useful paint <= 3 s, search <= 250 ms, focus/expand/details <=
500 ms, no post-settle long task > 200 ms, and 225 public nodes/224 edges with
no missing or duplicate entries. The real runtime campaign exposed only 3
nodes/2 edges; row 21 nevertheless passes only for the explicitly bounded
strict public-v1 HTTP/production-web scale path above and is not a claim that
the real Codex runtime produced 225 nodes.

## Row 20 exact-components browser closure

The row-20 UI proof used the exact production-component build at source digest
`1bf0d90cbe90f3a7077b21c639b2d12febf9981f29a9d8349c9414e4cd2b0d54`; the MCP
resource sha256 was
`05ffd2800a1651fb27450f669ec6ef3ac96ab580450f77835041df40560d9936`.
The disposable harness at
`/private/tmp/agent-farm-g8-row20-ui-proof/actual-components-harness.mjs`
(sha256 `42506b4c62197cd354e980d65cd79f4c963b7549dbf5fd24d2ab3d5bac2639a5`)
composed the built `createApp`, `DurableStorePort`, durable SQLite store, and
`ReadOnlyCodexBridgeAdapter` with two synthetic safe candidate records. The
harness was external to the product routes and did not expose raw source IDs,
paths, credentials, handles, or cookies.

The browser sequence retained the exact mutation boundary in five sanitized
stages: initial Alpha/current with Switch+Unpair; failed switch `503` preserving
Alpha/current and controls; successful switch `200` showing Beta/current;
failed unpair `503` preserving Beta/current and controls; successful unpair
`200` removing the binding controls. Browser console count was zero. A fresh
session after unpair returned status `200`, `paired=false`, and no active task;
a read-only reopen reported `activeBindingCount=0`, two revoked bindings, two
agents, and one edge. Sanitized artifacts are:

| Artifact | SHA-256 |
|---|---|
| `actual-components-harness.mjs` | `42506b4c62197cd354e980d65cd79f4c963b7549dbf5fd24d2ab3d5bac2639a5` |
| `artifacts/browser-ui-stages.json` (0600) | `529e306cbb4e820f28662ef96a13b63600dfb8ccb333eba14e57d9b97d541f22` |
| `artifacts/fresh-session-unpaired.json` (0600) | `70ad67fd58bdae774f6c48dca72e38a4b0b1af3937a155a5053428e8ccebd2bb` |
| `artifacts/db-reopen-unpaired.json` (0600) | `bab7179e1b9d4cf552eee60d611773e72e13d208cccb841db30ad6acd79a67a3` |
| `row20-http-record.json` (0600) | `467451e44f6b8d9290433e195d8eb67ed29582e5490883f54c56ad956b887189` |
| `artifacts/browser-after-unpair.jpg` (0600) | `1ce04e104b2b018acc4ed80c57e9f21b2c59a7bd1a4f0e804c0b21191fa5ca8f` |

This closes row 20 for the actual production-component/route acceptance
boundary. The separate real-Codex candidate-exhaustion artifact remains a
runtime limitation and is not silently promoted to real-runtime pairing
evidence.

## Row 11 canonical identity boundary

The final exact-current live artifact is retained in
`artifacts/row11-canonical-identity-blocker.json` (sha256
`2e18f4e331880998446bc48896f95ef3d87a48ee4a5b7d1a57097423d715e472`, mode
0600). In a bounded 90-second Codex 0.145 app-server window, candidate ordinal
12 of 12 paired and reconciled as connected; the public projection exposed 2
agents and 1 edge (unnamed root → Dirac), 0 identity-evidence records, and 12
sanitized events. Rhea, Kuhn, and Noether were absent; both projected agents
were unverified. This is a bounded observation of this exact task/window, not
a universal protocol claim. The active binding was revoked to zero and the
runtime closed. Historical/permission/403/other ordinal attempts remain
rejected or archived and are not promoted; row 11 stays BLOCKED.

## Row 22 bounded accessibility audit

The exact built Chromium audit is retained in
`artifacts/row22-exact-built-rendered-contrast.json` (sha256
`615527fcc0e959b332e523121c12bec781ed542e3e2dc4e839ff27ff9b81cf97`, mode
0600). It records source digest `1890e94f…`, build manifest `ab62d873…`, MCP
resource `5c2e47cc…`, and the computed sRGB/WCAG algorithm. Light and dark
rendered text each had 351 elements with zero failures (minimum ratios 4.59
and 4.82); selected and tinted states passed, and the focus outline measured
3.06:1 against a 3:1 threshold. Dialog and disabled controls were absent from
the scale harness and remain source-semantic coverage only. The built browser
also proves semantic Outline/tree keyboard behavior, exact 200% text scaling,
dark/light rendering, reduced motion, and zero console entries.
On 2026-08-12 the product owner explicitly removed macOS VoiceOver
certification from the Local V1 release standard. No transcript is claimed and
the deferral is not represented as a PASS. Row 22 is PASS; canonical verified
identity remains the single blocked checklist row.

## Final campaign boundary and HOLD rows

The campaign used a clean temporary checkout/data directory and retained only
sanitized logs, screenshots, browser console/network results, and hashes. It did
not copy or inspect the user checkout's `.agent-farm` secrets. The browser ran
on `localhost:18792` rather than reusing `127.0.0.1` because browser cookies are
host-wide rather than port-scoped; this avoided a prior campaign's stale cookie
and was an explicit fresh-origin boundary, not a product bypass.

Row 11 in [ACCEPTANCE_CHECKLIST.md](ACCEPTANCE_CHECKLIST.md) remains BLOCKED for canonical verified identity. Row 22 is PASS with exact built Chromium rendered contrast evidence. VoiceOver certification is deferred from
Local V1 by explicit product-owner decision and is not represented as a PASS.
Row 20 is PASS for the bounded exact production-component
browser closure above. Row 21 is
PASS for the bounded current-source strict public-v1 HTTP/browser scale
closure described above; the real Codex runtime still exposed only 3 nodes/2
edges. Rows 18 and 19 are PASS after bounded
closures on source/build digest `5ec764…`: the retained unhealthy-child
harness proves launcher timeout/exit 1/SIGTERM/aliveAfter 0, while the complete
sanitized request probe and proxy/browser recorder prove exact negative status
classes, response privacy, inert hash handling, and no authenticated mutation.
G8 is therefore not a PASS. G9 archive/release work remains out of scope.

The exact-current canonical row-11 runtime probe used candidate ordinal 12 of
12 and paired/reconciled successfully, but exposed only 2 public agents/1 edge,
zero identity-evidence records, and no Rhea/Kuhn/Noether branch. Its sanitized
artifact is the row-11 blocker above; earlier permission/403/ordinal-pairing
captures are rejected or archived and are not promoted.
