# G0 scan classification

Captured: 2026-08-11 (Asia/Kolkata)

The broad review intentionally records hits rather than deleting historical
fixtures or weakening safety tests.

## Reconciled candidate inventory

The post-stabilization checkout contains 142 non-ignored Git candidates:

- 57 application files under `apps/` (30 source, 20 tests, and 7 package/build
  configuration files);
- 42 package files under `packages/` (26 source, 7 tests, and 9 package/build
  configuration files);
- 23 evidence files, including historical Phase A-H material and the four G0/G1
  stabilization records;
- 9 documentation files, of which 6 are active and 3 are explicitly archived;
- 2 root integration tests and 2 local setup/launcher scripts; and
- 7 root control/configuration files: `.gitignore`, `README.md`, `package.json`,
  the pnpm lock/workspace files, and the two TypeScript configs.

Generated `dist/`, dependency trees, `*.tsbuildinfo`, `.agent-farm/` local
state, and `.agent-farm-backups/` recovery material are ignored and are not
source candidates. The relevant outer Agent Farm HTML remains a design
reference; the two unrelated EOC HTML files and their archive README remain
outside this Git checkout.

## Absolute paths

- `/Applications/ChatGPT.app` appears in active boundary documentation as an
  explicit **do-not-modify** rule.
- `/Users/praveengupta/.local/bin/codex` and
  `/Users/praveengupta/.codex/sessions` appear in retained Phase-A/Phase-F/G
  runtime evidence and opt-in smoke defaults. They are historical, machine-
  specific evidence or environment defaults, not browser/API projection data.
- `/Users/praveengupta/Desktop/Agent-farm V1/agent-farm` appears in the
  authoritative Local V1 plan and G0 evidence as the checkout under review.
- `/var/lib/agent-farm/*` and `/tmp/*` appear only in synthetic production
  preflight values or isolated test fixtures. They are not runtime secrets.
- `/Users/navin/*`, `/private/tmp/*`, and similar values occur only in
  redaction/security fixtures that prove private paths are removed.

No absolute path was found in the public browser payload contract as a result
of the G0 implementation changes. The existing Phase-F private-source scan
passed after the changes.

## Secrets, tokens, and credentials

The search results contain names of secret-bearing fields, fake test tokens,
and placeholder values used to exercise rejection paths. No live credential,
cookie, bearer token, OAuth code, or private source identifier was added to
the G0/G1 evidence. Generated `.agent-farm/`, `.agent-farm-backups/`, build
outputs, and `node_modules/` remain ignored.

## Documentation authority

- This file is a historical G0 classification captured on 2026-08-11. Its
  inventory counts and path list are not current release evidence.
- The former `docs/LOCAL_V1_COMPLETION_PLAN.md` is archived at
  `docs/archive/superseded-local-v1-plan-2026-08-12/LOCAL_V1_COMPLETION_PLAN.md`.
  The active authority is `docs/LOCAL_V1_RELEASE_PLAN.md`.
- `docs/EVIDENCE_LEDGER.md` reports current-vs-historical boundaries and links
  the G0/G1 records.
- `docs/archive/future-remote/` contains the external ChatGPT/OAuth runbook
  and an explicit HOLD header.
- `../archive/legacy-eoc-prototypes/` contains the two unrelated outer EOC
  mockups; the relevant `../agent-farm-hierarchy-review.html` remains outside
  the active checkout as a design reference.
- At G0, active documents labelled the fixed-principal/no-CSRF implementation
  as a pre-G3 shortcut. The accepted Local V1 now includes the HttpOnly local
  browser-session and CSRF boundary; see the current release plan and final
  acceptance record.
