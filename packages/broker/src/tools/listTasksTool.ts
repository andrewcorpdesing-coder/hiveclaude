import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TaskStore } from '../agents/TaskStore.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const VALID_STATUSES = new Set([
  'pending', 'assigned', 'in_progress', 'qa_pending', 'qa_phase1_running',
  'qa_phase2_pending', 'needs_revision', 'completed', 'failed', 'blocked', 'cancelled',
])

const ListTasksShape = {
  status: z.string().optional().describe(
    'Filter by status: pending | assigned | in_progress | qa_pending | ' +
    'completed | blocked | cancelled — omit for all tasks',
  ),
  assigned_to: z.string().optional().describe('Filter by agent_id'),
}

type ListTasksParams = {
  status?: string
  assigned_to?: string
}

export function registerListTasksTool(
  server: McpServer,
  taskStore: TaskStore,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_list_tasks',
    'List tasks with optional filters. Use to get an overview of system workload, ' +
    'check pending tasks, or review what a specific agent is working on.',
    ListTasksShape,
    async (params: ListTasksParams) => {
      try {
        if (params.status && !VALID_STATUSES.has(params.status)) {
          return toolErr(`Invalid status: ${params.status}`, 'INVALID_STATUS')
        }

        let tasks
        if (params.assigned_to) {
          tasks = taskStore.listForAgent(params.assigned_to)
          if (params.status) tasks = tasks.filter(t => t.status === params.status)
        } else if (params.status) {
          tasks = taskStore.listByStatus(params.status)
        } else {
          tasks = taskStore.listAll()
        }

        return toolOk({
          tasks: tasks.map(t => ({
            taskId: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            assignedRole: t.assignedRole,
            assignedTo: t.assignedTo,
            dependsOn: t.dependsOn,
            createdAt: t.createdAt,
            lastUpdated: t.lastUpdated,
          })),
          total: tasks.length,
        })
      } catch (err) {
        return toolErr(`List tasks failed: ${(err as Error).message}`)
      }
    },
  )
}
