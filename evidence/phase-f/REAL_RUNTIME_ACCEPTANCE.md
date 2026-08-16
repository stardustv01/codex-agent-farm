# Real Codex Runtime Acceptance

Status: **PASS (local runtime, REST, and MCP)**
Observed: 2026-08-09, Asia/Kolkata

## Runtime anchor

- Codex executable: `/Users/praveengupta/.local/bin/codex`
- Codex version: `0.145.0`
- SHA-256: `1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590`
- Adapter schema: exact retained Phase-A hashes, fail-closed gate
- Runtime transport: one read-only `codex app-server --stdio` client

The paired source-root identifier, rollout paths, prompts, messages, function-call
arguments, credentials, OAuth values, and source-thread identifiers are
intentionally omitted from this artifact.

## Reproduction

The source root is supplied out-of-band as an opaque pairing value:

```sh
AGENT_FARM_SOURCE_ROOT_ID="$PAIRED_ROOT_ID" \
AGENT_FARM_CODEX_SESSIONS_ROOT="$CODEX_SESSIONS_ROOT" \
node --import tsx evidence/phase-f/real-runtime-acceptance.mts
```

The command is read-only. It starts the pinned app-server, verifies its adapter
fingerprint, performs signed source-root pairing, reconciles the selected tree,
then checks durable storage, the authenticated REST hierarchy, and the official
stateful MCP hierarchy tool. `create_agent_session` is exercised as a genuine
successful MCP provisioning call; it does not spawn or control a Codex agent.

The machine-readable run record is
[REAL_RUNTIME_ACCEPTANCE_RUN.json](REAL_RUNTIME_ACCEPTANCE_RUN.json). It
records checkout `revision: null` because this checkout is an unborn branch
with no commit; the source manifest and acceptance-script hashes are retained
there instead.

## Accepted projection

The selected task projection is evolving and currently contains **83 agents and
82 edges**. The required branch is exact within that larger projection:

```text
Main
└── Dirac
    ├── Rhea
    │   └── Noether
    └── Kuhn
```

| Agent | Parent | Requested | Runtime observed | Provider | Verification | Lifecycle |
| --- | --- | --- | --- | --- | --- | --- |
| Main | — | — | Sol XHigh | OpenAI | Unverified (no model requested) | Ongoing task (not lifecycle-gated) |
| Dirac | Main | Sol High | Sol High | OpenAI | Verified | Completed |
| Rhea | Dirac | Luna Max | Luna Max | OpenAI | Verified | Completed |
| Kuhn | Dirac | Sol Medium | Sol Medium | OpenAI | Verified | Completed |
| Noether | Rhea | Sol Low | Sol Low | OpenAI | Verified | Completed |

Aggregate checks:

- Runtime state: `connected`
- Reconciliation state: `reconciled`
- Durable projection: **83 agents, 82 edges**
- Required branch: **4 exact edges** (`Main -> Dirac`, `Dirac -> Rhea`,
  `Dirac -> Kuhn`, `Rhea -> Noether`)
- REST hierarchy: **83 agents, 82 edges**, exact identity fields
- MCP hierarchy: **83 agents, 82 edges**, exact nested identity fields
- MCP `create_agent_session`: genuine success and bound-session continuity
- Private source-identifier scan: `PASS`
- REST private-field scan: `PASS`
- MCP private-field scan: `PASS`
- Source list traversal: **33 bounded pages** in this run
- Identity evidence sources: `codex.rollout.spawn` and
  `codex.rollout.turn-context`

The projection may contain additional selected task descendants beyond the
required branch. Their presence does not weaken the exact required-branch
assertion; all selected-tree relationships still pass the reconciler's
parent/session/cycle checks.

## Evidence boundary

Codex 0.145.0 forked subagent rollouts can contain inherited parent records.
Identity extraction therefore accepts only sanitized turn contexts whose raw
turn IDs belong to the selected thread and whose safe numeric start time is not
earlier than that thread's creation time. This leaves Main's observed Sol XHigh
unverified because no model was requested for Main; it does not transfer an
inherited child identity into Main. Dirac, Rhea, Kuhn, and Noether remain
verified from their requested and observed evidence.

The supplemental rollout reader uses a required absolute configured sessions
root with realpath and no-symlink checks. Its default per-file bound is **64
MiB** and its absolute cap is **128 MiB**. It also enforces bounded lines,
records, observed-history entries, requested spawns, argument bytes, and exact
correlation of the raw `thread.id`, requested rollout ID, and
`session_meta.payload.id`; `payload.session_id` is deliberately not compared.
An allowlist retains only provider, model, effort, and structural spawn task
name. If any evidence is
missing, malformed, ambiguous, inherited, or outside the trusted root, identity
remains `unverified`; topology reconciliation does not guess. No source IDs,
prompts, messages, paths, function-call arguments, credentials, or secrets are
returned or persisted.

## Remaining HOLD gates

This PASS does not prove external ChatGPT developer-mode rendering, deployed
HTTPS/OAuth behavior, or a real ChatGPT fullscreen/browser accessibility run.
Those remain HOLD until exercised in the external host. Browser-session state
is also process-local, so horizontal/multi-process standalone deployment is not
yet claimed.
