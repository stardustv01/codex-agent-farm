# G5 public contract evidence

Status: **G5 independent review PASS; milestone aggregate HOLD/not claimed.**
This record is for the current shared source state and intentionally
does not claim G6 visual approval, G7 feature completeness, external OAuth, or
fresh browser/ChatGPT host acceptance. The user explicitly waived the initial
commit; no commit, push, or release was performed.

## Boundary implemented

- `agent-farm.public.v1` is a distinct strict public schema. The durable
  `SnapshotSchema` remains internal and is never serialized as REST, MCP, or
  web hierarchy data.
- A single server adapter (`projectPublicHierarchy`) derives safe nodes, edges,
  task-state summaries, identity evidence, connection state, bounded story
  milestones, counts, and pagination from the durable projection and sanitized
  event envelopes.
- Public agent, edge, and milestone schemas require fixed opaque digests; the
  server always hashes private IDs even when an internal ID resembles the
  public prefix. Public labels and identity values are bounded and reject
  control/path/credential/any-node raw-ID echoes. Story milestones are an
  allowlisted structural vocabulary; event payload/result/error text is not
  emitted.
- Spawn/edge ordering uses stored ingest ordinals. Legacy rows retain `NULL`
  ordinals and are marked partial; created-at order is never presented as
  authoritative.
- REST hierarchy/details/render and MCP hierarchy/details/render strictly
  consume public-v1. MCP rejects legacy shapes and raw detail/branch selectors
  instead of applying a second mapper. The web strict path preserves IDs,
  edges, ordering, counts, story, and partial state without remapping; its old
  generic/demo adapter remains separate fixture compatibility.
- Duplicate-parent, cyclic, root-child, orphan, and unknown-authority edges are
  classified independently of input order and never become authoritative
  topology. Disjoint requested/observed identity remains unverified, mismatch
  remains explicit, and trust cannot be borrowed from the wrong evidence side.

## Migration/recovery boundary

Schema v3 adds nullable `spawn_ordinal` columns to the v2 projection. Before
mutating a file-backed v2 database, the store creates a SQLite-consistent
same-directory recovery copy, requires an owner-controlled regular source and
directory, never overwrites an existing recovery file, sets mode `0600`, and
opens it read-only to verify integrity and source version. Backup failure
leaves the source at v2. Migration is additive, legacy rows remain null,
reopen is idempotent, and rebuild equivalence is checked. A newer schema is
rejected with explicit recovery guidance. General launcher backup/restore UX
remains **G7 HOLD**.

## Targeted command matrix

All commands below were run from the repository root unless noted.

| Command | Result |
|---|---|
| Five affected-project `tsc --noEmit` chain (contracts, store, MCP, server, web) | PASS |
| Affected emit builds (contracts, store, MCP) | PASS |
| `./node_modules/.bin/vitest run packages/contracts/tests/contracts.test.ts packages/store/tests/store.test.ts packages/mcp/tests/app.test.ts apps/server/tests/public-hierarchy.test.ts apps/server/tests/server.test.ts apps/server/tests/public-v1.integration.test.ts apps/server/tests/composition.test.ts` | PASS — 7 files, 78 tests (contracts 11, store 21, MCP 7, server 39) |
| `cd apps/web && ../../node_modules/.bin/vitest run src/public-v1.test.ts src/reducer.test.ts src/pagination.test.ts src/mcp-host.test.ts` | PASS — 4 files, 43 tests |
| `pnpm check:privacy` | NOT EXECUTED — wrapper aborted before the checker because pnpm requested an interactive `node_modules` purge; dependency mutation was not allowed |
| `node evidence/phase-f/check-private-source-ids.mjs` | PASS — exact underlying private Codex source identifier scan passed |

The Streamable HTTP socket suites were not rerun in the final G5 matrix because
the restricted sandbox rejects loopback `listen` with `EPERM`. Earlier G4
outside-sandbox transport evidence is retained as regression context only; it
is not used as G5 proof.

## Parity/restart/scale evidence

`apps/server/tests/public-v1.integration.test.ts` uses a file-backed durable
fixture with one root, three primary branches, and depth-three descendants. It
compares REST hierarchy/details with MCP hierarchy/details/render, closes and
reopens the same SQLite file, verifies deterministic rebuild equivalence, and
recursively rejects private field names in every public payload. The same file
also exercises 225 agents and 224 edges over two pages with no duplicate IDs,
and verifies a disconnected state remains explicit.

## Privacy scan interpretation

The server-private composition/bridge code necessarily contains source-root,
installation, owner, tenant, and credential identifiers for attestation and
durable authorization. Those values are not part of the public adapter output.
The public adapter may read an internal source-thread ID solely to reject a raw
ID echo in a display label. The web generic/demo compatibility path retains its
historical input vocabulary but is not authoritative for strict public-v1
payloads; the strict path never copies those fields. Recursive integration
assertions cover REST, MCP, details, render, restart, and pagination output.

## Independent review corrections

The independent review corrected raw public-looking private ID passthrough,
sibling-ID label leakage, unsafe/disjoint identity truth, order-dependent
invalid topology, legacy MCP remapping, an undeclared REST render field, and
missing pre-migration recovery backup. No aggregate, commit, push, release,
G6, or G7 work was done.

## Remaining holds

- G6 code-native visual specification approval (Canopy, Focus Lens, Outline,
  responsive/reduced-motion states) is **HOLD** pending user review.
- G7 feature-complete visual interactions and launcher-level reversible backup
  automation are **HOLD**.
- Fresh supported-Mac/browser, external OAuth provider, deployed HTTPS, and
  ChatGPT host/fullscreen acceptance remain **HOLD**.

## Source digest

The following SHA-256 digest covers the G5 source, tests, and contract docs; the
evidence file itself is excluded to avoid a self-referential hash. No secret,
cookie, CSRF value, or generated local-auth state is included.

```text
SOURCE_DIGEST: 69a21f77fd34af707dcf099cde7c16b84dc0dcf0ecc928c2de97552f811830b9
packages/contracts/src/public.ts 5e1ff11dd381f305b9e83806536473584bb90507a9c122d10fcb90007891c888
packages/contracts/src/index.ts 135459545a68de9717fe2dae1c0f25082150965804234729187648c954ff9ee0
packages/contracts/tests/contracts.test.ts d89a7f83b7be6e4d1ef70f964d1ca10da0394fb234448778f32fa99737a8616d
packages/store/src/types.ts 4a5e5c21dc910317275377a6f6eb025238b6f6aa07bb3363aaa88081ba10f2d6
packages/store/src/schema.ts 5bcafbcbf6bc9ebf897b860c1a31f412d2fc4d45bc5174ef2b86b9018f46bfad
packages/store/src/store.ts d99efe9f4aef51938d3c3b7317985c8f90a098e2400217cb9d8934f32779d66b
packages/store/tests/store.test.ts 881598f632d60d9386ad49ed67e825e1be85884184964a85f061f2133a9083f6
apps/server/src/public-hierarchy.ts 23f537e3ee1237ceae2f66662828e3fde3dbbe7e1be98a10787208fa15f39d88
apps/server/src/composition.ts c3e7fa28161829c84348c736f271883fa5c9fa486d62cd4850652d60d178cede
apps/server/src/index.ts cd54333338837c5a13eb10be767b38a35604bc1f63dc87ec2648f39898bea23f
apps/server/tests/public-hierarchy.test.ts f3664bc7b65b961735d4b65ffb7228fe2f7e33b28da544a6568b06776332c3f8
apps/server/tests/public-v1.integration.test.ts 270d7351981008d0b55cbcd41cebf992b251a0ba65835a4d752762eb15a68e12
apps/server/tests/composition.test.ts 6b551aa503077d2e6a800d835fa4a5bb7050ed12b8e99c5506f2207060ec7432
apps/server/tests/mcp-transport.test.ts 6ba23d5d4db67c9a0729aa8c31f400f5c6df4923acf7c7f6440c70ec4fda74f0
packages/mcp/src/types.ts 211e8fc56652d2dead0484fefe3fa47675241d670d2fdb1c95c4c026cbe22ce4
packages/mcp/src/app.ts da4d22b3442bc2dc212191e7a67a496aef10e6db6dca058f82810a72255e3ce6
packages/mcp/tests/app.test.ts ea2da629dbb359f041401f38f527af67f0b431e76c9aa4f23e0eee8592f4bde1
packages/mcp/tests/http.test.ts fc32b192d65007d32596aefcb263c5329a3544051770cd7a56fcb4dfa38d1f12
apps/web/src/types.ts 4e07727d4225192fe19110af58538837eb58aaf1e5e5a9119028af247d0847f8
apps/web/src/normalize.ts bc02002cc44e6ce7dd826613210d37ef7d9308a6187b98bd1c8959bb7202926a
apps/web/src/pagination.ts 5b654509c02d47b349c06e67fe5bf8f85bd1ebe67536f57e583746dca56dfadb
apps/web/src/public-v1.test.ts bfa15888fc812b4bf2c181de7e795e059ffb3a219f33ecedbe4c49c319d5242a
apps/server/package.json 23a58a51a69bbf8cf87a5ae186e2b5e6eca983b4c46b2c3e6832be453ca9ecf5
pnpm-lock.yaml fa97cca96be8e7594a68353fcbf7b1fcecd3507ea89e488dbb9894a151ad4782
docs/EVIDENCE_LEDGER.md 2af8536084ef2ea2beb4fcdda4d5edd8b6c9611695f84cab9375add6b5afea22
```
