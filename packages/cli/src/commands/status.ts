import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import { loadConfig, brokerUrl } from '../config.js'

interface PingResponse {
  ok: boolean
  message: string
  version: string
  agents_online: number
  sessions: number
}

export async function runStatus(cwd: string = process.cwd()): Promise<void> {
  const config = loadConfig(cwd)
  const pidFile = join(cwd, '.hive', 'broker.pid')
  const base = brokerUrl(cwd)

  // PID file check
  let pidInfo = chalk.dim('not started')
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    pidInfo = isRunning(pid)
      ? chalk.green(`running  (pid ${pid})`)
      : chalk.red(`dead     (pid ${pid}, stale PID file)`)
  }

  console.log(chalk.bold('Hive Mind Broker'))
  console.log(`  project  ${chalk.cyan(config.project)}`)
  console.log(`  port     ${chalk.cyan(String(config.broker.port))}`)
  console.log(`  process  ${pidInfo}`)

  // Live ping
  try {
    const res = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as PingResponse
    console.log(`  broker   ${chalk.green('online')}   v${data.version}`)
    console.log(`  agents   ${chalk.yellow(String(data.agents_online))} online`)
    console.log(`  sessions ${chalk.yellow(String(data.sessions))} active`)
  } catch {
    console.log(`  broker   ${chalk.red('offline')}  (cannot reach ${base}/ping)`)
  }
}

export async function runAgents(cwd: string = process.cwd()): Promise<void> {
  const base = brokerUrl(cwd)
  try {
    const res = await fetch(`${base}/admin/agents?status=online`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { count: number; agents: Array<{ id: string; role: string; status: string; skills: string[] }> }

    if (data.count === 0) {
      console.log(chalk.dim('No agents online.'))
      return
    }
    console.log(chalk.bold(`${data.count} agent(s) online:\n`))
    for (const a of data.agents) {
      const skills = a.skills.length ? chalk.dim(` [${a.skills.join(', ')}]`) : ''
      console.log(`  ${chalk.green('●')} ${chalk.cyan(a.id)}  ${a.role}${skills}`)
    }
  } catch {
    console.error(chalk.red('✖') + `  Cannot reach broker at ${base}`)
    process.exit(1)
  }
}

export async function runTasks(statusFilter: string | undefined, cwd: string = process.cwd()): Promise<void> {
  const base = brokerUrl(cwd)
  const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ''
  try {
    const res = await fetch(`${base}/admin/tasks${qs}`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { count: number; tasks: Array<{ id: string; title: string; status: string; priority: number; assignedTo: string | null }> }

    const label = statusFilter ? `status=${statusFilter}` : 'all'
    console.log(chalk.bold(`${data.count} task(s) [${label}]:\n`))

    const statusColor: Record<string, (s: string) => string> = {
      pending:       chalk.dim,
      assigned:      chalk.yellow,
      in_progress:   chalk.cyan,
      qa_pending:    chalk.magenta,
      needs_revision:chalk.red,
      completed:     chalk.green,
      failed:        chalk.red,
      blocked:       chalk.red,
    }

    for (const t of data.tasks) {
      const color = statusColor[t.status] ?? ((s: string) => s)
      const assignee = t.assignedTo ? chalk.dim(` → ${t.assignedTo}`) : ''
      const prio = chalk.dim(`[P${t.priority}]`)
      console.log(`  ${prio} ${color(t.status.padEnd(14))} ${t.title}${assignee}`)
    }
  } catch {
    console.error(chalk.red('✖') + `  Cannot reach broker at ${base}`)
    process.exit(1)
  }
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
