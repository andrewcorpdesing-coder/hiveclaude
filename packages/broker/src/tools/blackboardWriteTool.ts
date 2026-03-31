import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { Blackboard } from '../blackboard/Blackboard.js'
import type { AuditLedger } from '../audit/AuditLedger.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const Shape = {
  agent_id: z.string().min(1),
  path: z.string().min(1).describe('Dot-notation path, e.g. "project.meta" or "knowledge.discoveries"'),
  value: z.unknown().describe('Value to write (any JSON-serialisable type)'),
  operation: z.string().optional().describe('set | append | merge — defaults to "set"'),
}

type Params = { agent_id: string; path: string; value: unknown; operation?: string }

const VALID_OPS = new Set(['set', 'append', 'merge'])

export function registerBlackboardWriteTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  blackboard: Blackboard,
  auditLedger?: AuditLedger,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_blackboard_write',
    'Write a value to the shared Blackboard. Use operation="append" for arrays, "merge" for objects, "set" to replace.',
    Shape,
    async (params: Params) => {
      try {
        const op = (params.operation ?? 'set') as 'set' | 'append' | 'merge'
        if (!VALID_OPS.has(op)) {
          return toolErr(`Invalid operation: ${op}. Use set | append | merge`, 'INVALID_OPERATION')
        }

        const agent = agentRegistry.getById(params.agent_id)
        if (!agent) return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')

        const result = blackboard.write(params.agent_id, agent.role, params.path, params.value, op)
        if (!result.allowed) {
          auditLedger?.log({
            agentId: params.agent_id,
            action: 'blackboard_write',
            target: params.path,
            detail: { operation: op, reason: result.reason },
            result: 'denied',
          })
          const detail = result.allowedOperations?.length
            ? ` Allowed: ${result.allowedOperations.join(', ')}`
            : ''
          return toolErr((result.reason ?? 'Write denied') + detail, 'PERMISSION_DENIED')
        }

        auditLedger?.log({
          agentId: params.agent_id,
          action: 'blackboard_write',
          target: params.path,
          detail: { operation: op },
          result: 'ok',
        })

        return toolOk({ path: params.path, operation: op, saved: true })
      } catch (err) {
        return toolErr(`Write failed: ${(err as Error).message}`)
      }
    },
  )
}
