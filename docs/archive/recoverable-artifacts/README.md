# Recoverable local artifacts

This boundary is reserved for generated or third-party recovery material that
must remain available to the operator but is not Agent Farm source. The active
checkout currently keeps one npm artifact at
`.agent-farm-backups/npm-artifacts-20260811-0123/package-lock.json` for
rollback/reference while the project uses pnpm 11.16.0 and
`pnpm-lock.yaml`. It is ignored by Git and is not part of a Local V1 source
manifest or release archive.

Do not copy this artifact into the active dependency workflow or treat it as a
second lockfile. Remove the local backup only after confirming that no
rollback/reference need remains.
