import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { FileLockRegistry } from '../agents/FileLockRegistry.js'
import type { EventQueue } from '../mcp/EventQueue.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const ReleaseLocksShape = {
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
  file_paths: z.array(z.string()).optional().describe(
    'Specific files to release. If omitted, releases ALL locks for this agent+task.',
  ),
}

type ReleaseLocksParams = {
  agent_id: string
  task_id: string
  file_paths?: string[]
}

export function registerReleaseLocksToolTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  fileLockRegistry: FileLockRegistry,
  eventQueue: EventQueue,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_release_locks',
    'Release file locks when done with files. ' +
    'Omit file_paths to release ALL locks for the current task. ' +
    'Call before hive_complete_task. ' +
    'Waiting agents will be notified automatically.',
    ReleaseLocksShape,
    async (params: ReleaseLocksParams) => {
      try {
        const agent = agentRegistry.getById(params.agent_id)
        if (!agent) {
          return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')
        }

        const { released, promoted } = fileLockRegistry.release(
          params.agent_id,
          params.task_id,
          params.file_paths,
        )

        // Notify agents that received a lock from the queue
        for (const p of promoted) {
          eventQueue.push(p.agentId, 'lock_granted', {
            filePath: p.filePath,
            lockType: p.lockType,
            grantedAt: new Date().toISOString(),
          })
          console.log(`[locks] Promoted: ${p.agentId} → ${p.lockType} on ${p.filePath}`)
        }

        console.log(`[locks] Released ${released.length} lock(s) for ${params.agent_id}`)

        return toolOk({
          released,
          promoted_to: promoted.map(p => ({ agentId: p.agentId, filePath: p.filePath, lockType: p.lockType })),
        })
      } catch (err) {
        return toolErr(`Release locks failed: ${(err as Error).message}`)
      }
    },
  )
}
