import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

// Phase 1 schema — only agents and broker_state
// Future phases will add tables via addSchema()
const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  role              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'offline',
  skills            TEXT NOT NULL DEFAULT '[]',
  reconnect_token   TEXT NOT NULL,
  connected_at      TEXT,
  last_seen         TEXT,
  current_task_id   TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS broker_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`

export class Database {
  private db: DatabaseSync

  constructor(dbPath: string) {
    const dir = dirname(dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(BASE_SCHEMA)
  }

  /** Register additional schema fragments from later phases */
  addSchema(sql: string): void {
    this.db.exec(sql)
  }

  prepare(sql: string) {
    return this.db.prepare(sql)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  close(): void {
    this.db.close()
  }
}
