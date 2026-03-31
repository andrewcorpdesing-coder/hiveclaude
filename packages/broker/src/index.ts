import { loadConfig } from './config.js'
import { Database } from './db/Database.js'
import { AgentRegistry } from './agents/AgentRegistry.js'
import { HttpServer } from './mcp/HttpServer.js'

const config = loadConfig()
const PORT = config.broker.port

console.log(`[broker] Starting Hive Mind broker — project: "${config.project}"`)

const db = new Database('.hive/tasks.db')
const agentRegistry = new AgentRegistry(db)
const server = new HttpServer({ db, agentRegistry, port: PORT })

server.start()

function shutdown() {
  console.log('[broker] Shutting down...')
  void server.stop().then(() => {
    agentRegistry.destroy()
    db.close()
    process.exit(0)
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
