import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { TaskStore } from '../agents/TaskStore.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const Shape = {
  agent_id: z.string().min(1),
}

type Params = { agent_id: string }

export function registerGetPendingReviewsTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  taskStore: TaskStore,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_get_pending_reviews',
    'REVIEWER ONLY. Returns all tasks awaiting QA review (status=qa_pending), ' +
    'ordered by priority. Includes completion summary, files modified, and reviewer notes.',
    Shape,
    async (params: Params) => {
      try {
        const agent = agentRegistry.getById(params.agent_id)
        if (!agent) return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')
        if (agent.role !== 'reviewer' && agent.role !== 'orchestrator') {
          return toolErr('Only reviewers and orchestrators can list pending reviews', 'FORBIDDEN')
        }

        const tasks = taskStore.listByStatus('qa_pending')

        return toolOk({
          count: tasks.length,
          tasks: tasks.map(t => ({
            taskId: t.id,
            title: t.title,
            description: t.description,
            priority: t.priority,
            assignedTo: t.assignedTo,
            completionSummary: t.completionSummary,
            filesModified: t.filesModified ?? [],
            testResults: t.testResults,
            notesForReviewer: t.notesForReviewer,
            acceptanceCriteria: t.acceptanceCriteria,
            completedAt: t.completedAt,
          })),
        })
      } catch (err) {
        return toolErr(`Get pending reviews failed: ${(err as Error).message}`)
      }
    },
  )
}
