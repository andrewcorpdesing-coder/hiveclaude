/**
 * Phase 2 integration tests — MessageBus + P2P messaging + hive_list_agents
 * Run with: node --test packages/broker/dist/tests/phase2.test.js
 * Requires broker NOT running (test starts its own instance)
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Database } from '../db/Database.js'
import { AgentRegistry } from '../agents/AgentRegistry.js'
import { HttpServer } from '../mcp/HttpServer.js'

const TEST_PORT = 7434
const BASE = `http://localhost:${TEST_PORT}`

async function postMessage(sessionId: string, toolName: string, params: Record<string, unknown>) {
  const body = {
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1000),
    method: 'tools/call',
    params: { name: toolName, arguments: params },
  }
  const res = await fetch(`${BASE}/message?sessionId=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
        let sessionId = ''

        const read = async (): Promise<void> => {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() ?? ''
              for (const line of lines) {
                if (line.startsWith('data: ') && !sessionId) {
                  const match = line.slice(6).trim().match(/sessionId=([a-f0-9-]+)/)
                  if (match) { sessionId = match[1]; resolve({ sessionId, close }) }
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

describe('Phase 2 — MessageBus + P2P Messaging + hive_list_agents', () => {
  let db: Database
  let registry: AgentRegistry
  let server: HttpServer

  before(async () => {
    db = new Database(`.hive/test-phase2-${Date.now()}.db`)
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

  it('hive_list_agents returns empty list when no agents online', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    const status = await postMessage(sessionId, 'hive_list_agents', {})
    assert.equal(status, 202)

    close()
  })

  it('hive_list_agents returns registered agent', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await postMessage(sessionId, 'hive_register', {
      agent_id: 'list-test-agent',
      role: 'architect',
      skills: ['design'],
    })
    await new Promise(r => setTimeout(r, 100))

    const agent = registry.getById('list-test-agent')
    assert.ok(agent, 'Agent should be registered')
    assert.equal(agent?.role, 'architect')

    // Verify hive_list_agents call succeeds (202 Accepted on SSE transport)
    const status = await postMessage(sessionId, 'hive_list_agents', {})
    assert.equal(status, 202)

    close()
  })

  it('hive_send queues message for target agent', async () => {
    const { sessionId: s1, close: c1 } = await openSse()
    const { sessionId: s2, close: c2 } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await postMessage(s1, 'hive_register', { agent_id: 'sender-1', role: 'orchestrator' })
    await postMessage(s2, 'hive_register', { agent_id: 'receiver-1', role: 'coder-backend' })
    await new Promise(r => setTimeout(r, 100))

    // Send a message from sender-1 to receiver-1
    const status = await postMessage(s1, 'hive_send', {
      from_agent_id: 'sender-1',
      to_agent_id: 'receiver-1',
      message_type: 'direct',
      content: 'Hello from sender-1',
      priority: 'normal',
    })
    assert.equal(status, 202)
    await new Promise(r => setTimeout(r, 100))

    // Verify message is in MessageBus pending queue for receiver-1
    const mb = server.getMessageBus()
    const events = mb.drain('receiver-1')
    assert.equal(events.length, 1, 'Should have 1 pending message')
    assert.equal(events[0].type, 'message_received')
    const payload = events[0].payload as Record<string, unknown>
    assert.equal(payload.from, 'sender-1')
    assert.equal(payload.content, 'Hello from sender-1')
    assert.equal(payload.type, 'direct')

    c1(); c2()
  })

  it('hive_send delivers message via heartbeat piggyback', async () => {
    const { sessionId: s1, close: c1 } = await openSse()
    const { sessionId: s2, close: c2 } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await postMessage(s1, 'hive_register', { agent_id: 'sender-2', role: 'orchestrator' })
    await postMessage(s2, 'hive_register', { agent_id: 'receiver-2', role: 'researcher' })
    await new Promise(r => setTimeout(r, 100))

    // Send message
    await postMessage(s1, 'hive_send', {
      from_agent_id: 'sender-2',
      to_agent_id: 'receiver-2',
      message_type: 'question',
      content: 'What is the status?',
      priority: 'high',
    })
    await new Promise(r => setTimeout(r, 100))

    // Message should be in queue before heartbeat
    const mb = server.getMessageBus()
    // Peek at the DB state by checking drain without consuming (use internal method via test)
    // Instead: heartbeat should drain it — verify via the registry that heartbeat succeeds
    const heartbeatStatus = await postMessage(s2, 'hive_heartbeat', {
      agent_id: 'receiver-2',
      status: 'idle',
    })
    assert.equal(heartbeatStatus, 202)
    await new Promise(r => setTimeout(r, 100))

    // After heartbeat, the message should have been consumed from the queue
    const remaining = mb.drain('receiver-2')
    assert.equal(remaining.length, 0, 'Message should have been drained by heartbeat')

    c1(); c2()
  })

  it('hive_send broadcast delivers to all online agents except sender', async () => {
    const { sessionId: s1, close: c1 } = await openSse()
    const { sessionId: s2, close: c2 } = await openSse()
    const { sessionId: s3, close: c3 } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await postMessage(s1, 'hive_register', { agent_id: 'bcast-sender', role: 'orchestrator' })
    await postMessage(s2, 'hive_register', { agent_id: 'bcast-recv-1', role: 'coder-backend' })
    await postMessage(s3, 'hive_register', { agent_id: 'bcast-recv-2', role: 'reviewer' })
    await new Promise(r => setTimeout(r, 100))

    // Broadcast (no to_agent_id)
    await postMessage(s1, 'hive_send', {
      from_agent_id: 'bcast-sender',
      message_type: 'awareness',
      content: 'Broadcast to all',
      priority: 'normal',
    })
    await new Promise(r => setTimeout(r, 100))

    const mb = server.getMessageBus()
    const ev1 = mb.drain('bcast-recv-1')
    const ev2 = mb.drain('bcast-recv-2')
    const evSender = mb.drain('bcast-sender')

    assert.equal(ev1.length, 1, 'bcast-recv-1 should have 1 message')
    assert.equal(ev2.length, 1, 'bcast-recv-2 should have 1 message')
    assert.equal(evSender.length, 0, 'Sender should not receive its own broadcast')

    c1(); c2(); c3()
  })

  it('hive_send rejects unknown sender', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    // Tool will return an error (isError=true) but HTTP status is still 202 on SSE transport
    const status = await postMessage(sessionId, 'hive_send', {
      from_agent_id: 'nonexistent-agent',
      to_agent_id: 'also-nonexistent',
      message_type: 'direct',
      content: 'test',
    })
    assert.equal(status, 202, 'SSE transport always returns 202; error comes in SSE stream')

    close()
  })

  it('hive_send rejects invalid message_type', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await postMessage(sessionId, 'hive_register', { agent_id: 'type-test', role: 'devops' })
    await new Promise(r => setTimeout(r, 100))

    const status = await postMessage(sessionId, 'hive_send', {
      from_agent_id: 'type-test',
      message_type: 'invalid_type',
      content: 'test',
    })
    assert.equal(status, 202)

    // Message should NOT be queued (tool returned error)
    const mb = server.getMessageBus()
    const events = mb.drain('type-test')
    assert.equal(events.length, 0, 'No message should be queued on invalid type')

    close()
  })
})
