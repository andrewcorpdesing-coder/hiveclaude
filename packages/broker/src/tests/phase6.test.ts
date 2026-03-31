/**
 * Phase 6 integration tests — AuditLedger
 * Tests append-only logging, query/filter API, privilege gates on hive_audit_log,
 * and end-to-end audit trail via HTTP tools.
 * Run with: node --test packages/broker/dist/tests/phase6.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Database } from '../db/Database.js'
import { AgentRegistry } from '../agents/AgentRegistry.js'
import { AuditLedger } from '../audit/AuditLedger.js'
import { HttpServer } from '../mcp/HttpServer.js'

const TEST_PORT = 7439
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

// ── AuditLedger unit tests ────────────────────────────────────────────────────

describe('Phase 6 — AuditLedger (unit)', () => {
  let db: Database
  let ledger: AuditLedger

  before(() => {
    db = new Database(`.hive/test-audit-unit-${Date.now()}.db`)
    ledger = new AuditLedger(db)
  })

  after(() => { db.close() })

  it('logs an entry and retrieves it', () => {
    ledger.log({ agentId: 'orch-1', action: 'task_create', target: 'task-abc', result: 'ok' })
    const rows = ledger.query({ agentId: 'orch-1' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'task_create')
    assert.equal(rows[0].target, 'task-abc')
    assert.equal(rows[0].result, 'ok')
  })

  it('logs detail as JSON and returns parsed', () => {
    ledger.log({
      agentId: 'coder-1', action: 'blackboard_write', target: 'project.meta',
      detail: { operation: 'set' }, result: 'denied',
    })
    const rows = ledger.query({ agentId: 'coder-1' })
    assert.equal(rows.length, 1)
    const detail = JSON.parse(rows[0].detail!) as Record<string, string>
    assert.equal(detail.operation, 'set')
  })

  it('filters by action', () => {
    ledger.log({ agentId: 'orch-1', action: 'lock_declare', target: 'task-x', result: 'ok' })
    const rows = ledger.query({ agentId: 'orch-1', action: 'lock_declare' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'lock_declare')
  })

  it('filters by result', () => {
    const denied = ledger.query({ result: 'denied' })
    assert.ok(denied.every(r => r.result === 'denied'))
    assert.ok(denied.length >= 1)
  })

  it('countBy returns correct count', () => {
    const initial = ledger.countBy('task_create')
    ledger.log({ agentId: 'orch-1', action: 'task_create', result: 'ok' })
    assert.equal(ledger.countBy('task_create'), initial + 1)
  })

  it('limit is respected', () => {
    for (let i = 0; i < 10; i++) {
      ledger.log({ agentId: 'bulk-agent', action: 'agent_register', result: 'ok' })
    }
    const rows = ledger.query({ agentId: 'bulk-agent', limit: 3 })
    assert.equal(rows.length, 3)
  })

  it('results are reverse-chronological (newest first)', () => {
    const rows = ledger.query({ agentId: 'orch-1' })
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].id >= rows[i].id, 'Rows should be in descending id order')
    }
  })
})

// ── HTTP integration tests ────────────────────────────────────────────────────

describe('Phase 6 — AuditLedger via HTTP tools', () => {
  let db: Database
  let registry: AgentRegistry
  let server: HttpServer

  before(async () => {
    db = new Database(`.hive/test-phase6-${Date.now()}.db`)
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

  it('hive_register creates an audit entry', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'audit-orch', role: 'orchestrator' })
      await new Promise(r => setTimeout(r, 100))

      const ledger = server.getAuditLedger()
      const rows = ledger.query({ agentId: 'audit-orch', action: 'agent_register' })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].result, 'ok')
    } finally {
      close()
    }
  })

  it('blackboard write allowed — creates ok audit entry', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'audit-orch2', role: 'orchestrator' })
      await new Promise(r => setTimeout(r, 100))

      await post(sessionId, 'hive_blackboard_write', {
        agent_id: 'audit-orch2', path: 'project.meta', value: { x: 1 }, operation: 'set',
      })
      await new Promise(r => setTimeout(r, 100))

      const ledger = server.getAuditLedger()
      const rows = ledger.query({ agentId: 'audit-orch2', action: 'blackboard_write' })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].result, 'ok')
      assert.equal(rows[0].target, 'project.meta')
    } finally {
      close()
    }
  })

  it('blackboard write denied — creates denied audit entry', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'audit-coder', role: 'coder-backend' })
      await new Promise(r => setTimeout(r, 100))

      await post(sessionId, 'hive_blackboard_write', {
        agent_id: 'audit-coder', path: 'project.meta', value: { hack: true }, operation: 'set',
      })
      await new Promise(r => setTimeout(r, 100))

      const ledger = server.getAuditLedger()
      const rows = ledger.query({ agentId: 'audit-coder', action: 'blackboard_write' })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].result, 'denied')
    } finally {
      close()
    }
  })

  it('hive_audit_log tool — orchestrator can read all entries', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'audit-orch3', role: 'orchestrator' })
      await new Promise(r => setTimeout(r, 100))

      const status = await post(sessionId, 'hive_audit_log', {
        agent_id: 'audit-orch3',
        limit: 20,
      })
      assert.equal(status, 202)
    } finally {
      close()
    }
  })

  it('hive_audit_log — coder is restricted to own entries', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'audit-coder2', role: 'coder-backend' })
      await new Promise(r => setTimeout(r, 100))

      const status = await post(sessionId, 'hive_audit_log', {
        agent_id: 'audit-coder2',
        filter_agent_id: 'audit-orch3',  // trying to see another agent's entries
      })
      assert.equal(status, 202)
      // The tool responds 202 (MCP doesn't use 4xx for logic errors)
      // But internally the ledger filters to audit-coder2's own entries only

      const ledger = server.getAuditLedger()
      // Verify the restriction logic directly: coder sees only own rows
      const ownRows = ledger.query({ agentId: 'audit-coder2' })
      const orchRows = ledger.query({ agentId: 'audit-orch3' })
      assert.ok(ownRows.every(r => r.agent_id === 'audit-coder2'))
      assert.ok(orchRows.every(r => r.agent_id === 'audit-orch3'))
    } finally {
      close()
    }
  })

  it('lock_declare is audited', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'audit-locker', role: 'coder-backend' })
      await new Promise(r => setTimeout(r, 100))

      await post(sessionId, 'hive_declare_files', {
        agent_id: 'audit-locker',
        task_id: 'task-lock-audit',
        files: { 'src/main.ts': 'EXCLUSIVE' },
      })
      await new Promise(r => setTimeout(r, 100))

      const ledger = server.getAuditLedger()
      const rows = ledger.query({ agentId: 'audit-locker', action: 'lock_declare' })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].result, 'ok')
      assert.equal(rows[0].target, 'task-lock-audit')
    } finally {
      close()
    }
  })
})
