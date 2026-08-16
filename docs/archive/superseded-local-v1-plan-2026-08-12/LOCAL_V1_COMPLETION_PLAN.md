# Agent Farm Local V1 Completion Plan

Status: **G0/G1 STABILIZED — G2 PENDING USER-APPROVED INITIAL COMMIT**

Plan date: 2026-08-11

Active checkout: `/Users/praveengupta/Desktop/Agent-farm V1/agent-farm`

Target: a trustworthy, installable, loopback-only Agent Farm Local V1.

This is the authoritative completion plan derived from the complete Agent Farm
task history and a fresh inspection of the active checkout. It separates the
historically proven core from unfinished Local V1 work. A passing historical
artifact, test subset, generated build, or visual prototype must not be used to
claim that the current source is locally release-ready.

## 1. Outcome

Agent Farm Local V1 is a read-only companion for visualizing recursive Codex
agent hierarchies. A supported user must be able to install it locally, start it
with one documented command, select one sanitized Codex task, establish a
trusted binding, and inspect its complete recursive hierarchy without Agent
Farm controlling or modifying Codex.

The finished product must provide three coordinated views over the same
server-owned projection:

1. **Living Canopy** — a whole-farm spatial hierarchy for understanding all
   independent primary branches and their descendants.
2. **Focus Lens** — a selected-branch view with parent, ancestors, descendants,
   sibling context, minimap, and a safe Spawned → Working → Returned story.
3. **Outline** — a compact semantic tree that is fully usable with keyboard,
   screen readers, high zoom, reduced motion, and narrow screens.

The server remains authoritative. The browser never invents lineage, model
identity, lifecycle, task ownership, or verification.

## 2. Current checkout truth

### 2.1 Historically proven foundation

The checkout contains substantial implementation for:

- a pinned, read-only Codex app-server bridge;
- sanitized recursive hierarchy reconstruction;
- requested-versus-observed model, effort, and provider evidence;
- durable SQLite projection and deterministic rebuilding;
- authenticated REST and a four-tool read-only MCP surface;
- OAuth/BFF production code and session-isolation tests;
- source-root attestation and signed pairing machinery;
- React Outline-style hierarchy, details, search, filters, and branch focus;
- local runtime and dropped-transport recovery evidence; and
- privacy, production-preflight, scale, and fail-closed validator coverage.

The retained Phase-F and Phase-G runs are historical evidence for the source
that produced them. Their recorded source manifests do not match the present
checkout after later Local V1 edits, so they cannot certify current source.

### 2.2 Pre-stabilization failures and remaining incomplete work

The exact pre-stabilization failures are retained in
`evidence/g0/BASELINE_FAILURES.md`. The bounded Phase 1 repairs resolved the
typecheck, package-test, Local E2E resolution, pagination, and build failures;
the one-source-state `pnpm check` run is recorded in
`evidence/g0/G1_GATE.md`. That G1 result is compilation and test evidence only,
not release readiness.

The current checkout remains unrecoverable and not release-ready because:

- the Git branch is unborn and has no commits;
- every source file remains untracked;
- G2 has not received the required explicit user approval or initial commit;
- the approved G3+ local-session, opaque-selection, durable-pairing, public-
  contract, and three-view work remains incomplete;
- no fresh Local V1 browser, restart, persistence, accessibility, or cleanup
  acceptance has been retained; and
- the relevant loose Agent Farm visual reference remains outside the active
  repository while the two unrelated EOC prototypes are preserved under the
  explicitly named outer archive.

### 2.3 Approved-plan divergences already present

These must be corrected rather than silently documented as acceptable:

- The browser currently receives raw `sourceRootId` values. The approved Local
  V1 design requires opaque, short-lived selection handles.
- Candidate data may include `agentPath`, and the UI renders it. Public task
  selection must not expose filesystem paths, rollout paths, raw source IDs, or
  private Codex identifiers.
- Local mutations currently use a fixed loopback principal without the approved
  automatic HttpOnly local session and CSRF boundary.
- The implemented UI remains the existing Outline/tree surface; Living Canopy,
  Focus Lens, minimap, safe story strip, and clustering are absent.
- Setup records and displays an orchestration budget, but Agent Farm V1 is
  read-only and does not configure or enforce Codex concurrency. The UI must not
  imply otherwise.

## 3. Product and security boundaries

### 3.1 In scope

- macOS local installation from a verified checkout or prepared archive;
- exact loopback binding only;
- automatic local browser session without OAuth login;
- sanitized Codex task selection and trusted pairing;
- durable selected-task binding and restart recovery;
- recursive hierarchy with several independent primary branches;
- authoritative names supplied by Codex, with clearly marked safe fallbacks;
- requested and observed identity evidence kept separate;
- Living Canopy, Focus Lens, and Outline;
- search, filtering, expand/collapse, branch focus, details, pan/zoom/fit, and
  large-farm clustering;
- read-only local REST and existing read-only MCP compatibility;
- clean install, real browser, security, privacy, accessibility, scale,
  persistence, rollback, and uninstall acceptance; and
- a reproducible exact-commit release candidate.

### 3.2 Explicitly deferred

- public deployment;
- a live external OAuth provider;
- external ChatGPT MCP registration, inline rendering, or fullscreen acceptance;
- LAN or remote access;
- cloud sync or multi-user collaboration;
- Agent Farm spawning, steering, messaging, retrying, stopping, archiving, or
  deleting Codex agents;
- modification of `~/.codex/config.toml` or Codex concurrency settings;
- modification, patching, or re-signing of ChatGPT or Codex desktop apps;
- unrelated third-party local applications;
- npm publication, GitHub publication, or public release without explicit user
  approval; and
- release claims for Windows or Linux without genuine platform acceptance.

### 3.3 Non-negotiable rules

- The supported Codex app-server is the only topology authority.
- Agent text and self-report never prove model identity.
- Caller-supplied owner, tenant, session, root, path, or installation identity
  never establishes authority.
- No prompt, message, reasoning content, tool argument, credential, token,
  cookie, raw source ID, or private path enters the public projection.
- Missing or conflicting evidence produces an explicit unverified, partial, or
  quarantined state; it is never guessed.
- Local mode must fail closed for non-loopback address, Host, Origin, forwarded
  header, selection-token, session, CSRF, and pairing failures.
- Production OAuth behavior must remain fail-closed and must not be weakened to
  make local mode easier.
- V1 remains read-only with respect to Codex.

## 4. Gate model

Work proceeds only through these gates. A later phase cannot compensate for a
failed earlier gate.

| Gate | Required result |
|---|---|
| G0 — Authority | Active source, documentation authority, archives, and exact current failures are identified. |
| G1 — Green baseline | Privacy, typecheck, package tests, integration tests, build, and offline preflight pass from one source state. |
| G2 — Recoverable baseline | A reviewed initial commit exists; ignored/generated/local files are excluded; a source manifest is retained. |
| G3 — Local security | HttpOnly local session, CSRF, opaque selection handles, loopback/Host/Origin enforcement, and negative tests pass. |
| G4 — Durable pairing | Sanitized selection, server-owned attestation, restart remount, task switching, and unpairing pass. |
| G5 — Public contract | Versioned safe hierarchy/story contract, migrations, privacy scan, and deterministic rebuild pass. |
| G6 — Visual specification | Code-native fixtures for Canopy, Focus Lens, and Outline are reviewed and accepted before production wiring. |
| G7 — Feature complete | All three views and required interactions operate on the same authoritative projection. |
| G8 — Local acceptance | Clean install, real runtime, built-in browser, security, persistence, scale, accessibility, and cleanup pass. |
| G9 — Local release candidate | Exact commit/archive checksums, rollback, uninstall, documentation, and final critic verdict pass. |

## 5. Execution phases

### Phase 0 — Re-establish authority and repository hygiene

Purpose: stop planning artifacts, generated output, historical evidence, and
active product source from being treated as one undifferentiated state.

Tasks:

- Inventory all 137 active repository files and classify source, test, evidence,
  documentation, generated output, local state, and backup material.
- Confirm that `/Users/praveengupta/Desktop/Agent-farm V1/agent-farm` is the only
  active product checkout.
- Classify the three loose outer HTML files:
  - preserve the current Agent Farm design reference if still useful;
  - move unrelated or superseded prototypes into an explicitly named archive;
  - do not copy archived EOC content into active Agent Farm documentation.
- Keep `.agent-farm/`, databases, credentials, local keys, build outputs,
  caches, and `node_modules` ignored.
- Keep the recoverable npm artifact under `.agent-farm-backups/`; document why
  it exists or move it into the selected archive boundary.
- Establish a documentation map:
  - this file governs remaining Local V1 work;
  - evidence ledgers report observed facts only;
  - external/OAuth documents move to `docs/archive/future-remote/` if they are
    not needed for active Local V1 operation;
  - historical evidence is never rewritten as a current pass.
- Record current command failures and a current source manifest before edits.
- Scan active source/docs for private identifiers, absolute personal paths,
  secrets, stale counts, stale statuses, and contradictory release language.

Exit criteria:

- G0 passes.
- No file has ambiguous active-versus-archived authority.
- No historical PASS is described as current-source certification.
- Exact failing commands and source manifest are retained without secrets.

### Phase 1 — Restore a green, recoverable baseline

Purpose: repair the interrupted Local V1 changes before adding another feature.

Tasks:

- Add a strict `parseHostPort` helper beside the existing port parsing logic.
  It must reject empty, nonnumeric, fractional, zero, negative, and greater-than-
  65535 ports without silently defaulting.
- Fix the two `exactOptionalPropertyTypes` failures by omitting absent optional
  properties rather than passing explicit `undefined`.
- Correct pagination fail-closed behavior so malformed and repeated cursors
  produce a truthful stale/partial snapshot instead of an unrelated exception.
- Make the local-pairing URL test derive its expectation from the test origin,
  including the explicit port.
- Repair root-level workspace resolution for the Local E2E test. Do not depend
  on accidental build artifacts or undeclared workspace links.
- Verify setup/start CLI grammar. Supported examples must be exact:

  ```text
  pnpm run setup --budget=10,10,3
  pnpm start:local --build
  ```

  The scripts must either deliberately accept pnpm's optional separator or
  reject it with one consistent documented message; docs and tests must agree.
- Ensure the launcher never starts from partially refreshed server dist plus
  stale web dist.
- Run every package typecheck/test independently before running the aggregate
  gate so a first failure does not hide later failures.
- Run the full local gate from the exact same source state:

  ```text
  pnpm check:privacy
  pnpm typecheck
  pnpm test
  pnpm build
  pnpm check:production-preflight
  pnpm check
  ```

- After G1, review ignored and untracked files, then obtain explicit user
  approval for the initial commit. Record commit ID and source manifest.

Exit criteria:

- G1 and G2 pass.
- No test is waived because another test passed.
- Build output is newer than and derived from the committed source.
- Worktree is clean after the approved initial commit.

Rollback:

- Revert only the bounded stabilization changes from the reviewed initial
  baseline. Never use destructive reset against an unreviewed or dirty tree.

### Phase 2 — Implement the correct local security boundary

Purpose: replace the fixed-principal shortcut with the approved local session
model while preserving exact loopback enforcement.

Tasks:

- Introduce a common browser-session interface with two implementations:
  - existing production OAuth BFF;
  - new local browser-session service.
- On first run, generate an Agent Farm-owned installation secret and local
  signing key using cryptographically secure randomness.
- Store local secret/key material only in the documented Agent Farm data
  directory with owner-only permissions. Never place it in source, logs,
  browser storage, URLs, or evidence.
- Issue an opaque `HttpOnly; SameSite=Strict` local session cookie. Use `Secure`
  wherever the transport permits it; document the exact loopback HTTP boundary.
- Require CSRF protection for session creation, task selection, switching,
  unpairing, deletion, or another local mutation.
- Bind the process to an exact loopback address. Reject:
  - `0.0.0.0` and LAN addresses;
  - foreign or malformed `Host` values;
  - foreign or malformed `Origin` values;
  - forwarded-host/proto attempts;
  - bearer headers in local mode;
  - token-like query or fragment values; and
  - cookie/session fixation or replay.
- Preserve non-enumerating errors across unknown, expired, revoked, and
  cross-session requests.
- Ensure production mode still requires its full OAuth configuration and cannot
  inherit local defaults.

Required tests:

- cookie attributes and rotation;
- CSRF success, omission, mismatch, replay, and cross-session use;
- Host/Origin/forwarded-header/DNS-rebinding negatives;
- two independent browser sessions;
- restart invalidation or restoration according to the documented session
  policy;
- bearer-token rejection in local mode; and
- production-configuration regression coverage.

Exit criteria:

- G3 passes.
- Local browser access works without a login screen but not without a valid
  server-issued local session.
- A loopback network position alone is not treated as complete mutation
  authorization.

### Phase 3 — Sanitize task discovery and make pairing durable

Purpose: let the user select one Codex task without revealing the private
identifiers used to bind it.

Tasks:

- Replace the browser-facing `sourceRootId` with a server-generated opaque,
  single-use, short-lived selection handle.
- Maintain a bounded server-side map from selection handle to the attested raw
  root identity. Bind the handle to local browser session, installation,
  expiration, and the exact current candidate snapshot.
- Return only safe candidate information:
  - generic or runtime-safe display name;
  - lifecycle/state;
  - safe last-activity time;
  - bounded descendant count where trustworthy; and
  - opaque selection handle.
- Remove `agentPath`, raw root IDs, filesystem paths, rollout paths, session
  paths, and installation internals from browser responses and UI.
- Use authoritative runtime nicknames where safe. If absent, display a clearly
  marked fallback such as `Agent task 01`; never expose the raw ID as a label.
- Preserve the existing server-owned attestation and signed pairing challenge.
- Pair the already accepted app-server client; do not create a second topology
  authority after selection.
- Persist the accepted binding in SQLite using only the minimum private mapping
  needed server-side.
- Implement deliberate task switching and unpairing with CSRF, confirmation,
  audit record, and non-enumerating failures.
- On restart, remount the durable binding and projection without duplicate or
  phantom agents.

Required negatives:

- expired, replayed, substituted, cross-session, or malformed selection handle;
- caller-supplied raw source root;
- forged pairing signature;
- mismatched installation/session/attestation digest;
- multiple concurrent submissions of the same selection; and
- candidate-list refresh invalidating an old handle.

Exit criteria:

- G4 passes.
- Browser/API/evidence scans contain no raw candidate identity or private path.
- Refresh, multiple tabs, and server restart preserve only the authorized
  selected hierarchy.

### Phase 4 — Complete the safe public hierarchy and story contract

Purpose: provide everything the three views require without expanding the
privacy surface.

Tasks:

- Version the public hierarchy snapshot and event/story schemas.
- Retain requested and observed identity as separate evidence objects with
  source and trust state.
- Add only safe fields required by the accepted UI, such as:
  - safe spawn time;
  - safe completion/return time;
  - bounded activity label derived from structural runtime state;
  - direct-child and descendant counts;
  - clustering metadata;
  - safe failure category;
  - partial/disconnected reason; and
  - story milestones derived from durable sanitized events.
- Never turn arbitrary prompts, responses, tool arguments, or agent summaries
  into a public activity/result field.
- Define deterministic sibling ordering: safe spawn ordinal followed by stable
  public ID.
- Keep existing branches stable when new descendants appear.
- Define migration behavior for old SQLite projections. Migrations must be
  additive, versioned, backed up, and reversible where possible.
- Update fixtures to include Main plus at least three independent primary
  branches and depth-three nesting.
- Prove serialization, restart, rebuild, pagination, and partial-snapshot
  behavior.

Exit criteria:

- G5 passes.
- Equivalent durable input produces an equivalent public snapshot.
- Old data is migrated or rejected with an explicit recovery instruction.
- Privacy scan passes against REST, MCP, browser bootstrap, logs, and evidence.

### Phase 5 — Approve a code-native visual specification

Purpose: convert the chosen visual direction into deterministic application
states before backend integration.

Tasks:

- Treat prior ImageGen and HTML concepts as inspiration only.
- Build code-native fixture states for:
  - whole-farm Living Canopy;
  - selected-agent Focus Lens;
  - completed-descendant clustering;
  - disconnected, failed, partial, and unverified states;
  - accessible Outline;
  - desktop, tablet, narrow mobile, 200% zoom, dark, light, and reduced-motion
    variants.
- Define tokens for Sol, Luna, identity verification, and every lifecycle state.
  Meaning must use text/shape/state as well as color.
- Define motion precisely:
  - branch growth on spawn;
  - restrained downward activity pulse;
  - upward returned-result pulse;
  - settled completed branch; and
  - no nonessential motion when reduced motion is enabled.
- Review the fixture with real readable labels and realistic 25-active/200-
  completed density. Do not approve a raster mockup whose tiny labels are
  illegible or invented.

Exit criteria:

- G6 passes with user approval of both whole-farm and selected-branch states.
- Independent primary branches are immediately understandable.
- The canvas remains the primary surface; details appear on demand.
- Outline remains an equal supported mode, not a hidden fallback.

### Phase 6 — Build Living Canopy

Purpose: deliver the whole-farm spatial hierarchy.

Implementation direction:

- React DOM controls for semantic/focusable nodes;
- deterministic local hierarchy layout;
- SVG connectors and minimap geometry;
- CSS or Web Animations for bounded seek-safe motion;
- no runtime CDN or remote assets; and
- the same normalized data contract for standalone and MCP resources.

Tasks:

- Render Main as the root anchor and each direct agent as an equal primary
  branch.
- Keep a descendant visually within its authoritative parent branch.
- Show name, model family, effort, lifecycle, verification, duration, and one
  safe activity label in a compact node.
- Implement pan, zoom, fit, search, status/model filter, expand/collapse, and
  selected-node details.
- Cluster large completed subtrees without changing authoritative counts or
  hiding active/failed/unverified descendants.
- Preserve branch positions during incremental updates as far as deterministic
  constraints allow.
- Provide truthful waiting, disconnected, incomplete, failed, cancelled, and
  unverified states.

Exit criteria:

- Main → Dirac → Rhea/Kuhn and Rhea → Noether renders correctly, while other
  independent primary branches remain siblings.
- Search/filter/focus/reconnect/live insertion never changes lineage.
- The view remains responsive with 25 active plus 200 completed agents.

### Phase 7 — Build Focus Lens, minimap, and story strip

Purpose: make one branch understandable without losing whole-farm context.

Tasks:

- Center the selected agent.
- Show immediate parent above, descendants below, ancestors as breadcrumbs, and
  sibling primary branches as faded context.
- Generate the minimap from the same authoritative geometry as Living Canopy.
- Add a conditional safe story strip:
  - Spawned;
  - Working/waiting;
  - Returned/completed; or
  - failed/disconnected/incomplete when applicable.
- Show requested/observed identity, provider, verification, parent, children,
  safe activity, safe result state, and safe error category on demand.
- Support `Show whole farm` without losing selected public identity or filters.
- Restore a safe view after refresh; never recreate a selection from an unknown
  raw identifier.

Exit criteria:

- Focus transitions do not mutate hierarchy data.
- Users always understand the selected agent's location in the complete farm.
- Pointer, touch, and keyboard paths provide equivalent functionality.

### Phase 8 — Finish Outline and accessibility

Purpose: make the semantic tree a complete supported product surface.

Tasks:

- Reuse the existing reducer, pagination, keyboard, search, filters, details,
  and branch focus only where tests prove them correct.
- Add complete independent-primary-branch fixtures and large-farm behavior.
- Ensure correct tree, treeitem, group, level, expanded, selected, busy, and
  live-region semantics.
- Announce parent, depth, child count, lifecycle, requested identity, observed
  identity, mismatch, verification, and partial/disconnected reason.
- Provide visible focus, focus restoration, no keyboard trap, and predictable
  arrow/Home/End behavior.
- Make Outline the default on narrow mobile if the full canvas cannot meet the
  same usability standard.
- Test 200% text zoom, contrast, reduced motion, keyboard-only use, and macOS
  VoiceOver.

Exit criteria:

- All functionality is usable without pointer or animation.
- No information is communicated only by color, position, or motion.
- Mobile and 200% zoom contain no clipped essential control or unreadable fixed
  canvas.

### Phase 9 — Complete the installer, launcher, and doctor workflow

Purpose: make installation predictable for a supported user without relying on
chat-supplied terminal workarounds.

Tasks:

- Keep pnpm 11.16.0 and Node 22.17.0 requirements explicit until genuinely
  broadened by testing.
- Decide one supported source-checkout workflow and one future packaged
  workflow. Do not mix npm and pnpm lock/install states.
- Provide a cross-platform Node launcher with:
  - Node and package-manager checks;
  - Codex executable discovery;
  - Codex version/binary/schema compatibility verification;
  - writable Agent Farm data directory creation;
  - secure local secret/key generation;
  - SQLite initialization/migration/backup;
  - exact loopback port selection;
  - complete-build freshness/hash validation; and
  - server startup and one printed URL.
- Add `doctor` output with precise remedies for missing Codex, unsupported
  version/schema, missing pnpm, occupied port, stale assets, invalid permissions,
  corrupted database, or incomplete configuration.
- Do not automatically open personal Chrome. Provide an explicit `--open`
  option only after supported local browser routing is defined.
- Make setup idempotent and preserve user-selected configuration safely.
- Treat the Sol High/Luna Max/Sol Max budget as **advisory display metadata** in
  read-only V1, or remove it from the operational UI. It must state clearly that
  Agent Farm does not modify or enforce Codex concurrency.
- Provide unpair, reset, and uninstall operations that affect only Agent Farm-
  owned files.

Exit criteria:

- One documented command starts a built, configured local application after
  dependency installation.
- Failure messages never advise weakening loopback, privacy, pairing, or
  compatibility checks.
- No accidental `package-lock.json`, local symlink, private path, or generated
  secret enters the release source.

### Phase 10 — Run the exact local acceptance campaign

Purpose: prove the candidate rather than infer readiness from tests/builds.

All evidence must reference one exact commit and source manifest.

#### 10.1 Clean installation

- Create a fresh isolated checkout/archive extraction.
- Verify Node, pnpm, and Codex prerequisites.
- Run frozen dependency installation.
- Build from scratch with no pre-existing dist or TypeScript build cache.
- Run setup and inspect generated files/permissions without printing secrets.
- Start the product using only documented commands.

#### 10.2 Real runtime

- Select a sanitized real Codex task.
- Pair through the server-owned attestation path.
- Verify several independent primary agents and depth-three nesting.
- Verify requested/observed model and effort from trustworthy runtime evidence.
- Drop and recover the Codex child process.
- Restart Agent Farm and remount SQLite.
- Confirm no duplicate events, duplicate sources, missing agents, or phantom
  active agents.

#### 10.3 Built-in browser

- Use the Codex built-in browser, not personal Chrome.
- Verify Canopy, Focus Lens, minimap, story, Outline, search, filters,
  expand/collapse, pan/zoom/fit, clustering, details, refresh, and task switch.
- Capture browser console state and interaction results, not screenshots alone.
- Test desktop, tablet, mobile, light, dark, 200% zoom, and reduced motion.

#### 10.4 Security and privacy

- Foreign Host and Origin rejection.
- Non-loopback interface rejection where available.
- Forwarded-header/DNS-rebinding attempts.
- Missing/mismatched/replayed CSRF.
- Cookie fixation/replay and cross-session access.
- Expired/substituted/replayed opaque selection handle.
- Forged pairing identity and raw-root submission.
- Source/path/prompt/token/credential scans across API, DOM, storage, console,
  logs, SQLite public projection, and retained evidence.
- Confirmation that discovery exposes only the four read-only MCP tools and no
  Codex control route.

#### 10.5 Accessibility

- Complete keyboard-only operation.
- Visible focus and focus restoration.
- VoiceOver announcement of hierarchy, depth, expanded state, status, model,
  effort, verification, and errors.
- No color-only or motion-only meaning.
- 200% zoom and narrow-screen usability.

#### 10.6 Scale and performance

- Deterministic 25-active plus 200-completed fixture with 224 edges.
- No missing/duplicate public IDs or unstable ordering.
- Record first useful render, interaction response, branch expansion, details,
  search/filter, and fullscreen/canvas-ready measurements.
- Record long tasks, memory behavior, console errors, freezes, and crashes.
- Set release thresholds from measured evidence; do not invent a PASS threshold
  after observing a failure.

#### 10.7 Cleanup and uninstall

- Stop all Agent Farm processes.
- Preserve sanitized evidence.
- Unpair/reset/uninstall Agent Farm.
- Confirm Codex configuration, Codex sessions, ChatGPT, and user projects are
  unchanged.

Exit criteria:

- G8 passes with every required row marked PASS and an artifact reference.
- A skipped, blank, null, inaccessible, or unverified required row keeps the
  candidate on HOLD.

### Phase 11 — Prepare the Local V1 release candidate

Purpose: create a reproducible handoff without silently becoming a public
release.

Tasks:

- Resolve every justified critic finding.
- Run final stale-code, TODO/FIXME, duplicate-implementation, private-path,
  secret, and documentation-authority scans.
- Ensure historical and future-remote documents are archived and labelled.
- Add or complete local installation, architecture, privacy, security,
  troubleshooting, support matrix, rollback, reset, and uninstall documentation.
- Produce an exact-commit source archive in a clean temporary directory.
- Record commit ID, file manifest, source manifest, archive SHA-256, built MCP
  resource hash, schema version, supported Codex version/binary/schema digest,
  and acceptance timestamps.
- Verify the archive with a fresh install and browser smoke.
- Ask the user to choose the legal license before any open-source publication;
  Apache-2.0 is the default recommendation because of its explicit patent grant.
- Do not publish npm, create a public repository/release, or promote a release
  tag without explicit approval.

Exit criteria:

- G9 passes.
- Local V1 may be called **local release-ready for the tested Mac and pinned
  Codex runtime only**.
- Open-source/public release remains a separate approval and acceptance event.

### Phase 12 — Preserve future remote work separately

Purpose: retain useful OAuth/MCP/ChatGPT work without mixing it into Local V1
readiness.

Tasks:

- Move remote deployment/OAuth/ChatGPT-host acceptance plans to
  `docs/archive/future-remote/` with an explicit FUTURE/HOLD header.
- Preserve existing production OAuth code and tests; do not delete or weaken
  them.
- Keep live-provider, HTTPS, two-principal, ChatGPT inline/fullscreen,
  screen-reader, and external rollback gates on HOLD.
- Resume this roadmap only after explicit user authorization for deployment,
  provider selection, credentials, and external coordination.

## 6. Test and evidence policy

### 6.1 Evidence levels

- **Unit/component PASS** proves only bounded logic or UI behavior.
- **Integration PASS** proves only the configured local fixture boundary.
- **Build PASS** proves compilability and asset generation.
- **Real runtime PASS** proves the pinned runtime behavior for one exact source.
- **Browser acceptance PASS** proves observed UI behavior for recorded surfaces.
- **Local release-ready** requires all applicable levels for the same exact
  commit and artifact.

### 6.2 Required evidence properties

- exact command and exit status;
- exact commit and source manifest;
- timestamp and environment versions;
- sanitized logs and browser results;
- no tokens, cookies, raw root IDs, prompts, messages, paths, or tool arguments;
- immutable run record plus human-readable interpretation;
- separate PASS/HOLD/FAIL for every gate; and
- critic verdict with all blocking findings resolved.

## 7. Multi-agent execution strategy

Use parallel agents only when the user explicitly authorizes delegated execution
for the implementation turn. File ownership must be explicit and non-overlapping.

Recommended bounded workstreams after Phase 1 establishes a commit:

1. Local session and CSRF service.
2. Opaque task-selection and durable pairing.
3. Public contract/migrations/privacy tests.
4. Code-native visual specification.
5. Living Canopy layout and interactions.
6. Focus Lens/minimap/story strip.
7. Outline/accessibility/responsive behavior.
8. Launcher/doctor/install/uninstall.
9. Security-negative and isolation tests.
10. Scale/performance/browser evidence.
11. Documentation/archive/release packaging.

Model use from the approved task history:

- Sol High workers: architecture, security-sensitive implementation, and complex
  integration tasks.
- Luna Max workers: bounded independent implementation, fixtures, tests, and
  documentation.
- Sol Max critics: major security, UI, acceptance, and release milestones.

Concurrency is a ceiling, not a target. Use fewer agents whenever shared-file
editing, sequential gates, or review dependencies would create conflict.

Every meaningful milestone requires an independent critic package containing:

- objective and acceptance criteria;
- exact files changed;
- test/evidence results;
- unresolved uncertainty;
- privacy/security impact; and
- PASS or REVISE verdict with prioritized findings.

## 8. Decision log

These decisions are locked unless the user explicitly changes scope:

- Local V1 is read-only with respect to Codex.
- Agent names come from trustworthy runtime evidence; examples such as Dirac,
  Ada, and Turing are fixtures, not names Agent Farm invents.
- Local mode does not require external OAuth, but it still requires a secure
  local browser session and CSRF for mutations.
- Raw source-root IDs and paths are server-private.
- Living Canopy is the primary spatial view; Focus Lens is the branch view;
  Outline is an equal accessible view.
- The existing OAuth/MCP implementation is preserved for future remote work.
- Built-in browser acceptance is required; personal Chrome is not the default
  acceptance surface.
- A passing test/build alone is not release authorization.
- No public release or publication occurs without explicit user approval.

## 9. Final definition of done

Agent Farm Local V1 is complete only when a fresh supported user can:

1. Install exact prerequisites from clean documentation.
2. Build/install without stale caches or undocumented shell workarounds.
3. Start Agent Farm with one documented local command.
4. Open one exact loopback URL and receive a secure automatic local session.
5. Select a sanitized Codex task without seeing raw IDs or private paths.
6. Complete trusted read-only pairing.
7. See multiple independent primary agents and recursive descendants.
8. Switch among Living Canopy, Focus Lens, and Outline.
9. Search, filter, expand, focus, inspect, pan, zoom, fit, and cluster safely.
10. Refresh, reconnect, and restart without losing or corrupting hierarchy.
11. See truthful requested-versus-observed identity and unverified states.
12. Use the product with keyboard, VoiceOver, 200% zoom, reduced motion, and a
    narrow viewport.
13. Confirm Agent Farm exposes no Codex control surface.
14. Confirm no private source data appears in browser/API/log/evidence surfaces.
15. Reset or uninstall Agent Farm without changing Codex, ChatGPT, or projects.
16. Reproduce all claims from one exact commit and release archive.

Until every applicable item passes, the correct verdict remains **HOLD — Local
V1 not release-ready**.
