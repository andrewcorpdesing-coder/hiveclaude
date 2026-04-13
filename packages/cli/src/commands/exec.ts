import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import chalk from 'chalk'
import { loadConfig, ROLE_MODEL_DEFAULTS } from '../config.js'

const VALID_ROLES = [
  'orchestrator', 'coder-backend', 'coder-frontend',
  'reviewer', 'researcher', 'architect', 'devops',
]

const MODEL_SHORTHANDS: Record<string, string> = {
  opus:   'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
}

function resolveModel(s: string): string {
  return MODEL_SHORTHANDS[s] ?? s
}

function parseRoleSpec(spec: string): { role: string; modelOverride: string | null } | null {
  const colonIdx = spec.indexOf(':')
  const role = colonIdx >= 0 ? spec.slice(0, colonIdx) : spec
  const modelPart = colonIdx >= 0 ? spec.slice(colonIdx + 1) : null
  if (!VALID_ROLES.includes(role)) return null
  return { role, modelOverride: modelPart ? resolveModel(modelPart) : null }
}

export async function runExec(
  roleSpecs: string[],
  opts: { launch?: boolean; yolo?: boolean },
  cwd: string = process.cwd(),
): Promise<void> {
  const config = loadConfig(cwd)
  const autoStart = ' "."'  // always auto-start all agents
  const skipPerms = opts.yolo ? ' --dangerously-skip-permissions' : ''

  // Build list of { role, model } to show
  let targets: Array<{ role: string; model: string }>

  if (roleSpecs.length === 0) {
    // No roles specified → show all 7 with their configured models
    targets = VALID_ROLES.map(role => ({
      role,
      model: config.models[role] ?? ROLE_MODEL_DEFAULTS[role],
    }))
  } else {
    targets = []
    for (const spec of roleSpecs) {
      const parsed = parseRoleSpec(spec)
      if (!parsed) {
        console.error(chalk.red('✖') + `  Unknown role: ${spec.split(':')[0]}`)
        console.error(`   Valid roles: ${VALID_ROLES.join(', ')}`)
        process.exit(1)
      }
      const model = parsed.modelOverride
        ?? config.models[parsed.role]
        ?? ROLE_MODEL_DEFAULTS[parsed.role]
      targets.push({ role: parsed.role, model })
    }
  }

  // Warn about missing agent directories
  const missing = targets.filter(({ role }) => !existsSync(resolve(cwd, 'agents', role)))
  if (missing.length > 0) {
    console.log(chalk.yellow('⚠') + `  Missing: ${missing.map(r => r.role).join(', ')} — run ${chalk.cyan('hive scaffold')} first`)
    console.log('')
  }

  // Print commands
  console.log(chalk.bold('  Open each in a separate terminal:\n'))
  for (const { role, model } of targets) {
    const dir = `agents/${role}`
    const perms = opts.yolo && role !== 'orchestrator' && role !== 'reviewer' ? skipPerms : ''
    console.log(`  ${chalk.cyan(role.padEnd(18))}  ${chalk.dim('$')} cd ${dir} && claude --model ${model}${perms} "."`)
  }
  console.log('')

  if (opts.launch) {
    await launchAll(targets, cwd, skipPerms, autoStart)
  } else {
    console.log(chalk.dim('  Tip: add --launch to open terminals automatically (best-effort)'))
  }
}

async function launchAll(
  targets: Array<{ role: string; model: string }>,
  cwd: string,
  skipPerms: string,
  autoStart: string,
): Promise<void> {
  console.log(chalk.bold('  Launching terminals...\n'))

  // Filter to existing agent directories
  const available = targets.filter(({ role }) => {
    const exists = existsSync(resolve(cwd, 'agents', role))
    if (!exists) console.log(chalk.dim(`  skip  ${role} (directory not found)`))
    return exists
  })

  if (available.length === 0) return

  const launched = tryLaunchAll(available, cwd, skipPerms, autoStart)
  if (launched) {
    for (const { role } of available) console.log(chalk.green('  ✔') + `  ${role}`)
  } else {
    console.log(chalk.yellow('  ⚠') + '  could not open terminal — run each command manually above')
  }
}

/**
 * Opens all agents in a single terminal window (tabbed).
 *
 * Windows: one `wt` command with "; new-tab" separators — all agents share one
 *   Windows Terminal window, each in its own tab.
 * macOS: opens all in one Terminal.app window via AppleScript.
 * Linux: falls back to one process per agent (no standard multi-tab protocol).
 */
function tryLaunchAll(
  targets: Array<{ role: string; model: string }>,
  cwd: string,
  skipPerms: string,
  autoStart: string,
): boolean {
  try {
    if (process.platform === 'win32') {
      return launchWindowsTerminal(targets, cwd, skipPerms, autoStart)
    }

    if (process.platform === 'darwin') {
      return launchMacTerminal(targets, cwd, skipPerms, autoStart)
    }

    return launchLinux(targets, cwd, skipPerms, autoStart)
  } catch {
    return false
  }
}

/**
 * Windows Terminal: builds a single `wt` compound command with split panes.
 *   wt -d <dir1> --title <role1> cmd /k <cmd1> ; split-pane -H -d <dir2> --title <role2> cmd /k <cmd2> ...
 * All agents share one WT window, each in its own horizontal pane.
 */
function launchWindowsTerminal(
  targets: Array<{ role: string; model: string }>,
  cwd: string,
  skipPerms: string,
  autoStart: string,
): boolean {
  const wtArgs: string[] = []
  for (let i = 0; i < targets.length; i++) {
    const { role, model } = targets[i]
    const agentDir = resolve(cwd, 'agents', role)
    const claudeCmd = `claude --model ${model}${skipPerms}${autoStart}`
    if (i > 0) wtArgs.push(';', 'split-pane', '-H')
    wtArgs.push('-d', agentDir, '--title', role, 'cmd', '/k', claudeCmd)
  }
  try {
    spawn('wt', wtArgs, { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    // wt not available — fall back to separate cmd windows
    for (const { role, model } of targets) {
      const agentDir = resolve(cwd, 'agents', role)
      const claudeCmd = `claude --model ${model}${skipPerms}${autoStart}`
      spawn('cmd', ['/c', 'start', 'cmd', '/k', `cd /d "${agentDir}" && ${claudeCmd}`], {
        detached: true, stdio: 'ignore',
      }).unref()
    }
    return true
  }
}

/**
 * macOS: opens each agent as a new tab in Terminal.app via AppleScript.
 */
function launchMacTerminal(
  targets: Array<{ role: string; model: string }>,
  cwd: string,
  skipPerms: string,
  autoStart: string,
): boolean {
  const scripts = targets.map(({ role, model }) => {
    const agentDir = resolve(cwd, 'agents', role)
    const claudeCmd = `claude --model ${model}${skipPerms}${autoStart}`
    return `tell application "Terminal" to do script "cd '${agentDir}' && ${claudeCmd}"`
  })
  spawn('osascript', ['-e', scripts.join('\n')], { detached: true, stdio: 'ignore' }).unref()
  return true
}

/**
 * Linux: no standard multi-tab protocol — spawns one process per agent.
 */
function launchLinux(
  targets: Array<{ role: string; model: string }>,
  cwd: string,
  skipPerms: string,
  autoStart: string,
): boolean {
  let anyLaunched = false
  for (const { role, model } of targets) {
    const agentDir = resolve(cwd, 'agents', role)
    const claudeCmd = `claude --model ${model}${skipPerms}${autoStart}`
    for (const [term, args] of [
      ['gnome-terminal', ['--', 'bash', '-c', `cd "${agentDir}" && ${claudeCmd}; exec bash`]],
      ['konsole',        ['-e', `bash -c 'cd "${agentDir}" && ${claudeCmd}'`]],
      ['xterm',          ['-e', `bash -c 'cd "${agentDir}" && ${claudeCmd}'`]],
    ] as Array<[string, string[]]>) {
      try {
        spawn(term, args, { detached: true, stdio: 'ignore' }).unref()
        anyLaunched = true
        break
      } catch { continue }
    }
  }
  return anyLaunched
}
