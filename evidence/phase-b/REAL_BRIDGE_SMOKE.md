# Real Codex Bridge Smoke Evidence

Date: 2026-08-09 (Asia/Kolkata)

Command:

```sh
AGENT_FARM_REAL_CODEX_SMOKE=1 node --import tsx --test test/real-app-server.smoke.test.ts
```

Working directory: `packages/codex-bridge`

Result: **PASS** — 1 test, 0 failures, 415.786584 ms test duration.

The test launched `/Users/praveengupta/.local/bin/codex app-server --stdio` and verified:

- the executable SHA-256 exactly matched the retained Phase A fingerprint;
- the real server accepted a versionless newline-delimited `initialize` request;
- its reported user agent matched `Codex Desktop/0.145.0`;
- the adapter gate accepted only the explicitly tested binary/user-agent/schema tuple;
- `initialized` was sent as an ID-less notification;
- real `thread/list` and `model/list` read-only calls returned minimized arrays;
- when a thread existed, real `thread/read` returned the same minimized thread ID;
- the client and child process were closed without sending any mutating method.

This proves read-only wire compatibility for the fingerprinted local binary. It does not by itself prove live event-to-store ingestion, recursive hierarchy capture, ChatGPT hosting, or release readiness.
