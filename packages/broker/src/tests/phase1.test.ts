/**
 * Phase 1 integration tests
 * Run with: node --test packages/broker/dist/tests/phase1.test.js
 * Requires broker NOT running (test starts its own instance)
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Database } from '../db/Database.js'
import { AgentRegistry } from '../agents/AgentRegistry.js'
import { HttpServer } from '../mcp/HttpServer.js'

const TEST_PORT = 7433
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
  // The response body for SSE transport comes back over the SSE stream, not the POST response
  return res.status
}

/** Open an SSE connection, return { sessionId, events: collected SSE events, close() } */
function openSse(): Promise<{ sessionId: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()

    const close = () => {
      try { controller.abort() } catch { /* ignore */ }
    }

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
                  if (match) {
                    sessionId = match[1]
                    resolve({ sessionId, close })
                  }
                }
              }
            }
          } catch (err) {
            if ((err as Error).name !== 'AbortError') throw err
          }
        }
        void read()
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') reject(err)
      })
  })
}

describe('Phase 1 — HTTP + SSE + Registration + Heartbeat', () => {
  let db: Database
  let registry: AgentRegistry
  let server: HttpServer

  before(async () => {
    db = new Database(`.hive/test-phase1-${Date.now()}.db`)
    registry = new AgentRegistry(db)
    server = new HttpServer({ db, agentRegistry: registry, port: TEST_PORT })
    server.start()
    await new Promise(r => setTimeout(r, 100)) // wait for server
  })

  after(async () => {
    await server.stop()
    registry.destroy()
    db.close()
  })

  it('GET /ping returns broker info', async () => {
    const res = await fetch(`${BASE}/ping`)
    const body = await res.json() as Record<string, unknown>
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.equal(typeof body.agents_online, 'number')
  })

  it('GET /sse opens connection and emits endpoint event with sessionId', async () => {
    const { sessionId, close } = await openSse()
    assert.match(sessionId, /^[a-f0-9-]{36}$/, 'sessionId should be a UUID')
    close()
  })

  it('hive_register registers agent and returns reconnect_token', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    const status = await postMessage(sessionId, 'hive_register', {
      agent_id: 'test-coder-1',
      role: 'coder-backend',
      skills: ['simplify'],
    })
    assert.equal(status, 202, 'POST /message should return 202 Accepted')

    await new Promise(r => setTimeout(r, 100))
    const agent = registry.getById('test-coder-1')
    assert.ok(agent, 'Agent should be registered in registry')
    assert.equal(agent?.role, 'coder-backend')
    assert.equal(agent?.status, 'online')
    assert.ok(agent?.reconnectToken, 'reconnectToken should be set')

    close()
  })

  it('hive_heartbeat updates lastSeen', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await postMessage(sessionId, 'hive_register', {
      agent_id: 'test-heartbeat-1',
      role: 'reviewer',
    })
    await new Promise(r => setTimeout(r, 100))

    const before = registry.getById('test-heartbeat-1')?.lastSeen

    await new Promise(r => setTimeout(r, 200)) // wait to make timestamps differ

    await postMessage(sessionId, 'hive_heartbeat', {
      agent_id: 'test-heartbeat-1',
      status: 'idle',
    })
    await new Promise(r => setTimeout(r, 100))

    const after = registry.getById('test-heartbeat-1')?.lastSeen
    assert.notEqual(before, after, 'lastSeen should have been updated')

    close()
  })

  it('disconnecting SSE marks agent offline', async () => {
    const { sessionId, close } = await openSse()
    await new Promise(r => setTimeout(r, 50))

    await postMessage(sessionId, 'hive_register', {
      agent_id: 'test-disconnect-1',
      role: 'researcher',
    })
    await new Promise(r => setTimeout(r, 100))

    assert.equal(registry.getById('test-disconnect-1')?.status, 'online')

    close() // close SSE connection
    await new Promise(r => setTimeout(r, 200))

    assert.equal(registry.getById('test-disconnect-1')?.status, 'offline')
  })

  it('POST /message with unknown sessionId returns 404', async () => {
    const status = await postMessage('nonexistent-session-id', 'hive_register', {})
    assert.equal(status, 404)
  })
})
