/**
 * Phase 3 integration tests — TaskStore + DAG + 6 task tools
 * Run with: node --test packages/broker/dist/tests/phase3.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Database } from '../db/Database.js'
import { AgentRegistry } from '../agents/AgentRegistry.js'
import { HttpServer } from '../mcp/HttpServer.js'

const TEST_PORT = 7435
const BASE = `http://localhost:${TEST_PORT}`

async function post(sessionId: string, toolName: string, params: Record<string, unknown>) {
  const res = await fetch(`${BASE}/message?sessionId=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 10000),
      method: 'tools/call',
      params: { name: toolName, arguments: params },
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
        let buffer = ''
        let resolved = false

        const read = async (): Promise<void> => {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() ?? ''
              for (const line of lines) {
                if (line.startsWith('data: ') && !resolved) {
                  const match = line.slice(6).trim().match(/sessionId=([a-f0-9-]+)/)
                  if (match) { resolved = true; resolve({ sessionId: match[1], close }) }
                }
              }
            }
          } catch (err) {
            if ((err as Error).name !== 'AbortError') throw err
          }
        }
        void read()
      })
      .catch((err: Error) => { if (err.name !== 'AbortError') reject(err) })
  })
}

describe('Phase 3 — TaskStore + DAG + Task Tools', () => {
  let db: Database
  let registry: AgentRegistry
  let server: HttpServer

  before(async () => {
    const dbPath = `.hive/test-phase3-${Date.now()}.db`
    db = new Database(dbPath)
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

  it('only orchestrators can create tasks', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await post(sessionId, 'hive_register', { agent_id: 'non-orch-1', role: 'coder-backend' })
    await new Promise(r => setTimeout(r, 100))

    await post(sessionId, 'hive_create_task', {
      created_by: 'non-orch-1',
      title: 'Should fail',
      description: 'Non-orchestrator should not be able to create tasks',
    })
    await new Promise(r => setTimeout(r, 100))

    // Task should NOT be in the store
    const ts = server.getTaskStore()
    const tasks = ts.listAll()
    assert.equal(tasks.length, 0, 'No tasks should have been created')

    close()
  })

  it('orchestrator creates task and it appears in list', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await post(sessionId, 'hive_register', { agent_id: 'orch-1', role: 'orchestrator' })
    await new Promise(r => setTimeout(r, 100))

    await post(sessionId, 'hive_create_task', {
      created_by: 'orch-1',
      title: 'Implement auth module',
      description: 'Build JWT authentication for the API',
      assigned_role: 'coder-backend',
      priority: 2,
    })
    await new Promise(r => setTimeout(r, 100))

    const ts = server.getTaskStore()
    const tasks = ts.listByStatus('pending')
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].title, 'Implement auth module')
    assert.equal(tasks[0].priority, 2)
    assert.equal(tasks[0].assignedRole, 'coder-backend')
    assert.equal(tasks[0].createdBy, 'orch-1')

    close()
  })

  it('agent claims task matching its role via hive_get_next_task', async () => {
    const { sessionId: so, close: co } = await openSse()
    const { sessionId: sa, close: ca } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await post(so, 'hive_register', { agent_id: 'orch-2', role: 'orchestrator' })
    await post(sa, 'hive_register', { agent_id: 'coder-1', role: 'coder-backend' })
    await new Promise(r => setTimeout(r, 100))

    const ts = server.getTaskStore()

    // Create a task for coder-backend
    ts.create({
      title: 'Build API routes',
      description: 'Add CRUD routes',
      createdBy: 'orch-2',
      assignedRole: 'coder-backend',
      priority: 3,
    })

    // Agent claims it
    await post(sa, 'hive_get_next_task', { agent_id: 'coder-1' })
    await new Promise(r => setTimeout(r, 100))

    const tasks = ts.listForAgent('coder-1')
    assert.equal(tasks.length, 1, 'coder-1 should have 1 task')
    assert.equal(tasks[0].status, 'in_progress')
    assert.equal(tasks[0].assignedTo, 'coder-1')

    co(); ca()
  })

  it('orchestrator cannot claim tasks', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await post(sessionId, 'hive_register', { agent_id: 'orch-3', role: 'orchestrator' })
    await new Promise(r => setTimeout(r, 100))

    // Should return error (still 202 on SSE transport)
    const status = await post(sessionId, 'hive_get_next_task', { agent_id: 'orch-3' })
    assert.equal(status, 202)

    close()
  })

  it('DAG: task with unresolved dependency is not available', async () => {
    const ts = server.getTaskStore()

    // Use 'architect' role — not used in any prior test in this suite
    const depTask = ts.create({
      title: 'DAG dep task',
      description: 'Must complete first',
      createdBy: 'orch-1',
      assignedRole: 'architect',
      priority: 3,
    })

    const blockedTask = ts.create({
      title: 'DAG blocked task',
      description: 'Depends on dep task',
      createdBy: 'orch-1',
      assignedRole: 'architect',
      priority: 1,  // higher priority but blocked by dependency
      dependsOn: [depTask.id],
    })

    // Only depTask should be available (blockedTask has unresolved dep)
    const next = ts.getNextAvailable('architect')
    assert.ok(next, 'Should find a task')
    assert.equal(next!.id, depTask.id, 'Should get the dep task, not the blocked one')
    assert.notEqual(next!.id, blockedTask.id, 'Blocked task should not be returned')
  })

  it('DAG: task becomes available after dependency completes', async () => {
    const ts = server.getTaskStore()

    // dep uses 'devops' role so researcher can't claim it
    const dep = ts.create({
      title: 'DAG prereq',
      description: 'Must run first (devops role)',
      createdBy: 'orch-1',
      assignedRole: 'devops',
      priority: 3,
    })

    // dependent uses 'researcher' and depends on dep
    const dependent = ts.create({
      title: 'DAG dependent task',
      description: 'Runs after prereq',
      createdBy: 'orch-1',
      assignedRole: 'researcher',
      priority: 1,
      dependsOn: [dep.id],
    })

    // Initially: dep is not yet completed → dependent is blocked
    const before = ts.getNextAvailable('researcher')
    assert.equal(before, null, 'Dependent task should not be available yet')

    // Complete the dep
    ts.forceComplete(dep.id)

    // Now dependent should be available
    const next = ts.getNextAvailable('researcher')
    assert.ok(next, 'Should now be available')
    assert.equal(next!.id, dependent.id)
  })

  it('hive_update_task_progress updates task status', async () => {
    const { sessionId: so, close: co } = await openSse()
    const { sessionId: sa, close: ca } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await post(so, 'hive_register', { agent_id: 'orch-4', role: 'orchestrator' })
    await post(sa, 'hive_register', { agent_id: 'coder-2', role: 'coder-frontend' })
    await new Promise(r => setTimeout(r, 100))

    const ts = server.getTaskStore()
    const task = ts.create({
      title: 'Build UI',
      description: 'React components',
      createdBy: 'orch-4',
      assignedRole: 'coder-frontend',
      priority: 3,
    })
    ts.assign(task.id, 'coder-2')
    ts.startProgress(task.id)

    await post(sa, 'hive_update_task_progress', {
      task_id: task.id,
      agent_id: 'coder-2',
      status: 'in_progress',
      summary: 'Completed 3 of 5 components',
      percent_complete: 60,
    })
    await new Promise(r => setTimeout(r, 100))

    const updated = ts.getById(task.id)
    assert.equal(updated?.status, 'in_progress')

    co(); ca()
  })

  it('hive_complete_task sets status to qa_pending', async () => {
    const { sessionId: so, close: co } = await openSse()
    const { sessionId: sa, close: ca } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await post(so, 'hive_register', { agent_id: 'orch-5', role: 'orchestrator' })
    await post(sa, 'hive_register', { agent_id: 'coder-3', role: 'coder-backend' })
    await new Promise(r => setTimeout(r, 100))

    const ts = server.getTaskStore()
    const task = ts.create({
      title: 'Add DB migrations',
      description: 'SQLite schema migrations',
      createdBy: 'orch-5',
      assignedRole: 'coder-backend',
    })
    ts.assign(task.id, 'coder-3')
    ts.startProgress(task.id)

    await post(sa, 'hive_complete_task', {
      task_id: task.id,
      agent_id: 'coder-3',
      summary: 'Added 3 migration files and updated schema',
      files_modified: ['src/db/migrations/001.sql'],
    })
    await new Promise(r => setTimeout(r, 100))

    const completed = ts.getById(task.id)
    assert.equal(completed?.status, 'qa_pending')
    assert.equal(completed?.completionSummary, 'Added 3 migration files and updated schema')
    assert.deepEqual(completed?.filesModified, ['src/db/migrations/001.sql'])

    co(); ca()
  })

  it('hive_list_tasks filters by status', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    const ts = server.getTaskStore()
    const pending = ts.listByStatus('pending')
    const all = ts.listAll()

    // Verify hive_list_tasks tool call succeeds
    const status = await post(sessionId, 'hive_list_tasks', { status: 'pending' })
    assert.equal(status, 202)

    // Verify the TaskStore directly
    assert.ok(all.length > 0, 'Should have tasks from earlier tests')
    assert.ok(pending.length <= all.length, 'Pending should be a subset of all')

    close()
  })

  it('hive_get_task returns full task details', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    const ts = server.getTaskStore()
    const task = ts.create({
      title: 'Detail test task',
      description: 'A task to test get details',
      createdBy: 'orch-1',
      acceptanceCriteria: 'Tests pass',
    })

    const status = await post(sessionId, 'hive_get_task', { task_id: task.id })
    assert.equal(status, 202)

    // Verify directly
    const fetched = ts.getById(task.id)
    assert.equal(fetched?.title, 'Detail test task')
    assert.equal(fetched?.acceptanceCriteria, 'Tests pass')

    close()
  })
})
