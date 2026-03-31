import type { HiveEvent } from '../types.js'

/**
 * Per-agent queue of pending events.
 * Events are delivered as piggyback on the next tool call response.
 */
export class EventQueue {
  private queues = new Map<string, HiveEvent[]>()

  push(agentId: string, type: string, payload: Record<string, unknown>): void {
    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, [])
    }
    this.queues.get(agentId)!.push({
      type,
      payload,
      timestamp: new Date().toISOString(),
    })
  }

  /** Returns and clears all pending events for an agent */
  drain(agentId: string): HiveEvent[] {
    const events = this.queues.get(agentId) ?? []
    this.queues.delete(agentId)
    return events
  }

  peek(agentId: string): HiveEvent[] {
    return this.queues.get(agentId) ?? []
  }

  clear(agentId: string): void {
    this.queues.delete(agentId)
  }
}
