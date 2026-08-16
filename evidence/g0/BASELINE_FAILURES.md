# G0 baseline failure ledger

Captured: 2026-08-11 (Asia/Kolkata)
Checkout: `/Users/praveengupta/Desktop/Agent-farm V1/agent-farm`
Branch: `codex/agent-farm` (unborn; no commits)

This record preserves the observed pre-stabilization failures. It is not a
release verdict and does not promote historical Phase-F/Phase-G evidence to
current-source certification.

## Pre-edit command matrix

| Command | Exit | Observed result |
|---|---:|---|
| `pnpm check:privacy` | 0 | Private Codex source identifier scan passed. |
| `pnpm typecheck` | 1 | Web `exactOptionalPropertyTypes` failures in `App.tsx` (`budget`) and `pagination.test.ts` (`edges`). |
| `pnpm build` | 2 | Server build failed because `parseHostPort` was referenced from `main.ts` but undefined there. |
| `pnpm --filter @agent-farm/codex-bridge test` | 0 | 29 passed, 1 skipped. |
| `pnpm --filter @agent-farm/contracts test` | 0 | 10 passed. |
| `pnpm --filter @agent-farm/store test` | 0 | 18 passed. |
| `pnpm --filter @agent-farm/server test` | 1 | 3 socket-backed MCP transport tests hit sandbox `listen EPERM 127.0.0.1`; one `main-config` assertion also surfaced the missing `parseHostPort`. |
| `pnpm --filter @agent-farm/web test` | 1 | Malformed pagination threw instead of returning stale/partial state; local pairing URL assertion omitted the explicit test origin port. |
| `pnpm test:integration` | 1 | `ERR_MODULE_NOT_FOUND` for undeclared root import `@agent-farm/store` in the Local E2E test. Other integration cases passed. |
| `pnpm test:external-acceptance` | 0 | 26 validator tests passed; this is external-host contract evidence only. |
| `pnpm start:local` | 1 | Correctly refused stale web assets before startup. |

The server and MCP socket failures were reproduced as sandbox-only policy
failures. The same tests passed outside the restricted runner after the code
stabilization (see `evidence/g0/G1_GATE.md`).

## Bounded stabilization applied

- Added strict `parseHostPort` validation beside server port parsing.
- Omitted absent optional React props under `exactOptionalPropertyTypes`.
- Returned stale/partial snapshots for malformed standalone pagination pages.
- Made the pairing URL test derive its expected URL from the explicit test
  origin.
- Added a root `tsconfig.json` path map so Local E2E package imports resolve to
  workspace source under `tsx`, without relying on built `dist/` or accidental
  symlinks.
- Made setup/startup accept one optional pnpm `--` separator and aligned local
  documentation with `pnpm run setup --budget=10,10,3` and
  `pnpm start:local --build`.

No G3+ local-session, opaque-handle, or UI feature work was started under this
ledger.
