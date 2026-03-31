/**
 * Static permission table for Blackboard sections.
 *
 * Rules (from design spec):
 *  project.meta / .conventions   → orchestrator: RW,  all others: R
 *  project.architecture          → orchestrator + architect: RW,  others: R
 *  knowledge.discoveries / .warnings → all: R + append
 *  knowledge.external_apis       → all: R + merge
 *  state.sprint / .milestones    → orchestrator: RW,  others: R
 *  state.blockers                → all: R + append
 *  agents.{own_id}.*             → self: RW,  others: R
 *  qa.findings                   → reviewer: R+append,  others: R
 *  qa.metrics                    → reviewer: RW,  others: R
 *  qa.pending_review             → orchestrator + reviewer: RW,  others: DENIED
 */

export type WriteOp = 'set' | 'append' | 'merge'

export interface PermissionResult {
  allowed: boolean
  reason?: string
  allowedOperations?: WriteOp[]
}

const ALL_ROLES = ['orchestrator', 'coder-backend', 'coder-frontend', 'reviewer', 'researcher', 'architect', 'devops']
const CODER_ROLES = ['coder-backend', 'coder-frontend']
const ALL_OPS: WriteOp[] = ['set', 'append', 'merge']

export class BlackboardPermissions {

  /**
   * Check if an agent (by role) can READ a path.
   */
  canRead(agentRole: string, path: string): boolean {
    // qa.pending_review is denied to most roles
    if (path.startsWith('qa.pending_review')) {
      return agentRole === 'orchestrator' || agentRole === 'reviewer'
    }
    return true  // everything else is readable by all
  }

  /**
   * Check if an agent can WRITE (set/append/merge) a path.
   */
  canWrite(
    agentId: string,
    agentRole: string,
    path: string,
    operation: WriteOp,
  ): PermissionResult {
    const section = this.topSection(path)
    const sub = this.subSection(path)

    // ── project.* ────────────────────────────────────────────────────────────
    if (section === 'project') {
      if (sub === 'architecture') {
        if (agentRole === 'orchestrator' || agentRole === 'architect') {
          return { allowed: true }
        }
        return { allowed: false, reason: 'Only orchestrator and architect can write project.architecture', allowedOperations: [] }
      }
      // meta, conventions — orchestrator only
      if (agentRole === 'orchestrator') return { allowed: true }
      return { allowed: false, reason: `Only orchestrator can write project.${sub}`, allowedOperations: [] }
    }

    // ── knowledge.* ──────────────────────────────────────────────────────────
    if (section === 'knowledge') {
      if (sub === 'external_apis') {
        if (operation === 'set') {
          return { allowed: false, reason: 'Use merge operation for knowledge.external_apis', allowedOperations: ['merge'] }
        }
        return { allowed: true }
      }
      // discoveries, warnings — all can append
      if (operation === 'set') {
        return { allowed: false, reason: `Use append for knowledge.${sub}`, allowedOperations: ['append'] }
      }
      return { allowed: true }
    }

    // ── state.* ──────────────────────────────────────────────────────────────
    if (section === 'state') {
      if (sub === 'blockers') {
        // all can append
        if (operation === 'set') {
          return { allowed: false, reason: 'Use append for state.blockers', allowedOperations: ['append'] }
        }
        return { allowed: true }
      }
      // sprint, milestones — orchestrator only
      if (agentRole === 'orchestrator') return { allowed: true }
      return { allowed: false, reason: `Only orchestrator can write state.${sub}`, allowedOperations: [] }
    }

    // ── agents.* ─────────────────────────────────────────────────────────────
    if (section === 'agents') {
      // path is like "agents.coder-1.status" → sub = "coder-1.status"
      const ownedBy = sub.split('.')[0]  // first segment after "agents."
      if (ownedBy === agentId) {
        return { allowed: true }
      }
      return { allowed: false, reason: `You can only write to your own agents section (agents.${agentId}.*)`, allowedOperations: [] }
    }

    // ── qa.* ─────────────────────────────────────────────────────────────────
    if (section === 'qa') {
      if (sub === 'pending_review') {
        if (agentRole === 'orchestrator' || agentRole === 'reviewer') {
          return { allowed: true }
        }
        return { allowed: false, reason: 'qa.pending_review is restricted to orchestrator and reviewer', allowedOperations: [] }
      }
      if (sub === 'findings') {
        if (agentRole === 'reviewer') {
          if (operation === 'set') {
            return { allowed: false, reason: 'Use append for qa.findings', allowedOperations: ['append'] }
          }
          return { allowed: true }
        }
        return { allowed: false, reason: 'Only reviewer can write to qa.findings', allowedOperations: ['append'] }
      }
      if (sub === 'metrics') {
        if (agentRole === 'reviewer') return { allowed: true }
        return { allowed: false, reason: 'Only reviewer can write to qa.metrics', allowedOperations: [] }
      }
    }

    // Default: deny unknown paths
    return { allowed: false, reason: `Unknown blackboard section: ${section}`, allowedOperations: [] }
  }

  private topSection(path: string): string {
    return path.split('.')[0]
  }

  private subSection(path: string): string {
    return path.split('.').slice(1).join('.')
  }
}
