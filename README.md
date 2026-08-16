# Codex Agent Farm

Codex Agent Farm is a local, read-only dashboard for Codex tasks. It shows the
selected task's root agent and recursive subagent hierarchy, including each
agent's model, effort, lifecycle status, and estimated cost.

Everything runs on your computer at `127.0.0.1`. Agent Farm does not send your
data to an Agent Farm cloud service, change Codex settings, or control agents.

## Requirements

- macOS
- Node.js 22.17.0 or newer
- Codex CLI 0.145.0 at `~/.local/bin/codex`

Version 0.1.0 is pinned to that exact Codex CLI release and verifies its binary
before installation. `agent-farm install` stops safely if the prerequisite does
not match.

## Install and start

```sh
npm install -g codex-agent-farm
agent-farm install
agent-farm doctor
agent-farm start
agent-farm open
```

### Ask Codex to install it for you

Copy this entire prompt and paste it into a Codex task:

```text
Install and verify Codex Agent Farm on this Mac from the public npm package
`codex-agent-farm`.

First, verify that:
- the machine is running macOS;
- Node.js is version 22.17.0 or newer;
- ~/.local/bin/codex exists and reports Codex CLI 0.145.0; and
- npm view codex-agent-farm version resolves successfully.

If a prerequisite does not match, stop and explain the mismatch. Do not bypass
the version or binary checks.

If the checks pass, run these commands without sudo:
1. npm install -g codex-agent-farm
2. agent-farm install
3. agent-farm doctor
4. agent-farm start
5. agent-farm status
6. agent-farm open

You may write only to npm's normal global package location and
~/.agent-farm/. You may read the bounded Codex session records needed by Agent
Farm and bind the dashboard only to 127.0.0.1. Do not modify Codex
configuration, request macOS privacy permissions, expose a LAN/public port,
delete existing Agent Farm data, or print private keys or task contents.

When finished, report the installed package version, doctor result, local URL,
service status, and whether the dashboard opened. Do not include secrets or
private filesystem data in the report.
```

The dashboard normally opens at `http://127.0.0.1:8799`.

If the dashboard does not open automatically, paste that address into your
browser. Use **Switch chat** in the dashboard to select another monitored Codex
task. When Agent Farm is launched with a valid current-task context, it focuses
that task automatically.

To use another port, pass the same value whenever you manage that instance:

```sh
AGENT_FARM_PORT=9000 agent-farm start
AGENT_FARM_PORT=9000 agent-farm open
AGENT_FARM_PORT=9000 agent-farm stop
```

## Commands

```text
agent-farm install     verify prerequisites and create private local state
agent-farm doctor      check the installation and local runtime
agent-farm start       start or focus the local service
agent-farm open        open the dashboard in the default browser
agent-farm status      show version, health, URL, and data location
agent-farm stop        stop the local service
agent-farm uninstall   stop the service and preserve its local data
```

## Local files and permissions

The npm package is stored in npm's global installation directory. Agent Farm
also creates `~/.agent-farm/` for its private local state:

```text
~/.agent-farm/
├── budget.env
├── README.txt
├── local.sqlite
├── server.log
├── server.pid
└── local-auth/
    ├── local-installation-secret
    └── local-session-signing-key
```

Some files appear only after the service starts, and SQLite may temporarily
create `local.sqlite-wal` and `local.sqlite-shm`. Directories use mode `0700`;
private files use mode `0600`.

Agent Farm runs as your current user. It does not require `sudo`, administrator
access, Full Disk Access, Screen Recording, Accessibility, camera, microphone,
location, a firewall change, or a public domain. It reads bounded records from
`~/.codex/sessions` to resolve agent identity, hierarchy, lifecycle, and usage.
The dashboard does not expose prompts, messages, tool arguments, credentials,
or private filesystem paths.

## Troubleshooting

Run:

```sh
agent-farm doctor
agent-farm status
```

If startup fails, inspect `~/.agent-farm/server.log`. Do not share the complete
`~/.agent-farm/` directory because it contains private local keys and task data.

## Stop and uninstall

```sh
agent-farm stop
agent-farm uninstall
npm uninstall -g codex-agent-farm
```

Uninstall preserves `~/.agent-farm/` so your local projections are not deleted.
After uninstalling, you may delete that directory manually if you do not want
to retain its data.

## License

Apache-2.0. See [LICENSE](LICENSE).
