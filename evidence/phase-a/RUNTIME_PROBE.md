# Phase A Runtime Probe

Captured: 2026-08-09 IST.

The probe was read-only with respect to Codex. Transcript content, thread IDs,
previews, paths, prompts, messages, tool arguments, and results were not printed
or retained.

## Binary

```text
path: /Users/praveengupta/.local/bin/codex
symlink target: /Users/praveengupta/.codex/packages/standalone/current/bin/codex
version: codex-cli 0.145.0
sha256: 1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590
architecture: Mach-O arm64
```

## Reproducible schema commands

```sh
codex app-server generate-json-schema --out <temporary-directory>
shasum -a 256 \
  <temporary-directory>/codex_app_server_protocol.schemas.json \
  <temporary-directory>/codex_app_server_protocol.v2.schemas.json \
  <temporary-directory>/ClientRequest.json \
  <temporary-directory>/ServerNotification.json
```

## Redacted runtime exchange

Run from the Agent Farm project:

```sh
node evidence/phase-a/app-server-probe.cjs
```

```json
{"probe":"initialize","userAgent":"Codex Desktop/0.145.0 (Mac OS 26.5.2; arm64) dumb (agent-farm-contract-probe; 0.0.0)","platformFamily":"unix","platformOs":"macos"}
{"probe":"thread/list-page-1","count":1,"hasNext":true,"threadFields":["agentNickname","agentRole","canAcceptDirectInput","cliVersion","createdAt","cwd","ephemeral","extra","forkedFromId","gitInfo","historyMode","id","modelProvider","name","parentThreadId","path","preview","recencyAt","sessionId","source","status","threadSource","turns","updatedAt"]}
{"probe":"thread/read","sameThread":true,"turnCount":13,"turns":[{"status":"completed","itemCount":15,"itemTypes":["agentMessage","fileChange","mcpToolCall","reasoning","userMessage"],"hasDuration":true,"hasError":false},{"status":"completed","itemCount":3,"itemTypes":["agentMessage","reasoning","userMessage"],"hasDuration":true,"hasError":false},{"status":"completed","itemCount":6,"itemTypes":["agentMessage","reasoning","subAgentActivity","userMessage"],"hasDuration":true,"hasError":false},{"status":"completed","itemCount":27,"itemTypes":["agentMessage","fileChange","reasoning","userMessage"],"hasDuration":true,"hasError":false},{"status":"completed","itemCount":16,"itemTypes":["agentMessage","fileChange","reasoning","userMessage"],"hasDuration":true,"hasError":false}]}
{"probe":"thread/list-repeat","count":1,"sameFirst":true}
```

The presence of sensitive item types is evidence for the pre-transfer field
allowlist. The probe intentionally retained only their type names.

## Limits

- Thread lifecycle notification delivery was not exercised.
- The first page advertised another page, but cursor traversal remains a Phase
  B adapter test.
- Real recursive root/child/grandchild and reroute correlation remain pending.
- This probe does not prove ChatGPT MCP rendering, production security,
  isolation, recovery, scale, or accessibility.
