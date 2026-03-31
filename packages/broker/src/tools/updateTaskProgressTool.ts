import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { TaskStore } from '../agents/TaskStore.js'
import type { MessageBus } from '../mcp/MessageBus.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const VALID_PROGRESS_STATUSES = new Set(['in_progress', 'blocked', 'needs_help'])

const UpdateProgressShape = {
  task_id: z.string().min(1),
  agent_id: z.string().min(1),
  status: z.string().describe('in_progress | blocked | needs_help'),
  summary: z.string().min(1).describe('What has been done and what remains'),
  percent_complete: z.number().optional().describe('0–100'),
  blocking_reason: z.string().optional().describe('Required when status=blocked'),
}

type UpdateProgressParams = {
  task_id: string
  agent_id: string
  status: string
  summary: string
  percent_complete?: number
  blocking_reason?: string
}

export function registerUpdateTaskProgressTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  taskStore: TaskStore,
  messageBus: MessageBus,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_update_task_progress',
    'Report progress on your current task. ' +
    'Use status=blocked with blocking_reason when you cannot proceed — ' +
    'the orchestrator will be notified automatically.',
    UpdateProgressShape,
    async (params: UpdateProgressParams) => {
      try {
        if (!VALID_PROGRESS_STATUSES.has(params.status)) {
          return toolErr(
            `Invalid status: ${params.status}. Valid: in_progress | blocked | needs_help`,
            'INVALID_STATUS',
          )
        }

        const agent = agentRegistry.getById(params.agent_id)
        if (!agent) {
          return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')
        }

        const task = taskStore.getById(params.task_id)
        if (!task) {
          return toolErr(`Unknown task: ${params.task_id}`, 'TASK_NOT_FOUND')
        }
        if (task.assignedTo !== params.agent_id) {
          return toolErr('This task is not assigned to you', 'FORBIDDEN')
        }

        taskStore.addProgress({
          taskId: params.task_id,
          agentId: params.agent_id,
          status: params.status,
          summary: params.summary,
          percentComplete: params.percent_complete,
          blockingReason: params.blocking_reason,
        })

        // Notify orchestrator — blocked tasks get high priority
        const orchestrators = agentRegistry.getOnline().filter(a => a.role === 'orchestrator')
        const isBlocked = params.status === 'blocked'
        const eventType = isBlocked ? 'task_blocked' : 'task_progress_update'
        const priority = isBlocked ? 'high' : 'normal'

        for (const orch of orchestrators) {
          messageBus.send({
            fromAgentId: params.agent_id,
            toAgentId: orch.id,
            targetIds: [orch.id],
            messageType: isBlocked ? 'warning' : 'status_update',
            content: JSON.stringify({
              event: eventType,
              taskId: params.task_id,
              status: params.status,
              summary: params.summary,
              percentComplete: params.percent_complete,
              blockingReason: params.blocking_reason,
            }),
            priority: priority as 'normal' | 'high',
          })
        }

        return toolOk({ ok: true, taskId: params.task_id, status: params.status })
      } catch (err) {
        return toolErr(`Update progress failed: ${(err as Error).message}`)
      }
    },
  )
}
