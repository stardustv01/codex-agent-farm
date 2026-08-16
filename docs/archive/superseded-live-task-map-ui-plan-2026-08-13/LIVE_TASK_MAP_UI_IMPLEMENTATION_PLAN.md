# Archived Live Task Map UI implementation plan

Status: **ARCHIVED — superseded by the multi-chat local product on 2026-08-13**

Scope: Local V1 UI improvement only

Principle: make the current Codex task immediately understandable without
changing the trusted runtime, reconciliation, privacy, or read-only boundaries.

## Product outcome

Opening Agent Farm from a Codex task should silently mount that task and show one
live hierarchy workspace. The user should not need to understand pairing,
bindings, reconciliation, or view modes before seeing the agents.

The primary experience is:

1. compact current-task header;
2. live parent/child hierarchy;
3. contextual agent inspector;
4. clear sync, lifecycle, and identity states.

The desktop and mobile layouts should express the same information architecture,
not two different products.

## Guardrails

- Keep the existing app-server authority, trusted local rollout fallback,
  durable reconciliation, revision endpoint, and guarded browser polling.
- Keep Agent Farm read-only. Do not add steer, interrupt, undo, spawn, or other
  Codex-control actions.
- Keep credential and token values excluded.
- Do not build a multi-task dashboard for Local V1.
- Do not replace polling with streaming in this work.
- Do not redesign cost calculation, storage, or identity reconciliation.
- Preserve arbitrary nested subagents; do not flatten the data model to fit a
  mockup.

## Phase 1 — Silent current-task mounting

Refine the startup flow in `apps/web/src/App.tsx`:

- Existing valid binding: remount silently.
- Exactly one eligible current task: select and mount it automatically.
- No eligible task: show a compact “No active Codex task” state with Retry.
- Multiple genuinely ambiguous tasks: open a small task chooser.
- Move Switch task into an overflow menu.
- Remove Pair and Unpair language from the normal product surface. Keep the
  underlying local-binding operations for recovery and diagnostics only.

Acceptance:

- The normal current-task path reaches the hierarchy without a pairing panel.
- Restart/remount and two-browser isolation continue to work.
- A failed mount never displays a false connected or empty hierarchy state.

## Phase 2 — One hierarchy workspace

Simplify `apps/web/src/production-hierarchy.tsx` and its CSS:

- Replace the competing Living Canopy, Focus Lens, and Outline navigation with
  one primary **Hierarchy** workspace.
- Keep focus as an interaction within the hierarchy, not a separate mode.
- Retain the accessible tree/list implementation as a secondary accessibility
  view instead of deleting its semantics.
- Use a compact top bar for task name, sync state, agent counts, search, filters,
  theme, and overflow.
- Remove the visible advisory-budget strip, binding-control strip, story strip,
  and permanent legend from the main reading path.
- Show lifecycle totals as small metrics: Active, Waiting, Complete, Blocked.
- Within each parent's direct children, order agents by lifecycle priority:
  **Active first**, then Blocked, Waiting, Complete, and Unknown. Preserve the
  real parent/child structure; ordering must never reparent or flatten agents.
- Give Active agents a consistent high-visibility treatment: live dot, stronger
  accent rail/border, and full-opacity label. Do not rely on color alone.

Acceptance:

- The first viewport contains task context and agents, not setup controls.
- Active agents are visible first and clearly highlighted on desktop and mobile.
- Search and filters remain available but no longer dominate the page.
- Existing selection, expanded branches, filters, and keyboard focus survive a
  live snapshot refresh.

## Phase 3 — Responsive hierarchy and inspector

Desktop:

- Use a viewport-bound workspace with hierarchy on the left and a stable
  inspector on the right.
- Make parent/child depth, branch membership, and lifecycle readable without
  relying on decorative connectors alone.
- Allow dense wide trees to use the existing overlap-safe vertical lane.

Mobile:

- Use Sol Pro's two-stage hierarchy instead of a long agent list:
  1. **Task overview:** root task, important primary branches, and a grouped
     settled remainder such as `+7 settled`.
  2. **Branch focus:** breadcrumb, selected branch, and that branch's children.
- Never group or hide active, blocked, mismatched, or newly arrived descendants.
- Apply the same Active-first sibling ordering in Task Overview and Branch Focus.
- Show one compact selected-agent preview below the task map.
- Open deeper agent details in a bottom sheet. The sheet is an interaction
  pattern only; it must not turn the underlying hierarchy into a flat list.
- Do not add bottom navigation or render all agents as one long scrolling feed.
- Do not place permanent Overview/Timeline panels under every visible branch.
- Keep primary task state and branch context visible without a 3,000+ px
  journey.

Inspector:

- Use two tabs: **Overview** and **Timeline**.
- Overview contains identity, lifecycle, parent/children, summary, changed
  files, and cost truth.
- Timeline contains messages and read-only tool activity.
- Keep usage segments and pricing provenance collapsed by default.
- Display estimated, partial, and unavailable costs exactly as recorded; never
  substitute zero.

Acceptance:

- No card overlap or document-level horizontal overflow at desktop, 360 px,
  dark mode, or 200% text zoom.
- Selecting an agent on mobile opens a keyboard-accessible sheet and restores
  focus when closed.

## Phase 4 — Truthful live-state language

Present separate state axes instead of one overloaded badge:

- **Viewer:** Live, Catching up, Reconnecting, Stale.
- **Lifecycle:** Active, Waiting, Complete, Blocked, Unknown.
- **Identity:** Matched, Observed, Mismatch, Unavailable.
- **Model:** requested and observed values shown separately when available.

Use the existing revision feed for updates. New agents may receive a brief
reduced-motion-safe highlight, and multiple changes should be announced as one
aggregated accessible update. During refresh, preserve the last confirmed tree
instead of hiding it.

Acceptance:

- A newly spawned nested subagent appears without page reload within the
  existing bounded refresh window.
- Background reconciliation does not hide the durable hierarchy or flip the UI
  into a false unverified state.
- “Unverified” is not used when the more precise state is Observed or
  Unavailable.

## Phase 5 — Focused verification

Add or update only tests that protect the changed behavior:

- zero / one / ambiguous current-task startup;
- restart/remount and cross-browser isolation;
- one hierarchy view with preserved selection, expansion, filters, and focus;
- arbitrary nested child rendering;
- mobile bottom-sheet behavior and desktop inspector behavior;
- live revision arrival and stale-response rejection;
- lifecycle and identity-label semantics;
- absence of Codex-control actions and credential-shaped values;
- desktop, mobile, dark, reduced-motion, 200% zoom, keyboard, and console audit.

Run targeted tests while implementing. After the UI stabilizes, run one exact
build and one fresh local browser acceptance campaign. Do not repeat acceptance
without a diagnosed source change.

## Expected files

Primary:

- `apps/web/src/App.tsx`
- `apps/web/src/production-hierarchy.tsx`
- `apps/web/src/production-hierarchy.css`
- `apps/web/src/reducer.ts`
- `apps/web/src/types.ts`
- corresponding focused web tests

Conditional only if automatic selection cannot be expressed through the current
contract:

- `apps/web/src/standalone-bootstrap.ts`
- a minimal local-only server contract/route adjustment

No runtime, store, pricing, or reconciliation source should change unless a
specific failing acceptance case proves it is necessary.

## Final design authority

Use these approved boards as the visual and information-architecture authority:

- `evidence/ui-redesign-2026-08-13/final-ui/agent-farm-desktop-final.png`
- `evidence/ui-redesign-2026-08-13/final-ui/agent-farm-mobile-final.png`

They are implementation targets, not permission to fabricate unavailable data
or weaken the product guardrails in this plan. When a board and written behavior
differ, the behavioral and truthfulness requirements in this plan win.

Earlier concepts remain design history only. In particular, the rejected
direct-ImageGen long-list mobile concept is archived and is not an implementation
reference.

## Deferred beyond this implementation

- Multi-task dashboard and task history.
- Streaming transport or sub-second sync rewrite.
- Semantic branch compression and virtualization unless real performance data
  proves they are necessary.
- Hosted mode, OAuth, publication, and VoiceOver certification.
- Any Codex mutation or automatic control feature.

## Completion definition

This UI work is complete when the current task opens directly into a readable
live hierarchy, desktop and mobile share one coherent information architecture,
agent detail is contextual rather than page-length, live changes arrive without
losing user state, and all existing privacy/read-only/runtime guarantees remain
green.

## Corrected implementation evidence — 2026-08-13

- A trusted local launch now supplies the server-only current Codex task ID.
  An old durable binding is claimed only when it names that same task.
- A different trusted launch target replaces the exact old binding with a fresh
  Agent Farm projection session, preventing historical agents from contaminating
  the new task.
- The ambiguous-task chooser remains available, `Switch task` is restored in
  the overflow menu, and discovery failures are surfaced instead of silently
  becoming an empty candidate list.
- The production surface is one active-first hierarchy with a contextual
  desktop inspector and a 360 px branch-focus/mobile-sheet flow.
- Viewer freshness, lifecycle, identity, model, and pricing provenance remain
  separate truthful axes. Exact-session rollout lifecycle may fill only an
  unknown list/read lifecycle; explicit app-server state always wins, invalid
  values are ignored, and genuinely missing evidence remains `Status
  unavailable`.
- Partial aggregate cost now retains a known self/descendant subtotal and its
  pinned pricing provenance while explicitly labeling the remainder
  unavailable. It is never presented as a complete total or as zero.
- Completed branches remain visible in the hierarchy. They are ordered after
  higher-priority lifecycle states but are no longer collapsed into an opaque
  settled-branch count.
- Superseded production renderer modes and their `.prod-*` styles were removed.
  The G6 visual-spec fixture remains DEV-only historical evidence.
- Package-level typechecks passed. Focused server/store/config coverage passed
  71 tests, the web suite passed 97 tests, and local integration passed 19 tests.
  Privacy scanning and the exact built web bundle also passed.
- Built local browser acceptance passed desktop hierarchy/inspector, 360 px
  branch focus, mobile bottom sheet, focus return, dark mode, reduced-motion
  CSS, and true 200% text reflow. At 360 px and a computed 32 px base font,
  document `scrollWidth` equalled `clientWidth` (360 px), with no browser console
  warnings or errors.
- Built-browser recovery acceptance passed: the trusted launch target was marked
  `launched here`, the old binding did not win, a fresh projection mounted, the
  `Switch task` dialog opened, and the console had no warnings or errors.
- Current built-browser correction acceptance showed four real nodes: the root,
  three direct children, and the exact named Luna monitor. All four recovered
  `Complete` from trusted exact-session evidence; the two guardian children
  stayed generically named because no trusted task labels exist. Desktop and
  360 px mobile both displayed all four nodes, the mobile preview opened the
  inspector sheet, and dark plus true 200% text modes remained operable.

## Final visual acceptance — 2026-08-13

- The approved desktop information architecture is implemented with a compact
  branded header, lifecycle totals, centered root, explicit parent-to-branch
  connector geometry, proportional model-marked cards, and a stable contextual
  inspector with navigable Parent and Children rows.
- The approved mobile information architecture is implemented with a compact
  terminal mark, root summary, connected branch rail, branch-size labels,
  focused branch summary and descendant rail, selected-agent preview, and a
  compact bottom sheet that can expand to full identity and cost details.
- Deterministic inline SVG assets replace placeholder glyphs for the Agent Farm
  brand, terminal mark, model identities, search, chevrons, and sheet controls.
  The brand geometry was informed by one ImageGen exploration; no generated
  raster asset ships in the product UI.
- The illustrative nested Terra child in the approved board is a visual testing
  fixture, not a requirement to fabricate a Terra agent in live runtime data.
  Arbitrary nested hierarchy behavior remains protected by source tests.
- Final source acceptance passed 100 web tests, the web typecheck, the complete
  production build, build-manifest freshness, and privacy scanning. The exact
  built browser passed desktop and 360 px mobile layout, compact and expanded
  mobile details, partial-cost semantics, dark mode, true 200% text, and zero
  document-level horizontal overflow (`scrollWidth === clientWidth`).
- The corrected suites passed 260 server/store/contracts/MCP tests (including
  16 local-HTTP tests rerun with loopback permission), 99 web tests, and 43
  Codex-bridge tests with one explicit real-runtime skip. Package typechecks,
  production build, durable partial-cost reload coverage, and privacy scanning
  passed.
- The decisive original hierarchy campaign remains unproven: the current run
  now has the required three direct agents, but it does not contain the required
  nested Terra child. Therefore the formal completion definition above is still
  **HOLD**.

This is implementation evidence only. It does not authorize a completion claim, commit, tag,
release, publication, hosted deployment, OAuth promotion, or VoiceOver
certification.
