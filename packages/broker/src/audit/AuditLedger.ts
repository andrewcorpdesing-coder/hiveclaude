import type { Database } from '../db/Database.js'

const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  agent_id  TEXT NOT NULL,
  action    TEXT NOT NULL,
  target    TEXT,
  detail    TEXT,
  result    TEXT NOT NULL CHECK(result IN ('ok', 'denied', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_audit_agent  ON audit_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log(ts);
`

export interface AuditEntry {
  agentId: string
  action: string
  target?: string
  detail?: unknown
  result: 'ok' | 'denied' | 'error'
}

export interface AuditRow {
  id: number
  ts: string
  agent_id: string
  action: string
  target: string | null
  detail: string | null
  result: string
}

export interface AuditQueryParams {
  agentId?: string
  action?: string
  result?: 'ok' | 'denied' | 'error'
  since?: string   // ISO timestamp
  limit?: number
}

export class AuditLedger {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.db.addSchema(AUDIT_SCHEMA)
  }

  log(entry: AuditEntry): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO audit_log (ts, agent_id, action, target, detail, result)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      now,
      entry.agentId,
      entry.action,
      entry.target ?? null,
      entry.detail != null ? JSON.stringify(entry.detail) : null,
      entry.result,
    )
  }

  query(params: AuditQueryParams = {}): AuditRow[] {
    const limit = Math.min(params.limit ?? 100, 500)
    const conditions: string[] = []
    const args: unknown[] = []

    if (params.agentId) { conditions.push('agent_id = ?'); args.push(params.agentId) }
    if (params.action)  { conditions.push('action = ?');   args.push(params.action) }
    if (params.result)  { conditions.push('result = ?');   args.push(params.result) }
    if (params.since)   { conditions.push('ts >= ?');      args.push(params.since) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    args.push(limit)

    return this.db.prepare(
      `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`,
    ).all(...(args as Parameters<typeof this.db.prepare>)) as unknown as AuditRow[]
  }

  countBy(action: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as n FROM audit_log WHERE action = ?',
    ).get(action) as { n: number }
    return row.n
  }
}
