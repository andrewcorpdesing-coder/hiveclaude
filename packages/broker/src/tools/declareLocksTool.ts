import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { FileLockRegistry } from '../agents/FileLockRegistry.js'
import type { EventQueue } from '../mcp/EventQueue.js'
import type { AuditLedger } from '../audit/AuditLedger.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const VALID_LOCK_TYPES = new Set(['READ', 'EXCLUSIVE', 'SOFT'])

const DeclareLocksShape = {
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
  files: z.record(z.string()).describe(
    'Map of relative_file_path → lock_type. ' +
    'Lock types: READ (shared read), EXCLUSIVE (no others), SOFT (advisory, never blocks)',
  ),
}

type DeclareLocksParams = {
  agent_id: string
  task_id: string
  files: Record<string, string>
}

export function registerDeclareLocksToolTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  fileLockRegistry: FileLockRegistry,
  eventQueue: EventQueue,
  auditLedger?: AuditLedger,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_declare_files',
    'Declare the files you need for your task and request locks. ' +
    'Call BEFORE starting work. Locks granted immediately when compatible; ' +
    'queued when blocked by another agent. ' +
    'Types: READ=shared read, EXCLUSIVE=no others can touch it, SOFT=advisory only.',
    DeclareLocksShape,
    async (params: DeclareLocksParams) => {
      try {
        const agent = agentRegistry.getById(params.agent_id)
        if (!agent) {
          return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')
        }

        // Validate all lock types
        for (const [filePath, lockType] of Object.entries(params.files)) {
          if (!VALID_LOCK_TYPES.has(lockType)) {
            return toolErr(
              `Invalid lock type "${lockType}" for "${filePath}". Valid: READ | EXCLUSIVE | SOFT`,
              'INVALID_LOCK_TYPE',
            )
          }
        }

        const { result, contention } = fileLockRegistry.declare(
          params.agent_id,
          params.task_id,
          params.files as Record<string, 'READ' | 'EXCLUSIVE' | 'SOFT'>,
        )

        // Notify current lock owners of contention
        for (const notice of contention) {
          eventQueue.push(notice.ownerAgentId, 'lock_contention_notice', {
            filePath: notice.filePath,
            waitingAgentId: notice.waitingAgentId,
            waitingAgentRole: agentRegistry.getById(notice.waitingAgentId)?.role,
            queuePosition: notice.queuePosition,
          })
        }

        const grantedCount = Object.keys(result.granted).length
        const queuedCount = Object.keys(result.queued).length
        auditLedger?.log({
          agentId: params.agent_id,
          action: 'lock_declare',
          target: params.task_id,
          detail: { granted: result.granted, queued: Object.keys(result.queued) },
          result: 'ok',
        })

        console.log(
          `[locks] ${params.agent_id}: granted ${grantedCount}, queued ${queuedCount} ` +
          `(task: ${params.task_id})`,
        )

        return toolOk({ granted: result.granted, queued: result.queued })
      } catch (err) {
        return toolErr(`Declare files failed: ${(err as Error).message}`)
      }
    },
  )
}
