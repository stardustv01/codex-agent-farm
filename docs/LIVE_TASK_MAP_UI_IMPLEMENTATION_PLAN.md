# Agent Farm local implementation (single active chat)

Status: **IMPLEMENTED, LOCALLY ACCEPTED, AND INCLUDED IN NPM 0.1.0**

The earlier single-task Live Task Map plan is preserved at
[`archive/superseded-live-task-map-ui-plan-2026-08-13/LIVE_TASK_MAP_UI_IMPLEMENTATION_PLAN.md`](archive/superseded-live-task-map-ui-plan-2026-08-13/LIVE_TASK_MAP_UI_IMPLEMENTATION_PLAN.md).
It is design history, not current product authority.

## Current product behavior

- One loopback Agent Farm server keeps exactly one Codex chat actively bound
  and monitored under one installation at a time.
- Each chat has a distinct durable Agent Farm scope; switching to another chat
  deactivates the previous live worker and revokes its active binding, while
  its confirmed snapshot is retained for re-open on demand.
- A second trusted launcher invocation focuses the existing localhost through a
  signed, short-lived, replay-protected handoff. Missing or ambiguous evidence
  fails closed and leaves the manual switcher available.
- The browser displays a safe chat title and workspace basename only. Private
  Codex source IDs, filesystem paths, credentials, and control capabilities are
  excluded.
- The current hierarchy root is labeled **Root Chat**. Project/workspace groups,
  Quick Chats, search, current state, and background-monitored state are shown
  in the chat switcher.
- Agent Farm remains read-only. No steer, interrupt, spawn, undo, or mutation
  surface was added.

## Current acceptance boundary

The exact production build passed package typechecks, focused single-active
switch and focus-proof tests, the complete web suite, privacy scanning, real loopback MCP
transport tests, and built-browser acceptance at desktop and 360 px mobile.
Dark mode and true 200% text had no document-level horizontal overflow, the
mobile inspector remained reachable, and the browser console had no warnings
or errors.

The earlier runtime isolation fixture retained two simultaneously active chat
bindings; that multi-chat behavior was superseded by the single-active-chat
model, which deactivates the previous binding on switch.

This implementation was included in the npm 0.1.0 publication. That registry
publication does not retroactively establish a Git commit or tag, and hosted
deployment remains outside the product boundary.
