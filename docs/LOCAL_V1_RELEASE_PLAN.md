# Agent Farm 0.1 release status

Status: **published on npm; source-control release in progress**

`codex-agent-farm@0.1.0` is publicly available from npm for macOS. The package
uses the Apache-2.0 license and installs the `agent-farm` executable. Cloud
hosting, public ingress, and a remote Agent Farm account remain out of scope.

The pre-publication Local V1 plan is retained as historical evidence at
[`archive/pre-publication-local-v1-plan-2026-08-12/LOCAL_V1_RELEASE_PLAN.md`](archive/pre-publication-local-v1-plan-2026-08-12/LOCAL_V1_RELEASE_PLAN.md).
Its old publication and authorization statements do not describe the current
registry state.

## Verified distribution boundary

- Package: `codex-agent-farm@0.1.0`
- Platform: macOS (`darwin`)
- License: Apache-2.0
- Runtime: local-only, bound to `127.0.0.1`
- Codex boundary: read-only monitoring; no agent control or Codex configuration
  mutation
- Update boundary: v0.1.0 has no signed automatic-update channel; install an
  explicitly selected npm version instead

The exact package acceptance procedure and permissions are documented in
[`LOCAL_CLI_INSTALLATION.md`](LOCAL_CLI_INSTALLATION.md). Registry publication
does not by itself certify a Git commit, tag, protected CI run, or future
version.

## Source-control release procedure

1. Exclude local state, generated package archives, bundled release output,
   caches, and pet-generation intermediates from Git.
2. Run privacy, typecheck, tests, production build, and package inspection from
   the intended source tree.
3. Create and record the first reviewed Git commit.
4. Configure the intended Git remote and push only after confirming its owner
   and visibility.
5. Add protected CI and tag a future version only after CI reproduces the
   accepted package.

The npm 0.1.0 publication preceded the repository's first commit. That history
must remain explicit; a later Git commit or tag must not be presented as the
original source identity of the already-published artifact.
