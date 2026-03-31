/**
 * Phase 8 integration tests — Admin API REST
 * Tests all /admin/* endpoints: agents, tasks, locks, blackboard, audit.
 * Uses plain fetch — no SSE needed.
 * Run with: node --test packages/broker/dist/tests/phase8.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Database } from '../db/Database.js'
import { AgentRegistry } from '../agents/AgentRegistry.js'
import { HttpServer } from '../mcp/HttpServer.js'

const TEST_PORT = 7441
const BASE = `http://localhost:${TEST_PORT}`

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function del(path: string) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function post(path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('Phase 8 — Admin API REST', () => {
  let db: Database
  let registry: AgentRegistry
  let server: HttpServer

  before(async () => {
    db = new Database(`.hive/test-phase8-${Date.now()}.db`)
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

  // ── /admin/agents ─────────────────────────────────────────────────────────

  it('GET /admin/agents returns all agents', async () => {
    registry.register({ agentId: 'admin-orch', role: 'orchestrator', skills: [] })
    registry.register({ agentId: 'admin-coder', role: 'coder-backend', skills: ['typescript'] })

    const { status, body } = await get('/admin/agents')
    assert.equal(status, 200)
    assert.ok((body.count as number) >= 2)
    const agents = body.agents as Array<{ id: string }>
    assert.ok(agents.some(a => a.id === 'admin-orch'))
    assert.ok(agents.some(a => a.id === 'admin-coder'))
  })

  it('GET /admin/agents?status=online returns only online agents', async () => {
    registry.register({ agentId: 'admin-online', role: 'researcher', skills: [] })
    registry.markOffline('admin-coder')

    const { status, body } = await get('/admin/agents?status=online')
    assert.equal(status, 200)
    const agents = body.agents as Array<{ id: string; status: string }>
    assert.ok(agents.every(a => a.status !== 'offline'))
    assert.ok(agents.some(a => a.id === 'admin-online'))
    assert.ok(!agents.some(a => a.id === 'admin-coder'))
  })

  it('DELETE /admin/agents/:id forces agent offline', async () => {
    registry.register({ agentId: 'admin-to-kill', role: 'devops', skills: [] })

    const { status, body } = await del('/admin/agents/admin-to-kill')
    assert.equal(status, 200)
    assert.equal(body.ok, true)

    const agent = registry.getById('admin-to-kill')
    assert.equal(agent?.status, 'offline')
  })

  it('DELETE /admin/agents/:id returns 404 for unknown agent', async () => {
    const { status } = await del('/admin/agents/ghost-agent')
    assert.equal(status, 404)
  })

  // ── /admin/tasks ──────────────────────────────────────────────────────────

  it('GET /admin/tasks returns all tasks', async () => {
    const ts = server.getTaskStore()
    ts.create({ title: 'Admin task 1', description: 'desc', createdBy: 'admin-orch' })
    ts.create({ title: 'Admin task 2', description: 'desc', createdBy: 'admin-orch' })

    const { status, body } = await get('/admin/tasks')
    assert.equal(status, 200)
    assert.ok((body.count as number) >= 2)
  })

  it('GET /admin/tasks?status=pending filters by status', async () => {
    const { status, body } = await get('/admin/tasks?status=pending')
    assert.equal(status, 200)
    const tasks = body.tasks as Array<{ status: string }>
    assert.ok(tasks.every(t => t.status === 'pending'))
  })

  it('GET /admin/tasks/:id returns single task', async () => {
    const ts = server.getTaskStore()
    const task = ts.create({ title: 'Specific task', description: 'desc', createdBy: 'admin-orch' })

    const { status, body } = await get(`/admin/tasks/${task.id}`)
    assert.equal(status, 200)
    assert.equal(body.id, task.id)
    assert.equal(body.title, 'Specific task')
  })

  it('GET /admin/tasks/:id returns 404 for unknown task', async () => {
    const { status } = await get('/admin/tasks/nonexistent-task-id')
    assert.equal(status, 404)
  })

  it('POST /admin/tasks/:id/force-complete bypasses QA', async () => {
    const ts = server.getTaskStore()
    const task = ts.create({ title: 'Force complete me', description: 'desc', createdBy: 'admin-orch' })

    const { status, body } = await post(`/admin/tasks/${task.id}/force-complete`)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(ts.getById(task.id)!.status, 'completed')
  })

  // ── /admin/locks ──────────────────────────────────────────────────────────

  it('GET /admin/locks returns active and queued locks', async () => {
    const lr = server.getFileLockRegistry()
    lr.declare('admin-locker', 'task-adm', { 'src/admin.ts': 'EXCLUSIVE' })

    const { status, body } = await get('/admin/locks')
    assert.equal(status, 200)
    assert.ok('active' in body)
    assert.ok('queued' in body)
    const active = body.active as { count: number; locks: Array<{ agent_id: string }> }
    assert.ok(active.count >= 1)
    assert.ok(active.locks.some(l => l.agent_id === 'admin-locker'))
  })

  // ── /admin/blackboard ─────────────────────────────────────────────────────

  it('GET /admin/blackboard returns full snapshot', async () => {
    const bb = server.getBlackboard()
    bb.write('admin-orch', 'orchestrator', 'project.meta', { name: 'HiveMind' }, 'set')

    const { status, body } = await get('/admin/blackboard')
    assert.equal(status, 200)
    assert.ok('project' in body)
    assert.ok('knowledge' in body)
    assert.ok('state' in body)
    const project = body.project as { meta: { name: string } }
    assert.equal(project.meta.name, 'HiveMind')
  })

  // ── /admin/audit ──────────────────────────────────────────────────────────

  it('GET /admin/audit returns audit entries', async () => {
    const ledger = server.getAuditLedger()
    ledger.log({ agentId: 'admin-orch', action: 'task_create', target: 'task-x', result: 'ok' })

    const { status, body } = await get('/admin/audit')
    assert.equal(status, 200)
    assert.ok((body.count as number) >= 1)
  })

  it('GET /admin/audit?action=task_create filters by action', async () => {
    const { status, body } = await get('/admin/audit?action=task_create')
    assert.equal(status, 200)
    const entries = body.entries as Array<{ action: string }>
    assert.ok(entries.every(e => e.action === 'task_create'))
  })

  it('GET /admin/audit?agent_id=admin-orch filters by agent', async () => {
    const { status, body } = await get('/admin/audit?agent_id=admin-orch')
    assert.equal(status, 200)
    const entries = body.entries as Array<{ agent_id: string }>
    assert.ok(entries.every(e => e.agent_id === 'admin-orch'))
  })

  it('GET /admin/audit?result=denied filters denied entries', async () => {
    const ledger = server.getAuditLedger()
    ledger.log({ agentId: 'bad-actor', action: 'blackboard_write', result: 'denied' })

    const { status, body } = await get('/admin/audit?result=denied')
    assert.equal(status, 200)
    const entries = body.entries as Array<{ result: string; agent_id: string }>
    assert.ok(entries.every(e => e.result === 'denied'))
    assert.ok(entries.some(e => e.agent_id === 'bad-actor'))
  })

  // ── 404 for unknown admin route ───────────────────────────────────────────

  it('unknown /admin/* route returns 404', async () => {
    const { status } = await get('/admin/unknown-resource')
    assert.equal(status, 404)
  })
})
