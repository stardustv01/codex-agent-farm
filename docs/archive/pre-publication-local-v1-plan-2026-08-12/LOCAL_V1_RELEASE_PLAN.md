# Agent Farm Local V1 release plan (historical)

Status: **historical pre-redesign candidate; superseded by the Live Task Map
implementation on 2026-08-13; not current release evidence**.

This file is retained as historical acceptance evidence. Its source digest,
renderer descriptions, and pair/switch/unpair UI references describe the
pre-redesign candidate and must not be used to authorize or describe the
current build. Current implementation acceptance is recorded in
[`LIVE_TASK_MAP_UI_IMPLEMENTATION_PLAN.md`](../../LIVE_TASK_MAP_UI_IMPLEMENTATION_PLAN.md).
No release has been authorized.

Candidate date: 2026-08-12

Supported boundary: local-only macOS, Node.js 22.17.0, pnpm 11.16.0, pinned
Codex CLI 0.145.0.

The exact-current acceptance record is
[`FINAL_LOCAL_V1_ACCEPTANCE.md`](../../../evidence/phase-h/local-mode/FINAL_LOCAL_V1_ACCEPTANCE.md).
The build-manifest source digest is
`fee341547c7bf9faf0dc7796890ef55bfa44e586625760e134dac3772e644285`;
the self-contained MCP resource SHA-256 is
`53092dc6d872750e7356cd82c47013540f06386f33027ff40fd1486666b841e9`.

## Approved release standard

| Requirement | Current evidence / release treatment | State |
|---|---|---|
| Exact-current runtime identity | Parent exact-built browser acceptance: 7 agents, 6 edges, runtime-observed identity persisted 7/7 | PASS |
| Recursive hierarchy and local detail | Messages, read-only tool activity, changed-file evidence, usage segments, parent/children, and summaries remain bounded and selectable by opaque public ID | PASS |
| Credential boundary | Credential, token, password, cookie, private-key, and authorization values stay excluded from API, DOM, storage, logs, and evidence | PASS |
| Read-only Codex boundary | No Codex mutation, interrupt, steer, or other automatic control route is exposed. Pair/switch/unpair govern Agent Farm's local binding only | PASS |
| Cost accounting | Every displayed value is labelled estimated or partial; recursive self/children/total uses integer USD microdollars; unavailable descendants are never treated as zero | PASS |
| Pricing provenance | Immutable reviewed snapshot `openai-api-2026-08-14-auto-review-luna-v2`, hash `b88e26bda70b8b710814cd48833a086b18163510ceb14916005fe2a30fa04440`, official-source URLs, retrieved/verified timestamp, and exact-model rates are retained | PASS |
| Pricing ambiguity | `codex-auto-review` is canonically attributed to GPT-5.6 Luna using the official Luna rates. Other unknown/rerouted aliases remain unavailable. Incomplete segments may show only a known partial subtotal; completed estimates are pinned and never silently repriced | PASS |
| Browser rendering | Desktop, 360 px, dark mode, and 200% text zoom: zero card overlap and zero document horizontal overflow; usage collapsed by default; messages/tools reachable | PASS |
| Rendered contrast | Exact built Chromium: 351 text elements in light and dark, zero failures, minima 4.59 and 4.82; focus indicator 3.06:1 | PASS |
| Keyboard semantics | Outline has 7 tree items with level/expanded/selected semantics and deterministic Home/End behavior | PASS |
| VoiceOver | Explicitly removed from the Local V1 release requirement by the product owner on 2026-08-12. No transcript or certification PASS is claimed | WAIVED / FUTURE |
| Aggregate quality | Privacy, all workspace typechecks, 376 package tests, 19 integrations, 26 validator cases, exact build, and production preflight passed. Bridge additionally records one deliberately skipped real-runtime package test; runtime acceptance was performed separately | PASS |
| Fresh lifecycle | Frozen install, setup, doctor, first start, same-data restart, key continuity, permissions, and guarded cleanup passed in an isolated checkout | PASS |
| Publication / hosted operation | npm/registry publication, hosted deployment, live OAuth, external ChatGPT host, and public release remain outside Local V1 acceptance | NOT AUTHORIZED |

## Release procedure after explicit authorization

1. Freeze the accepted source. Do not edit files after recording the digest.
2. If the product owner wants a Git release, create the explicitly authorized
   initial commit and record its commit ID. The prior initial-commit gate was
   waived for acceptance; it must not be fabricated retroactively.
3. Produce a source archive from that exact state, excluding `.agent-farm/`,
   `node_modules/`, caches, rejected diagnostics, and all generated secrets.
4. Record the archive file manifest and SHA-256 beside the accepted source and
   MCP hashes.
5. Extract into a new directory and repeat the documented frozen install,
   setup, doctor, start, restart, and guarded cleanup smoke. Rebuild only if the
   distributed form intentionally omits `dist/`.
6. Run the privacy/source-ID scan on the final archive and verify that the
   current evidence links remain valid.
7. Ask the product owner to choose a license before any open-source
   publication. Apache-2.0 remains the recommendation, not an assumed choice.
8. Only after a separate explicit instruction may Codex commit, tag, push,
   publish, upload, or promote a release. Registry metadata—not a local tag—is
   publication evidence.

## Stop conditions

Stop and return to acceptance if the source digest changes, the manifest is
stale, a credential/control surface appears, cost loses its estimated/partial/
unavailable truth, a fresh lifecycle step fails, or the final archive differs
from the accepted source. VoiceOver is not a Local V1 stop condition under the
current waiver, but remains a future accessibility-certification item.
