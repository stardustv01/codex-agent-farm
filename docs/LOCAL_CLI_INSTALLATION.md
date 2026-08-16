# Local CLI installation and permissions

Status: **version 0.1.0 published on npm for macOS**

This document is the authority for Agent Farm's local distribution boundary.
Agent Farm is installed with a CLI, runs on the user's machine, and exposes a
loopback-only browser experience. Cloud hosting, public ingress, and a remote
Agent Farm account are not part of this product.

## Intended command surface

The `codex-agent-farm` package provides this executable surface:

```text
agent-farm install     validate prerequisites and create owner-only state
agent-farm doctor      perform read-only installation and runtime checks
agent-farm start       start or focus the singleton loopback service
agent-farm open        open the local browser UI
agent-farm status      report version, health, port, and state location
agent-farm stop        stop only the process owned by this installation
agent-farm update      verify and install an explicitly selected release
agent-farm uninstall   stop, unpair, preserve/export data if requested, remove owned files
```

The exact 0.1.0 package passed clean-install acceptance and is publicly
available from npm as `codex-agent-farm`. The license is Apache-2.0.
`agent-farm update` remains intentionally disabled because v0.1.0 has no signed
automatic-update channel; install an explicitly selected npm version instead.

## Installation approvals

An installing human or agent may approve only the following operations:

1. Read the selected version's manifest, checksum, and documentation.
2. Download that exact package and its locked dependencies.
3. Execute Node.js and the verified compatible Codex CLI as the current user.
4. Read bounded, non-symlink Codex session files below the resolved
   `~/.codex/sessions` trust root for identity correlation.
5. Create the declared Agent Farm data directory with mode `0700`.
6. Create configuration, key, and SQLite files with mode `0600`.
7. Bind only an explicitly reported loopback address and port.
8. Open the loopback URL in the user's browser after the server is healthy.

The installer must show its chosen data directory, binary/runtime source,
port, and version before completing setup. It must not print key material,
session contents, prompts, source root IDs, or database rows.

## Permissions that must be refused

Stop installation if it asks for any of the following without a separately
reviewed product change:

- `sudo`, root, administrator, or setuid access
- Full Disk Access
- Accessibility or automation control
- Screen Recording
- camera, microphone, contacts, calendar, or location
- listening on `0.0.0.0`, a LAN address, or a public interface
- inbound firewall or router changes
- a hosted Agent Farm login, cloud database, public domain, or TLS certificate
- disabling CSRF, host/origin checks, binary verification, or safe file modes
- reading arbitrary home-directory files
- modifying Codex model, provider, concurrency, or authentication settings
- deleting or overwriting an existing database during install/update

## Codex configuration boundary

The current source implementation launches the supported Codex app-server
adapter and focuses the local UI through a signed loopback handoff. It does not
need to add a generic MCP entry to `~/.codex/config.toml`.

The public installer must therefore not run `codex mcp add` merely because
Agent Farm contains an MCP transport. If a future release adds a supported
Codex MCP registration, it must:

1. use the documented `codex mcp add` command or equivalent `mcp_servers`
   configuration;
2. show the exact entry before writing it;
3. avoid embedding tokens or secrets in command arguments or TOML;
4. verify the entry using `codex mcp get` or `codex mcp list`; and
5. remove only that owned entry during uninstall.

General Codex MCP syntax is documented by OpenAI at
<https://developers.openai.com/codex/mcp/>. That documentation does not itself
make Agent Farm's current loopback endpoint safe to register as a bare URL.

## Local data ownership

The source checkout owns these generated paths below its `.agent-farm/`; an
installed CLI owns the equivalent paths below `~/.agent-farm/`:

```text
budget.env
README.txt
local.sqlite
local.sqlite-wal
local.sqlite-shm
server.pid
server.log
local-auth/local-installation-secret
local-auth/local-session-signing-key
```

Unknown files, symlinks, foreign ownership, or unsafe modes cause setup and
cleanup to fail closed. Updates must preserve the database and create an
explicit backup before an incompatible schema migration.

## Agent installation procedure

An autonomous installer should follow this order:

1. Resolve an exact, non-floating release version.
2. Verify its registry/release source and checksum.
3. Inspect the package contents and lifecycle scripts.
4. Confirm the requested permissions match this document.
5. Install without `sudo`.
6. Run `agent-farm doctor` and stop on any failure.
7. Start the loopback service and wait for health readiness.
8. Open the local UI and verify current-chat/switch-chat behavior.
9. Confirm the page has no private source IDs or credential-like values.
10. Report the installed version, artifact checksum, data path, port, doctor
    result, and browser result without revealing secrets.

## Release acceptance required for future versions

The CLI is releasable only after all of these pass against one exact artifact:

- package name/ownership are finalized (license is Apache-2.0);
- root CLI is public while internal workspaces remain private;
- packed contents contain required runtime/web assets and exclude source
  evidence, local databases, keys, logs, caches, and unrelated artifacts;
- install, doctor, start, focus, stop, update, and uninstall are tested from a
  clean supported macOS user account;
- install/uninstall do not alter unrelated Codex state;
- a second invocation focuses the existing service rather than starting a
  conflicting server;
- single-active-chat switching, responsive browser behavior, and privacy
  scanning pass from the installed artifact;
- protected CI validates the exact commit/tag and package digest; and
- anonymous registry installation reproduces the accepted result.
