import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { Blackboard } from '../blackboard/Blackboard.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const Shape = {
  agent_id: z.string().min(1),
  path: z.string().min(1).describe('Dot-notation path, e.g. "project.meta" or "state.blockers"'),
}

type Params = { agent_id: string; path: string }

export function registerBlackboardReadTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  blackboard: Blackboard,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_blackboard_read',
    'Read a value from the shared Blackboard using dot-notation path.',
    Shape,
    async (params: Params) => {
      try {
        const agent = agentRegistry.getById(params.agent_id)
        if (!agent) return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')

        const result = blackboard.read(agent.role, params.path)
        if (!result.ok) return toolErr(result.reason ?? 'Read denied', 'PERMISSION_DENIED')

        return toolOk({ path: params.path, value: result.value })
      } catch (err) {
        return toolErr(`Read failed: ${(err as Error).message}`)
      }
    },
  )
}
