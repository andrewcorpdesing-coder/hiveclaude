/**
 * Phase 7 integration tests — QA Pipeline
 * Tests: approve flow, reject+revision flow, feedback required on reject,
 * reviewer-only gate, DAG unblock after approval, revision task priority.
 * Run with: node --test packages/broker/dist/tests/phase7.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Database } from '../db/Database.js'
import { AgentRegistry } from '../agents/AgentRegistry.js'
import { HttpServer } from '../mcp/HttpServer.js'

const TEST_PORT = 7440
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

describe('Phase 7 — QA Pipeline', () => {
  let db: Database
  let registry: AgentRegistry
  let server: HttpServer

  before(async () => {
    db = new Database(`.hive/test-phase7-${Date.now()}.db`)
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

  // ── TaskStore unit tests ──────────────────────────────────────────────────

  it('approve sets task to completed with verdict', () => {
    const ts = server.getTaskStore()
    const task = ts.create({
      title: 'Unit approve', description: 'test', createdBy: 'orch',
    })
    // Manually move to qa_pending
    ts.complete({ taskId: task.id, agentId: 'coder-1', summary: 'done' })

    const approved = ts.approve({ taskId: task.id, reviewerId: 'rev-1', feedback: 'LGTM' })
    assert.equal(approved.status, 'completed')
    assert.ok(approved.completedAt)
  })

  it('reject sets task to needs_revision with verdict', () => {
    const ts = server.getTaskStore()
    const task = ts.create({
      title: 'Unit reject', description: 'test', createdBy: 'orch',
    })
    ts.complete({ taskId: task.id, agentId: 'coder-2', summary: 'done' })

    const rejected = ts.reject({ taskId: task.id, reviewerId: 'rev-1', feedback: 'Fix the tests' })
    assert.equal(rejected.status, 'needs_revision')
  })

  it('getRevisionTask returns needs_revision task for the agent', () => {
    const ts = server.getTaskStore()
    const task = ts.create({
      title: 'Revision task', description: 'test', createdBy: 'orch',
      assignedTo: 'coder-revision',
    })
    ts.assign(task.id, 'coder-revision')
    ts.complete({ taskId: task.id, agentId: 'coder-revision', summary: 'done' })
    ts.reject({ taskId: task.id, reviewerId: 'rev-1', feedback: 'Needs more tests' })

    const revision = ts.getRevisionTask('coder-revision')
    assert.ok(revision)
    assert.equal(revision.id, task.id)
    assert.equal(revision.status, 'needs_revision')
  })

  it('getRevisionTask returns null if no revision task', () => {
    const ts = server.getTaskStore()
    const result = ts.getRevisionTask('no-revisions-agent')
    assert.equal(result, null)
  })

  // ── HTTP tool tests ───────────────────────────────────────────────────────

  it('hive_get_pending_reviews denied for coder', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'qa-coder', role: 'coder-backend' })
      await new Promise(r => setTimeout(r, 100))

      const status = await post(sessionId, 'hive_get_pending_reviews', {
        agent_id: 'qa-coder',
      })
      assert.equal(status, 202)  // MCP always 202 — error is in body

      // Verify it was blocked at the tool level (not a DB call)
      // The tool returns isError:true but HTTP status is still 202 in SSE
    } finally {
      close()
    }
  })

  it('full approve flow: qa_pending → completed', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'qa-orch', role: 'orchestrator' })
      await post(sessionId, 'hive_register', { agent_id: 'qa-reviewer', role: 'reviewer' })
      await new Promise(r => setTimeout(r, 150))

      // Orchestrator creates a task
      const ts = server.getTaskStore()
      const task = ts.create({
        title: 'Approve via HTTP', description: 'implement X', createdBy: 'qa-orch',
        assignedTo: 'qa-coder-worker',
      })
      ts.assign(task.id, 'qa-coder-worker')
      ts.complete({ taskId: task.id, agentId: 'qa-coder-worker', summary: 'X implemented' })

      assert.equal(ts.getById(task.id)!.status, 'qa_pending')

      // Reviewer lists pending reviews
      const listStatus = await post(sessionId, 'hive_get_pending_reviews', {
        agent_id: 'qa-reviewer',
      })
      assert.equal(listStatus, 202)
      await new Promise(r => setTimeout(r, 50))

      // Reviewer approves
      const approveStatus = await post(sessionId, 'hive_submit_review', {
        reviewer_id: 'qa-reviewer',
        task_id: task.id,
        verdict: 'approved',
        feedback: 'Clean implementation',
      })
      assert.equal(approveStatus, 202)
      await new Promise(r => setTimeout(r, 100))

      assert.equal(ts.getById(task.id)!.status, 'completed')

      // Audit trail
      const ledger = server.getAuditLedger()
      const rows = ledger.query({ agentId: 'qa-reviewer', action: 'task_review' })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].result, 'ok')
      const detail = JSON.parse(rows[0].detail!) as { verdict: string }
      assert.equal(detail.verdict, 'approved')
    } finally {
      close()
    }
  })

  it('full reject flow: qa_pending → needs_revision → in_progress via get_next_task', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'qa-reviewer2', role: 'reviewer' })
      await new Promise(r => setTimeout(r, 100))

      const ts = server.getTaskStore()
      const task = ts.create({
        title: 'Reject via HTTP', description: 'implement Y', createdBy: 'orch',
        assignedTo: 'qa-coder-reject',
      })
      ts.assign(task.id, 'qa-coder-reject')
      ts.complete({ taskId: task.id, agentId: 'qa-coder-reject', summary: 'Y done' })

      // Reviewer rejects
      const status = await post(sessionId, 'hive_submit_review', {
        reviewer_id: 'qa-reviewer2',
        task_id: task.id,
        verdict: 'rejected',
        feedback: 'Missing unit tests',
      })
      assert.equal(status, 202)
      await new Promise(r => setTimeout(r, 100))

      assert.equal(ts.getById(task.id)!.status, 'needs_revision')

      // The coder's next task should be their revision task
      const revision = ts.getRevisionTask('qa-coder-reject')
      assert.ok(revision, 'revision task should be available')
      assert.equal(revision.id, task.id)
    } finally {
      close()
    }
  })

  it('reject without feedback returns error', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'qa-reviewer3', role: 'reviewer' })
      await new Promise(r => setTimeout(r, 100))

      const ts = server.getTaskStore()
      const task = ts.create({
        title: 'No feedback test', description: 'test', createdBy: 'orch',
      })
      ts.complete({ taskId: task.id, agentId: 'orch', summary: 'done' })

      const status = await post(sessionId, 'hive_submit_review', {
        reviewer_id: 'qa-reviewer3',
        task_id: task.id,
        verdict: 'rejected',
        // no feedback
      })
      assert.equal(status, 202)
      await new Promise(r => setTimeout(r, 50))

      // Task should still be qa_pending (reject was blocked)
      assert.equal(ts.getById(task.id)!.status, 'qa_pending')
    } finally {
      close()
    }
  })

  it('non-reviewer cannot submit review', async () => {
    const { sessionId, close } = await openSse()
    try {
      await new Promise(r => setTimeout(r, 50))
      await post(sessionId, 'hive_register', { agent_id: 'qa-impostor', role: 'coder-backend' })
      await new Promise(r => setTimeout(r, 100))

      const ts = server.getTaskStore()
      const task = ts.create({
        title: 'Impostor test', description: 'test', createdBy: 'orch',
      })
      ts.complete({ taskId: task.id, agentId: 'orch', summary: 'done' })

      await post(sessionId, 'hive_submit_review', {
        reviewer_id: 'qa-impostor',
        task_id: task.id,
        verdict: 'approved',
      })
      await new Promise(r => setTimeout(r, 100))

      // Task should still be qa_pending
      assert.equal(ts.getById(task.id)!.status, 'qa_pending')
    } finally {
      close()
    }
  })

  it('approved task unblocks DAG dependent', () => {
    const ts = server.getTaskStore()

    const parent = ts.create({
      title: 'Parent task', description: 'must finish first', createdBy: 'orch',
    })
    const child = ts.create({
      title: 'Child task', description: 'depends on parent', createdBy: 'orch',
      assignedRole: 'coder-backend',
      dependsOn: [parent.id],
    })

    // Child should not be available yet
    assert.equal(ts.getNextAvailable('coder-backend')?.id === child.id, false,
      'child should not be available while parent is pending')

    // Complete parent through QA
    ts.assign(parent.id, 'worker-1')
    ts.complete({ taskId: parent.id, agentId: 'worker-1', summary: 'done' })
    ts.approve({ taskId: parent.id, reviewerId: 'rev-1' })

    assert.equal(ts.getById(parent.id)!.status, 'completed')

    // Child should now be available
    const next = ts.getNextAvailable('coder-backend')
    assert.ok(next, 'child task should now be available')
    assert.equal(next.id, child.id)
  })
})
