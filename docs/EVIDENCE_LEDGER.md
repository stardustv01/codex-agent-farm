# Evidence Ledger

This ledger separates evidence that is reproducible in the local checkout from
gates that require a real Codex hierarchy, a live OAuth provider, a deployed
HTTPS origin, or the built-in ChatGPT host. A local PASS is not a release
authorization by itself.

## Current Local V1 stabilization record

The current source has completed the approved Local V1 aggregate, exact-built
browser acceptance, and fresh isolated setup/start/restart/cleanup lifecycle.
The authoritative current record is
[`evidence/phase-h/local-mode/FINAL_LOCAL_V1_ACCEPTANCE.md`](../evidence/phase-h/local-mode/FINAL_LOCAL_V1_ACCEPTANCE.md).
VoiceOver certification is explicitly deferred by the product owner; no hosted,
registry, or publication claim is made. The superseded partial G8 campaign is
retained under `evidence/phase-h/local-mode/archive/`. The G0 inventory and
pre-edit failure record are retained as historical snapshots in
[`evidence/g0/SOURCE_MANIFEST.txt`](../evidence/g0/SOURCE_MANIFEST.txt) and
[`evidence/g0/BASELINE_FAILURES.md`](../evidence/g0/BASELINE_FAILURES.md);
neither is current release evidence.
The one-source-state aggregate G1 run passed outside the restricted sandbox;
its exact command matrix, test counts, MCP resource hash, and bounded source
hashes are in [`evidence/g0/G1_GATE.md`](../evidence/g0/G1_GATE.md). No initial
commit exists yet (the user explicitly waived it), so no commit-based G2 claim
is made. Superseded G3 through G7 milestone records are retained under
[`evidence/phase-h/local-mode/archive/superseded-milestones-2026-08-12/`](../evidence/phase-h/local-mode/archive/superseded-milestones-2026-08-12/).
Their historical HOLD language is not the current verdict. Current public
contract, visual, runtime-identity, browser, security, scale, and lifecycle
coverage is summarized by the final acceptance record and release plan.
These records do not promote historical Phase-F/Phase-G runtime evidence to
current-source release certification.

## Status legend

- **Pass (local)** — implementation and local unit/integration evidence passed;
  the corresponding real-host gate may still be HOLD.
- **Pass (local runtime)** — the pinned local Codex app-server was exercised
  through runtime pairing, reconciliation, authenticated REST, and the
  official stateful MCP protocol; external ChatGPT host acceptance may still
  be HOLD.
- **Pass (preflight)** — an interface, schema, or official-documentation
  contract is retained; it is not runtime acceptance.
- **HOLD** — required evidence is not present in this checkout or needs an
  external provider/host/runtime.
- **Deferred** — intentionally outside the V1 control surface.

| ID | Requirement | Evidence in this checkout | Authority | State |
|---|---|---|---|---|
| A-01 | Supported Codex bridge exists | Local `codex-cli 0.145.0` app-server help and retained binary path | Binary-owned interface | Pass (preflight) |
| A-02 | Current protocol shape | Retained command/schema hashes and adapter fingerprints | Binary-owned contract | Pass (preflight) |
| A-03 | Real protocol connection | Redacted initialize/list/read trace with no transcript content | Fresh local runtime | Pass (local) |
| A-04 | Real response framing bound | `thread/read` is unpaginated; bridge line cap is 8 MiB, production reconciliation uses metadata-only reads, and list pages remain bounded | Runtime/main config tests | Pass (local) |
| A-05 | Recursive lineage fields | `sessionId`, `parentThreadId`, spawn source, and collaboration receiver fields | Generated schema | Pass (preflight) |
| A-06 | Requested identity source | Collaboration spawn model/effort fields | Generated schema | Pass (preflight) |
| A-07 | Observed identity candidates | Thread settings plus model-reroute projection | Generated schema | Pass (preflight) |
| A-08 | Apps UI/resource contract | Official MCP Apps/ChatGPT extension references and generated resource | Official documentation + local loader tests | Pass (local/preflight) |
| A-09 | Server-side state rule | Official widget/cross-session state guidance and server-owned projection | Official documentation + local tests | Pass (local/preflight) |
| A-11 | Bridge mutation boundary | Explicit outbound method allowlist and fail-closed deny tests | Bridge contract/tests | Pass (local) |
| A-12 | Local privacy boundary | Root consent, field allowlist, pre-transfer redaction, retention/deletion tests | Bridge contract/tests | Pass (local) |
| A-13 | Authentication/session boundaries | JWT/resource/scope checks, browser BFF, pairing tests, and non-enumerating failures | Auth/server tests | Pass (local); live provider HOLD |
| A-14 | Cursorless ordering | Connection epochs, ingestion ordinals, snapshot reconciliation, replay/quarantine tests | Store/reconciler tests | Pass (local) |
| B-01 | Event ingestion and deterministic projection | Sanitized notification/event reducer, durable projection, rebuild equivalence, and live selected-tree reconciliation | Bridge/store/reconciler + phase-F runtime | Pass (local runtime) |
| B-02 | Source-root server attestation | Bounded list/read authority, digest/expiry, exact-root/session checks, pairing rejection tests | Source-root/server tests | Pass (local runtime) |
| B-03 | One pre-pair/post-pair runtime client | Live phase-F run used one pinned read-only `app-server --stdio` client from attestation through pairing and reconciliation | Phase-F runtime evidence | Pass (local runtime) |
| B-04 | Selected-root BFS and safe discovery | Root subtree read breadth-first; sanitized `subagentActivity` references may add children; unrelated global debris ignored; selected-tree conflicts fail closed | Reconciler tests + phase-F runtime | Pass (local runtime) |
| C-01 | Authenticated durable backend | SQLite schema v2, owner/tenant/session scoping, idempotency, audit, cross-session negatives | Store/server/integration tests | Pass (local); live OAuth HOLD |
| C-02 | Stable OAuth grant remount | Durable HMAC digest mapping of owner/tenant/subject/resource/`sid`; rotated `jti`, process-restart remount, expiry/revocation, deletion revoke | MCP/store/composition tests | Pass (local) |
| C-03 | Caller cannot select Agent Farm identity | Server-generated ID, reject pre-bound auth claims, bound tool context, argument/session mismatch checks | MCP HTTP/app tests | Pass (local) |
| C-04 | Standalone OAuth BFF | Authorization-code + PKCE, HttpOnly cookie, CSRF, refresh/revocation/logout, browser-session provisioning | Browser BFF/server integration tests with fake provider | Pass (local); live provider/deployment HOLD |
| C-05 | Bounded optional rollout identity | Required absolute `AGENT_FARM_CODEX_SESSIONS_ROOT` trust root; optional per-thread reader uses a 64 MiB default file bound and 128 MiB absolute cap, realpath/no-symlink checks, file/line/record/history/spawn/argument bounds, and exact turn correlation; missing evidence stays unverified | Rollout reader/reconciler tests + phase-F evidence | Pass (local runtime) |
| D-01 | Accessible responsive standalone UI | React tree/details/fullscreen implementation, normalized host adapters, reducer/standalone tests, production build | Web tests/build | Pass (local/preflight); real browser/accessibility HOLD |
| D-02 | Production static/resource boundary | Self-contained MCP resource loader, CSP/host/origin checks, token-bearing URL rejection | Server/MCP resource tests | Pass (local); deployed HTTPS HOLD |
| E-01 | MCP protocol/resource/fullscreen contract | Official SDK transport/resource descriptors and local HTTP/MCP hierarchy tests | MCP/server + phase-F tests | Pass (local); external ChatGPT host/fullscreen/browser HOLD |
| F-01 | Canonical recursive hierarchy from real runtime | Evolving Phase-F selected projection contains 83 agents and 82 edges; the required branch has exact edges Main→Dirac, Dirac→Rhea/Kuhn, and Rhea→Noether; REST and MCP each reconcile 83 agents/82 edges | [REAL_RUNTIME_ACCEPTANCE.md](../evidence/phase-f/REAL_RUNTIME_ACCEPTANCE.md) and [REAL_RUNTIME_ACCEPTANCE_RUN.json](../evidence/phase-f/REAL_RUNTIME_ACCEPTANCE_RUN.json) | Pass (local runtime) |
| F-02 | Actual-vs-requested model/effort proof | Required branch identity table; Main observed Sol XHigh/OpenAI and remains unverified because no model was requested; Dirac, Rhea, Kuhn, and Noether have verified requested/observed identities | Phase-F runtime + REST/MCP assertions | Pass (local runtime) |
| G-01 | Two simultaneous isolated sessions | Local concurrent same-owner distinct-grant isolation and concurrent independent-principal isolation, each with non-enumerating cross-session 404s | MCP/server tests | Pass (local); live OAuth principals and host remain HOLD |
| G-02 | Reconnect/remount/failure recovery | Real pinned app-server child drop, truthful disconnect, fresh child/epoch, exact semantic projection continuity, deterministic rebuild, and SQLite remount | [REAL_RUNTIME_RECOVERY.md](../evidence/phase-g/REAL_RUNTIME_RECOVERY.md) and [REAL_RUNTIME_RECOVERY_RUN.json](../evidence/phase-g/REAL_RUNTIME_RECOVERY_RUN.json) | Pass (local real runtime) |
| G-03 | 25 active plus 200 completed scale | Exact 225-node fixture, 224 edges, pagination and deterministic rebuild | Integration/composition tests | Pass (local); host accessibility/latency HOLD |
| G-04 | Keyboard, accessibility, responsive acceptance | UI behavior tests and responsive implementation only | Web test/build | HOLD: built-in browser + screen reader/keyboard audit |
| G-05 | Security and cross-session negative tests | Forged claims, wrong resource/scope, source-root substitution, replay, token/session confusion, control-tool discovery | Auth/bridge/MCP/server tests | Pass (local); live OAuth/host penetration HOLD |
| H-01 | Permission-aware agent controls | Explicitly absent from V1 descriptors/routes | Deferred gate | Deferred |

## Live local milestone

[REAL_RUNTIME_ACCEPTANCE.md](../evidence/phase-f/REAL_RUNTIME_ACCEPTANCE.md) and
[REAL_RUNTIME_ACCEPTANCE_RUN.json](../evidence/phase-f/REAL_RUNTIME_ACCEPTANCE_RUN.json)
record the pinned local app-server run, signed pairing, selected-tree
reconciliation, authenticated REST hierarchy, and official stateful MCP
hierarchy call. That immutable Phase-F snapshot contains 83 agents and 82
edges; the later Phase-G recovery snapshot contains 89 agents and 88 edges.
The required branch and public identity table are:

```text
Main
└── Dirac
    ├── Rhea
    │   └── Noether
    └── Kuhn
```

| Agent | Parent | Requested | Runtime observed | Provider | Verification | Lifecycle |
|---|---|---|---|---|---|---|
| Main | — | — | Sol XHigh | OpenAI | Unverified (no model requested) | Ongoing task (not lifecycle-gated) |
| Dirac | Main | Sol High | Sol High | OpenAI | Verified | Completed |
| Rhea | Dirac | Luna Max | Luna Max | OpenAI | Verified | Completed |
| Kuhn | Dirac | Sol Medium | Sol Medium | OpenAI | Verified | Completed |
| Noether | Rhea | Sol Low | Sol Low | OpenAI | Verified | Completed |

The required branch has four exact edges inside the larger projection. Both
REST and MCP reconcile 83 agents and 82 edges, and the MCP run includes a
genuine successful `create_agent_session` provisioning call. The artifact
does not expose source IDs, prompts, messages, function-call arguments,
rollout paths, credentials, or OAuth values.

## Acceptance evidence rules

- Unit, typecheck, build, mock-provider, HTTP-200, and local screenshot results
  are preflight/component evidence, not final host or security acceptance.
- Standalone and real ChatGPT surfaces require separate fresh-runtime traces.
  The local MCP protocol/resource/fullscreen path is PASS; external ChatGPT
  host/fullscreen and built-in-browser rendering remain HOLD.
- Identity acceptance requires app-server runtime/thread settings/reroute or
  bounded, exact-thread rollout evidence; labels, configuration defaults,
  fixtures, and agent self-report do not count. The phase-F run proves the
  required-branch table above within the evolving 83-agent/82-edge local
  REST/MCP projection.
- The OAuth `sid` is a refresh-stable grant key; `jti` is required for current
  token verification but is not persisted or used as the remount identity.
- The server generates the Agent Farm session ID. Caller-supplied owner,
  tenant, source-root, or Agent Farm session values never establish authority.
- Source-root pairing is accepted only when the server's short-lived
  app-server attestation digest/session/expiry matches the signed challenge.
- `thread/read` is one-shot and unpaginated. The bridge line cap is 8 MiB;
  production restart reconciliation requests `includeTurns:false`, while
  bounded list pages provide topology. The optional rollout reader uses a
  64 MiB default per-file bound and 128 MiB absolute cap, plus bounded lines,
  records, history, spawns, arguments, paths, and symlink components; it is not
  exposed by the metadata-only runtime facade.
- Reconciliation selects one configured root from authoritative `thread/list`
  parentage and validates each selected node with a metadata-only read.
  Unrelated global graph debris is ignored; malformed/cyclic/orphaned/conflicting
  references inside the selected tree fail closed. Identity without bounded
  evidence remains explicitly unverified.
- Rollout identity is optional evidence, not topology authority. The required
  absolute sessions root is trusted by realpath/no-symlink checks; missing,
  inherited, malformed, or ambiguous records leave identity unverified and
  expose no raw IDs, prompts, paths, arguments, or secrets.
- Recovery requires before/outage/after watermarks with no duplicate events or
  phantom active agents. A transport `DELETE` or MCP remount must not silently
  create a different Agent Farm session for the same grant.
- Scale requires a fixed manifest of 25 active and 200 completed unique agents,
  pagination, stable ordering, no missing/duplicate IDs, measured latency, and
  browser-console evidence.
- Accessibility combines automated checks with keyboard and screen-reader
  verification on standalone and MCP fullscreen surfaces.
- Any cross-session leak, forged identity acceptance, V1 Codex mutation,
  exposed control tool, raw token persistence, or source-root substitution is a
  release-blocking failure.
- External execution uses
  [the ChatGPT acceptance runbook](archive/future-remote/EXTERNAL_CHATGPT_ACCEPTANCE.md) and a fresh
  copy of its HOLD-by-default JSON template. Missing or `null` evidence cannot
  be promoted to PASS.

## Retained evidence

- [Phase A runtime probe](../evidence/phase-a/RUNTIME_PROBE.md)
- [Schema and binary hashes](../evidence/phase-a/SCHEMA_HASHES.txt)
- [Real bridge smoke](../evidence/phase-b/REAL_BRIDGE_SMOKE.md)
- [Phase B-C integration acceptance](../evidence/phase-b-c/INTEGRATION_ACCEPTANCE.md)
- [Real runtime/REST/MCP acceptance](../evidence/phase-f/REAL_RUNTIME_ACCEPTANCE.md)

The Phase B-C note is historical fixture/integration evidence; the phase-F
artifact supersedes its earlier pre-phase-F recursive-hierarchy boundary for
the local runtime/REST/MCP gate while leaving external host gates open.

## Phase H: local-only install and run (approved Local V1 PASS)

Phase H introduces an explicit repository-local mode for a clean install and
loopback-only run. Exact-current runtime/browser and fresh isolated lifecycle
acceptance are recorded in the final evidence. Historical bounded milestone
notes remain archived separately.

| ID | Requirement | Evidence in this checkout | State |
|---|---|---|---|
| H-02 | Local session, key, cookie, CSRF, Host/Origin, and replay boundary | [Final Local V1 acceptance](../evidence/phase-h/local-mode/FINAL_LOCAL_V1_ACCEPTANCE.md) plus archived milestone detail | PASS for local-only V1 |
| H-03 | Manual install, build, setup, browser, security, persistence, and cleanup acceptance | [Final Local V1 acceptance](../evidence/phase-h/local-mode/FINAL_LOCAL_V1_ACCEPTANCE.md) records the exact aggregate, parent exact-built browser acceptance, and fresh isolated lifecycle | PASS for approved local-only V1; VoiceOver deferred; no hosted/publication claim |
| H-04 | Opaque local selection, durable pairing, restart claim, switch/unpair, and browser privacy boundary | Final acceptance plus archived milestone detail | PASS for local-only V1 |
| H-05 | Versioned public hierarchy/story contract, deterministic projection, migration compatibility, parity, pagination, and privacy | Final aggregate and acceptance | PASS for local-only V1 |
| H-06 | Living Canopy / Focus Lens visual specification, density, responsive, zoom, theme, and motion evidence | Final acceptance and retained rendered artifact | PASS for approved Local V1 surfaces |
| H-07 | Production Canopy, Focus Lens, Outline, rich read-only details, identity, cost, and shared public-v1 projection | [Final acceptance](../evidence/phase-h/local-mode/FINAL_LOCAL_V1_ACCEPTANCE.md) and [release plan](LOCAL_V1_RELEASE_PLAN.md) | PASS; VoiceOver explicitly waived for Local V1 |
| H-08 | Launcher/doctor/build freshness, safe setup, guarded cleanup, and real local acceptance | [Final Local V1 acceptance](../evidence/phase-h/local-mode/FINAL_LOCAL_V1_ACCEPTANCE.md); superseded G8 material is archived separately | PASS for approved local-only V1 |

There is no remaining blocker under the approved Local V1 standard. VoiceOver
certification is deferred by explicit product-owner decision and is not
represented as a PASS. Hosted/public release, live OAuth, external ChatGPT host
acceptance, commit/tag/push, and publication remain separate authorization
boundaries.
