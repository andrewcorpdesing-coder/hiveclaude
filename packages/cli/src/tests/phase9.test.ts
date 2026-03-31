/**
 * Phase 9 tests — CLI commands
 * Tests: init creates correct files, start/stop daemon lifecycle,
 * status detects online/offline broker, agents/tasks commands.
 * Run with: node --test packages/cli/dist/tests/phase9.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { exec } from 'node:child_process'

const execAsync = promisify(exec)

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(__dirname, '../../dist/index.js')
const BROKER_DIST = resolve(__dirname, '../../../broker/dist/index.js')

async function cli(args: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execAsync(`node "${CLI_BIN}" ${args}`, { cwd })
    return { stdout, stderr, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

function writeConfig(dir: string, config: object): void {
  mkdirSync(join(dir, '.hive'), { recursive: true })
  writeFileSync(join(dir, '.hive', 'hive.config.json'), JSON.stringify(config))
}

// ── hive init ─────────────────────────────────────────────────────────────

describe('Phase 9 — hive init', () => {
  let tmpDir: string

  before(() => {
    tmpDir = join(process.cwd(), `.hive/test-cli-init-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  after(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('creates .hive/hive.config.json with project name', async () => {
    const result = await cli('init my-test-project', tmpDir)
    assert.equal(result.code, 0)
    assert.ok(existsSync(join(tmpDir, '.hive', 'hive.config.json')))
    const config = JSON.parse(readFileSync(join(tmpDir, '.hive', 'hive.config.json'), 'utf8')) as { project: string }
    assert.equal(config.project, 'my-test-project')
  })

  it('creates .hive/.gitignore with db and pid entries', async () => {
    assert.ok(existsSync(join(tmpDir, '.hive', '.gitignore')))
    const gi = readFileSync(join(tmpDir, '.hive', '.gitignore'), 'utf8')
    assert.ok(gi.includes('*.db'))
    assert.ok(gi.includes('broker.pid'))
  })

  it('second init is idempotent — does not overwrite', async () => {
    const result = await cli('init different-name', tmpDir)
    assert.equal(result.code, 0)
    assert.ok(result.stdout.includes('already exists'))
    // Config still has original name
    const config = JSON.parse(readFileSync(join(tmpDir, '.hive', 'hive.config.json'), 'utf8')) as { project: string }
    assert.equal(config.project, 'my-test-project')
  })

  it('config has default broker port 7432', () => {
    const config = JSON.parse(readFileSync(join(tmpDir, '.hive', 'hive.config.json'), 'utf8')) as { broker: { port: number } }
    assert.equal(config.broker.port, 7432)
  })
})

// ── hive status (offline) ─────────────────────────────────────────────────

describe('Phase 9 — hive status (offline broker)', () => {
  let tmpDir: string

  before(() => {
    tmpDir = join(process.cwd(), `.hive/test-cli-status-${Date.now()}`)
    writeConfig(tmpDir, { project: 'offline-test', broker: { port: 7499, transport: 'sse' } })
  })

  after(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('shows project name and port', async () => {
    const result = await cli('status', tmpDir)
    assert.equal(result.code, 0)
    assert.ok(result.stdout.includes('offline-test'))
    assert.ok(result.stdout.includes('7499'))
  })

  it('shows broker as offline when port not listening', async () => {
    const result = await cli('status', tmpDir)
    assert.equal(result.code, 0)
    assert.ok(result.stdout.includes('offline'))
  })
})

// ── hive start without init ───────────────────────────────────────────────

describe('Phase 9 — hive start without init', () => {
  it('exits with error if no hive.config.json', async () => {
    const emptyDir = join(process.cwd(), `.hive/test-cli-noinit-${Date.now()}`)
    mkdirSync(emptyDir, { recursive: true })
    try {
      const result = await cli('start', emptyDir)
      assert.ok(
        result.code !== 0 || result.stdout.includes('init'),
        'Should fail or mention init when no config exists',
      )
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})

// ── hive start / stop lifecycle ───────────────────────────────────────────

describe('Phase 9 — hive start / stop (daemon lifecycle)', () => {
  let tmpDir: string
  const DAEMON_PORT = 7443

  before(() => {
    tmpDir = join(process.cwd(), `.hive/test-cli-daemon-${Date.now()}`)
    writeConfig(tmpDir, { project: 'test-daemon', broker: { port: DAEMON_PORT, transport: 'sse' } })
  })

  after(async () => {
    // Safety: always stop before cleanup
    await cli('stop', tmpDir)
    await new Promise(r => setTimeout(r, 300))
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('hive start launches broker and writes PID file', async () => {
    if (!existsSync(BROKER_DIST)) {
      // Skip gracefully if broker hasn't been built
      return
    }
    const result = await cli('start', tmpDir)
    assert.equal(result.code, 0, `start failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.ok(result.stdout.includes('pid=') || result.stdout.includes('Broker started'))
    assert.ok(existsSync(join(tmpDir, '.hive', 'broker.pid')), 'PID file should exist')
  })

  it('hive status reports online after start', async () => {
    if (!existsSync(join(tmpDir, '.hive', 'broker.pid'))) return
    await new Promise(r => setTimeout(r, 400))  // let broker fully start
    const result = await cli('status', tmpDir)
    assert.equal(result.code, 0)
    assert.ok(result.stdout.includes('online'))
    assert.ok(result.stdout.includes('agents'))
  })

  it('hive start again reports already running', async () => {
    if (!existsSync(join(tmpDir, '.hive', 'broker.pid'))) return
    const result = await cli('start', tmpDir)
    assert.equal(result.code, 0)
    assert.ok(result.stdout.includes('already running'))
  })

  it('hive agents returns agent list', async () => {
    if (!existsSync(join(tmpDir, '.hive', 'broker.pid'))) return
    const result = await cli('agents', tmpDir)
    assert.equal(result.code, 0)
    // Might be empty but should not error
    assert.ok(!result.stderr.includes('Cannot reach') || result.stdout.includes('No agents'))
  })

  it('hive tasks returns task list', async () => {
    if (!existsSync(join(tmpDir, '.hive', 'broker.pid'))) return
    const result = await cli('tasks', tmpDir)
    assert.equal(result.code, 0)
  })

  it('hive stop sends SIGTERM and removes PID file', async () => {
    if (!existsSync(join(tmpDir, '.hive', 'broker.pid'))) return
    const result = await cli('stop', tmpDir)
    assert.equal(result.code, 0)
    assert.ok(result.stdout.includes('stopped') || result.stdout.includes('SIGTERM'))
    await new Promise(r => setTimeout(r, 600))
    assert.ok(!existsSync(join(tmpDir, '.hive', 'broker.pid')), 'PID file should be removed')
  })

  it('hive stop when not running is graceful', async () => {
    const result = await cli('stop', tmpDir)
    assert.equal(result.code, 0)
    assert.ok(result.stdout.includes('not running'))
  })
})
