# Hive Mind

**Coordina múltiples instancias de Claude Code para que trabajen juntas en un mismo proyecto.**

Hive Mind es un broker MCP local que conecta varios agentes Claude Code entre sí. Cada agente tiene un rol (orquestador, coder, reviewer, etc.), comparte estado en una pizarra común, se coordina con tareas, bloqueos de archivos y mensajes directos — todo sin salir del terminal.

```
┌─────────────────────────────────────────────────────────┐
│                    Tu proyecto                          │
│                                                         │
│  agents/orchestrator/   agents/coder-backend/   ...    │
│  ┌─────────────────┐    ┌─────────────────┐            │
│  │  Claude Code    │    │  Claude Code    │            │
│  │  CLAUDE.md      │    │  CLAUDE.md      │            │
│  │  .mcp.json ─────┼────┼─── .mcp.json   │            │
│  └────────┬────────┘    └────────┬────────┘            │
│           │                      │                      │
│           └──────────┬───────────┘                      │
│                      ▼                                  │
│              ┌───────────────┐                          │
│              │  hive broker  │  :7432                  │
│              │  /mcp  /ping  │                          │
│              │  SQLite + BB  │                          │
│              └───────────────┘                          │
└─────────────────────────────────────────────────────────┘
```

---

## Prerequisitos

- **Node.js 22+** (usa `node:sqlite` built-in)
- **Claude Code** instalado (`npm install -g @anthropic-ai/claude-code`)
- **npm 10+**

---

## Instalación

### Opción A — Desde el repositorio (desarrollo local)

```bash
git clone https://github.com/tu-usuario/hivemind
cd hivemind
npm install
npm run build
npm run link:local      # registra 'hive' globalmente via npm link
```

### Opción B — Desde npm (cuando se publique)

```bash
npm install -g @hivemind/cli
```

---

## Quick Start

```bash
# 1. Inicializar en tu proyecto
cd mi-proyecto
hive init

# 2. Arrancar el broker en background
hive start

# 3. Crear directorios de agentes con prompts y configuración MCP
hive scaffold

# 4. Lanzar cada agente en su propio Claude Code
#    Abre una terminal y navega al directorio del agente:
cd agents/orchestrator
claude                          # usa el modelo por defecto

#    En otra terminal:
cd agents/coder-backend
claude --model claude-sonnet-4-6  # puedes especificar el modelo por rol
```

Eso es todo. Los agentes se registran solos en el broker al iniciarse y empiezan a coordinar.

---

## Comandos CLI

| Comando | Descripción |
|---------|-------------|
| `hive init [nombre]` | Crea `.hive/` con config y `.mcp.json` en la raíz |
| `hive start` | Arranca el broker como daemon (PID en `.hive/broker.pid`) |
| `hive stop` | Para el broker |
| `hive status` | Estado del broker, agentes online, sesiones activas |
| `hive agents` | Lista agentes conectados con rol y estado |
| `hive tasks [--status <estado>]` | Lista tareas (pending, in\_progress, completed…) |
| `hive prompt <rol> [-i id] [-o path]` | Imprime o guarda el system prompt para un rol |
| `hive scaffold` | Crea `agents/<rol>/CLAUDE.md` y `.mcp.json` para cada rol |

---

## Roles disponibles

| Rol | Responsabilidad |
|-----|----------------|
| `orchestrator` | Coordina el trabajo, crea tareas, desbloquea dependencias |
| `coder-backend` | Implementa lógica de servidor, APIs, base de datos |
| `coder-frontend` | Implementa UI, componentes, estilos |
| `reviewer` | Revisa código, aprueba o rechaza tareas en QA |
| `architect` | Define estructura, toma decisiones de diseño de alto nivel |
| `researcher` | Investiga librerías, APIs externas, mejores prácticas |
| `devops` | Gestiona infraestructura, CI/CD, despliegues |

No necesitas usar todos los roles — arranca con `orchestrator` + 1-2 coders.

### Selección de modelo por rol

Cada agente es un proceso independiente de Claude Code — puedes asignar un modelo distinto a cada uno según su responsabilidad:

```bash
# Orquestador y arquitecto — decisiones complejas, razonamiento profundo
claude --model claude-opus-4-6

# Coders — buen balance de capacidad y costo
claude --model claude-sonnet-4-6

# Reviewer, researcher, devops — tareas más directas
claude --model claude-haiku-4-5-20251001
```

| Rol | Modelo sugerido | Por qué |
|-----|----------------|---------|
| `orchestrator` | Opus | Planificación, DAG de tareas, decisiones de alto nivel |
| `architect` | Opus | Diseño de sistemas, trade-offs técnicos complejos |
| `coder-backend` | Sonnet | Implementación con buen balance calidad/costo |
| `coder-frontend` | Sonnet | Idem |
| `reviewer` | Sonnet | Necesita razonamiento pero no tanta profundidad |
| `researcher` | Haiku | Búsquedas, recopilación de información |
| `devops` | Haiku | Scripts, configuración, tareas repetitivas |

Esto permite optimizar el costo total del equipo — Opus donde importa la calidad, Haiku para trabajo rutinario.

---

## Cómo funciona

### Conexión MCP
Cada directorio `agents/<rol>/` contiene un `.mcp.json` que apunta al broker:
```json
{
  "mcpServers": {
    "hivemind": {
      "type": "http",
      "url": "http://localhost:7432/mcp"
    }
  }
}
```
Claude Code lo detecta automáticamente al abrir ese directorio.

### Herramientas disponibles para los agentes

Las herramientas MCP con prefijo `hive_` están disponibles en cada sesión:

| Herramienta | Descripción |
|-------------|-------------|
| `hive_register` | Registrarse en el broker (primera llamada obligatoria) |
| `hive_wait` | Bloquea hasta que el broker tenga eventos — cero tokens mientras idle |
| `hive_heartbeat` | Keep-alive de locks durante trabajo activo (cada 55s) |
| `hive_send` | Enviar mensaje directo a otro agente |
| `hive_list_agents` | Ver agentes online y su estado |
| `hive_create_task` | Crear tarea con prioridad, dependencias y rol asignado |
| `hive_get_next_task` | Obtener la siguiente tarea disponible para este agente |
| `hive_update_task_progress` | Reportar progreso en una tarea |
| `hive_complete_task` | Marcar tarea como completa (entra en QA si es necesario) |
| `hive_get_task` | Ver detalle de una tarea |
| `hive_list_tasks` | Listar tareas con filtros |
| `hive_blackboard_read` | Leer estado compartido (dot-notation: `project.meta`) |
| `hive_blackboard_write` | Escribir en la pizarra compartida |
| `hive_declare_files` | Declarar archivos que este agente va a modificar |
| `hive_request_lock` | Solicitar bloqueo exclusivo o compartido sobre archivos |
| `hive_release_locks` | Liberar bloqueos al terminar |
| `hive_get_pending_reviews` | (reviewer) Ver tareas esperando revisión |
| `hive_submit_review` | (reviewer) Aprobar o rechazar con feedback |
| `hive_audit_log` | Consultar registro de auditoría |

### Pizarra compartida (Blackboard)
Estado JSON compartido persistido en `.hive/blackboard.json`. Estructura por defecto:
```
project.meta          — metadatos del proyecto
project.architecture  — decisiones de arquitectura
project.conventions   — convenciones de código
knowledge.discoveries — hallazgos relevantes
knowledge.warnings    — problemas conocidos
state.sprint          — sprint actual
state.blockers        — bloqueos activos
agents.<id>           — estado por agente
qa.findings           — resultados de QA
```

### Bloqueos de archivos
Antes de editar un archivo, el agente declara qué archivos toca y solicita un lock. Si otro agente tiene el archivo bloqueado, espera en cola y recibe un evento `lock_granted` cuando queda libre.

### Pipeline de QA
Las tareas marcadas como `completed` pueden pasar por revisión (`qa_pending`). Un agente reviewer las aprueba (`completed`) o rechaza (`needs_revision`). Si son rechazadas, vuelven al agente original con feedback.

---

## Monitor en tiempo real

Con el broker corriendo, abre en el navegador:

```
http://localhost:7432/monitor
```

Dashboard con auto-refresh cada 3 segundos — muestra agentes online, tareas con su estado, pizarra compartida, locks activos y audit log. Sin dependencias, sin instalación adicional.

---

## Admin API

El broker expone endpoints REST para monitoreo externo:

```
GET  /ping                          — health check
GET  /admin/agents[?status=online]  — listar agentes
DEL  /admin/agents/:id              — forzar agente offline
GET  /admin/tasks[?status=...]      — listar tareas
GET  /admin/tasks/:id               — detalle de tarea
POST /admin/tasks/:id/force-complete — completar tarea sin QA
GET  /admin/locks                   — bloqueos activos y en cola
GET  /admin/blackboard              — snapshot completo de la pizarra
GET  /admin/audit[?agent_id=&action=&result=&since=&limit=]
```

---

## Estructura de archivos generada

```
mi-proyecto/
├── .mcp.json                    ← Claude Code lo lee en la raíz
├── .hive/
│   ├── hive.config.json         ← configuración del broker
│   ├── tasks.db                 ← SQLite (tareas, mensajes, locks, audit)
│   ├── blackboard.json          ← pizarra compartida
│   ├── broker.pid               ← PID del daemon
│   └── broker.log               ← logs del broker
└── agents/
    ├── orchestrator/
    │   ├── CLAUDE.md            ← system prompt completo del rol
    │   └── .mcp.json            ← apunta a http://localhost:7432/mcp
    ├── coder-backend/
    │   ├── CLAUDE.md
    │   └── .mcp.json
    └── ...
```

---

## Publicar en npm

```bash
npm login                  # autenticarse con npmjs.org (una sola vez)
npm run release            # build + publish @hivemind/broker y @hivemind/cli
```

---

## Desarrollo

```bash
npm install                # instalar dependencias de todos los packages
npm run build              # compilar broker + cli
npm test                   # correr todos los tests (123 tests broker + 14 tests CLI)
npm run dev:broker         # modo watch del broker
```

---

## Licencia

MIT
