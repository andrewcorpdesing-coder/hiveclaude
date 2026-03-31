import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TaskStore } from '../agents/TaskStore.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const GetTaskShape = {
  task_id: z.string().min(1),
}

type GetTaskParams = {
  task_id: string
}

export function registerGetTaskTool(
  server: McpServer,
  taskStore: TaskStore,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_get_task',
    'Get full details of a task by ID — description, status, dependencies, completion info.',
    GetTaskShape,
    async (params: GetTaskParams) => {
      try {
        const task = taskStore.getById(params.task_id)
        if (!task) {
          return toolErr(`Task not found: ${params.task_id}`, 'TASK_NOT_FOUND')
        }
        return toolOk({ task })
      } catch (err) {
        return toolErr(`Get task failed: ${(err as Error).message}`)
      }
    },
  )
}
