/**
 * Phase 5 integration tests — Blackboard
 * Tests permission enforcement, read/write/append/merge operations,
 * persistence (atomic JSON file), and MCP tool access via HTTP.
 * Run with: node --test packages/broker/dist/tests/phase5.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Database } from '../db/Database.js'
import { AgentRegistry } from '../agents/AgentRegistry.js'
import { HttpServer } from '../mcp/HttpServer.js'
import { Blackboard } from '../blackboard/Blackboard.js'
import { BlackboardPermissions } from '../blackboard/BlackboardPermissions.js'

const TEST_PORT = 7438
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

// ── BlackboardPermissions unit tests ─────────────────────────────────────────

describe('Phase 5 — BlackboardPermissions (unit)', () => {
  const perms = new BlackboardPermissions()

  it('orchestrator can set project.meta', () => {
    const r = perms.canWrite('orch-1', 'orchestrator', 'project.meta', 'set')
    assert.equal(r.allowed, true)
  })

  it('coder cannot set project.meta', () => {
    const r = perms.canWrite('coder-1', 'coder-backend', 'project.meta', 'set')
    assert.equal(r.allowed, false)
  })

  it('architect can set project.architecture', () => {
    const r = perms.canWrite('arch-1', 'architect', 'project.architecture', 'set')
    assert.equal(r.allowed, true)
  })

  it('coder cannot set project.architecture', () => {
    const r = perms.canWrite('coder-1', 'coder-backend', 'project.architecture', 'set')
    assert.equal(r.allowed, false)
  })

  it('any agent can append to knowledge.discoveries', () => {
    for (const role of ['coder-backend', 'coder-frontend', 'researcher', 'architect']) {
      const r = perms.canWrite('x', role, 'knowledge.discoveries', 'append')
      assert.equal(r.allowed, true, `${role} should be allowed`)
    }
  })

  it('set is denied on knowledge.discoveries — must use append', () => {
    const r = perms.canWrite('x', 'researcher', 'knowledge.discoveries', 'set')
    assert.equal(r.allowed, false)
    assert.deepEqual(r.allowedOperations, ['append'])
  })

  it('merge is required for knowledge.external_apis', () => {
    const r = perms.canWrite('x', 'researcher', 'knowledge.external_apis', 'set')
    assert.equal(r.allowed, false)
    assert.deepEqual(r.allowedOperations, ['merge'])

    const ok = perms.canWrite('x', 'researcher', 'knowledge.external_apis', 'merge')
    assert.equal(ok.allowed, true)
  })

  it('all agents can append to state.blockers', () => {
    const r = perms.canWrite('x', 'coder-backend', 'state.blockers', 'append')
    assert.equal(r.allowed, true)
  })

  it('set is denied on state.blockers', () => {
    const r = perms.canWrite('x', 'coder-backend', 'state.blockers', 'set')
    assert.equal(r.allowed, false)
  })

  it('orchestrator can set state.sprint', () => {
    const r = perms.canWrite('orch-1', 'orchestrator', 'state.sprint', 'set')
    assert.equal(r.allowed, true)
  })

  it('coder cannot write state.sprint', () => {
    const r = perms.canWrite('coder-1', 'coder-backend', 'state.sprint', 'set')
    assert.equal(r.allowed, false)
  })

  it('agent can write its own agents section', () => {
    const r = perms.canWrite('agent-42', 'coder-backend', 'agents.agent-42.status', 'set')
    assert.equal(r.allowed, true)
  })

  it('agent cannot write another agent\'s section', () => {
    const r = perms.canWrite('agent-42', 'coder-backend', 'agents.agent-99.status', 'set')
    assert.equal(r.allowed, false)
  })

  it('reviewer can append to qa.findings', () => {
    const r = perms.canWrite('rev-1', 'reviewer', 'qa.findings', 'append')
    assert.equal(r.allowed, true)
  })

  it('non-reviewer cannot write qa.findings', () => {
    const r = perms.canWrite('coder-1', 'coder-backend', 'qa.findings', 'append')
    assert.equal(r.allowed, false)
  })

  it('qa.pending_review denied to non-orchestrator/reviewer for read', () => {
    assert.equal(perms.canRead('coder-backend', 'qa.pending_review'), false)
    assert.equal(perms.canRead('orchestrator', 'qa.pending_review'), true)
    assert.equal(perms.canRead('reviewer', 'qa.pending_review'), true)
  })
})

// ── Blackboard class tests ────────────────────────────────────────────────────

describe('Phase 5 — Blackboard (in-memory + persistence)', () => {
  const dir = `.hive/test-bb-${Date.now()}`

  after(() => {
    try { fs.rmSync(dir, { recursive: true }) } catch { /* ignore */ }
  })

  it('starts with default structure', () => {
    const bb = new Blackboard(dir)
    assert.deepEqual(bb.getAt('knowledge.discoveries'), [])
    assert.deepEqual(bb.getAt('state.blockers'), [])
    assert.equal(bb.getAt('state.sprint'), null)
  })

  it('set operation replaces value', () => {
    const bb = new Blackboard(dir)
    bb.write('orch-1', 'orchestrator', 'project.meta', { name: 'Hive' }, 'set')
    assert.deepEqual(bb.getAt('project.meta'), { name: 'Hive' })
  })

  it('append operation adds to array', () => {
    const bb = new Blackboard(dir)
    bb.write('res-1', 'researcher', 'knowledge.discoveries', 'first', 'append')
    bb.write('res-1', 'researcher', 'knowledge.discoveries', 'second', 'append')
    assert.deepEqual(bb.getAt('knowledge.discoveries'), ['first', 'second'])
  })

  it('merge operation merges objects', () => {
    const bb = new Blackboard(dir)
    bb.write('res-1', 'researcher', 'knowledge.external_apis', { stripe: 'v3' }, 'merge')
    bb.write('res-1', 'researcher', 'knowledge.external_apis', { sendgrid: 'v2' }, 'merge')
    const apis = bb.getAt('knowledge.external_apis') as Record<string, string>
    assert.equal(apis.stripe, 'v3')
    assert.equal(apis.sendgrid, 'v2')
  })

  it('persists to disk and reloads', () => {
    const dir2 = `.hive/test-bb-reload-${Date.now()}`
    try {
      const bb1 = new Blackboard(dir2)
      bb1.write('orch-1', 'orchestrator', 'project.meta', { version: '1.0' }, 'set')

      // New instance should reload from file
      const bb2 = new Blackboard(dir2)
      assert.deepEqual(bb2.getAt('project.meta'), { version: '1.0' })
    } finally {
      try { fs.rmSync(dir2, { recursive: true }) } catch { /* ignore */ }
    }
  })

  it('permission denied returns allowed: false', () => {
    const bb = new Blackboard(dir)
    const result = bb.write('coder-1', 'coder-backend', 'project.meta', { x: 1 }, 'set')
    assert.equal(result.allowed, false)
  })

  it('read denied for qa.pending_review by non-reviewer', () => {
    const bb = new Blackboard(dir)
    const result = bb.read('coder-backend', 'qa.pending_review')
    assert.equal(result.ok, false)
  })

  it('read allowed for qa.pending_review by reviewer', () => {
    const bb = new Blackboard(dir)
    const result = bb.read('reviewer', 'qa.pending_review')
    assert.equal(result.ok, true)
  })
})

// ── HTTP tool integration tests ───────────────────────────────────────────────

describe('Phase 5 — Blackboard MCP tools (HTTP)', () => {
  let db: Database
  let registry: AgentRegistry
  let server: HttpServer

  before(async () => {
    db = new Database(`.hive/test-phase5-${Date.now()}.db`)
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

  it('hive_blackboard_write and hive_blackboard_read via SSE', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))

      await post(sessionId, 'hive_register', { agent_id: 'orch-http', role: 'orchestrator' })
      await new Promise(r => setTimeout(r, 100))

      const writeStatus = await post(sessionId, 'hive_blackboard_write', {
        agent_id: 'orch-http',
        path: 'project.meta',
        value: { name: 'Hive Mind', version: '0.1' },
        operation: 'set',
      })
      assert.equal(writeStatus, 202)
      await new Promise(r => setTimeout(r, 50))

      const bb = server.getBlackboard()
      assert.deepEqual(bb.getAt('project.meta'), { name: 'Hive Mind', version: '0.1' })

      const readStatus = await post(sessionId, 'hive_blackboard_read', {
        agent_id: 'orch-http',
        path: 'project.meta',
      })
      assert.equal(readStatus, 202)
    } finally {
      close()
    }
  })

  it('hive_blackboard_write denied for coder writing project.meta', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'coder-http', role: 'coder-backend' })
      await new Promise(r => setTimeout(r, 100))

      const status = await post(sessionId, 'hive_blackboard_write', {
        agent_id: 'coder-http',
        path: 'project.meta',
        value: { hack: true },
        operation: 'set',
      })
      assert.equal(status, 202)  // MCP always returns 202; error is in body
      await new Promise(r => setTimeout(r, 50))

      // Verify the blackboard was NOT modified (it was set by orch-http above)
      const bb = server.getBlackboard()
      assert.equal((bb.getAt('project.meta') as Record<string, unknown>)?.hack, undefined)
    } finally {
      close()
    }
  })

  it('coder can append to knowledge.discoveries via tool', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'coder-discover', role: 'coder-backend' })
      await new Promise(r => setTimeout(r, 100))

      const status = await post(sessionId, 'hive_blackboard_write', {
        agent_id: 'coder-discover',
        path: 'knowledge.discoveries',
        value: 'Found that X causes Y',
        operation: 'append',
      })
      assert.equal(status, 202)
      await new Promise(r => setTimeout(r, 50))

      const bb = server.getBlackboard()
      const discoveries = bb.getAt('knowledge.discoveries') as unknown[]
      assert.ok(Array.isArray(discoveries))
      assert.ok(discoveries.includes('Found that X causes Y'))
    } finally {
      close()
    }
  })
})
