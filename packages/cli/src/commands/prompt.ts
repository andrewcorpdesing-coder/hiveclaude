import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import chalk from 'chalk'
import { loadConfig } from '../config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function findPromptsDir(): string {
  // 1. Monorepo dev layout
  const devDir = resolve(__dirname, '../../../broker/dist/prompts')
  if (existsSync(devDir)) return devDir

  // 2. Published package
  try {
    const req = createRequire(import.meta.url)
    const brokerMain = req.resolve('@hivemind/broker')
    return resolve(dirname(brokerMain), 'prompts')
  } catch { /* not installed */ }

  return devDir
}

const PROMPTS_DIR = findPromptsDir()

const VALID_ROLES = ['orchestrator', 'coder-backend', 'coder-frontend', 'reviewer', 'researcher', 'architect', 'devops']

export async function runPrompt(
  role: string,
  agentId: string | undefined,
  outputPath: string | undefined,
  cwd: string = process.cwd(),
): Promise<void> {
  if (!VALID_ROLES.includes(role)) {
    console.error(chalk.red('✖') + `  Unknown role: ${role}`)
    console.error(`   Valid roles: ${VALID_ROLES.join(', ')}`)
    process.exit(1)
  }

  // Dynamic import of PromptLoader from broker dist
  const loaderPath = resolve(PROMPTS_DIR, 'PromptLoader.js')
  if (!existsSync(loaderPath)) {
    console.error(chalk.red('✖') + '  Broker not built. Run: npm run build (in packages/broker)')
    process.exit(1)
  }

  const { PromptLoader } = await import(pathToFileURL(loaderPath).href) as { PromptLoader: new (dir: string) => { load: (role: string, vars: object) => string } }
  const loader = new PromptLoader(PROMPTS_DIR)

  const config = loadConfig(cwd)
  const id = agentId ?? `${role}-1`
  const brokerUrl = `http://localhost:${config.broker.port}`

  const prompt = loader.load(role as never, {
    agent_id: id,
    project: config.project,
    broker_url: brokerUrl,
  })

  if (outputPath) {
    const absPath = resolve(cwd, outputPath)
    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, prompt, 'utf8')
    console.log(chalk.green('✔') + `  Wrote prompt to ${outputPath}`)
  } else {
    // Print to stdout — ready to pipe or copy
    console.log(prompt)
  }
}

export async function runScaffold(cwd: string = process.cwd()): Promise<void> {
  const config = loadConfig(cwd)
  const port = config.broker?.port ?? 7432
  const brokerUrl = `http://localhost:${port}`
  const loaderPath = resolve(PROMPTS_DIR, 'PromptLoader.js')
  const hasPrompts = existsSync(loaderPath)

  // .mcp.json config pointing to the broker (Streamable HTTP transport)
  const mcpConfig = {
    mcpServers: {
      hivemind: {
        type: 'http',
        url: `${brokerUrl}/mcp`,
      },
    },
  }

  let loader: { load: (role: string, vars: object) => string } | null = null
  if (hasPrompts) {
    const { PromptLoader } = await import(pathToFileURL(loaderPath).href) as { PromptLoader: new (dir: string) => typeof loader }
    loader = new PromptLoader(PROMPTS_DIR) as typeof loader
  } else {
    console.log(chalk.yellow('⚠') + '  Broker not built — CLAUDE.md stubs will have instructions only.')
    console.log('   Run ' + chalk.cyan('npm run build') + ' in packages/broker to embed full prompts.')
  }

  for (const role of VALID_ROLES) {
    const agentDir = join(cwd, 'agents', role)
    mkdirSync(agentDir, { recursive: true })

    // ── CLAUDE.md ────────────────────────────────────────────────────────
    const claudeMd = join(agentDir, 'CLAUDE.md')
    if (!existsSync(claudeMd)) {
      let content: string
      if (loader) {
        content = (loader as { load: (role: string, vars: object) => string }).load(role as never, {
          agent_id: `${role}-1`,
          project: config.project,
          broker_url: brokerUrl,
        })
      } else {
        content = [
          `# ${role} agent`,
          ``,
          `Run the following command to regenerate the full system prompt:`,
          ``,
          `\`\`\``,
          `hive prompt ${role} --agent-id ${role}-1 --output agents/${role}/CLAUDE.md`,
          `\`\`\``,
        ].join('\n')
      }
      writeFileSync(claudeMd, content, 'utf8')
      console.log(chalk.green('✔') + `  Created agents/${role}/CLAUDE.md${loader ? '' : ' (stub)'}`)
    } else {
      console.log(chalk.dim(`  skip  agents/${role}/CLAUDE.md (already exists)`))
    }

    // ── .mcp.json ─────────────────────────────────────────────────────────
    const mcpJson = join(agentDir, '.mcp.json')
    writeFileSync(mcpJson, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8')
    console.log(chalk.green('✔') + `  Created agents/${role}/.mcp.json`)
  }

  console.log('')
  console.log('  Start each agent by opening a Claude Code session in its agents/<role>/ directory.')
  console.log('  Each CLAUDE.md will be picked up automatically as the system prompt.')
}
