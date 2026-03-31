import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const ListAgentsShape = {
  include_offline: z.boolean().optional().describe('Include offline agents in results. Default: false.'),
}

type ListAgentsParams = {
  include_offline?: boolean
}

export function registerListAgentsTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
): void {
  // Cast to any — SDK ZodRawShape generics exceed TS depth limit (TS2589); runtime is correct
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_list_agents',
    'List agents registered with the broker. Returns id, role, status, skills, and last_seen. ' +
    'Use to discover available agents for messaging or task delegation.',
    ListAgentsShape,
    async (params: ListAgentsParams) => {
      try {
        const agents = params.include_offline
          ? agentRegistry.getAll()
          : agentRegistry.getOnline()

        return toolOk({
          agents: agents.map(a => ({
            id: a.id,
            role: a.role,
            status: a.status,
            skills: a.skills,
            lastSeen: a.lastSeen,
            currentTaskId: a.currentTaskId,
          })),
          total: agents.length,
        })
      } catch (err) {
        return toolErr(`List agents failed: ${(err as Error).message}`)
      }
    },
  )
}
