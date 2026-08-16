# G7 production hierarchy evidence

Status: independent code/evidence and parent-agent browser review **PASS** on
the exact source listed below. The G8 fresh local/runtime/accessibility
acceptance campaign remains **PENDING**; this note does not authorize release.
No aggregate gate, commit, push, or release was performed for G7.

## Scope and authority

The production standalone path now renders the same normalized public-v1
projection through `ProductionHierarchy` for Canopy, Focus Lens, and Outline.
The adapter preserves strict public-v1 task, identity, lifecycle, verification,
counts, partial-state, and allowlisted story fields end-to-end. A malformed
payload declaring public-v1 fails closed rather than falling through to a
permissive legacy renderer. Legacy input compatibility remains in the parser,
but the old private-field tree/detail renderer is not imported by the
production App path.

The UI contains no source path, prompt, reasoning, tool argument, credential,
or private source identifier. Node controls are React buttons in a semantic
`region`; the SVG connector layer is decorative. Outline is a real tree with
`treeitem`, level, set position, expanded, selected, and predictable
Up/Down/Home/End/Left/Right/Enter/Space behavior. Focus Lens derives its
selected branch, ancestry breadcrumbs, context lanes, minimap, and one
allowlisted structural story strip from the same projection. Failed switch or
unpair mutations preserve the existing local binding and show a non-enumerating
alert; successful mutations refresh the authoritative snapshot. Every local
mutation response preserves a valid replacement CSRF value even when a 2xx
response body is malformed. The confirmation dialog establishes initial
focus, traps Tab within the modal, supports Escape while idle, and restores
focus to its trigger.

Canopy parent cards expose an explicit selected-card Expand/Collapse action in
the existing lifecycle badge. A single pointer/touch/Enter activation toggles
an already selected parent, and ArrowLeft/ArrowRight provide the matching
keyboard path. Outline reports visible active/settled counts, primary branches,
and actual maximum ancestry depth rather than treating every non-completed
state as active. Its accessible row label announces safe parent, level, child
count, lifecycle, requested/observed model, and verification. Legacy fixture
compatibility remains bounded, but its model/provider/effort labels now pass
the same path/credential screening as display labels.

The browser-review harness is a DEV-only exact query and uses the real
production component, not the G6 presentation fixture:

```text
http://127.0.0.1:5173/?fixture=g7-production
```

It merges both strict public-v1 fixture pages (25 active + 200 settled), runs
through `normalizeSnapshot` and the normal reducer, and dynamically imports
only while `import.meta.env.DEV === true`. The harness is not exported from
`index.ts` and is removed from the production entry path by the Vite DEV
constant. G6 remains separately available at its documented DEV-only query.

## Targeted command matrix

| Command | Result |
|---|---|
| `cd apps/web && ../../node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false` | PASS — exit 0 on the final reviewed source |
| `cd apps/web && ../../node_modules/.bin/vitest run src/standalone-bootstrap.test.ts src/production-hierarchy.test.tsx src/public-v1.test.ts` | PASS — 3 files, 30 tests on the final reviewed source |
| `cd apps/web && ../../node_modules/.bin/vitest run src/g7-production-fixture.test.tsx src/production-hierarchy.test.tsx` | PASS — 2 files, 6 tests before the independent review corrections |
| `cd apps/web && ../../node_modules/.bin/vitest run` | PASS — 9 files, 85 tests before the bounded Focus visibility correction; not rerun afterward by design |
| `cd apps/web && ../../node_modules/.bin/tsc -b --pretty false` | PASS — exit 0 before the final geometry-only cluster correction; not rerun afterward by design |
| `cd apps/web && ../../node_modules/.pnpm/node_modules/.bin/vite build` | PASS — 175 modules; Vite emitted a >500 kB chunk warning before the final geometry-only cluster correction; not rerun afterward by design |
| `node evidence/phase-f/check-private-source-ids.mjs` | PASS — `Private Codex source identifier scan passed.` on the final reviewed source |
| `pnpm check:privacy` | HOLD — pnpm attempted registry metadata/install and aborted in the non-TTY environment; the direct privacy script above passed |

The final focused tests cover strict public-v1 rendering,
malformed payload fail-closed behavior, Canopy/Focus/Outline parity, safe
details and forbidden-key scanning, Focus minimap/story, Outline keyboard
navigation, truthful Outline summaries, pointer/touch/keyboard collapse,
modal focus restoration, switch/unpair confirmation and rotated-CSRF error
recovery, and legacy identity-label privacy. The earlier harness matrix covers
the complete 225-node DEV-only query/export boundary.

## Parent-agent browser review

The parent reloaded the exact final source at the DEV-only production harness
after the independent-review corrections. This is a bounded G7 browser review,
not the G8 fresh-host campaign:

- Desktop Living Canopy rendered 25 active cards plus 3 settled clusters with
  node/cluster pair overlap `0`, outside-container count `0`, and document
  horizontal overflow `0`.
- The selected Main card showed the action inside its state badge with
  `aria-expanded=true`. One click collapsed the projection to 1 card,
  changed the action to `Expand branch`, and set `aria-expanded=false`; the
  second click restored 25 cards, `Collapse branch`, and
  `aria-expanded=true`.
- Desktop Focus Lens kept selected Atlas visible with 16 cards plus 3 clusters,
  node/cluster pair overlap `0`, and document horizontal overflow `0`.
- Mobile at inner width 360 rendered with node/cluster pair overlap `0`,
  critical clipping `0`, document horizontal overflow `0`, and the selected
  card action visibly present with truthful expanded state.
- Mobile Canopy at the product 200% control rendered with `data-zoom=200`,
  node/cluster pair overlap `0`, critical clipping `0`, and document horizontal
  overflow `0`. Computed text sizes were exact 2x: node name
  `11.68→23.36`, metadata `9.44→18.88`, toolbar button `11.2→22.4`,
  select/input `10.88→21.76`, and Details heading `18.4→36.8`.
- Mobile Outline kept all 225 treeitems at 200%. Computed sizes were exact 2x:
  row `16→32`, name `11.52→23.04`, metadata `9.44→18.88`, and summary
  `10.56→21.12`; critical clipping and document horizontal overflow were `0`.
- Reduced motion still computed to no animation and zero transition duration,
  and the OS `prefers-reduced-motion` stylesheet rule remained present.
- The dark toggle changed the app background from `rgb(243,246,245)` to
  `rgb(18,33,40)`, text from `rgb(23,51,58)` to `rgb(232,245,241)`, and node
  background from white to `rgb(23,44,52)`, with `prod-theme-dark` present and
  document horizontal overflow `0`.
- The final browser console warning/error list was empty.

The first post-review desktop capture that placed the action as a fourth text
line was rejected because it produced 18 node overlaps. The accepted final
source moves the selected-only action into the existing state badge; the
measurements above are from that corrected source.

## Source and stale/private scan

The final G7 source manifest covers the fourteen implementation/contract/test
files below. It intentionally excludes this evidence file to avoid a
self-referential digest. The aggregate is SHA-256 of the newline-terminated
`shasum -a 256` manifest in the listed order.

```text
d328cef63dae935ecd21a641f934d96ab671bde7052bfe1585db371d4f31bdd8  apps/web/src/types.ts
eedcaeba7674c86b1d6142a13e10a1a0d6f98c6e4d75da7cbdfa2904b5a39f61  apps/web/src/normalize.ts
bec2bffe2bbfc2f1f37b8961c1b4d37e2576d8dc45813833dc0777b1eaef6c26  apps/web/src/production-hierarchy.tsx
d8e36c2c8e8d263bd559e707a7857de80f30bb13dc1c2f1608c6a05c5e5e7461  apps/web/src/production-hierarchy.css
390d90c8f86f6582a68aa7addfa613c7725f92ef63e4d10881b93e70480bce37  apps/web/src/production-hierarchy.test.tsx
9dbc1b99589aadcba707fd837a1fdf1f0f1608f08d6e9aab08d3fa690eeab697  apps/web/src/App.tsx
f105f0c08d085f56af9c813b0a5df34d5476ea2e2789db7a26f9daabb6fa047e  apps/web/src/App.test.tsx
49f4f64aadf316d0aff0c516a32abcb92ad7a1e66e1a24034b996e1f0d12a027  apps/web/src/public-v1.test.ts
495106f5ec35f9a973f98833fba27acdde1ee9d659ae03bc17b8b3a4f8119fec  apps/web/src/g7-production-fixture.tsx
e71d2f5be239e8ad46f35b1b1a9f542b636158c8393be2557664a13ad0293ac2  apps/web/src/g7-production-fixture.test.tsx
6384d3d788b4df71d2810ccb471aec6f8ecbdc43056ffa2c5960df12b12899b1  apps/web/src/main.tsx
e92ee5c0ee659fde2bbbaad42fd281a3dc05f5e70016f20351549e8043b22c64  apps/web/src/standalone-bootstrap.ts
f083991ffbb3d671391bc1e2ee9367a19ed9d40705f695892b266b19beb660f2  apps/web/src/standalone-bootstrap.test.ts
142b66bc375260dccc41a00f8f2cadda3756f9a562a5ab09db6ff0a8cfc98d23  apps/web/src/global.d.ts
aggregate: 288144d7499e6739b1c072b239bb483f897aa235d46fb9085e073fefae996255
```

The stale selector scan found no `prod-prod-*`, `TODO`, or `FIXME` in the
production component/styles/harness. The repository-wide privacy scan passed.
Legacy private-field names still exist in compatibility parsers, historical
evidence, and negative-test assertions; they are not production response/render
fields and the old tree renderer is not reachable from `App.tsx`.

## Holds and next gate

- Outline keyboard semantics now move an expanded parent to its first direct
  child (Atlas → Atlas · Ada regression); collapsed parents expand in place and
  leaves remain stationary.
- Outline rendering now uses authoritative DFS/preorder, keeping each parent
  immediately followed by its visible descendants before the next sibling
  branch.
- Fresh supported-Mac install/start, real local runtime, production launcher,
  fresh built-in-browser/console acceptance, contrast, and macOS VoiceOver
  campaign remain G8 HOLD. The bounded G7 fixture checks above do not replace
  those fresh-host gates.
- MCP/standalone fresh parity and production launcher/doctor acceptance remain
  pending the local acceptance campaign; no external host acceptance is
  inferred from these web tests.
- G8 fresh-host work, release packaging, and any G9 claim are explicitly out
  of scope for this patch.
