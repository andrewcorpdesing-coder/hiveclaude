export type AgentRole =
  | 'orchestrator'
  | 'coder-backend'
  | 'coder-frontend'
  | 'reviewer'
  | 'researcher'
  | 'architect'
  | 'devops'

export type AgentStatus = 'online' | 'offline' | 'busy' | 'idle'

export interface AgentRecord {
  id: string
  role: AgentRole
  status: AgentStatus
  skills: string[]
  reconnectToken: string
  connectedAt: string | null
  lastSeen: string | null
  currentTaskId: string | null
}

export interface HiveEvent {
  type: string
  payload: Record<string, unknown>
  timestamp: string
}

export interface ToolSuccess<T = unknown> {
  ok: true
  result: T
  pending_events: HiveEvent[]
}

export interface ToolFailure {
  ok: false
  error: string
  code?: string
}

export type ToolPayload<T = unknown> = ToolSuccess<T> | ToolFailure
