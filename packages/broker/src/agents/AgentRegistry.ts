import { randomUUID } from 'node:crypto'
import { Database } from '../db/Database.js'
import type { AgentRecord, AgentRole, AgentStatus } from '../types.js'

interface AgentRow {
  id: string
  role: string
  status: string
  skills: string
  reconnect_token: string
  connected_at: string | null
  last_seen: string | null
  current_task_id: string | null
}

export class AgentRegistry {
  private db: Database
  private heartbeatTimer: NodeJS.Timeout
  private onOfflineCallback?: (agentId: string) => void

  constructor(db: Database) {
    this.db = db
    // Check for stale agents every 10s — mark offline if no heartbeat for 30s
    this.heartbeatTimer = setInterval(() => this.reapStaleAgents(), 10_000)
  }

  /** Called by FileLockRegistry/HttpServer to release locks when agent goes offline */
  setOnOfflineCallback(fn: (agentId: string) => void): void {
    this.onOfflineCallback = fn
  }

  register(params: {
    agentId: string
    role: AgentRole
    skills: string[]
    reconnectToken?: string
  }): AgentRecord {
    const now = new Date().toISOString()
    const token = params.reconnectToken ?? randomUUID()

    this.db.prepare(`
      INSERT INTO agents (id, role, status, skills, reconnect_token, connected_at, last_seen)
      VALUES (?, ?, 'online', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        role = excluded.role,
        status = 'online',
        skills = excluded.skills,
        reconnect_token = excluded.reconnect_token,
        connected_at = excluded.connected_at,
        last_seen = excluded.last_seen
    `).run(
      params.agentId,
      params.role,
      JSON.stringify(params.skills),
      token,
      now,
      now,
    )

    return this.getById(params.agentId)!
  }

  heartbeat(agentId: string, status?: AgentStatus): void {
    const now = new Date().toISOString()
    if (status) {
      this.db.prepare(`
        UPDATE agents SET last_seen = ?, status = ? WHERE id = ?
      `).run(now, status, agentId)
    } else {
      this.db.prepare(`
        UPDATE agents SET last_seen = ? WHERE id = ?
      `).run(now, agentId)
    }
  }

  markOffline(agentId: string): void {
    this.db.prepare(`
      UPDATE agents SET status = 'offline' WHERE id = ?
    `).run(agentId)
    this.onOfflineCallback?.(agentId)
    console.log(`[registry] Agent offline: ${agentId}`)
  }

  getById(agentId: string): AgentRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM agents WHERE id = ?
    `).get(agentId) as AgentRow | undefined
    return row ? this.rowToRecord(row) : null
  }

  getByReconnectToken(token: string): AgentRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM agents WHERE reconnect_token = ?
    `).get(token) as AgentRow | undefined
    return row ? this.rowToRecord(row) : null
  }

  getAll(): AgentRecord[] {
    const rows = this.db.prepare(`SELECT * FROM agents`).all() as unknown as AgentRow[]
    return rows.map(r => this.rowToRecord(r))
  }

  getOnline(): AgentRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM agents WHERE status != 'offline'
    `).all() as unknown as AgentRow[]
    return rows.map(r => this.rowToRecord(r))
  }

  countOnline(): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM agents WHERE status != 'offline'
    `).get() as { count: number }
    return result.count
  }

  private reapStaleAgents(): void {
    const stale = this.db.prepare(`
      SELECT id FROM agents
      WHERE status != 'offline'
        AND last_seen < datetime('now', '-90 seconds')
    `).all() as Array<{ id: string }>

    for (const { id } of stale) {
      this.markOffline(id)
    }
  }

  private rowToRecord(row: AgentRow): AgentRecord {
    return {
      id: row.id,
      role: row.role as AgentRole,
      status: row.status as AgentStatus,
      skills: JSON.parse(row.skills) as string[],
      reconnectToken: row.reconnect_token,
      connectedAt: row.connected_at,
      lastSeen: row.last_seen,
      currentTaskId: row.current_task_id,
    }
  }

  destroy(): void {
    clearInterval(this.heartbeatTimer)
  }
}
