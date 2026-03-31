import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const VALID_ROLES = [
  'orchestrator',
  'coder-backend',
  'coder-frontend',
  'reviewer',
  'researcher',
  'architect',
  'devops',
] as const

export type AgentRole = typeof VALID_ROLES[number]

export interface PromptVars {
  agent_id: string
  project: string
  broker_url: string
}

export class PromptLoader {
  private promptsDir: string

  constructor(promptsDir?: string) {
    this.promptsDir = promptsDir ?? __dirname
  }

  /**
   * Returns the filled system prompt for a given role.
   * Substitutes {{agent_id}}, {{project}}, {{broker_url}}, {{port}}.
   */
  load(role: AgentRole, vars: PromptVars): string {
    const filePath = join(this.promptsDir, `${role}.md`)
    if (!existsSync(filePath)) {
      throw new Error(`No prompt found for role "${role}" at ${filePath}`)
    }
    const template = readFileSync(filePath, 'utf8')
    return this.fill(template, vars)
  }

  /**
   * Returns the raw (unfilled) template for a role.
   */
  raw(role: AgentRole): string {
    const filePath = join(this.promptsDir, `${role}.md`)
    if (!existsSync(filePath)) {
      throw new Error(`No prompt found for role "${role}" at ${filePath}`)
    }
    return readFileSync(filePath, 'utf8')
  }

  /**
   * List all available role prompt files.
   */
  availableRoles(): AgentRole[] {
    return VALID_ROLES.filter(role =>
      existsSync(join(this.promptsDir, `${role}.md`)),
    )
  }

  private fill(template: string, vars: PromptVars): string {
    const port = vars.broker_url.split(':').pop() ?? '7432'
    return template
      .replaceAll('{{agent_id}}', vars.agent_id)
      .replaceAll('{{project}}', vars.project)
      .replaceAll('{{broker_url}}', vars.broker_url)
      .replaceAll('{{port}}', port)
  }
}
