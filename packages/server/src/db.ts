import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Logger } from './log.ts'

/**
 * Storage is `node:sqlite` (built into Node >= 22.5) so the platform has no
 * native build step. Knowledge-base search uses FTS5 with the `trigram`
 * tokenizer, which handles CJK and substring matching — important because SRE
 * documents here are mostly Chinese with embedded English identifiers.
 */
export function openDatabase(path: string, log: Logger): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db, log)
  return db
}

function migrate(db: DatabaseSync, log: Logger): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      kernel            TEXT NOT NULL,
      kernel_session_id TEXT,
      title             TEXT NOT NULL,
      model_provider    TEXT,
      model             TEXT,
      cwd               TEXT NOT NULL,
      origin            TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      runbook_id        TEXT,
      alert_id          TEXT,
      allowed_tools     TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      text       TEXT NOT NULL,
      tool_name  TEXT,
      call_id    TEXT,
      ok         INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

    CREATE TABLE IF NOT EXISTS approvals (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      kernel          TEXT NOT NULL,
      tool_name       TEXT NOT NULL,
      args            TEXT NOT NULL,
      risk            TEXT NOT NULL,
      reason          TEXT NOT NULL,
      origin          TEXT NOT NULL,
      status          TEXT NOT NULL,
      requested_at    INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      decided_at      INTEGER,
      decided_by      TEXT,
      decision_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, requested_at DESC);

    CREATE TABLE IF NOT EXISTS audit (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      actor   TEXT NOT NULL,
      action  TEXT NOT NULL,
      subject TEXT NOT NULL,
      detail  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);

    CREATE TABLE IF NOT EXISTS skills (
      name        TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      body        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      source      TEXT NOT NULL DEFAULT 'platform',
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      name       TEXT PRIMARY KEY,
      spec       TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS providers (
      id         TEXT PRIMARY KEY,
      spec       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS permission_rules (
      id          TEXT PRIMARY KEY,
      priority    INTEGER NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      tool        TEXT,
      risk        TEXT,
      origins     TEXT,
      effect      TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS runbooks (
      id         TEXT PRIMARY KEY,
      spec       TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id          TEXT PRIMARY KEY,
      runbook_id  TEXT NOT NULL,
      cron        TEXT NOT NULL,
      timezone    TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS runs (
      id           TEXT PRIMARY KEY,
      runbook_id   TEXT NOT NULL,
      session_id   TEXT,
      status       TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER,
      report       TEXT,
      findings     TEXT NOT NULL DEFAULT '[]',
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS alerts (
      id           TEXT PRIMARY KEY,
      fingerprint  TEXT NOT NULL,
      source       TEXT NOT NULL,
      name         TEXT NOT NULL,
      severity     TEXT NOT NULL,
      target       TEXT,
      summary      TEXT,
      labels       TEXT NOT NULL DEFAULT '{}',
      status       TEXT NOT NULL,
      session_id   TEXT,
      received_at  INTEGER NOT NULL,
      raw          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_received ON alerts(received_at DESC);

    CREATE TABLE IF NOT EXISTS kb_docs (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      source      TEXT NOT NULL,
      tags        TEXT NOT NULL DEFAULT '[]',
      mime        TEXT NOT NULL,
      hash        TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id     TEXT NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
      ord        INTEGER NOT NULL,
      text       TEXT NOT NULL,
      embedding  BLOB,
      embedding_model TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id, ord);

    CREATE TABLE IF NOT EXISTS memory (
      id               TEXT PRIMARY KEY,
      kind             TEXT NOT NULL,
      subject          TEXT NOT NULL,
      text             TEXT NOT NULL,
      tags             TEXT NOT NULL DEFAULT '[]',
      importance       INTEGER NOT NULL DEFAULT 3,
      source           TEXT NOT NULL,
      source_session_id TEXT,
      created_at       INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      access_count     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_memory_subject ON memory(subject, kind);

    CREATE TABLE IF NOT EXISTS workflows (
      id         TEXT PRIMARY KEY,
      spec       TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id          TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      session_id  TEXT,
      trigger     TEXT NOT NULL,
      status      TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      steps       TEXT NOT NULL DEFAULT '[]',
      report      TEXT,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_started ON workflow_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS agents (
      id         TEXT PRIMARY KEY,
      spec       TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id              TEXT PRIMARY KEY,
      agent_id        TEXT NOT NULL,
      trigger         TEXT NOT NULL,
      alert_id        TEXT,
      session_id      TEXT,
      workflow_run_id TEXT,
      status          TEXT NOT NULL,
      summary         TEXT,
      started_at      INTEGER NOT NULL,
      finished_at     INTEGER,
      error           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS credentials (
      ref        TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      enc        BLOB NOT NULL,
      iv         BLOB NOT NULL,
      tag        BLOB NOT NULL,
      has_refresh INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `)

  addColumnIfMissing(db, 'sessions', 'parent_session_id', 'TEXT', log)

  // FTS5 is created separately: the trigram tokenizer needs SQLite >= 3.34 and
  // must be probed, and we want a clear warning when the build lacks it.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        text,
        subject,
        content='memory',
        content_rowid='rowid',
        tokenize='trigram'
      );
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, text, subject) VALUES (new.rowid, new.text, new.subject);
      END;
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, text, subject) VALUES ('delete', old.rowid, old.text, old.subject);
      END;
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, text, subject) VALUES ('delete', old.rowid, old.text, old.subject);
        INSERT INTO memory_fts(rowid, text, subject) VALUES (new.rowid, new.text, new.subject);
      END;
    `)
  } catch (error) {
    log.warn(`memory full-text index unavailable, falling back to LIKE: ${String(error)}`)
  }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
        text,
        content='kb_chunks',
        content_rowid='id',
        tokenize='trigram'
      );
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
        INSERT INTO kb_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
        INSERT INTO kb_fts(kb_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
        INSERT INTO kb_fts(kb_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO kb_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `)
  } catch (error) {
    log.warn(`knowledge base full-text index unavailable, falling back to LIKE: ${String(error)}`)
  }
}

export function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
  log: Logger,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some((entry) => entry.name === column)) return
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    log.info(`migrated: ${table}.${column} added`)
  } catch (error) {
    log.warn(`migration for ${table}.${column} failed: ${String(error)}`)
  }
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === true
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
