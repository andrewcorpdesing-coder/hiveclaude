import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { AuditLedger } from '../audit/AuditLedger.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const Shape = {
  agent_id: z.string().min(1).describe('agent_id of the requester'),
  filter_agent_id: z.string().optional().describe('Only show entries from this agent'),
  action: z.string().optional().describe('Filter by action: agent_register | task_create | task_complete | lock_declare | blackboard_write'),
  result: z.string().optional().describe('Filter by result: ok | denied | error'),
  since: z.string().optional().describe('ISO timestamp — only entries after this time'),
  limit: z.number().optional().describe('Max rows to return (default 100, max 500)'),
}

type Params = {
  agent_id: string
  filter_agent_id?: string
  action?: string
  result?: string
  since?: string
  limit?: number
}

const VALID_RESULTS = new Set(['ok', 'denied', 'error'])

export function registerAuditLogTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  auditLedger: AuditLedger,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_audit_log',
    'Query the immutable audit log. Returns a reverse-chronological list of agent actions. ' +
    'Only orchestrators and reviewers can query all agents; others see only their own entries.',
    Shape,
    async (params: Params) => {
      try {
        const agent = agentRegistry.getById(params.agent_id)
        if (!agent) return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')

        if (params.result && !VALID_RESULTS.has(params.result)) {
          return toolErr(`Invalid result filter: ${params.result}`, 'INVALID_FILTER')
        }

        // Non-privileged agents can only see their own entries
        const canSeeAll = agent.role === 'orchestrator' || agent.role === 'reviewer'
        const agentIdFilter = canSeeAll
          ? (params.filter_agent_id ?? undefined)
          : params.agent_id

        const rows = auditLedger.query({
          agentId: agentIdFilter,
          action: params.action,
          result: params.result as 'ok' | 'denied' | 'error' | undefined,
          since: params.since,
          limit: params.limit,
        })

        return toolOk({
          count: rows.length,
          entries: rows.map(r => ({
            id: r.id,
            ts: r.ts,
            agentId: r.agent_id,
            action: r.action,
            target: r.target ?? undefined,
            detail: r.detail ? JSON.parse(r.detail) : undefined,
            result: r.result,
          })),
        })
      } catch (err) {
        return toolErr(`Audit query failed: ${(err as Error).message}`)
      }
    },
  )
}
