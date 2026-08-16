# External ChatGPT acceptance

This runbook is the release gate for Agent Farm outside the local checkout. It
starts at **HOLD**. Local tests, a successful build, a reachable URL, an inline
widget screenshot, or a single authenticated user cannot change that status by
themselves.

Record the run in a copy of
[`EXTERNAL_CHATGPT_ACCEPTANCE_RUN_TEMPLATE.json`](../../../evidence/phase-e/EXTERNAL_CHATGPT_ACCEPTANCE_RUN_TEMPLATE.json).
Keep tokens, cookies, authorization codes, OAuth `sid`/`jti` values, Codex
source IDs, prompts, messages, paths, and tool arguments out of the record.
The JSON label is not authoritative by itself. A final PASS must also satisfy
the fail-closed validator:

```sh
node --import tsx evidence/phase-e/validate-external-acceptance.mts \
  evidence/phase-e/EXTERNAL_CHATGPT_ACCEPTANCE_RUN.json
```

The untouched template can be structure-checked without promoting it:

```sh
node --import tsx evidence/phase-e/validate-external-acceptance.mts \
  --template evidence/phase-e/EXTERNAL_CHATGPT_ACCEPTANCE_RUN_TEMPLATE.json
```

## Official host expectations

ChatGPT developer mode is enabled under **Settings -> Security and login**. The
MCP server is then registered from the ChatGPT Plugins page with its public
HTTPS URL and connection details. Test the resulting connection in a new chat.

Agent Farm should first render inline. Its hierarchy is a rich interactive
diagram, so fullscreen is the correct deeper-exploration surface. The
fullscreen view must coexist with ChatGPT's system composer. Both surfaces
must maintain WCAG AA contrast, support text resizing, use alt text where
images convey information, and remain usable with the keyboard.

Official references:

- [Create and test a plugin locally with an MCP server](https://developers.openai.com/plugins/build/plugins#create-and-test-a-plugin-locally-with-an-mcp-server)
- [ChatGPT plugin UI guidelines and display modes](https://developers.openai.com/plugins/concepts/ui-guidelines)
- [Apps SDK runtime capabilities](https://developers.openai.com/plugins/reference#capabilities)

## Local-only standalone acceptance

Local-only mode (`AGENT_FARM_LOCAL_MODE=1`) is a standalone, browser-only path
served on loopback. It does not require ChatGPT hosting, MCP registration, or
OAuth. The local principal is used for this path.

For a clean install, use a clean checkout with Node >=22.17, pnpm 11.16, and
the Codex CLI available:

1. Run `pnpm install --frozen-lockfile && pnpm build`.
2. Run `pnpm run setup` and complete the budget prompt. The local budget defaults
   are 10 Sol High, 10 Luna Max, and 3 Sol Max.
3. Run `pnpm start:local`.
4. Open `http://127.0.0.1:8787` in a browser.
5. Verify the hierarchy, search, expand/collapse, branch focus, details,
   identity evidence, and budget display.
6. Verify loopback-only enforcement denies non-loopback hosts.

These steps are separate from the ChatGPT/MCP external acceptance gates below.
Those external gates remain pending; a passing local checklist does not claim
ChatGPT hosting, OAuth, MCP registration, or external acceptance.

## 1. Preconditions

Do not begin the host run until every item below is available:

- A public HTTPS origin with a valid certificate and no browser warning.
- The exact deployed revision and executable-source manifest digest.
- A production database backup and a tested rollback target.
- A live OAuth provider with authorization-code + PKCE, refresh, and
  revocation support.
- Two independent test principals, A and B. Do not share browser sessions,
  cookies, grants, or accounts between them.
- Exact production `Host`, `Origin`, issuer, audience, resource, redirect URI,
  JWKS, token-status, and Codex binary allowlists.
- ChatGPT developer mode and permission to register the MCP server.
- A built-in ChatGPT/Codex browser surface. Do not use personal Chrome as
  acceptance evidence.
- A keyboard-only pass and a macOS VoiceOver pass scheduled for both the
  standalone page and ChatGPT fullscreen.

Run `pnpm check` and the offline production preflight against the exact source
revision before deployment. If the deployment changes executable source,
re-run the real transport-recovery evidence before host acceptance.

## 2. Deployment identity and reachability

1. Record the release revision, source-manifest digest, MCP resource SHA-256,
   database schema version, pinned Codex path/version/SHA-256, and deployment
   timestamp.
2. Verify `/healthz` and `/ready` over the public HTTPS origin.
3. Verify the certificate hostname and expiry. Confirm an HTTP request cannot
   downgrade or bypass the configured HTTPS origin policy.
4. Verify CSP, allowed host, and allowed origin behavior with the public
   hostname. Forwarded headers must not widen an allowlist.
5. Capture sanitized status codes, header names, timestamps, and digests only.
   Never retain bearer values, cookies, redirect authorization codes, or
   private response bodies.

Any certificate warning, unexpected host/origin acceptance, or production HTTP
origin is an immediate **FAIL**.

## 3. Live OAuth and standalone application

Run the following independently for principals A and B:

1. Start from a fresh signed-out browser state.
2. Open `/auth/login`, complete provider authorization, and return to the exact
   registered `/auth/callback` URI.
3. Confirm the browser receives only the secure HttpOnly session cookie and
   the expected CSRF mechanism; no access or refresh token may appear in URL,
   DOM, storage, console, or network logs retained as evidence.
4. Create the visualization session through
   `POST /api/v1/browser/session`. Record only a one-way digest of the public
   `agentSessionId`.
5. Load the hierarchy and one details panel. Refresh the page and confirm the
   same principal sees the same projection.
6. Exercise a real token refresh. Confirm the Agent Farm session remains
   stable across rotated token identity.
7. Log out and revoke the grant. Confirm the old browser session and protected
   data no longer work.

Then run A and B concurrently. Their public session digests must differ. A
cross-principal or unknown-session request must return the same
non-enumerating failure shape, and neither principal may observe the other's
agents, counts, status, timing, or existence.

## 4. Register and verify the ChatGPT MCP connection

1. Enable ChatGPT developer mode under **Settings -> Security and login**.
2. In ChatGPT Plugins, add the public Agent Farm MCP server URL and its live
   OAuth connection details.
3. Start a new chat with the connection enabled.
4. Confirm MCP discovery exposes exactly these four tools:

   - `create_agent_session`
   - `get_agent_hierarchy`
   - `get_agent_details`
   - `render_agent_hierarchy`

5. Confirm all four tools are read-only with respect to Codex. Discovery and
   routing must not contain `control_agent`, create/spawn, steer, interrupt,
   retry, message, archive, delete, or another mutation surface.
6. Call `create_agent_session` without a caller-selected Agent Farm session.
   Record only the one-way digest of the returned public session ID and the MCP
   protocol session digest.
7. Read the hierarchy, read one agent's details, and render the UI resource.
   Confirm no source IDs, prompts, messages, paths, function arguments,
   credentials, or OAuth values are returned to the model or widget.

Repeat the MCP sequence with principal B while principal A remains connected.
Verify session and data isolation exactly as in the standalone test.

## 5. Recursive hierarchy and runtime identity

In both standalone and ChatGPT surfaces, verify the real branch:

```text
Main
+-- Dirac (Sol High)
    +-- Rhea (Luna Max)
    |   +-- Noether (Sol Low)
    +-- Kuhn (Sol Medium)
```

For Dirac, Rhea, Kuhn, and Noether, the requested and runtime-observed model,
effort, and provider must agree and be marked **Verified**. Main remains
**Unverified (no model requested)** unless trustworthy runtime evidence proves
an explicit request. Labels, configuration defaults, fixture data, and an
agent's own text never count as identity evidence.

Expand/collapse nodes, focus one branch, search, filter by model/status, open
details, and return to the full tree. Confirm the parent/child edges do not
change across inline, fullscreen, refresh, or MCP remount.

## 6. ChatGPT inline and fullscreen UI

Verify in the real ChatGPT host, not a standalone imitation:

1. The first render appears inline without clipping or nested scrolling.
2. Expanding requests ChatGPT fullscreen and displays the same server-owned
   session and hierarchy.
3. ChatGPT's composer remains usable in fullscreen and does not cover critical
   controls or information.
4. Closing fullscreen returns safely to the inline surface with meaningful UI
   state preserved.
5. Reopening fullscreen, remounting the widget, refreshing the chat, and
   reconnecting the MCP transport do not create a different Agent Farm session
   for the same live grant.
6. Disconnected, waiting, failed, cancelled, incomplete, and unverified states
   are visually and programmatically distinguishable without relying on color
   alone.
7. No widget console error, CSP violation, uncaught exception, layout overflow,
   or repeated network loop occurs.

Test at narrow mobile width, tablet width, common desktop width, 200% text
zoom, light theme, and dark theme. Record viewport and host version rather than
screenshots containing private conversation text.

## 7. Keyboard, VoiceOver, and responsive acceptance

Perform this matrix separately on the standalone app and ChatGPT fullscreen:

- Navigate every interactive control using Tab/Shift+Tab only.
- Activate expand/collapse, branch focus, search, filters, details, fullscreen,
  and close with the documented keyboard action.
- Confirm focus order follows the visible hierarchy and focus is restored after
  closing details/fullscreen.
- Confirm a visible focus indicator is never clipped.
- With VoiceOver, confirm the tree, node depth, expanded state, status, model,
  verification, parent, and details are announced meaningfully.
- Confirm live status/error changes are announced without stealing focus.
- Verify WCAG AA contrast and that 200% text resizing causes no loss of content
  or functionality.

A mouse-only workflow, ambiguous screen-reader tree, keyboard trap, invisible
focus, or inaccessible error is a **FAIL**.

## 8. Scale and recovery in the real host

Load a deterministic manifest containing exactly 25 active and 200 completed
unique agents with 224 edges. Record, without inventing a release threshold:

- first useful inline render time;
- fullscreen-ready time;
- search/filter response time;
- branch expand and details-open response time;
- page count and returned item count;
- browser memory snapshot if the host exposes it; and
- console errors, dropped frames, freezes, or crashes.

The run must have no missing/duplicate public IDs, no unstable ordering, no
phantom active agents, no crash/freeze, and no unbounded request loop. Preserve
the measured values for later threshold setting.

During an active view, drop the Codex app-server child and verify a truthful
disconnected state. Recover with a new connection epoch, then refresh,
fullscreen-remount, and restart the Agent Farm server. The semantic projection
and grant-bound Agent Farm session must remain stable; event keys and sources
must not duplicate.

## 9. Live negative security checks

Use harmless test identities and sanitized assertions:

- missing, expired, revoked, wrong-issuer, wrong-audience, wrong-resource, and
  insufficient-scope tokens;
- callback state/nonce/PKCE mismatch;
- CSRF omission and mismatch;
- caller-supplied Agent Farm session, owner, tenant, or source-root values;
- cross-principal MCP protocol session reuse;
- unknown session/details lookup and malformed IDs;
- unapproved `Origin`, `Host`, forwarded-host/proto, and remote HTTP origin;
- attempts to discover or call a V1 mutation/control tool;
- widget URLs containing token-like query or fragment values; and
- response/log/storage scans for secrets and prohibited private fields.

Every negative must fail closed without revealing whether another principal's
session or agent exists. Any data leak, accepted forged identity, source-root
substitution, exposed control tool, raw token persistence, or Codex mutation
is a release-blocking **FAIL**.

## 10. Verdict and rollback

Mark the external gate **PASS** only when every required check above has fresh,
sanitized evidence for the exact deployed revision and the validator prints
`EXTERNAL CHATGPT ACCEPTANCE PASS (validated)`. A `null` in a required field,
`HOLD`, missing principal, skipped browser/VoiceOver step, unresolved critic
finding, or missing evidence reference keeps the overall status at **HOLD**.
Use the explicit `NOT_APPLICABLE` or `NOT_EXPOSED` sentinel only where the
template permits it and retain the required reason. Any security/isolation
failure sets the result to **FAIL**.

If a gate fails:

1. Disable external traffic and stop the candidate process.
2. Preserve redacted logs, checksums, timestamps, and the database backup.
3. Restore the last known-good build with its matching Codex binary/schema.
4. Rotate or revoke affected credentials through the provider.
5. Re-run health, authenticated smoke, isolation, and the failed acceptance
   section before reopening traffic.

Do not weaken OAuth, CSP, host/origin validation, source-root pairing,
redaction, or the read-only tool allowlist to obtain a visual PASS.
