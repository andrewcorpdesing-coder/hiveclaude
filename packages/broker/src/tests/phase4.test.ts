/**
 * Phase 4 integration tests — FileLockRegistry
 * Tests the locking matrix, queue promotion, TTL release on disconnect.
 * Run with: node --test packages/broker/dist/tests/phase4.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Database } from '../db/Database.js'
import { AgentRegistry } from '../agents/AgentRegistry.js'
import { HttpServer } from '../mcp/HttpServer.js'

const TEST_PORT = 7437
const BASE = `http://localhost:${TEST_PORT}`

async function post(sessionId: string, tool: string, params: Record<string, unknown>) {
  const res = await fetch(`${BASE}/message?sessionId=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: Math.floor(Math.random() * 10000),
      method: 'tools/call',
      params: { name: tool, arguments: params },
    }),
  })
  return res.status
}

function openSse(): Promise<{ sessionId: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const close = () => { try { controller.abort() } catch { /* ignore */ } }
    fetch(`${BASE}/sse`, { signal: controller.signal })
      .then(async (res) => {
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let resolved = false
        const read = async (): Promise<void> => {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buf += decoder.decode(value, { stream: true })
              const lines = buf.split('\n'); buf = lines.pop() ?? ''
              for (const line of lines) {
                if (line.startsWith('data: ') && !resolved) {
                  const m = line.slice(6).trim().match(/sessionId=([a-f0-9-]+)/)
                  if (m) { resolved = true; resolve({ sessionId: m[1], close }) }
                }
              }
            }
          } catch (err) { if ((err as Error).name !== 'AbortError') throw err }
        }
        void read()
      })
      .catch((err: Error) => { if (err.name !== 'AbortError') reject(err) })
  })
}

describe('Phase 4 — FileLockRegistry', () => {
  let db: Database
  let registry: AgentRegistry
  let server: HttpServer

  before(async () => {
    db = new Database(`.hive/test-phase4-${Date.now()}.db`)
    registry = new AgentRegistry(db)
    server = new HttpServer({ db, agentRegistry: registry, port: TEST_PORT })
    server.start()
    await new Promise(r => setTimeout(r, 100))
  })

  after(async () => {
    await server.stop()
    registry.destroy()
    db.close()
  })

  // ── SOFT locks ──────────────────────────────────────────────────────────────

  it('SOFT lock is always granted immediately', async () => {
    const lr = server.getFileLockRegistry()
    const result = lr.declare('agent-soft', 'task-1', { 'src/config.ts': 'SOFT' })
    assert.equal(result.result.granted['src/config.ts'], 'SOFT')
    assert.equal(Object.keys(result.result.queued).length, 0)
  })

  it('SOFT lock does not block EXCLUSIVE from another agent', async () => {
    const lr = server.getFileLockRegistry()
    lr.declare('agent-soft2', 'task-2', { 'src/utils.ts': 'SOFT' })
    const result = lr.declare('agent-excl', 'task-3', { 'src/utils.ts': 'EXCLUSIVE' })
    assert.equal(result.result.granted['src/utils.ts'], 'EXCLUSIVE')
    assert.equal(Object.keys(result.result.queued).length, 0)
  })

  // ── READ locks ──────────────────────────────────────────────────────────────

  it('multiple READ locks coexist on the same file', async () => {
    const lr = server.getFileLockRegistry()
    const r1 = lr.declare('reader-1', 'task-r1', { 'src/shared.ts': 'READ' })
    const r2 = lr.declare('reader-2', 'task-r2', { 'src/shared.ts': 'READ' })
    const r3 = lr.declare('reader-3', 'task-r3', { 'src/shared.ts': 'READ' })

    assert.equal(r1.result.granted['src/shared.ts'], 'READ')
    assert.equal(r2.result.granted['src/shared.ts'], 'READ')
    assert.equal(r3.result.granted['src/shared.ts'], 'READ')
  })

  it('EXCLUSIVE blocks a READ — READ goes to queue', async () => {
    const lr = server.getFileLockRegistry()
    const exclusive = lr.declare('excl-agent', 'task-e1', { 'src/blocked.ts': 'EXCLUSIVE' })
    assert.equal(exclusive.result.granted['src/blocked.ts'], 'EXCLUSIVE')

    const readAttempt = lr.declare('read-agent', 'task-r4', { 'src/blocked.ts': 'READ' })
    assert.equal(Object.keys(readAttempt.result.granted).length, 0)
    assert.ok(readAttempt.result.queued['src/blocked.ts'])
    assert.equal(readAttempt.result.queued['src/blocked.ts'].position, 1)
    assert.deepEqual(readAttempt.result.queued['src/blocked.ts'].waitingBehind, ['excl-agent'])
  })

  it('READ blocks an EXCLUSIVE — EXCLUSIVE goes to queue', async () => {
    const lr = server.getFileLockRegistry()
    const read = lr.declare('read-first', 'task-rf', { 'src/contested.ts': 'READ' })
    assert.equal(read.result.granted['src/contested.ts'], 'READ')

    const excl = lr.declare('excl-waiter', 'task-ew', { 'src/contested.ts': 'EXCLUSIVE' })
    assert.equal(Object.keys(excl.result.granted).length, 0)
    assert.ok(excl.result.queued['src/contested.ts'])
    assert.equal(excl.result.queued['src/contested.ts'].waitingBehind[0], 'read-first')
  })

  // ── Queue promotion ─────────────────────────────────────────────────────────

  it('releasing EXCLUSIVE promotes queued READ', async () => {
    const lr = server.getFileLockRegistry()
    const file = 'src/promote-test.ts'

    lr.declare('holder', 'task-h', { [file]: 'EXCLUSIVE' })
    lr.declare('waiter', 'task-w', { [file]: 'READ' })

    assert.equal(lr.getLocksForAgent('waiter').length, 0, 'waiter has no lock yet')

    const { released, promoted } = lr.release('holder', 'task-h', [file])
    assert.equal(released.length, 1)
    assert.equal(promoted.length, 1)
    assert.equal(promoted[0].agentId, 'waiter')
    assert.equal(promoted[0].lockType, 'READ')

    assert.equal(lr.getLocksForAgent('waiter').length, 1, 'waiter now holds the lock')
  })

  it('releasing EXCLUSIVE promotes multiple consecutive READs', async () => {
    const lr = server.getFileLockRegistry()
    const file = 'src/multi-read-promote.ts'

    lr.declare('excl-holder', 'task-exc', { [file]: 'EXCLUSIVE' })
    lr.declare('read-wait-1', 'task-rw1', { [file]: 'READ' })
    lr.declare('read-wait-2', 'task-rw2', { [file]: 'READ' })
    lr.declare('read-wait-3', 'task-rw3', { [file]: 'READ' })

    const { promoted } = lr.release('excl-holder', 'task-exc', [file])
    assert.equal(promoted.length, 3, 'All 3 waiting READs should be promoted')

    const promotedIds = promoted.map(p => p.agentId).sort()
    assert.deepEqual(promotedIds, ['read-wait-1', 'read-wait-2', 'read-wait-3'].sort())
  })

  it('EXCLUSIVE in queue waits for all READs to release', async () => {
    const lr = server.getFileLockRegistry()
    const file = 'src/excl-wait.ts'

    lr.declare('reader-a', 'task-ra', { [file]: 'READ' })
    lr.declare('reader-b', 'task-rb', { [file]: 'READ' })
    const exclResult = lr.declare('excl-queued', 'task-eq', { [file]: 'EXCLUSIVE' })

    assert.ok(exclResult.result.queued[file], 'EXCLUSIVE should be queued')

    // Release one reader — EXCLUSIVE still can't get it
    const after1 = lr.release('reader-a', 'task-ra', [file])
    assert.equal(after1.promoted.length, 0, 'EXCLUSIVE should still wait for reader-b')

    // Release second reader — EXCLUSIVE can now be granted
    const after2 = lr.release('reader-b', 'task-rb', [file])
    assert.equal(after2.promoted.length, 1)
    assert.equal(after2.promoted[0].agentId, 'excl-queued')
    assert.equal(after2.promoted[0].lockType, 'EXCLUSIVE')
  })

  // ── hasActiveLocks ──────────────────────────────────────────────────────────

  it('hasActiveLocks reflects current lock state', async () => {
    const lr = server.getFileLockRegistry()
    lr.declare('lock-checker', 'task-lc', { 'src/checker.ts': 'READ' })
    assert.equal(lr.hasActiveLocks('lock-checker'), true)

    lr.release('lock-checker', 'task-lc')
    assert.equal(lr.hasActiveLocks('lock-checker'), false)
  })

  // ── releaseAllForAgent ──────────────────────────────────────────────────────

  it('releaseAllForAgent releases all locks and promotes queue', async () => {
    const lr = server.getFileLockRegistry()
    const f1 = 'src/offline-a.ts'
    const f2 = 'src/offline-b.ts'

    lr.declare('offline-agent', 'task-off', { [f1]: 'EXCLUSIVE', [f2]: 'EXCLUSIVE' })
    lr.declare('waiting-for-a', 'task-wa', { [f1]: 'READ' })
    lr.declare('waiting-for-b', 'task-wb', { [f2]: 'READ' })

    // Simulate agent going offline
    const promoted = lr.releaseAllForAgent('offline-agent')
    assert.equal(promoted.length, 2)

    const promotedIds = promoted.map(p => p.agentId).sort()
    assert.deepEqual(promotedIds, ['waiting-for-a', 'waiting-for-b'].sort())

    assert.equal(lr.hasActiveLocks('offline-agent'), false)
  })

  // ── hive_declare_files tool (via HTTP) ─────────────────────────────────────

  it('hive_declare_files tool grants locks via SSE transport', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))

      await post(sessionId, 'hive_register', { agent_id: 'tool-agent-1', role: 'coder-backend' })
      await new Promise(r => setTimeout(r, 100))

      const status = await post(sessionId, 'hive_declare_files', {
        agent_id: 'tool-agent-1',
        task_id: 'tool-task-1',
        files: { 'src/api.ts': 'EXCLUSIVE', 'src/types.ts': 'READ' },
      })
      assert.equal(status, 202)
      await new Promise(r => setTimeout(r, 100))

      const lr = server.getFileLockRegistry()
      const locks = lr.getLocksForAgent('tool-agent-1')
      assert.equal(locks.length, 2)
    } finally {
      close()
    }
  })

  it('agent offline via SSE disconnect releases all locks', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 100))

    await post(sessionId, 'hive_register', { agent_id: 'disconnect-agent', role: 'researcher' })
    await new Promise(r => setTimeout(r, 150))

    const lr = server.getFileLockRegistry()

    // Declare directly (bypassing tool) to ensure the lock is there regardless of agent check
    lr.declare('disconnect-agent', 'disc-task', { 'src/research.ts': 'EXCLUSIVE' })

    assert.equal(lr.hasActiveLocks('disconnect-agent'), true)

    close()  // disconnect SSE — triggers markOffline → releaseAllForAgent
    await new Promise(r => setTimeout(r, 400))

    assert.equal(lr.hasActiveLocks('disconnect-agent'), false, 'Locks should be released on disconnect')
  })

  // ── Same agent can update own lock ─────────────────────────────────────────

  it('same agent can upgrade READ to EXCLUSIVE on same file+task', async () => {
    const lr = server.getFileLockRegistry()
    const file = 'src/upgradeable.ts'

    lr.declare('upgrader', 'task-upg', { [file]: 'READ' })
    assert.equal(lr.getLocksForAgent('upgrader')[0].lock_type, 'READ')

    lr.declare('upgrader', 'task-upg', { [file]: 'EXCLUSIVE' })
    assert.equal(lr.getLocksForAgent('upgrader')[0].lock_type, 'EXCLUSIVE')
  })
})
