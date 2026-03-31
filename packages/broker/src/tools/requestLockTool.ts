import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { FileLockRegistry } from '../agents/FileLockRegistry.js'
import type { EventQueue } from '../mcp/EventQueue.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const RequestLockShape = {
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
  file_path: z.string().min(1),
  lock_type: z.string().describe('READ | EXCLUSIVE | SOFT'),
  reason: z.string().optional().describe('Why this file is needed mid-task'),
}

type RequestLockParams = {
  agent_id: string
  task_id: string
  file_path: string
  lock_type: string
  reason?: string
}

const VALID = new Set(['READ', 'EXCLUSIVE', 'SOFT'])

export function registerRequestLockTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  fileLockRegistry: FileLockRegistry,
  eventQueue: EventQueue,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_request_lock',
    'Request a lock on a single file discovered mid-task. ' +
    'Use when you find you need a file not declared upfront.',
    RequestLockShape,
    async (params: RequestLockParams) => {
      try {
        const agent = agentRegistry.getById(params.agent_id)
        if (!agent) {
          return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')
        }
        if (!VALID.has(params.lock_type)) {
          return toolErr(
            `Invalid lock_type: ${params.lock_type}. Valid: READ | EXCLUSIVE | SOFT`,
            'INVALID_LOCK_TYPE',
          )
        }

        const { result, contention } = fileLockRegistry.request(
          params.agent_id,
          params.task_id,
          params.file_path,
          params.lock_type as 'READ' | 'EXCLUSIVE' | 'SOFT',
        )

        for (const notice of contention) {
          eventQueue.push(notice.ownerAgentId, 'lock_contention_notice', {
            filePath: notice.filePath,
            waitingAgentId: notice.waitingAgentId,
            waitingAgentRole: agentRegistry.getById(notice.waitingAgentId)?.role,
            queuePosition: notice.queuePosition,
          })
        }

        return toolOk({ granted: result.granted, queued: result.queued })
      } catch (err) {
        return toolErr(`Request lock failed: ${(err as Error).message}`)
      }
    },
  )
}
