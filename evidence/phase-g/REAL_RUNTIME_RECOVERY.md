# Real Codex Runtime Recovery Acceptance

This gate exercises the same read-only `CodexRuntimeService` and
`spawnStdioAppServer` path used by the production composition. It is opt-in
because it starts a local Codex app-server and reads the configured sessions
store.

```sh
AGENT_FARM_REAL_CODEX_RECOVERY=1 \
AGENT_FARM_SOURCE_ROOT_ID="<top-level Codex source root supplied out-of-band>" \
node --import tsx evidence/phase-g/real-runtime-recovery.mts
```

The script creates a temporary SQLite store, establishes the normal
source-root attestation and durable pairing boundary, then verifies:

- one accepted, paired connection and a non-empty recursive projection;
- termination of only the child returned by `spawnStdioAppServer`;
- truthful `disconnected` state while the child transport is down;
- retry through the production controller with one replacement child and a
  new connection epoch;
- unchanged agent/edge cardinality, unique durable event keys, and deterministic
  projection rebuild after recovery;
- SQLite close/remount with the same hierarchy, event identity, and required
  recursive branch.

## Recorded result

The final timestamped out-of-band run passed all gates:

- state transitions: `unpaired → connected → disconnected → connected`;
- 89 agents and 88 edges before and after recovery;
- the replacement child received a new connection epoch;
- duplicate event-key delta and duplicate-source delta were both zero;
- the required recursive branch was present after recovery and remount;
- the remounted SQLite projection rebuilt deterministically.

The recovered event count was 318 before the drop and 636 afterward. This is
intentional full-snapshot journaling: each connection epoch has its own unique
reconciliation event set. It is not evidence of duplicate event keys, and the
remounted event identity remained stable.

The machine-readable redacted run record is
`evidence/phase-g/REAL_RUNTIME_RECOVERY_RUN.json`. The final record retains the
script-captured timestamps, acceptance-script hash, source-tree manifest, and
matching semantic projection fingerprints across initial, recovered, and
remounted states. The JSON output is redacted: it
contains states, SHA-256 digests, booleans, and aggregate counts only. It never
prints the supplied source-root ID, private prompts, rollout paths, session
IDs, child PIDs, or raw Codex diagnostics. Without
`AGENT_FARM_REAL_CODEX_RECOVERY=1`, the command exits with a deliberate `SKIP`.
