import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

export const SCHEMA_VERSION = 6;

/** Apply all durable-store migrations. Migrations are intentionally local and deterministic. */
export function migrate(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  const hasMigrationTable = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get() !== undefined;

  // Never attempt to mutate a database written by a newer Agent Farm build.
  // Opening it read/write with an older migration set could silently discard
  // fields that the public projection depends on.  The recovery instruction
  // is deliberately generic: preserve the database backup and reopen it with
  // the matching/newer release rather than trying an ad-hoc downgrade.
  const newest = hasMigrationTable
    ? db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version?: number | null } | undefined
    : undefined;
  if (typeof newest?.version === "number" && newest.version > SCHEMA_VERSION) {
    throw new Error(
      "Unsupported durable store schema version; back up the database and reopen it with a compatible Agent Farm release.",
    );
  }

  // A file-backed older projection gets a SQLite-consistent, owner-only
  // recovery copy before the first schema mutation. A pre-existing recovery
  // path is never overwritten or silently trusted.
  if (typeof newest?.version === "number" && newest.version < SCHEMA_VERSION) {
    createMigrationBackup(db, newest.version);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = db
    .prepare("SELECT version FROM schema_migrations WHERE version = ?")
    .get(SCHEMA_VERSION) as { version?: number } | undefined;
  if (applied?.version === SCHEMA_VERSION) return;

  const runMigration = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','revoked','deleted')),
        source_adapter TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1,
        root_source_thread_id TEXT,
        root_source_session_id TEXT,
        watermark_ingest_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (watermark_ingest_ordinal >= 0),
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, owner_id, agent_session_id)
      );

      CREATE TABLE IF NOT EXISTS private_source_thread_mappings (
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        source_adapter TEXT NOT NULL,
        source_thread_id TEXT NOT NULL,
        source_session_id TEXT,
        is_root INTEGER NOT NULL DEFAULT 0 CHECK (is_root IN (0,1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, owner_id, agent_session_id, source_adapter, source_thread_id),
        UNIQUE (tenant_id, owner_id, agent_session_id, source_adapter, source_thread_id),
        FOREIGN KEY (tenant_id, owner_id, agent_session_id)
          REFERENCES app_sessions (tenant_id, owner_id, agent_session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agents (
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source_adapter TEXT,
        source_thread_id TEXT,
        source_session_id TEXT,
        parent_source_thread_id TEXT,
        role TEXT,
        name TEXT,
        lifecycle TEXT NOT NULL DEFAULT 'unknown',
        result_summary TEXT,
        error_summary TEXT,
        verification_state TEXT NOT NULL DEFAULT 'unverified',
        is_root INTEGER NOT NULL DEFAULT 0 CHECK (is_root IN (0,1)),
        spawn_ordinal INTEGER CHECK (spawn_ordinal IS NULL OR spawn_ordinal >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        usage_json TEXT,
        usage_segments_json TEXT,
        pricing_snapshot_id TEXT,
        cost_json TEXT,
        cost_usage_digest TEXT,
        PRIMARY KEY (tenant_id, owner_id, agent_session_id, agent_id),
        UNIQUE (tenant_id, owner_id, agent_session_id, source_adapter, source_thread_id),
        FOREIGN KEY (tenant_id, owner_id, agent_session_id)
          REFERENCES app_sessions (tenant_id, owner_id, agent_session_id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS agents_one_root_per_session
        ON agents (tenant_id, owner_id, agent_session_id) WHERE is_root = 1;

      CREATE TABLE IF NOT EXISTS agent_edges (
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        parent_agent_id TEXT NOT NULL,
        child_agent_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'app-server',
        spawn_ordinal INTEGER CHECK (spawn_ordinal IS NULL OR spawn_ordinal >= 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, owner_id, agent_session_id, parent_agent_id, child_agent_id),
        UNIQUE (tenant_id, owner_id, agent_session_id, child_agent_id),
        CHECK (parent_agent_id <> child_agent_id),
        FOREIGN KEY (tenant_id, owner_id, agent_session_id, parent_agent_id)
          REFERENCES agents (tenant_id, owner_id, agent_session_id, agent_id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, owner_id, agent_session_id, child_agent_id)
          REFERENCES agents (tenant_id, owner_id, agent_session_id, agent_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS identity_evidence (
        evidence_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        requested_model TEXT,
        requested_effort TEXT,
        requested_provider TEXT,
        observed_model TEXT,
        observed_effort TEXT,
        observed_provider TEXT,
        source TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        evidence_hash TEXT NOT NULL,
        trust_class TEXT NOT NULL CHECK (trust_class IN ('requested','observed','reconciled')),
        FOREIGN KEY (tenant_id, owner_id, agent_session_id, agent_id)
          REFERENCES agents (tenant_id, owner_id, agent_session_id, agent_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pricing_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        snapshot_hash TEXT NOT NULL UNIQUE CHECK (length(snapshot_hash) = 64),
        snapshot_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS identity_evidence_scope_idx
        ON identity_evidence (tenant_id, owner_id, agent_session_id, agent_id, observed_at, evidence_id);

      CREATE TABLE IF NOT EXISTS sanitized_events (
        event_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        connection_epoch TEXT NOT NULL,
        ingest_ordinal INTEGER NOT NULL,
        event_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        source_adapter TEXT,
        source_thread_id TEXT,
        source_session_id TEXT,
        turn_id TEXT,
        item_id TEXT,
        status TEXT,
        sanitized_payload_hash TEXT NOT NULL,
        sanitized_payload_json TEXT NOT NULL,
        correlation_id TEXT,
        authority TEXT NOT NULL CHECK (authority IN ('notification','snapshot','reconciliation','system')),
        redaction_version TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (tenant_id, owner_id, agent_session_id, event_key),
        UNIQUE (tenant_id, owner_id, agent_session_id, ingest_ordinal),
        FOREIGN KEY (tenant_id, owner_id, agent_session_id)
          REFERENCES app_sessions (tenant_id, owner_id, agent_session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS sanitized_events_order_idx
        ON sanitized_events (tenant_id, owner_id, agent_session_id, ingest_ordinal, event_id);

      CREATE TABLE IF NOT EXISTS event_quarantine (
        conflict_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        existing_payload_hash TEXT NOT NULL,
        conflicting_payload_hash TEXT NOT NULL,
        connection_epoch TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason = 'sanitized_payload_hash_conflict'),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (tenant_id, owner_id, agent_session_id)
          REFERENCES app_sessions (tenant_id, owner_id, agent_session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS bridge_bindings (
        binding_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        source_adapter TEXT NOT NULL,
        selected_source_root_id TEXT NOT NULL,
        credential_hash TEXT NOT NULL,
        nonce_hash TEXT,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        UNIQUE (tenant_id, owner_id, agent_session_id, installation_id, selected_source_root_id),
        FOREIGN KEY (tenant_id, owner_id, agent_session_id)
          REFERENCES app_sessions (tenant_id, owner_id, agent_session_id) ON DELETE CASCADE
      );

      -- MCP grant bindings intentionally have no foreign key to app_sessions.
      -- A protocol DELETE (or an Agent Farm projection cleanup) must not erase
      -- the grant-to-session identity mapping needed by a later remount.
      -- The grant tuple itself is represented only by a keyed SHA-256 digest;
      -- raw owner/tenant/subject/resource/sid values never enter SQLite.
      CREATE TABLE IF NOT EXISTS mcp_grant_session_bindings (
        grant_key_digest TEXT PRIMARY KEY CHECK (length(grant_key_digest) = 64),
        agent_session_id TEXT NOT NULL CHECK (length(agent_session_id) BETWEEN 1 AND 256),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
        expires_at INTEGER NOT NULL CHECK (expires_at > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS mcp_grant_session_bindings_lifecycle_idx
        ON mcp_grant_session_bindings (status, expires_at, updated_at);

      CREATE TABLE IF NOT EXISTS idempotency_records (
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (tenant_id, owner_id, agent_session_id, operation, idempotency_key)
      );

      -- Audit rows intentionally have no foreign key: a session deletion leaves
      -- an auditable tombstone while all Agent Farm projection data is removed.
      CREATE TABLE IF NOT EXISTS audit_records (
        audit_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        agent_session_id TEXT,
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_scope_idx
        ON audit_records (tenant_id, owner_id, agent_session_id, created_at, audit_id);

      -- A transactional maintenance marker is used only while deleting an
      -- Agent Farm session. It never contains user/Codex data.
      CREATE TABLE IF NOT EXISTS store_maintenance (
        marker TEXT PRIMARY KEY
      );

      CREATE TRIGGER IF NOT EXISTS identity_evidence_append_only_update
        BEFORE UPDATE ON identity_evidence
        BEGIN SELECT RAISE(ABORT, 'identity evidence is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS identity_evidence_append_only_delete
        BEFORE DELETE ON identity_evidence
        WHEN NOT EXISTS (SELECT 1 FROM store_maintenance WHERE marker = 'session-delete')
        BEGIN SELECT RAISE(ABORT, 'identity evidence is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS sanitized_events_append_only_update
        BEFORE UPDATE ON sanitized_events
        BEGIN SELECT RAISE(ABORT, 'sanitized events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS sanitized_events_append_only_delete
        BEFORE DELETE ON sanitized_events
        WHEN NOT EXISTS (SELECT 1 FROM store_maintenance WHERE marker = 'session-delete')
        BEGIN SELECT RAISE(ABORT, 'sanitized events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_records_append_only_update
        BEFORE UPDATE ON audit_records
        BEGIN SELECT RAISE(ABORT, 'audit records are append-only'); END;
    `);
    // v4 adds local rollout usage. Existing rows retain null usage and receive
    // usage only after an exact correlation.
    // v3 is additive. Existing v2 databases retain their rows and receive a
    // nullable event-backed ordinal; the public adapter explicitly marks
    // rows without one as legacy instead of pretending created_at is an
    // authoritative spawn order.
    const addColumnIfMissing = (table: string, column: string, definition: string): void => {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
      if (!columns.some((entry) => entry.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };
    addColumnIfMissing("agents", "spawn_ordinal", "INTEGER CHECK (spawn_ordinal IS NULL OR spawn_ordinal >= 0)");
    addColumnIfMissing("agents", "usage_json", "TEXT");
    addColumnIfMissing("agents", "usage_segments_json", "TEXT");
    addColumnIfMissing("agents", "pricing_snapshot_id", "TEXT");
    addColumnIfMissing("agents", "cost_json", "TEXT");
    addColumnIfMissing("agents", "cost_usage_digest", "TEXT");
    addColumnIfMissing("agent_edges", "spawn_ordinal", "INTEGER CHECK (spawn_ordinal IS NULL OR spawn_ordinal >= 0)");
    // SQLite cannot add a foreign key to the legacy agents table in-place.
    // Equivalent triggers keep a non-null pricing pin referentially valid for
    // both fresh and migrated databases. Pricing rows are append-only because
    // completed estimates must never be silently repriced.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS agents_pricing_pin_insert
        BEFORE INSERT ON agents
        WHEN NEW.pricing_snapshot_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pricing_snapshots WHERE snapshot_id = NEW.pricing_snapshot_id
        )
        BEGIN SELECT RAISE(ABORT, 'pricing snapshot pin is invalid'); END;
      CREATE TRIGGER IF NOT EXISTS agents_pricing_pin_update
        BEFORE UPDATE OF pricing_snapshot_id ON agents
        WHEN NEW.pricing_snapshot_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pricing_snapshots WHERE snapshot_id = NEW.pricing_snapshot_id
        )
        BEGIN SELECT RAISE(ABORT, 'pricing snapshot pin is invalid'); END;
      CREATE TRIGGER IF NOT EXISTS pricing_snapshots_append_only_update
        BEFORE UPDATE ON pricing_snapshots
        BEGIN SELECT RAISE(ABORT, 'pricing snapshots are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS pricing_snapshots_append_only_delete
        BEFORE DELETE ON pricing_snapshots
        BEGIN SELECT RAISE(ABORT, 'pricing snapshots are append-only'); END;
    `);
    // Preserve the accepted v3→v4 lineage marker when a pre-v4 file is
    // upgraded directly to the current v6 shape. The physical migration is
    // atomic, but the marker keeps doctor/recovery tooling truthful about the
    // intermediate contract that was applied.
    if (typeof newest?.version === "number" && newest.version < 4 &&
        db.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get() === undefined) {
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (4, ?)").run(Date.now());
    }
    if (typeof newest?.version === "number" && newest.version < 5 &&
        db.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get() === undefined) {
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (5, ?)").run(Date.now());
    }
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, Date.now());
  });

  runMigration();
}

function createMigrationBackup(db: Database.Database, sourceVersion: number): void {
  if (!db.name || db.name === ":memory:") {
    throw new Error("Older durable store requires a file-backed migration backup before it can be opened.");
  }
  const sourcePath = resolve(db.name);
  const backupPath = `${sourcePath}.v${sourceVersion}.pre-v${SCHEMA_VERSION}.backup.sqlite`;
  const source = lstatSync(sourcePath);
  const parent = lstatSync(dirname(sourcePath));
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!source.isFile() || source.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink() ||
      (currentUid !== undefined && (source.uid !== currentUid || parent.uid !== currentUid))) {
    throw new Error("Durable store migration backup requires an owner-controlled regular database file and directory.");
  }
  if (existsSync(backupPath)) {
    throw new Error("A durable store migration backup already exists; preserve or rename it before retrying.");
  }

  let created = false;
  try {
    const quotedBackupPath = backupPath.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${quotedBackupPath}'`);
    created = true;
    chmodSync(backupPath, 0o600);
    const backup = lstatSync(backupPath);
    if (!backup.isFile() || backup.isSymbolicLink() || (currentUid !== undefined && backup.uid !== currentUid) ||
        (backup.mode & 0o077) !== 0) {
      throw new Error("Durable store migration backup permissions are unsafe.");
    }
    const verification = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = verification.pragma("integrity_check", { simple: true });
      const version = verification.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version?: number | null } | undefined;
      if (integrity !== "ok" || version?.version !== sourceVersion) {
        throw new Error("Durable store migration backup verification failed.");
      }
    } finally {
      verification.close();
    }
  } catch (error: unknown) {
    if (created) {
      try {
        const backup = lstatSync(backupPath);
        if (backup.isFile() && !backup.isSymbolicLink() && (currentUid === undefined || backup.uid === currentUid)) {
          unlinkSync(backupPath);
        }
      } catch {
        // Preserve the original failure; never broaden cleanup beyond the
        // exact backup file created by this invocation.
      }
    }
    void error;
    throw new Error("Durable store migration backup could not be created and verified; the source database was not migrated.");
  }
}
