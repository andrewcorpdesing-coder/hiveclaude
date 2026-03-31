import type { Database } from '../db/Database.js'
import type { HiveEvent } from '../types.js'

const MESSAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  target_agent_id TEXT NOT NULL,
  from_agent_id   TEXT NOT NULL,
  event_name      TEXT NOT NULL DEFAULT 'message_received',
  payload         TEXT NOT NULL,
  priority        TEXT NOT NULL DEFAULT 'normal'
                  CHECK(priority IN ('normal', 'high', 'urgent')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pm_target ON pending_messages(target_agent_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_pm_priority ON pending_messages(priority);
`

interface PendingRow {
  id: number
  event_name: string
  payload: string
  created_at: string
}

export class MessageBus {
  private db: Database
  private pruneTimer: NodeJS.Timeout

  constructor(db: Database) {
    this.db = db
    this.db.addSchema(MESSAGE_SCHEMA)
    // Prune expired messages every 5 minutes
    this.pruneTimer = setInterval(() => this.pruneExpired(), 5 * 60 * 1000)
  }

  /**
   * Queue a message for one or more target agents.
   * targetIds is the resolved list — either [toAgentId] or all agents except sender.
   */
  send(params: {
    fromAgentId: string
    toAgentId?: string
    targetIds: string[]
    messageType: string
    content: string
    priority: 'normal' | 'high' | 'urgent'
  }): void {
    if (params.targetIds.length === 0) return

    const now = new Date()
    const createdAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString() // 1h TTL

    const payload = JSON.stringify({
      from: params.fromAgentId,
      to: params.toAgentId ?? 'broadcast',
      type: params.messageType,
      content: params.content,
      priority: params.priority,
      sentAt: createdAt,
    })

    const stmt = this.db.prepare(`
      INSERT INTO pending_messages
        (target_agent_id, from_agent_id, event_name, payload, priority, created_at, expires_at)
      VALUES (?, ?, 'message_received', ?, ?, ?, ?)
    `)

    this.db.transaction(() => {
      for (const targetId of params.targetIds) {
        stmt.run(targetId, params.fromAgentId, payload, params.priority, createdAt, expiresAt)
      }
    })
  }

  /**
   * Drain all pending non-expired messages for an agent.
   * Deletes fetched rows — each message is delivered exactly once.
   * Results are ordered: urgent → high → normal, then by insertion order.
   */
  drain(agentId: string): HiveEvent[] {
    const rows = this.db.prepare(`
      SELECT id, event_name, payload, created_at
      FROM pending_messages
      WHERE target_agent_id = ?
        AND expires_at > datetime('now')
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
        id ASC
    `).all(agentId) as unknown as PendingRow[]

    if (rows.length === 0) return []

    const del = this.db.prepare('DELETE FROM pending_messages WHERE id = ?')
    this.db.transaction(() => {
      for (const row of rows) del.run(row.id)
    })

    return rows.map(r => ({
      type: r.event_name,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      timestamp: r.created_at,
    }))
  }

  pruneExpired(): void {
    this.db.prepare(`DELETE FROM pending_messages WHERE expires_at <= datetime('now')`).run()
  }

  destroy(): void {
    clearInterval(this.pruneTimer)
  }
}
