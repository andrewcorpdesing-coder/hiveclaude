import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { FileLockRegistry } from '../agents/FileLockRegistry.js'
import type { EventQueue } from '../mcp/EventQueue.js'
import type { MessageBus } from '../mcp/MessageBus.js'
import type { AgentStatus } from '../types.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const VALID_STATUSES = new Set(['idle', 'busy', 'thinking'])

// Simple shape — no z.enum() to avoid TS2589 deep instantiation
const HeartbeatShape = {
  agent_id: z.string().min(1),
  status: z.string().optional().describe('idle | busy | thinking — omit to keep current status'),
}

type HeartbeatParams = {
  agent_id: string
  status?: string
}

export function registerHeartbeatTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  eventQueue: EventQueue,
  messageBus: MessageBus,
  fileLockRegistry: FileLockRegistry,
): void {
  // Cast to any — SDK ZodRawShape generics exceed TS depth limit (TS2589); runtime is correct
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_heartbeat',
    'Keep-alive signal. Call every 15 seconds to maintain session and file locks. ' +
    'Returns any pending events from the broker.',
    HeartbeatShape,
    async (params: HeartbeatParams) => {
      try {
        if (params.status && !VALID_STATUSES.has(params.status)) {
          return toolErr(`Invalid status: ${params.status}`, 'INVALID_STATUS')
        }

        const agent = agentRegistry.getById(params.agent_id)
        if (!agent) {
          return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')
        }

        agentRegistry.heartbeat(params.agent_id, params.status as AgentStatus | undefined)
        fileLockRegistry.refreshHeartbeat(params.agent_id)
        const pendingEvents = [
          ...eventQueue.drain(params.agent_id),
          ...messageBus.drain(params.agent_id),
        ]

        return toolOk({ ok: true }, pendingEvents)
      } catch (err) {
        return toolErr(`Heartbeat failed: ${(err as Error).message}`)
      }
    },
  )
}
