# G6 visual specification evidence

Status: independent code/evidence/browser review **PASS** on the exact final
source. User approval for the Living Canopy and Focus Lens is **APPROVED** in
this turn. Sol review and the remaining product acceptance gates are still
**PENDING**, so this does not authorize release. No commit, push, release, or
G7 backend work is claimed. The user explicitly waived the initial commit
earlier in this checkout.

## Scope and boundary

G6 is delivered as a code-native, deterministic development fixture in
`apps/web/src/g6-fixtures.ts`, `g6-fixture.tsx`, and `g6-fixture.css`. The
entry point in `apps/web/src/main.tsx` is inert unless both of these conditions
hold:

```text
import.meta.env.DEV === true
URLSearchParams(location.search).get("fixture") === "g6"
```

`main.tsx` loads the fixture with a dynamic import inside that DEV-only branch,
and `index.ts` does not export the fixture or its data. This keeps it out of the
ordinary public entry graph at source level and leaves the G5 runtime path
unchanged. A fresh production-bundle check remains part of later acceptance.
The fixture uses no remote asset, CDN, raster mockup, or backend/G7 interaction.
The local route for review is:

```text
http://127.0.0.1:5173/?fixture=g6
```

Start it from the repository root with:

```text
pnpm --filter @agent-farm/web dev --host 127.0.0.1 --port 5173
```

The fixture data is parsed through the strict G5 public-v1 shape. It contains
two deterministic pages (200 + 25 nodes), 225 nodes, 224 edges, one root, at
least three primary branches, depth three, 25 active nodes, and 200 completed
descendants. The browser-facing fixture contains only public-safe labels,
lifecycle/task summaries, counts, edges, and story milestones; no source root,
agent path, installation/session identifier, credential, prompt, reasoning,
tool argument, result, or error payload is included.

## Visual contract implemented

- **Living Canopy** is the whole-farm view. Active branches use lane-and-stack
  geometry; completed descendants collapse into truthful settled clusters while
  active, failed, disconnected, and unverified states remain individually
  visible with text and shape as well as color.
- **Focus Lens** selects one branch and shows one selected-branch story surface
  plus contextual cards. The title, counts, and selected branch remain
  truthful; the story is not duplicated into a second competing surface.
- **Outline** exposes the same hierarchy and counts as a tree-compatible
  equivalent mode rather than a simplified hidden fallback. The deterministic
  fixture order is parent-before-child depth-first; visible indentation,
  `aria-level`, and Left/Right/Up/Down/Home/End navigation preserve the public
  branch/depth structure.
- Sol/Luna identity, verification, and lifecycle use distinct tokens, border
  treatments, shape glyphs, and text labels in addition to color.
- Structural spawn/settled events are shown as allowlisted story milestones;
  working activity travels downward and returned results travel upward. Both
  the manual control and `prefers-reduced-motion` remove fixture animations and
  transitions.
- Desktop, tablet, narrow mobile, light/dark canvas, and 200% text zoom have
  deterministic reflow rules. Narrow/zoom layouts use a vertical scroll lane
  when spatial connectors cannot remain readable.

## Targeted command matrix

| Command | Result |
|---|---|
| `cd apps/web && ../../node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false` | PASS — exit 0 on the final reviewed source |
| `cd apps/web && ../../node_modules/.bin/vitest run src/g6-fixture.test.tsx` | PASS — 1 file, 6 tests on the final reviewed source |
| `node evidence/phase-f/check-private-source-ids.mjs` | PASS — `Private Codex source identifier scan passed.` |
| Parent-agent browser review at `http://127.0.0.1:5173/?fixture=g6` | PASS on the exact final source after ancestor-bound audits and direct inspection of the accepted final artifacts below |

The unit test is a semantic/schema guard, not a geometry proof. Geometry and
computed-style measurements below were taken in the running browser fixture.

## Browser diagnostic trail and final acceptance

The original parent-agent measurements predated the independent corrections.
They remain useful diagnostic evidence, not final-current-source acceptance:

| Surface / condition | Measured result |
|---|---|
| Desktop Canopy | 25 visible cards; overlap count `0`; out-of-canvas count `0`; canvas semantics `role="region"` |
| Desktop Focus Lens | 11 visible cards; overlap count `0`; out-of-canvas count `0`; exactly one story region; heading `Focus Lens` |
| Narrow 360px override (inner 450px review lane) | Original screenshot exposed right-edge clipping; the earlier no-document-X-overflow claim did not detect clipped descendants |
| 200% text zoom | Exact `2x` computed-font ratios were recorded; final-current-source clipping/overflow still needs recapture |
| Reduced motion | Manual control was measured; the source also contains the OS preference media query, but the host preference was false and was not force-emulated |
| Console | No warnings or errors were recorded |

The final deterministic fixture test verifies these corrected scenario counts
and state labels:

```text
connected:    connected, complete, 25 active
partial:      stale, partial, 25 active
disconnected: disconnected, 0 active + 25 disconnected
failed:       connected, complete, 24 active + 1 failed
unverified:   connected, complete, 25 active + 1 unverified identity
```

The first refreshed review then recorded correct semantic/state assertions:

- Desktop light Canopy: 25 cards, no measured overlap/outside/document-X
  overflow, and `role="region"`.
- Desktop Focus Lens: 11 cards, one story surface, no measured
  overlap/outside/document-X overflow, and H1 `Focus Lens`.
- Outline: 225 tree items with levels; Left from Atlas · Ada reached Atlas and
  Right returned to the first child.
- Scenarios: disconnected showed 25 disconnected/0 active; failed showed one
  failed agent with sibling work retained; unverified visibly marked Vega;
  partial used an explicit banner.
- Manual reduced motion computed no animations/transitions. The stylesheet
  contained `@media (prefers-reduced-motion: reduce)`; the current host OS
  preference was false, so that media condition was present but not
  force-emulated.
- Console warnings/errors: none.

However, direct pixel inspection rejected responsive visual PASS. The refreshed
mobile image visibly cuts the Outline tab, Reduced motion control, banner text,
and summary row at the right edge. The refreshed tablet-dark image visibly cuts
the third branch and top controls. `document.scrollWidth === clientWidth` was
therefore insufficient because a descendant may be clipped by an ancestor
without increasing document width.

All diagnostic browser artifacts are retained under
`evidence/phase-h/visuals/g6/`. The original three images remain pre-review
inputs:

- `living-canopy-desktop.png`
- `focus-lens-desktop.png`
- `outline-mobile.png`

```text
0169af08ca6ae3b302eb316db9e4b8ba564c1fad3babf3037ffa9a13edd33d90  evidence/phase-h/visuals/g6/focus-lens-desktop.png
2bc721bcef0c5ed67b5e58b533898ef0f689410a24a23158ad0db6cc9e8a5033  evidence/phase-h/visuals/g6/living-canopy-desktop.png
ef2f9bb14ba9422014aa8ecabb630b3031767be5a956d42b38c5cfae2761f987  evidence/phase-h/visuals/g6/outline-mobile.png
```

The rejected first-refresh artifacts are:

```text
318184c1823082aa61021f92cdf71560c7013b6b73865ce684a6c3df3a96c694  evidence/phase-h/visuals/g6/focus-lens-desktop-post-review.png
a9cbacf82b85729169e4f0d1b6f166ea97a381835adf28e6dad16f318536dec9  evidence/phase-h/visuals/g6/living-canopy-desktop-post-review.png
b46278d13a8c6b26039b014d807df83d53b3da9bdae279a463162f19d4a9ca50  evidence/phase-h/visuals/g6/living-canopy-tablet-dark-post-review.png
09b659ced617c6bc5ba321dd9281d3e765fe92c8b35e66ff6fb98e3c63a824e5  evidence/phase-h/visuals/g6/outline-mobile-post-review.png
```

`file` identifies these four `.png`-named captures as JPEG-encoded image data;
their hashes and dimensions are still recorded truthfully. They are diagnostic
artifacts, not final proof or a substitute for user approval.

After rejecting them, the final source digest below adds a deterministic compact
layout: the toolbar and summary use bounded grids, the primary surface no longer
clips descendants, and Canopy/Focus use a vertical `overflow: auto` reading lane
at 1120px and below with a visible “Scroll lane · every branch remains
available” affordance. At 480px and below, tabs, toolbar controls, selector,
header metrics, banner, and Outline summary each use explicit one-column rows.

The accepted exact-final-source browser review records:

| Surface / condition | Final measured and inspected result |
|---|---|
| Desktop light Canopy | Exact final source; 25 cards; overlap, outside-canvas, and document-X counts `0`; canvas `role="region"`; three branches and completed clusters visibly intact |
| Desktop light Focus Lens | Exact final source; 11 cards; overlap, outside-canvas, and document-X counts `0`; exactly one story surface; H1 `Focus Lens` |
| Tablet dark, inner width `960` | Ancestor audit checked 37 critical elements: clipped `0`, document-X `0`; canvas computed `overflow: auto`; dark theme and visible compact scroll-lane affordance confirmed in pixels |
| Mobile light Outline, inner width `450` | Ancestor audit checked 235 critical elements: clipped-by-ancestor `0`, clipped text `0`, outside-viewport `0`, document-X `0`; 225 tree items; single-column tabs, controls, selector, banner, header, and four summary rows visibly intact |
| Outline keyboard | 225 tree items with levels; Left from Atlas · Ada reached Atlas at level 2, and Right returned to its first child at level 3 |
| 200% fixture text zoom | Exact `2x` node-name, metadata, and control font ratios were measured with clipped, overlap, and document-X counts `0`; the final mobile stacking change only replaces multi-column compact rows with full-width rows |
| Reduced motion | Manual mode computed no animations and zero-duration transitions; the runtime stylesheet contains `@media (prefers-reduced-motion: reduce)`; the host OS preference was false, so OS activation itself was not force-emulated |
| Scenario truth | Partial banner explicit; disconnected 25 disconnected/0 active; failed one failed agent with sibling work retained; unverified visibly marks Vega identity |
| Console | No warnings or errors |

Direct inspection of the accepted final images agrees with the ancestor audit:
mobile content is unambiguously single-column, tablet content uses the intended
scroll lane without a clipped right branch, and both desktop surfaces are
complete. The accepted artifact hashes are:

```text
c5d8fdd48c662180942cbc90c3acb63c7bb6725103d445ba5c1d28027dcf3175  evidence/phase-h/visuals/g6/living-canopy-desktop-final.png
edb9576c93e6176fc3c9b0ad72db8040d4f343f69d3f635f3514f1875b57cd78  evidence/phase-h/visuals/g6/focus-lens-desktop-final.png
a8d2c7f966c951d56d93343dd9d1ca3d3ca1ce0770fe096821a47bf60cd550a7  evidence/phase-h/visuals/g6/living-canopy-tablet-dark-final.png
6ee3c2e3a6ed7a059dbb9815824a54f5de2a37dd4d5bc38ab76c693767bb45f3  evidence/phase-h/visuals/g6/outline-mobile-final-v2.png
```

`file` identifies all four accepted `.png`-named captures as JPEG-encoded image
data. Their encoding, dimensions, and hashes are recorded truthfully; this
filename/encoding mismatch does not alter the inspected pixels.

## Privacy and stale-code scan

The final direct privacy command passed. The G6 test includes forbidden-key
strings only as negative assertions; those strings are not fixture data or
rendered response fields. The source scan found one dynamic import inside the
DEV/query gate, no public G6 export in `index.ts`, no legacy fixture branch, and
no raw private-field mapper. The G5 public-v1 adapter remains the authoritative
production contract. No G7 launcher, interaction, migration, or backend
authority was added. The decorative minimap alone uses `role="img"` and has no
controls. The interactive canvases use tested `role="region"` semantics.

## Source digest

The following digest covers the G6 implementation/test files and the two entry
files changed to expose the DEV-only fixture. It intentionally excludes this
evidence file so that the evidence can record the digest without self-reference.

```text
58f52605d703db87875d895723ab3913a72c8e1f69151a6dc3000800e8689c7f  apps/web/src/g6-fixtures.ts
281618dad816bd3f477894c1e17dd6f90a52776e2cc72d870777d39e58adc361  apps/web/src/g6-fixture.tsx
de88dee12b46b4eb3b63aaf10cea5203310ef6fa61d0425ca1287f7202aa5b34  apps/web/src/g6-fixture.css
a9e67aaca28203ee11183eabd5eaf87e84d71d3dc7816fb662cfd36dbec7d58f  apps/web/src/g6-fixture.test.tsx
2b8d94d1c45679ff0a8b0534d8ff3b7a5af3cce04f86a01b0bff039bdf29d1ff  apps/web/src/main.tsx
42ae98f05a31fa5124c6b78be444f389f8aac8c10c359716373e6c43898eb9d5  apps/web/src/index.ts
aggregate: d594d72964fc1985767d9ca0bd82616c6a82d1a979d2c3456412e7f60c3ccae6
```

The aggregate is the SHA-256 of the six `shasum -a 256` manifest lines in the
listed order.

## Remaining gates and holds

- G6 Living Canopy and Focus Lens user visual approval is **APPROVED** in this
  turn; the accepted final screenshots and independent review remain the
  supporting evidence. Sol review and remaining Outline/product acceptance are
  still **PENDING**.
- G7 full interaction/launcher/backend acceptance is **HOLD** and was not
  started by this patch.
- Fresh supported-Mac install, production build/start, external ChatGPT host,
  fullscreen, accessibility screen-reader/keyboard audit, and any deployed
  HTTPS acceptance remain governed by the existing Phase H checklist and are
  not inferred from this fixture.
