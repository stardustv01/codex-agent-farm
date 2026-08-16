# G1 green-baseline evidence

Captured: 2026-08-11 (Asia/Kolkata)
Checkout: `/Users/praveengupta/Desktop/Agent-farm V1/agent-farm`
Branch: `codex/agent-farm` (unborn; no commits)

The full G1 command was run once after the bounded stabilization, from the same
source state, with the required elevated permission because the restricted
sandbox denies loopback socket binds.

## Aggregate gate

| Command | Exit | Result |
|---|---:|---|
| `pnpm check` (elevated; includes privacy, typecheck, recursive tests, integration, external validator, build, and production preflight) | 0 | PASS. All package tests passed; server 15 files/129 tests; MCP 2 files/19 tests; web 5 files/66 tests; Local/integration 14 tests; external validator 26 tests; build and offline production preflight passed. |

The build emitted the self-contained MCP resource hash:

```text
sha256:0c33b73686d19c3a99659c2d9be95f9fbf59ea0f6285ad6240211f3faa9232ac
```

The aggregate gate is G1 evidence only. It does not establish browser,
restart/persistence, accessibility, local session/CSRF, opaque selection,
durable pairing, or release readiness.

The CLI grammar was also exercised after the gate: both
`pnpm run setup --budget=10,10,3` and the compatibility form
`pnpm run setup -- --budget=10,10,3` exited 0 and generated the expected
repository-local budget files. The launcher accepts the analogous optional
separator for `pnpm start:local --build`.

## Independent package checks

Before the aggregate run, each workspace typecheck passed independently:

- `pnpm --filter @agent-farm/codex-bridge typecheck`
- `pnpm --filter @agent-farm/contracts typecheck`
- `pnpm --filter @agent-farm/mcp typecheck`
- `pnpm --filter @agent-farm/store typecheck`
- `pnpm --filter @agent-farm/server typecheck`
- `pnpm --filter @agent-farm/web typecheck`

Each exited 0. Socket-backed package/server tests also passed outside the
sandbox: `pnpm --filter @agent-farm/mcp test` (2 files/19 tests) and
`pnpm --filter @agent-farm/server test` (15 files/129 tests), both exit 0.

## Current source hashes

These hashes cover the bounded implementation and hygiene files changed in
this G0/G1 pass. Re-run before any G2 commit or archive claim.

```text
19b71929270049fd68e26fb50d82173db9a8ccc10bb1ccfc5314e1cd9e83e332  apps/server/src/main.ts
387aa6f1b95639c1668ee1cc5e479b38f41e9cfbf41f15622a184e198f55d710  apps/web/src/App.tsx
fde396cbb16c03e03fa5e2eff07a7e75df79a0d83e393e89080b9d2ef5e7c937  apps/web/src/adapters.ts
048af4e3f60531e28eff590e7cf04abe4191b363b2f5f7c0441e1f904a910ae6  apps/web/src/pagination.test.ts
a92181f5f732a0e8125341fee5401769482035ce0c9ff71d4de87e6a474a6845  apps/web/src/App.test.tsx
3dcc7c6efc911350f0fb27361163f15845877ad366f2f578bfba2798883ecc93  tests/integration/agent-farm-local.e2e.test.ts
eb96d0f724f501ed530d079a079ba0caa58d73b27d8cf4bb741e27086a9f3d57  scripts/configure-local.mjs
df312a7766717f16c58007377fe972a770e7994703f1b679a4c82af0e605f226  scripts/start-local.mjs
8b4b1eb187df1666e94da1fdf22ef4ae747819bf484f1007122494cdbf279380  package.json
c78391f1a9d43f48ee152a1d30531845851904bb498386d5af12d10e99aa2141  .gitignore
a9437331674e4952463d6f19b071309de18c4f7093342de72ee2b923b8157777  tsconfig.json
```
