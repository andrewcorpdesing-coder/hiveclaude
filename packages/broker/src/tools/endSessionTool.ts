import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomUUID } from 'node:crypto'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { Blackboard } from '../blackboard/Blackboard.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const EndSessionShape = {
  agent_id: z.string().min(1).describe('Your agent ID (must be orchestrator role)'),
  tasks_completed: z
    .array(z.string())
    .optional()
    .describe('Task IDs completed during this session'),
  tasks_blocked: z
    .array(z.string())
    .optional()
    .describe('Task IDs still blocked or in progress at session end'),
  key_decisions: z
    .array(z.string())
    .optional()
    .describe('Architectural or design decisions taken this session'),
  next_actions: z
    .array(z.string())
    .optional()
    .describe('Recommended first actions for the next session'),
  warnings: z
    .array(z.string())
    .optional()
    .describe('Issues, gotchas or risks discovered this session'),
  notes: z
    .string()
    .optional()
    .describe('Free-form summary of what happened this session'),
}

type EndSessionParams = {
  agent_id: string
  tasks_completed?: string[]
  tasks_blocked?: string[]
  key_decisions?: string[]
  next_actions?: string[]
  warnings?: string[]
  notes?: string
}

export function registerEndSessionTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  blackboard: Blackboard,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_end_session',
    'Save a structured session summary to the shared blackboard before stopping. ' +
    'Only orchestrators should call this. ' +
    'The summary persists in knowledge.session_log and is loaded on the next session startup, ' +
    'giving future orchestrators full context without re-exploring the project.',
    EndSessionShape,
    async (params: EndSessionParams) => {
      const agent = agentRegistry.getById(params.agent_id)
      if (!agent) return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')
      if (agent.role !== 'orchestrator') {
        return toolErr('Only orchestrators can call hive_end_session', 'FORBIDDEN')
      }

      const entry = {
        session_id: randomUUID(),
        timestamp: new Date().toISOString(),
        orchestrator_id: params.agent_id,
        tasks_completed: params.tasks_completed ?? [],
        tasks_blocked: params.tasks_blocked ?? [],
        key_decisions: params.key_decisions ?? [],
        next_actions: params.next_actions ?? [],
        warnings: params.warnings ?? [],
        notes: params.notes ?? '',
      }

      const result = blackboard.write(
        params.agent_id,
        'orchestrator',
        'knowledge.session_log',
        entry,
        'append',
      )

      if (!result.saved) {
        return toolErr(result.reason ?? 'Failed to write session log', 'WRITE_DENIED')
      }

      console.log(`[session] Session log saved by ${params.agent_id}`)
      return toolOk({
        ok: true,
        session_id: entry.session_id,
        timestamp: entry.timestamp,
        message: 'Session summary saved. Safe to stop.',
      })
    },
  )
}
