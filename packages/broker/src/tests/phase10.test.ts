/**
 * Phase 10 — End-to-End Integration Test
 *
 * Simulates a complete multi-agent workflow without real Claude Code instances:
 *
 *   orchestrator
 *     └─ creates task-A (implement endpoint)
 *     └─ creates task-B (write integration tests) — depends on task-A
 *
 *   coder-backend
 *     └─ registers → heartbeat → get task-A → declare locks
 *     └─ update progress → complete → locks auto-released
 *
 *   reviewer
 *     └─ registers → get pending reviews → submit_review (approve)
 *     └─ task-A → completed, task-B unblocked
 *
 *   coder-backend
 *     └─ get task-B → work → complete
 *
 *   reviewer
 *     └─ reject task-B with feedback
 *
 *   coder-backend
 *     └─ get_next_task returns revision of task-B
 *     └─ re-complete with fixes
 *
 *   reviewer
 *     └─ approve task-B
 *
 * Throughout: blackboard reads/writes, messages, heartbeat events, audit trail.
 *
 * Run with: node --test packages/broker/dist/tests/phase10.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Database } from '../db/Database.js'
import { AgentRegistry } from '../agents/AgentRegistry.js'
import { HttpServer } from '../mcp/HttpServer.js'
import { PromptLoader } from '../prompts/PromptLoader.js'

const TEST_PORT = 7445
const BASE = `http://localhost:${TEST_PORT}`

// ── HTTP helpers ──────────────────────────────────────────────────────────

interface McpPayload {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
  code?: string
  pending_events?: Array<{ type: string; payload: unknown }>
}

async function mcpCall(
  sessionId: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<McpPayload> {
  const res = await fetch(`${BASE}/message?sessionId=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 10000),
      method: 'tools/call',
      params: { name: tool, arguments: params },
    }),
  })
  // MCP responses come via SSE; for tool calls we just get 202 ACK
  // The actual result arrives as an SSE event — we read it from the response text
  const text = await res.text()
  // Find the JSON-RPC result in the response (may be empty for 202)
  const match = text.match(/\{.*\}/s)
  if (!match) return { ok: true }
  try {
    const rpc = JSON.parse(match[0]) as { result?: { content?: Array<{ text: string }> } }
    const content = rpc.result?.content?.[0]?.text
    if (!content) return { ok: true }
    return JSON.parse(content) as McpPayload
  } catch {
    return { ok: true }
  }
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

async function adminGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`)
  return res.json() as Promise<Record<string, unknown>>
}

async function adminPost(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST' })
  return res.json() as Promise<Record<string, unknown>>
}

// ── Test suite ────────────────────────────────────────────────────────────

describe('Phase 10 — End-to-End Multi-Agent Workflow', () => {
  let db: Database
  let registry: AgentRegistry
  let server: HttpServer

  // Session handles
  let orchSession: { sessionId: string; close: () => void }
  let coderSession: { sessionId: string; close: () => void }
  let reviewerSession: { sessionId: string; close: () => void }

  // Task IDs filled during test
  let taskAId: string
  let taskBId: string

  const BB_DIR = `.hive/test-bb-e2e-${Date.now()}`

  before(async () => {
    db = new Database(`.hive/test-phase10-${Date.now()}.db`)
    registry = new AgentRegistry(db)
    server = new HttpServer({ db, agentRegistry: registry, port: TEST_PORT, blackboardDir: BB_DIR })
    server.start()
    await new Promise(r => setTimeout(r, 150))
  })

  after(async () => {
    orchSession?.close()
    coderSession?.close()
    reviewerSession?.close()
    await new Promise(r => setTimeout(r, 200))
    await server.stop()
    registry.destroy()
    db.close()
  })

  // ── PromptLoader ─────────────────────────────────────────────────────────

  it('PromptLoader fills all template variables', () => {
    const loader = new PromptLoader()
    const roles = loader.availableRoles()
    assert.ok(roles.includes('orchestrator'))
    assert.ok(roles.includes('coder-backend'))
    assert.ok(roles.includes('reviewer'))
    assert.ok(roles.length >= 7, 'All 7 roles should have prompts')

    const prompt = loader.load('orchestrator', {
      agent_id: 'orch-e2e',
      project: 'TestProject',
      broker_url: 'http://localhost:7445',
    })
    assert.ok(prompt.includes('orch-e2e'), 'agent_id substituted')
    assert.ok(prompt.includes('TestProject'), 'project substituted')
    assert.ok(prompt.includes('http://localhost:7445'), 'broker_url substituted')
    assert.ok(!prompt.includes('{{'), 'No unfilled template variables')
  })

  it('PromptLoader throws for unknown role', () => {
    const loader = new PromptLoader()
    assert.throws(
      () => loader.load('unicorn' as never, { agent_id: 'x', project: 'p', broker_url: 'u' }),
      /No prompt found/,
    )
  })

  // ── Agent Registration ────────────────────────────────────────────────────

  it('orchestrator, coder-backend, and reviewer register', async () => {
    orchSession = await openSse()
    coderSession = await openSse()
    reviewerSession = await openSse()
    await new Promise(r => setTimeout(r, 100))

    await mcpCall(orchSession.sessionId, 'hive_register', { agent_id: 'e2e-orch', role: 'orchestrator' })
    await mcpCall(coderSession.sessionId, 'hive_register', { agent_id: 'e2e-coder', role: 'coder-backend' })
    await mcpCall(reviewerSession.sessionId, 'hive_register', { agent_id: 'e2e-reviewer', role: 'reviewer' })
    await new Promise(r => setTimeout(r, 200))

    const agents = await adminGet('/admin/agents?status=online')
    const list = agents.agents as Array<{ id: string }>
    assert.ok(list.some(a => a.id === 'e2e-orch'))
    assert.ok(list.some(a => a.id === 'e2e-coder'))
    assert.ok(list.some(a => a.id === 'e2e-reviewer'))
  })

  // ── Blackboard Initialisation ─────────────────────────────────────────────

  it('orchestrator writes project meta and sprint to blackboard', async () => {
    const bb = server.getBlackboard()

    bb.write('e2e-orch', 'orchestrator', 'project.meta', {
      name: 'HiveMind E2E',
      version: '0.1.0',
      description: 'End-to-end test project',
    }, 'set')

    bb.write('e2e-orch', 'orchestrator', 'state.sprint', {
      number: 1,
      goal: 'Implement user endpoint and tests',
      startDate: new Date().toISOString(),
    }, 'set')

    assert.equal((bb.getAt('project.meta') as Record<string, string>).name, 'HiveMind E2E')
    assert.equal((bb.getAt('state.sprint') as Record<string, number>).number, 1)
  })

  // ── Task Creation (DAG) ───────────────────────────────────────────────────

  it('orchestrator creates task-A and task-B with DAG dependency', async () => {
    const ts = server.getTaskStore()

    const taskA = ts.create({
      title: 'Implement POST /users endpoint',
      description: 'Create a REST endpoint that accepts { name, email } and persists to DB. Must validate input and return 201 with the created user.',
      createdBy: 'e2e-orch',
      assignedRole: 'coder-backend',
      priority: 2,
      acceptanceCriteria: 'POST /users returns 201 with { id, name, email }. Rejects invalid email with 400.',
    })
    taskAId = taskA.id

    const taskB = ts.create({
      title: 'Write integration tests for POST /users',
      description: 'Write integration tests covering success, invalid email, missing fields, and duplicate email cases.',
      createdBy: 'e2e-orch',
      assignedRole: 'coder-backend',
      priority: 2,
      dependsOn: [taskAId],
      acceptanceCriteria: 'All 4 test cases pass. Coverage > 80%.',
    })
    taskBId = taskB.id

    assert.equal(ts.getById(taskAId)!.status, 'pending')
    assert.equal(ts.getById(taskBId)!.status, 'pending')
    assert.deepEqual(ts.getById(taskBId)!.dependsOn, [taskAId])
  })

  it('task-B is not available while task-A is pending', () => {
    const ts = server.getTaskStore()
    const next = ts.getNextAvailable('coder-backend')
    // Should get task-A (no dependencies), NOT task-B
    assert.ok(next, 'Should have an available task')
    assert.equal(next.id, taskAId, 'Should get task-A first')
  })

  // ── Coder works on task-A ─────────────────────────────────────────────────

  it('coder claims task-A and declares file locks', async () => {
    const ts = server.getTaskStore()
    const lr = server.getFileLockRegistry()

    // Simulate hive_get_next_task
    const task = ts.getNextAvailable('coder-backend')!
    ts.assign(task.id, 'e2e-coder')
    ts.startProgress(task.id)

    // Declare locks
    const { result } = lr.declare('e2e-coder', task.id, {
      'src/api/users.ts': 'EXCLUSIVE',
      'src/types/user.ts': 'EXCLUSIVE',
      'src/db/schema.ts': 'READ',
    })

    assert.equal(result.granted['src/api/users.ts'], 'EXCLUSIVE')
    assert.equal(result.granted['src/types/user.ts'], 'EXCLUSIVE')
    assert.equal(result.granted['src/db/schema.ts'], 'READ')
    assert.equal(Object.keys(result.queued).length, 0)
    assert.equal(ts.getById(taskAId)!.status, 'in_progress')
  })

  it('coder records a discovery to the blackboard', () => {
    const bb = server.getBlackboard()
    bb.write('e2e-coder', 'coder-backend', 'knowledge.discoveries',
      'The DB schema uses snake_case columns but the API returns camelCase — transform in the repository layer',
      'append')

    const discoveries = bb.getAt('knowledge.discoveries') as string[]
    assert.ok(Array.isArray(discoveries))
    assert.ok(discoveries.some(d => d.includes('snake_case')))
  })

  it('coder sends a message to orchestrator about an API decision', async () => {
    const mb = server.getMessageBus()
    mb.send({
      fromAgentId: 'e2e-coder',
      toAgentId: 'e2e-orch',
      targetIds: ['e2e-orch'],
      messageType: 'request',
      content: JSON.stringify({ question: 'Should POST /users return full user object or just ID?' }),
      priority: 'normal',
    })

    const msgs = mb.drain('e2e-orch')
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].type, 'message_received')
  })

  it('coder completes task-A and releases locks', () => {
    const ts = server.getTaskStore()
    const lr = server.getFileLockRegistry()

    // Progress update
    ts.addProgress({
      taskId: taskAId, agentId: 'e2e-coder',
      status: 'in_progress', summary: 'Implementation complete', percentComplete: 100,
    })

    // Release locks
    const { released, promoted } = lr.release('e2e-coder', taskAId)
    assert.ok(released.includes('src/api/users.ts'))
    assert.ok(released.includes('src/types/user.ts'))
    assert.equal(lr.hasActiveLocks('e2e-coder'), false)

    // Complete task
    ts.complete({
      taskId: taskAId, agentId: 'e2e-coder',
      summary: 'Implemented POST /users with input validation and 201 response.',
      filesModified: ['src/api/users.ts', 'src/types/user.ts'],
      testResults: { passed: 4, failed: 0 },
      notesForReviewer: 'Check the email validation regex in validateUserInput()',
    })

    assert.equal(ts.getById(taskAId)!.status, 'qa_pending')
  })

  // ── Reviewer approves task-A ──────────────────────────────────────────────

  it('reviewer sees task-A in pending reviews', () => {
    const ts = server.getTaskStore()
    const pending = ts.listByStatus('qa_pending')
    assert.ok(pending.some(t => t.id === taskAId))
  })

  it('reviewer approves task-A → completed, task-B unblocked', () => {
    const ts = server.getTaskStore()
    const ledger = server.getAuditLedger()

    const approved = ts.approve({
      taskId: taskAId,
      reviewerId: 'e2e-reviewer',
      feedback: 'Clean implementation. Email regex is solid.',
    })
    ledger.log({ agentId: 'e2e-reviewer', action: 'task_review', target: taskAId, detail: { verdict: 'approved' }, result: 'ok' })
    assert.equal(approved.status, 'completed')

    // task-B should now be available (dependency resolved)
    const next = ts.getNextAvailable('coder-backend')
    assert.ok(next, 'task-B should now be available')
    assert.equal(next.id, taskBId)
  })

  // ── Coder works on task-B ─────────────────────────────────────────────────

  it('coder claims task-B and completes it', () => {
    const ts = server.getTaskStore()
    const lr = server.getFileLockRegistry()

    ts.assign(taskBId, 'e2e-coder')
    ts.startProgress(taskBId)

    lr.declare('e2e-coder', taskBId, { 'src/api/users.test.ts': 'EXCLUSIVE' })

    ts.addProgress({ taskId: taskBId, agentId: 'e2e-coder', status: 'in_progress', summary: 'Writing tests', percentComplete: 100 })
    lr.release('e2e-coder', taskBId)

    ts.complete({
      taskId: taskBId, agentId: 'e2e-coder',
      summary: 'Added 4 integration tests.',
      filesModified: ['src/api/users.test.ts'],
      testResults: { passed: 4, failed: 0, coverage: '82%' },
    })

    assert.equal(ts.getById(taskBId)!.status, 'qa_pending')
  })

  // ── Reviewer rejects task-B (first pass) ─────────────────────────────────

  it('reviewer rejects task-B with specific feedback', () => {
    const ts = server.getTaskStore()
    const ledger = server.getAuditLedger()
    const rejected = ts.reject({
      taskId: taskBId, reviewerId: 'e2e-reviewer',
      feedback: 'Missing test case for duplicate email. The acceptance criteria requires 4 cases but only 3 are meaningful.',
    })
    ledger.log({ agentId: 'e2e-reviewer', action: 'task_review', target: taskBId, detail: { verdict: 'rejected' }, result: 'ok' })
    assert.equal(rejected.status, 'needs_revision')
  })

  it('coder gets revision task first via getRevisionTask', () => {
    const ts = server.getTaskStore()
    const revision = ts.getRevisionTask('e2e-coder')
    assert.ok(revision, 'Should have a revision task')
    assert.equal(revision.id, taskBId)
    assert.equal(revision.status, 'needs_revision')
  })

  // ── Coder revises and resubmits task-B ───────────────────────────────────

  it('coder fixes task-B and resubmits', () => {
    const ts = server.getTaskStore()
    const lr = server.getFileLockRegistry()

    // Re-enter in_progress
    ts.startProgress(taskBId)
    lr.declare('e2e-coder', taskBId, { 'src/api/users.test.ts': 'EXCLUSIVE' })
    lr.release('e2e-coder', taskBId)

    ts.complete({
      taskId: taskBId, agentId: 'e2e-coder',
      summary: 'Added duplicate email test case. All 4 cases now covered.',
      filesModified: ['src/api/users.test.ts'],
      testResults: { passed: 4, failed: 0, coverage: '89%' },
      notesForReviewer: 'Added test for duplicate email returning 409 Conflict',
    })

    assert.equal(ts.getById(taskBId)!.status, 'qa_pending')
  })

  // ── Reviewer approves task-B ──────────────────────────────────────────────

  it('reviewer approves task-B — all tasks completed', () => {
    const ts = server.getTaskStore()
    const ledger = server.getAuditLedger()
    const approved = ts.approve({
      taskId: taskBId, reviewerId: 'e2e-reviewer',
      feedback: 'All 4 cases covered. Coverage 89%. LGTM.',
    })
    ledger.log({ agentId: 'e2e-reviewer', action: 'task_review', target: taskBId, detail: { verdict: 'approved' }, result: 'ok' })
    assert.equal(approved.status, 'completed')

    // Both tasks are now completed
    assert.equal(ts.getById(taskAId)!.status, 'completed')
    assert.equal(ts.getById(taskBId)!.status, 'completed')
  })

  // ── Heartbeat with events ─────────────────────────────────────────────────

  it('heartbeat returns pending events piggybacked', async () => {
    // Push an event to the coder's queue
    server.getEventQueue().push('e2e-coder', 'lock_granted', {
      filePath: 'src/test.ts', lockType: 'EXCLUSIVE',
      grantedAt: new Date().toISOString(), reason: 'test',
    })

    // Heartbeat delivers it
    await mcpCall(coderSession.sessionId, 'hive_heartbeat', {
      agent_id: 'e2e-coder', status: 'idle',
    })
    await new Promise(r => setTimeout(r, 100))
    // Event queue should be drained
    const remaining = server.getEventQueue().drain('e2e-coder')
    assert.equal(remaining.length, 0, 'Events should have been drained by heartbeat')
  })

  // ── Audit trail ───────────────────────────────────────────────────────────

  it('audit log records reviewer actions', () => {
    const ledger = server.getAuditLedger()
    const rows = ledger.query({ agentId: 'e2e-reviewer', action: 'task_review' })
    assert.ok(rows.length >= 2, 'Should have at least 2 review entries (approve A + reject B + approve B)')
    assert.ok(rows.some(r => JSON.parse(r.detail ?? '{}').verdict === 'approved'))
    assert.ok(rows.some(r => JSON.parse(r.detail ?? '{}').verdict === 'rejected'))
  })

  // ── Admin API snapshot ────────────────────────────────────────────────────

  it('admin API shows consistent final state', async () => {
    const tasks = await adminGet('/admin/tasks?status=completed')
    const completed = tasks.tasks as Array<{ id: string }>
    assert.ok(completed.some(t => t.id === taskAId))
    assert.ok(completed.some(t => t.id === taskBId))

    const locks = await adminGet('/admin/locks')
    const activeLocks = locks.active as { count: number }
    assert.equal(activeLocks.count, 0, 'No locks should remain after workflow')

    const bb = await adminGet('/admin/blackboard')
    const project = bb.project as { meta: { name: string } }
    assert.equal(project.meta.name, 'HiveMind E2E')
  })

  // ── Disconnect cleans up ──────────────────────────────────────────────────

  it('coder SSE disconnect releases any remaining locks', async () => {
    const lr = server.getFileLockRegistry()
    // Give coder an active lock
    lr.declare('e2e-coder', 'stray-task', { 'src/stray.ts': 'EXCLUSIVE' })
    assert.equal(lr.hasActiveLocks('e2e-coder'), true)

    // Disconnect
    coderSession.close()
    await new Promise(r => setTimeout(r, 400))

    assert.equal(lr.hasActiveLocks('e2e-coder'), false, 'Locks released on disconnect')
    coderSession = { sessionId: '', close: () => {} }  // mark as closed
  })
})
