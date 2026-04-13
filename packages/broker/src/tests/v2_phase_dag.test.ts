/**
 * v0.4 DAG — Gap 1: hive_add_dependency + CPM
 *
 * Prueba:
 *   1. addDependency() — válida, inválida, ciclo, self-reference
 *   2. wouldCreateCycle() — detección de ciclos con BFS
 *   3. getCriticalPathBlockedCount() — CPM vs heurística simple
 *   4. getNewlyUnblockedTasks() — tareas desbloqueadas tras completar dep
 *
 * Run: node --test dist/tests/v2_phase_dag.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Database }    from '../db/Database.js'
import { TaskStore }   from '../agents/TaskStore.js'
import { AgentRegistry } from '../agents/AgentRegistry.js'

const BASE = `.hive/test-v2-dag-${Date.now()}`

interface Fixtures {
  db:       Database
  store:    TaskStore
  registry: AgentRegistry
  cleanup:  () => void
}

function makeFixtures(suffix: string): Fixtures {
  const dbPath = `${BASE}-${suffix}.db`
  const db      = new Database(dbPath)
  const store   = new TaskStore(db)
  const registry = new AgentRegistry(db)
  return {
    db, store, registry,
    cleanup: () => {
      registry.destroy()
      db.close()
      import('node:fs').then(fs => fs.default.unlinkSync(dbPath)).catch(() => {})
    },
  }
}

describe('v0.4 DAG — Gap 1: addDependency + CPM', () => {

  // ── addDependency() ───────────────────────────────────────────────────────

  describe('addDependency()', () => {
    let f: Fixtures
    before(() => { f = makeFixtures('add-dep') })
    after(()  => { f.cleanup() })

    it('crea una fila en task_dependencies', () => {
      const t1 = f.store.create({ title: 'T1', description: 'd', createdBy: 'o' })
      const t2 = f.store.create({ title: 'T2', description: 'd', createdBy: 'o' })

      const result = f.store.addDependency(t2.id, t1.id)
      assert.equal(result.ok, true, 'debe retornar ok')

      const row = f.db.prepare(
        'SELECT * FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?'
      ).get(t2.id, t1.id)
      assert.ok(row, 'fila debe existir en task_dependencies')
    })

    it('tarea con dependency sin completar no sale en getTopCandidates', () => {
      const t1 = f.store.create({ title: 'Prereq', description: 'd', createdBy: 'o', assignedRole: 'coder-backend' })
      const t2 = f.store.create({ title: 'Dependent', description: 'd', createdBy: 'o', assignedRole: 'coder-backend' })

      f.store.addDependency(t2.id, t1.id)

      const candidates = f.store.getTopCandidates('coder-backend', 20)
      const ids = candidates.map(c => c.id)
      assert.ok(!ids.includes(t2.id), 'tarea con dep sin completar no debe aparecer')
      assert.ok(ids.includes(t1.id), 'prereq debe aparecer')
    })

    it('retorna TASK_NOT_FOUND para task_id desconocido', () => {
      const t1 = f.store.create({ title: 'T1b', description: 'd', createdBy: 'o' })
      const result = f.store.addDependency('nonexistent-id', t1.id)
      assert.equal(result.ok, false)
      assert.equal((result as { code: string }).code, 'TASK_NOT_FOUND')
    })

    it('retorna TASK_NOT_FOUND para depends_on_id desconocido', () => {
      const t1 = f.store.create({ title: 'T1c', description: 'd', createdBy: 'o' })
      const result = f.store.addDependency(t1.id, 'nonexistent-dep')
      assert.equal(result.ok, false)
      assert.equal((result as { code: string }).code, 'TASK_NOT_FOUND')
    })

    it('retorna SELF_REFERENCE si task_id === depends_on_id', () => {
      const t1 = f.store.create({ title: 'Self', description: 'd', createdBy: 'o' })
      const result = f.store.addDependency(t1.id, t1.id)
      assert.equal(result.ok, false)
      assert.equal((result as { code: string }).code, 'SELF_REFERENCE')
    })

    it('retorna ALREADY_EXISTS si ya existe la dependencia', () => {
      const t1 = f.store.create({ title: 'T1-dup', description: 'd', createdBy: 'o' })
      const t2 = f.store.create({ title: 'T2-dup', description: 'd', createdBy: 'o' })
      f.store.addDependency(t2.id, t1.id)
      const result = f.store.addDependency(t2.id, t1.id)
      assert.equal(result.ok, false)
      assert.equal((result as { code: string }).code, 'ALREADY_EXISTS')
    })
  })

  // ── wouldCreateCycle() ────────────────────────────────────────────────────

  describe('wouldCreateCycle()', () => {
    let f: Fixtures
    before(() => { f = makeFixtures('cycle') })
    after(()  => { f.cleanup() })

    it('retorna false para edge válido', () => {
      const t1 = f.store.create({ title: 'A', description: 'd', createdBy: 'o' })
      const t2 = f.store.create({ title: 'B', description: 'd', createdBy: 'o' })
      assert.equal(f.store.wouldCreateCycle(t2.id, t1.id), false)
    })

    it('retorna true para ciclo directo A→B, B→A', () => {
      const tA = f.store.create({ title: 'CycleA', description: 'd', createdBy: 'o' })
      const tB = f.store.create({ title: 'CycleB', description: 'd', createdBy: 'o' })
      // Create A→B (B depends on A)
      f.db.prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run(tB.id, tA.id)
      // Now check: would B→A (A depends on B) create a cycle?
      // wouldCreateCycle(tA.id, tB.id): start BFS from tB, can we reach tA?
      // tB→tA (already in db), so yes → cycle
      assert.equal(f.store.wouldCreateCycle(tA.id, tB.id), true)
    })

    it('retorna true para ciclo transitivo A→B→C→A', () => {
      const tA = f.store.create({ title: 'TA', description: 'd', createdBy: 'o' })
      const tB = f.store.create({ title: 'TB', description: 'd', createdBy: 'o' })
      const tC = f.store.create({ title: 'TC', description: 'd', createdBy: 'o' })
      // B depends on A, C depends on B
      f.db.prepare('INSERT INTO task_dependencies VALUES (?,?)').run(tB.id, tA.id)
      f.db.prepare('INSERT INTO task_dependencies VALUES (?,?)').run(tC.id, tB.id)
      // Would adding A→C (A depends on C) create a cycle?
      // wouldCreateCycle(tA.id, tC.id): BFS from tC
      //   tC → tB (dep) → tA (dep) → found tA → cycle!
      assert.equal(f.store.wouldCreateCycle(tA.id, tC.id), true)
    })

    it('addDependency rechaza con WOULD_CREATE_CYCLE', () => {
      const tX = f.store.create({ title: 'X', description: 'd', createdBy: 'o' })
      const tY = f.store.create({ title: 'Y', description: 'd', createdBy: 'o' })
      f.store.addDependency(tY.id, tX.id)  // Y depends on X
      const result = f.store.addDependency(tX.id, tY.id)  // would create cycle
      assert.equal(result.ok, false)
      assert.equal((result as { code: string }).code, 'WOULD_CREATE_CYCLE')
    })
  })

  // ── getCriticalPathBlockedCount() ─────────────────────────────────────────

  describe('getCriticalPathBlockedCount()', () => {
    let f: Fixtures
    before(() => { f = makeFixtures('cpm') })
    after(()  => { f.cleanup() })

    it('sin tareas → 0', () => {
      assert.equal(f.store.getCriticalPathBlockedCount(), 0)
    })

    it('tarea blocked ON critical path → cuenta 1', () => {
      // Critical path: A(4h) → B(2h) → C(blocked, 1h)
      // Total = 7h. C is at the end with no slack.
      const tA = f.store.create({ title: 'CPM-A', description: 'd', createdBy: 'o', estimatedMs: 4*3600_000 })
      const tB = f.store.create({ title: 'CPM-B', description: 'd', createdBy: 'o', estimatedMs: 2*3600_000 })
      const tC = f.store.create({ title: 'CPM-C-blocked', description: 'd', createdBy: 'o', estimatedMs: 1*3600_000 })

      f.db.prepare("INSERT INTO task_dependencies VALUES (?,?)").run(tB.id, tA.id)
      f.db.prepare("INSERT INTO task_dependencies VALUES (?,?)").run(tC.id, tB.id)
      f.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(tA.id)
      f.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(tB.id)
      f.db.prepare("UPDATE tasks SET status='blocked' WHERE id=?").run(tC.id)

      assert.equal(f.store.getCriticalPathBlockedCount(), 1, 'C está en la ruta crítica, debe contar 1')
    })

    it('tarea blocked OFF critical path → no cuenta', () => {
      // Critical path: X(8h). Y(2h, blocked) is a parallel task with slack.
      // Float(Y) = project_duration - EF(Y) > 0
      const tX = f.store.create({ title: 'CPM-X-long', description: 'd', createdBy: 'o', estimatedMs: 8*3600_000 })
      const tY = f.store.create({ title: 'CPM-Y-blocked-short', description: 'd', createdBy: 'o', estimatedMs: 2*3600_000 })

      f.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(tX.id)
      f.db.prepare("UPDATE tasks SET status='blocked' WHERE id=?").run(tY.id)

      // No dependency between X and Y → they're parallel
      // EF(Y) = 2h, EF(X) = 8h → project_duration = 8h
      // Float(Y) = LS(Y) - ES(Y) = (8-2) - 0 = 6 > 0 → NOT on critical path
      const count = f.store.getCriticalPathBlockedCount()
      assert.equal(count, 0, 'Y no está en la ruta crítica, no debe contar')
    })
  })

  // ── getNewlyUnblockedTasks() ──────────────────────────────────────────────

  describe('getNewlyUnblockedTasks()', () => {
    let f: Fixtures
    before(() => { f = makeFixtures('unblock') })
    after(()  => { f.cleanup() })

    it('al completar dep, tarea dependiente aparece como desbloqueada', async () => {
      const t1 = f.store.create({ title: 'Prereq', description: 'd', createdBy: 'o', assignedRole: 'worker' })
      const t2 = f.store.create({ title: 'Blocked', description: 'd', createdBy: 'o', assignedRole: 'worker', dependsOn: [t1.id] })

      // Complete t1
      f.store.assign(t1.id, 'agent-1')
      f.store.startProgress(t1.id)
      f.store.complete({ taskId: t1.id, agentId: 'agent-1', summary: 'done' })
      f.store.approve({ taskId: t1.id, reviewerId: 'rev-1' })

      const unblocked = f.store.getNewlyUnblockedTasks(t1.id)
      const ids = unblocked.map(u => u.id)
      assert.ok(ids.includes(t2.id), 't2 debe aparecer como desbloqueada')
    })
  })

  // ── computeCPM() scheduler ────────────────────────────────────────────────

  describe('computeCPM() cadena lineal A→B→C: todos float=0, todos critical', () => {
    let f: Fixtures
    before(() => { f = makeFixtures('cpm-linear') })
    after(()  => { f.cleanup() })

    it('cadena lineal A→B→C: todos float=0, todos critical', () => {
      const tA = f.store.create({ title: 'A', description: 'd', createdBy: 'o', estimatedDuration: 60 })
      const tB = f.store.create({ title: 'B', description: 'd', createdBy: 'o', estimatedDuration: 60, dependsOn: [tA.id] })
      const tC = f.store.create({ title: 'C', description: 'd', createdBy: 'o', estimatedDuration: 60, dependsOn: [tB.id] })

      const a = f.store.getById(tA.id)!
      const b = f.store.getById(tB.id)!
      const c = f.store.getById(tC.id)!

      assert.equal(a.floatMinutes, 0,      'A float debe ser 0')
      assert.equal(b.floatMinutes, 0,      'B float debe ser 0')
      assert.equal(c.floatMinutes, 0,      'C float debe ser 0')
      assert.equal(a.isCriticalPath, true, 'A debe estar en ruta crítica')
      assert.equal(b.isCriticalPath, true, 'B debe estar en ruta crítica')
      assert.equal(c.isCriticalPath, true, 'C debe estar en ruta crítica')
    })
  })

  describe('computeCPM() rama no crítica: A(60)→C, B(10)→C — B tiene float positivo', () => {
    let f: Fixtures
    before(() => { f = makeFixtures('cpm-fork') })
    after(()  => { f.cleanup() })

    it('rama no crítica: A(60)→C, B(10)→C — B tiene float positivo', () => {
      const tA = f.store.create({ title: 'Fork-A', description: 'd', createdBy: 'o', estimatedDuration: 60 })
      const tB = f.store.create({ title: 'Fork-B', description: 'd', createdBy: 'o', estimatedDuration: 10 })
      const tC = f.store.create({ title: 'Fork-C', description: 'd', createdBy: 'o', estimatedDuration: 30, dependsOn: [tA.id, tB.id] })

      const a = f.store.getById(tA.id)!
      const b = f.store.getById(tB.id)!
      const c = f.store.getById(tC.id)!

      // ES(C) = max(EF(A)=60, EF(B)=10) = 60 → project end = 90
      // Float(A)=0, Float(C)=0 → críticos
      // Float(B) = LS(B) - ES(B) = 50 - 0 = 50 → no crítico
      assert.equal(a.isCriticalPath, true,  'A debe estar en ruta crítica')
      assert.equal(c.isCriticalPath, true,  'C debe estar en ruta crítica')
      assert.equal(b.isCriticalPath, false, 'B no debe estar en ruta crítica')
      assert.ok((b.floatMinutes ?? 0) > 0,  'B debe tener float positivo')
    })
  })

  describe('computeCPM() getNextAvailable() prefiere tarea crítica', () => {
    let f: Fixtures
    before(() => { f = makeFixtures('cpm-sched') })
    after(()  => { f.cleanup() })

    it('getNextAvailable() retorna tarea crítica antes que tarea con float alto', () => {
      // A(60) → B(60): A es crítica (float=0), C(10) es paralela con float alto
      // Ambas A y C disponibles (sin deps bloqueantes). getNextAvailable debe retornar A.
      const tA = f.store.create({ title: 'Sched-A', description: 'd', createdBy: 'o',
        assignedRole: 'coder-backend', estimatedDuration: 60 })
      const tB = f.store.create({ title: 'Sched-B', description: 'd', createdBy: 'o',
        assignedRole: 'coder-backend', estimatedDuration: 60, dependsOn: [tA.id] })
      const tC = f.store.create({ title: 'Sched-C', description: 'd', createdBy: 'o',
        assignedRole: 'coder-backend', estimatedDuration: 10 })

      // A: is_critical_path=1, float=0. C: float=110 (project=120, LS(C)=110). B: bloqueada.
      const next = f.store.getNextAvailable('coder-backend')
      assert.ok(next !== null, 'debe haber tarea disponible')
      assert.equal(next!.id, tA.id, 'debe retornar A (crítica) antes que C (float alto)')
    })
  })

  describe('computeCPM() recalcula tras approve()', () => {
    let f: Fixtures
    before(() => { f = makeFixtures('cpm-recalc') })
    after(()  => { f.cleanup() })

    it('computeCPM() recalcula tras approve(): A completada saca a B y C a float=0', () => {
      const tA = f.store.create({ title: 'Recalc-A', description: 'd', createdBy: 'o', estimatedDuration: 60 })
      const tB = f.store.create({ title: 'Recalc-B', description: 'd', createdBy: 'o', estimatedDuration: 60, dependsOn: [tA.id] })
      const tC = f.store.create({ title: 'Recalc-C', description: 'd', createdBy: 'o', estimatedDuration: 60, dependsOn: [tB.id] })

      // Completar A via flujo completo (approve() llama computeCPM)
      f.store.assign(tA.id, 'agent-x')
      f.store.startProgress(tA.id)
      f.store.complete({ taskId: tA.id, agentId: 'agent-x', summary: 'done' })
      f.store.approve({ taskId: tA.id, reviewerId: 'rev-x' })

      // Ahora solo B y C son activas. Ambas deben ser críticas con float=0.
      const b = f.store.getById(tB.id)!
      const c = f.store.getById(tC.id)!

      assert.equal(b.isCriticalPath, true, 'B debe ser crítica tras completar A')
      assert.equal(c.isCriticalPath, true, 'C debe ser crítica tras completar A')
      assert.equal(b.floatMinutes, 0, 'B float debe ser 0')
      assert.equal(c.floatMinutes, 0, 'C float debe ser 0')
    })
  })
})
