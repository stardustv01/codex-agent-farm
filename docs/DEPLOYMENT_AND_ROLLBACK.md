# Local release and rollback

Agent Farm is distributed as a local CLI-installed companion. Cloud hosting,
public ingress, OAuth deployment, and a remote Agent Farm account are out of
scope. The superseded remote deployment checklist is archived at
[`archive/future-remote/DEPLOYMENT_AND_ROLLBACK.md`](archive/future-remote/DEPLOYMENT_AND_ROLLBACK.md).

## Release

1. Freeze an exact commit and tag.
2. Build and inspect the exact CLI package.
3. Confirm the package contains the built server and web assets but excludes
   `.agent-farm/`, SQLite files, keys, logs, caches, evidence, and development
   artifacts.
4. Run the complete test, typecheck, privacy, and build gates in protected CI.
5. Install the packed artifact as a clean non-admin user.
6. Run the packaged doctor, start, single-active-chat switch, responsive
   browser, stop, and uninstall acceptance.
7. Verify the package from the public registry without local credentials or
   workspace links before promoting a stable version.

The authoritative permissions and agent installation procedure are in
[`LOCAL_CLI_INSTALLATION.md`](LOCAL_CLI_INSTALLATION.md).

## Update

- Resolve an exact version; do not silently follow an unpinned branch.
- Verify package provenance and digest before execution.
- Stop the owned process and back up the owner-only SQLite database.
- Install the matching runtime/web bundle as one unit.
- Run the doctor before starting the new version.
- Preserve the previous package and database backup until browser acceptance
  passes.

## Rollback

1. Stop only the process owned by the Agent Farm installation.
2. Preserve logs and make a read-only copy of the SQLite database.
3. Restore the previous exact package/runtime bundle.
4. Reuse the current database only when that release supports its schema;
   otherwise stop and ship an explicit forward migration.
5. Run the doctor, start on loopback, and repeat browser/privacy acceptance.
6. Never weaken loopback, CSRF, host/origin, binary, or file-permission checks
   to make rollback pass.

## Uninstall

The CLI must remove only files and process registrations it owns. It must stop
the service, require explicit confirmation before discarding projections,
preserve or export data when requested, remove only its own Codex integration
entry if one was explicitly installed, and leave all other Codex settings,
sessions, credentials, and projects untouched.
