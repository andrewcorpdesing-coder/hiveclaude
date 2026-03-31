import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface AgentConfig {
  id: string
  role: string
  skills: string[]
  always_on?: boolean
  on_demand?: boolean
}

export interface HiveConfig {
  project: string
  broker: {
    port: number
    transport: string
  }
  agents: AgentConfig[]
  qa: {
    auto_lint: boolean
    auto_test: boolean
    ai_review: boolean
    escalate_threshold: string
    commands?: string[]
  }
  audit: {
    deferred: boolean
    trigger_on: string[]
    log_level: string
  }
  blackboard: Record<string, unknown>
}

const DEFAULT_CONFIG: HiveConfig = {
  project: 'unnamed',
  broker: { port: 7432, transport: 'sse' },
  agents: [],
  qa: { auto_lint: false, auto_test: false, ai_review: false, escalate_threshold: 'high' },
  audit: {
    deferred: true,
    trigger_on: ['milestone_complete', 'every_5_tasks', 'critical_issue'],
    log_level: 'inter_agent_messages',
  },
  blackboard: {},
}

export function loadConfig(cwd: string = process.cwd()): HiveConfig {
  const configPath = join(cwd, '.hive', 'hive.config.json')
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG
  }
  const raw = readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(raw) as Partial<HiveConfig>
  return { ...DEFAULT_CONFIG, ...parsed }
}
