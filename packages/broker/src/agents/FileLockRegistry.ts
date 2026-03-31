import type { Database } from '../db/Database.js'

const LOCK_SCHEMA = `
CREATE TABLE IF NOT EXISTS file_locks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path       TEXT NOT NULL,
  lock_type       TEXT NOT NULL CHECK(lock_type IN ('READ', 'EXCLUSIVE', 'SOFT')),
  agent_id        TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  acquired_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat  TEXT NOT NULL DEFAULT (datetime('now')),
  ttl_seconds     INTEGER NOT NULL DEFAULT 30,
  UNIQUE(file_path, agent_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_locks_file  ON file_locks(file_path);
CREATE INDEX IF NOT EXISTS idx_locks_agent ON file_locks(agent_id);
CREATE INDEX IF NOT EXISTS idx_locks_task  ON file_locks(task_id);

CREATE TABLE IF NOT EXISTS lock_queue (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path            TEXT NOT NULL,
  requested_lock_type  TEXT NOT NULL CHECK(requested_lock_type IN ('READ', 'EXCLUSIVE')),
  agent_id             TEXT NOT NULL,
  task_id              TEXT NOT NULL,
  enqueued_at          TEXT NOT NULL DEFAULT (datetime('now')),
  position             INTEGER NOT NULL,
  notified             INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_queue_file  ON lock_queue(file_path);
CREATE INDEX IF NOT EXISTS idx_queue_agent ON lock_queue(agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_unique ON lock_queue(file_path, agent_id, task_id);
`

interface LockRow {
  id: number
  file_path: string
  lock_type: string
  agent_id: string
  task_id: string
  acquired_at: string
  last_heartbeat: string
  ttl_seconds: number
}

interface QueueRow {
  id: number
  file_path: string
  requested_lock_type: string
  agent_id: string
  task_id: string
  enqueued_at: string
  position: number
  notified: number
}

export interface LockResult {
  granted: Record<string, string>   // filePath → lockType
  queued: Record<string, { position: number; waitingBehind: string[] }>
}

/** Agents that received a lock from the queue after a release */
export interface PromotedLock {
  agentId: string
  filePath: string
  lockType: string
}

/** Contention notice to send to current lock owners */
export interface ContentionNotice {
  ownerAgentId: string
  filePath: string
  waitingAgentId: string
  waitingAgentRole?: string
  queuePosition: number
}

export class FileLockRegistry {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.db.addSchema(LOCK_SCHEMA)
  }

  /**
   * Batch lock declaration (hive_declare_files).
   * Returns what was granted immediately and what was queued.
   * Also returns contention notices to dispatch.
   */
  declare(
    agentId: string,
    taskId: string,
    filesMap: Record<string, 'READ' | 'EXCLUSIVE' | 'SOFT'>,
  ): { result: LockResult; contention: ContentionNotice[] } {
    const result: LockResult = { granted: {}, queued: {} }
    const contention: ContentionNotice[] = []

    this.db.transaction(() => {
      for (const [filePath, lockType] of Object.entries(filesMap)) {
        const r = this.acquireOne(agentId, taskId, filePath, lockType)
        if (r.granted) {
          result.granted[filePath] = lockType
        } else if (r.queued) {
          result.queued[filePath] = r.queued
          for (const ownerAgentId of r.queued.waitingBehind) {
            contention.push({
              ownerAgentId,
              filePath,
              waitingAgentId: agentId,
              queuePosition: r.queued.position,
            })
          }
        }
      }
    })

    return { result, contention }
  }

  /**
   * Single lock request (hive_request_lock).
   */
  request(
    agentId: string,
    taskId: string,
    filePath: string,
    lockType: 'READ' | 'EXCLUSIVE' | 'SOFT',
  ): { result: LockResult; contention: ContentionNotice[] } {
    return this.declare(agentId, taskId, { [filePath]: lockType })
  }

  /**
   * Release locks for an agent/task.
   * filePaths = undefined → release ALL locks for this agent+task.
   * Returns list of agents promoted from queue (need lock_granted events).
   */
  release(
    agentId: string,
    taskId: string,
    filePaths?: string[],
  ): { released: string[]; promoted: PromotedLock[] } {
    const targets = filePaths ?? this.getFilePathsForAgentTask(agentId, taskId)

    const released: string[] = []
    const promoted: PromotedLock[] = []

    this.db.transaction(() => {
      for (const filePath of targets) {
        const deleted = this.db.prepare(`
          DELETE FROM file_locks
          WHERE file_path = ? AND agent_id = ? AND task_id = ?
        `).run(filePath, agentId, taskId)

        if ((deleted as { changes: number }).changes > 0) {
          released.push(filePath)
          const newLocks = this.promoteFromQueue(filePath)
          promoted.push(...newLocks)
        }
      }
    })

    return { released, promoted }
  }

  /**
   * Release ALL locks for an agent across all tasks (used on agent offline).
   */
  releaseAllForAgent(agentId: string): PromotedLock[] {
    const locks = this.db.prepare(`
      SELECT DISTINCT file_path, task_id FROM file_locks WHERE agent_id = ?
    `).all(agentId) as unknown as Array<{ file_path: string; task_id: string }>

    const promoted: PromotedLock[] = []

    this.db.transaction(() => {
      // Also remove from queue
      this.db.prepare(`DELETE FROM lock_queue WHERE agent_id = ?`).run(agentId)

      for (const { file_path, task_id } of locks) {
        this.db.prepare(`
          DELETE FROM file_locks WHERE file_path = ? AND agent_id = ? AND task_id = ?
        `).run(file_path, agentId, task_id)

        const newLocks = this.promoteFromQueue(file_path)
        promoted.push(...newLocks)
      }
    })

    return promoted
  }

  /**
   * Reset TTL heartbeat for all active locks of an agent.
   * Called on hive_heartbeat.
   */
  refreshHeartbeat(agentId: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE file_locks SET last_heartbeat = ? WHERE agent_id = ?
    `).run(now, agentId)
  }

  getLocksForAgent(agentId: string): LockRow[] {
    return this.db.prepare(
      'SELECT * FROM file_locks WHERE agent_id = ?',
    ).all(agentId) as unknown as LockRow[]
  }

  getLocksForFile(filePath: string): LockRow[] {
    return this.db.prepare(
      'SELECT * FROM file_locks WHERE file_path = ?',
    ).all(filePath) as unknown as LockRow[]
  }

  getAllLocks(): LockRow[] {
    return this.db.prepare('SELECT * FROM file_locks ORDER BY acquired_at ASC').all() as unknown as LockRow[]
  }

  getAllQueued(): QueueRow[] {
    return this.db.prepare('SELECT * FROM lock_queue ORDER BY file_path ASC, position ASC').all() as unknown as QueueRow[]
  }

  hasActiveLocks(agentId: string): boolean {
    const row = this.db.prepare(
      'SELECT COUNT(*) as n FROM file_locks WHERE agent_id = ?',
    ).get(agentId) as { n: number }
    return row.n > 0
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Try to acquire a single lock. Returns granted=true or queued info.
   * Must be called inside a transaction.
   */
  private acquireOne(
    agentId: string,
    taskId: string,
    filePath: string,
    lockType: 'READ' | 'EXCLUSIVE' | 'SOFT',
  ): { granted: true } | { granted: false; queued: { position: number; waitingBehind: string[] } } {
    const now = new Date().toISOString()

    // Rule 1: SOFT is always granted
    if (lockType === 'SOFT') {
      this.db.prepare(`
        INSERT INTO file_locks (file_path, lock_type, agent_id, task_id, acquired_at, last_heartbeat)
        VALUES (?, 'SOFT', ?, ?, ?, ?)
        ON CONFLICT(file_path, agent_id, task_id) DO UPDATE SET
          lock_type = 'SOFT', last_heartbeat = excluded.last_heartbeat
      `).run(filePath, agentId, taskId, now, now)
      return { granted: true }
    }

    // Get locks from OTHER agents on this file
    const othersLocks = this.db.prepare(`
      SELECT * FROM file_locks
      WHERE file_path = ? AND NOT (agent_id = ? AND task_id = ?)
    `).all(filePath, agentId, taskId) as unknown as LockRow[]

    // Rule 6: same agent+task → update existing lock
    const ownLock = this.db.prepare(`
      SELECT * FROM file_locks WHERE file_path = ? AND agent_id = ? AND task_id = ?
    `).get(filePath, agentId, taskId) as LockRow | undefined

    if (ownLock) {
      // Upgrading own lock
      this.db.prepare(`
        UPDATE file_locks SET lock_type = ?, last_heartbeat = ? WHERE id = ?
      `).run(lockType, now, ownLock.id)
      return { granted: true }
    }

    if (lockType === 'READ') {
      // Rule 2: READ is compatible with other READs
      // Rule 4: READ must wait if there's an EXCLUSIVE
      const exclusives = othersLocks.filter(l => l.lock_type === 'EXCLUSIVE')
      if (exclusives.length === 0) {
        this.db.prepare(`
          INSERT INTO file_locks (file_path, lock_type, agent_id, task_id, acquired_at, last_heartbeat)
          VALUES (?, 'READ', ?, ?, ?, ?)
        `).run(filePath, agentId, taskId, now, now)
        return { granted: true }
      }
      // Queue it
      const position = this.enqueue(filePath, 'READ', agentId, taskId)
      return {
        granted: false,
        queued: { position, waitingBehind: exclusives.map(l => l.agent_id) },
      }
    }

    // EXCLUSIVE: Rule 3 + Rule 5 — blocked by READ or EXCLUSIVE from others; SOFT is transparent
    const blockingLocks = othersLocks.filter(l => l.lock_type !== 'SOFT')
    if (blockingLocks.length === 0) {
      this.db.prepare(`
        INSERT INTO file_locks (file_path, lock_type, agent_id, task_id, acquired_at, last_heartbeat)
        VALUES (?, 'EXCLUSIVE', ?, ?, ?, ?)
      `).run(filePath, agentId, taskId, now, now)
      return { granted: true }
    }

    const position = this.enqueue(filePath, 'EXCLUSIVE', agentId, taskId)
    return {
      granted: false,
      queued: { position, waitingBehind: [...new Set(blockingLocks.map(l => l.agent_id))] },
    }
  }

  /**
   * Insert into lock_queue at the next position.
   * Returns position assigned.
   */
  private enqueue(
    filePath: string,
    lockType: 'READ' | 'EXCLUSIVE',
    agentId: string,
    taskId: string,
  ): number {
    const countRow = this.db.prepare(
      'SELECT COUNT(*) as n FROM lock_queue WHERE file_path = ?',
    ).get(filePath) as { n: number }

    const position = countRow.n + 1
    const now = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO lock_queue (file_path, requested_lock_type, agent_id, task_id, enqueued_at, position)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, agent_id, task_id) DO NOTHING
    `).run(filePath, lockType, agentId, taskId, now, position)

    return position
  }

  /**
   * After a lock release, try to promote the next waiting agent(s) from the queue.
   * Must be called inside a transaction.
   */
  private promoteFromQueue(filePath: string): PromotedLock[] {
    const promoted: PromotedLock[] = []
    const now = new Date().toISOString()

    while (true) {
      const next = this.db.prepare(`
        SELECT * FROM lock_queue WHERE file_path = ? ORDER BY position ASC LIMIT 1
      `).get(filePath) as QueueRow | undefined

      if (!next) break

      // Check if grantable with current remaining locks
      const remaining = this.db.prepare(`
        SELECT * FROM file_locks
        WHERE file_path = ? AND NOT (agent_id = ? AND task_id = ?)
      `).all(filePath, next.agent_id, next.task_id) as unknown as LockRow[]

      const canGrant = this.isCompatible(next.requested_lock_type as 'READ' | 'EXCLUSIVE', remaining)
      if (!canGrant) break

      // Grant it
      this.db.prepare(`DELETE FROM lock_queue WHERE id = ?`).run(next.id)
      this.db.prepare(`
        UPDATE lock_queue SET position = position - 1 WHERE file_path = ? AND position > ?
      `).run(filePath, next.position)
      this.db.prepare(`
        INSERT INTO file_locks (file_path, lock_type, agent_id, task_id, acquired_at, last_heartbeat)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(filePath, next.requested_lock_type, next.agent_id, next.task_id, now, now)

      promoted.push({ agentId: next.agent_id, filePath, lockType: next.requested_lock_type })

      // If it was a READ, try to also grant consecutive READs right behind it
      if (next.requested_lock_type !== 'READ') break
      // Loop continues — will grant next READ if compatible
    }

    return promoted
  }

  /**
   * Can the requested lock type be granted given the existing locks on that file?
   * Note: existingLocks should exclude the requesting agent's own locks.
   */
  private isCompatible(requestedType: 'READ' | 'EXCLUSIVE', existingLocks: LockRow[]): boolean {
    if (requestedType === 'READ') {
      // Compatible unless there's an EXCLUSIVE
      return !existingLocks.some(l => l.lock_type === 'EXCLUSIVE')
    }
    // EXCLUSIVE requires no other locks at all (ignoring SOFT)
    return existingLocks.filter(l => l.lock_type !== 'SOFT').length === 0
  }

  private getFilePathsForAgentTask(agentId: string, taskId: string): string[] {
    const rows = this.db.prepare(`
      SELECT file_path FROM file_locks WHERE agent_id = ? AND task_id = ?
    `).all(agentId, taskId) as unknown as Array<{ file_path: string }>
    return rows.map(r => r.file_path)
  }
}
