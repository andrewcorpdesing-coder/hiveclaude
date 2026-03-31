import type { HiveEvent, ToolPayload } from '../types.js'

type ContentBlock = { type: 'text'; text: string }

export interface McpToolResult {
  [key: string]: unknown
  content: ContentBlock[]
  isError?: boolean
}

export function toolOk<T>(result: T, pendingEvents: HiveEvent[] = []): McpToolResult {
  const payload: ToolPayload<T> = { ok: true, result, pending_events: pendingEvents }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }
}

export function toolErr(error: string, code?: string): McpToolResult {
  const payload: ToolPayload = { ok: false, error, code }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }
}
