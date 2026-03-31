import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { MessageBus } from '../mcp/MessageBus.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const VALID_MESSAGE_TYPES = new Set([
  'direct', 'help_request', 'help_response', 'awareness',
  'peer_review_request', 'peer_review_response', 'status_update',
  'question', 'answer', 'warning', 'escalation',
])

const VALID_PRIORITIES = new Set(['normal', 'high', 'urgent'])

const SendShape = {
  from_agent_id: z.string().min(1),
  to_agent_id: z.string().optional().describe('Target agent ID. Omit for broadcast to all online agents.'),
  message_type: z.string().describe(
    'direct | help_request | help_response | awareness | peer_review_request | ' +
    'peer_review_response | status_update | question | answer | warning | escalation',
  ),
  content: z.string().min(1).describe('Message body — free text or JSON string'),
  priority: z.string().optional().describe('normal | high | urgent — default: normal'),
}

type SendParams = {
  from_agent_id: string
  to_agent_id?: string
  message_type: string
  content: string
  priority?: string
}

export function registerSendTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  messageBus: MessageBus,
): void {
  // Cast to any — SDK ZodRawShape generics exceed TS depth limit (TS2589); runtime is correct
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_send',
    'Send a direct message to a specific agent, or broadcast to all online agents. ' +
    'Messages are queued and delivered on the next heartbeat of the recipient.',
    SendShape,
    async (params: SendParams) => {
      try {
        if (!VALID_MESSAGE_TYPES.has(params.message_type)) {
          return toolErr(
            `Invalid message_type: ${params.message_type}. Valid: ${[...VALID_MESSAGE_TYPES].join(', ')}`,
            'INVALID_MESSAGE_TYPE',
          )
        }

        const priority = (params.priority ?? 'normal') as 'normal' | 'high' | 'urgent'
        if (!VALID_PRIORITIES.has(priority)) {
          return toolErr(
            `Invalid priority: ${params.priority}. Valid: normal | high | urgent`,
            'INVALID_PRIORITY',
          )
        }

        const sender = agentRegistry.getById(params.from_agent_id)
        if (!sender) {
          return toolErr(`Unknown sender: ${params.from_agent_id}`, 'AGENT_NOT_FOUND')
        }

        let targetIds: string[]

        if (params.to_agent_id) {
          const target = agentRegistry.getById(params.to_agent_id)
          if (!target) {
            return toolErr(`Unknown target: ${params.to_agent_id}`, 'AGENT_NOT_FOUND')
          }
          targetIds = [params.to_agent_id]
        } else {
          // Broadcast — all online agents except sender
          targetIds = agentRegistry
            .getOnline()
            .map(a => a.id)
            .filter(id => id !== params.from_agent_id)
        }

        if (targetIds.length === 0) {
          return toolOk({ ok: true, delivered_to: 0, note: 'No online agents to receive message' })
        }

        messageBus.send({
          fromAgentId: params.from_agent_id,
          toAgentId: params.to_agent_id,
          targetIds,
          messageType: params.message_type,
          content: params.content,
          priority,
        })

        return toolOk({
          ok: true,
          delivered_to: targetIds.length,
          targets: targetIds,
        })
      } catch (err) {
        return toolErr(`Send failed: ${(err as Error).message}`)
      }
    },
  )
}
