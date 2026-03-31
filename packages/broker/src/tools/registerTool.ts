import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomUUID } from 'node:crypto'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { EventQueue } from '../mcp/EventQueue.js'
import type { HiveSession } from '../mcp/HttpServer.js'
import type { AgentRole } from '../types.js'
import type { AuditLedger } from '../audit/AuditLedger.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const VALID_ROLES = new Set([
  'orchestrator', 'coder-backend', 'coder-frontend',
  'reviewer', 'researcher', 'architect', 'devops',
])

// Simple shapes — no z.enum() to avoid TS2589 deep instantiation
const RegisterShape = {
  agent_id: z.string().min(1).describe('Unique agent ID, e.g. coder-backend-1'),
  role: z.string().describe('Agent role: orchestrator | coder-backend | coder-frontend | reviewer | researcher | architect | devops'),
  skills: z.array(z.string()).optional().describe('Active skills for this instance'),
  reconnect_token: z.string().optional().describe('Token from a previous session for reconnection'),
}

type RegisterParams = {
  agent_id: string
  role: string
  skills?: string[]
  reconnect_token?: string
}

export function registerRegisterTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  eventQueue: EventQueue,
  sessions: Map<string, HiveSession>,
  session: HiveSession,
  auditLedger?: AuditLedger,
): void {
  // Cast to any — SDK ZodRawShape generics exceed TS depth limit (TS2589); runtime is correct
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_register',
    'Register this agent with the Hive Mind broker. MUST be called before any other tool. ' +
    'Returns a reconnect_token to resume identity if session is interrupted.',
    RegisterShape,
    async (params: RegisterParams) => {
      try {
        if (!VALID_ROLES.has(params.role)) {
          return toolErr(`Invalid role: ${params.role}. Valid roles: ${[...VALID_ROLES].join(', ')}`, 'INVALID_ROLE')
        }

        let isReconnection = false
        if (params.reconnect_token) {
          const existing = agentRegistry.getByReconnectToken(params.reconnect_token)
          if (existing) isReconnection = true
        }

        const record = agentRegistry.register({
          agentId: params.agent_id,
          role: params.role as AgentRole,
          skills: params.skills ?? [],
          reconnectToken: isReconnection ? params.reconnect_token : randomUUID(),
        })

        session.agentId = record.id
        const pendingEvents = eventQueue.drain(record.id)

        for (const [sid, s] of sessions) {
          if (sid !== session.sessionId && s.agentId) {
            eventQueue.push(s.agentId, 'agent_joined', { agentId: record.id, role: record.role })
          }
        }

        auditLedger?.log({
          agentId: record.id,
          action: 'agent_register',
          detail: { role: record.role, isReconnection },
          result: 'ok',
        })

        console.log(`[registry] Agent ${isReconnection ? 'reconnected' : 'registered'}: ${record.id} (${record.role})`)

        return toolOk({
          agentId: record.id,
          role: record.role,
          reconnect_token: record.reconnectToken,
          is_reconnection: isReconnection,
        }, pendingEvents)
      } catch (err) {
        return toolErr(`Registration failed: ${(err as Error).message}`)
      }
    },
  )
}
