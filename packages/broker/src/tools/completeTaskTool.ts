import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { TaskStore } from '../agents/TaskStore.js'
import type { MessageBus } from '../mcp/MessageBus.js'
import type { AuditLedger } from '../audit/AuditLedger.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const CompleteTaskShape = {
  task_id: z.string().min(1),
  agent_id: z.string().min(1),
  summary: z.string().min(1).describe('What was implemented, decisions taken, files modified'),
  files_modified: z.array(z.string()).optional(),
  test_results: z.record(z.unknown()).optional(),
  notes_for_reviewer: z.string().optional().describe('Context specifically for the QA reviewer'),
}

type CompleteTaskParams = {
  task_id: string
  agent_id: string
  summary: string
  files_modified?: string[]
  test_results?: Record<string, unknown>
  notes_for_reviewer?: string
}

export function registerCompleteTaskTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  taskStore: TaskStore,
  messageBus: MessageBus,
  auditLedger?: AuditLedger,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_complete_task',
    'Mark your current task as complete and submit for QA review. ' +
    'Call only AFTER releasing all file locks. ' +
    'The task enters qa_pending state and the orchestrator is notified.',
    CompleteTaskShape,
    async (params: CompleteTaskParams) => {
      try {
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
        if (!['assigned', 'in_progress', 'blocked', 'needs_revision'].includes(task.status)) {
          return toolErr(
            `Cannot complete task with status: ${task.status}`,
            'INVALID_TASK_STATUS',
          )
        }

        const completed = taskStore.complete({
          taskId: params.task_id,
          agentId: params.agent_id,
          summary: params.summary,
          filesModified: params.files_modified,
          testResults: params.test_results,
          notesForReviewer: params.notes_for_reviewer,
        })

        auditLedger?.log({
          agentId: params.agent_id,
          action: 'task_complete',
          target: params.task_id,
          detail: { filesModified: params.files_modified ?? [] },
          result: 'ok',
        })

        console.log(`[tasks] Completed (qa_pending): ${params.task_id} by ${params.agent_id}`)

        // Notify orchestrators
        const orchestrators = agentRegistry.getOnline().filter(a => a.role === 'orchestrator')
        for (const orch of orchestrators) {
          messageBus.send({
            fromAgentId: params.agent_id,
            toAgentId: orch.id,
            targetIds: [orch.id],
            messageType: 'status_update',
            content: JSON.stringify({
              event: 'task_submitted_for_qa',
              taskId: params.task_id,
              title: task.title,
              summary: params.summary,
              filesModified: params.files_modified ?? [],
            }),
            priority: 'normal',
          })
        }

        return toolOk({
          ok: true,
          taskId: completed.id,
          status: completed.status,
          message: 'Task submitted for QA review',
        })
      } catch (err) {
        return toolErr(`Complete task failed: ${(err as Error).message}`)
      }
    },
  )
}
