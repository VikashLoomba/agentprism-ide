import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import { ACP_AGENT_LIST } from '../shared/agents.ts'
import type { AcpAgentSpec } from '../shared/agents.ts'
import { validateWorkflow } from '../shared/validate.ts'
import type { AgentsResponse, CapabilitiesResponse, ClientMessage, PromptsResponse, ServerMessage } from '../shared/protocol.ts'
import {
  PORT,
  DEFAULT_CWD,
  AGENT_BINS,
  PROJECT_PROMPTS_DIR,
  USER_PROMPTS_DIR,
  PROJECT_TOOLS_DIR,
  USER_TOOLS_DIR,
} from './config.ts'
import { listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow } from './store/workflows.ts'
import { loadCapabilities } from './workflow/capability-loader.ts'
import { readCapabilityFile, writeCapabilityFile } from './store/capabilities.ts'
import { loadPrompts } from './workflow/prompt-loader.ts'
import { readPrompt, writePrompt } from './store/prompts.ts'
import { RunManager } from './run-manager.ts'

function isInstalled(agentId: string): boolean {
  const bin = AGENT_BINS[agentId]
  const candidates = [
    bin && path.join(process.cwd(), 'node_modules', '.bin', bin),
    path.join(process.cwd(), 'node_modules', '@agentclientprotocol', `${agentId}-agent-acp`),
    path.join(process.cwd(), 'node_modules', '@agentclientprotocol', `${agentId}-acp`),
  ].filter(Boolean) as string[]
  return candidates.some((p) => fs.existsSync(p))
}

function agentsWithStatus(): AcpAgentSpec[] {
  return ACP_AGENT_LIST.map((a) => ({ ...a, installed: isInstalled(a.id) }))
}

const app = express()
app.use(express.json({ limit: '4mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/agents', (_req, res) => {
  const body: AgentsResponse = { agents: agentsWithStatus(), defaultCwd: DEFAULT_CWD }
  res.json(body)
})

app.get('/api/workflows', async (_req, res, next) => {
  try {
    res.json(await listWorkflows())
  } catch (err) {
    next(err)
  }
})

app.get('/api/workflows/:name', async (req, res) => {
  try {
    const content = await readWorkflow(req.params.name)
    res.json({ name: req.params.name, content })
  } catch {
    res.status(404).json({ error: 'Workflow not found' })
  }
})

const saveSchema = z.object({ content: z.string() })
app.put('/api/workflows/:name', async (req, res, next) => {
  try {
    const { content } = saveSchema.parse(req.body)
    const info = await writeWorkflow(req.params.name, content)
    res.json(info)
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'content is required' })
    next(err)
  }
})

app.delete('/api/workflows/:name', async (req, res, next) => {
  try {
    await deleteWorkflow(req.params.name)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

app.get('/api/capabilities', async (_req, res, next) => {
  try {
    const { entries } = await loadCapabilities(process.env)
    const body: CapabilitiesResponse = { capabilities: entries }
    res.json(body)
  } catch (err) {
    next(err)
  }
})

app.get('/api/prompts', async (_req, res, next) => {
  try {
    const { entries } = await loadPrompts()
    const body: PromptsResponse = { prompts: entries }
    res.json(body)
  } catch (err) {
    next(err)
  }
})

function promptDirFor(tier: string): string {
  if (tier === 'project') return PROJECT_PROMPTS_DIR
  if (tier === 'user') return USER_PROMPTS_DIR
  throw new Error('Unknown prompt tier')
}

app.get('/api/prompts/:tier/:name', async (req, res) => {
  try {
    const { content } = await readPrompt(promptDirFor(req.params.tier), req.params.name)
    res.json({ name: req.params.name, content })
  } catch {
    res.status(404).json({ error: 'Prompt not found' })
  }
})

const savePromptSchema = z.object({ content: z.string() })
app.put('/api/prompts/:tier/:name', async (req, res, next) => {
  try {
    const { content } = savePromptSchema.parse(req.body)
    res.json(await writePrompt(promptDirFor(req.params.tier), req.params.name, content))
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'content is required' })
    next(err)
  }
})

function toolDirFor(tier: string): string {
  if (tier === 'project') return PROJECT_TOOLS_DIR
  if (tier === 'user') return USER_TOOLS_DIR
  throw new Error('Unknown tool tier')
}

app.get('/api/tools/:tier/:name', async (req, res) => {
  try {
    const { content } = await readCapabilityFile(toolDirFor(req.params.tier), req.params.name)
    res.json({ name: req.params.name, content })
  } catch {
    res.status(404).json({ error: 'Tool not found' })
  }
})

const saveToolSchema = z.object({ content: z.string() })
app.put('/api/tools/:tier/:name', async (req, res, next) => {
  try {
    const { content } = saveToolSchema.parse(req.body)
    res.json(await writeCapabilityFile(toolDirFor(req.params.tier), req.params.name, content))
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'content is required' })
    next(err)
  }
})

const validateSchema = z.object({ source: z.string() })
app.post('/api/validate', async (req, res, next) => {
  let source: string
  try {
    ;({ source } = validateSchema.parse(req.body))
  } catch {
    return res.status(400).json({ error: 'source is required' })
  }
  try {
    const { catalog } = await loadCapabilities(process.env)
    const { catalog: promptCatalog } = await loadPrompts()
    res.json(validateWorkflow(source, undefined, undefined, catalog, promptCatalog))
  } catch (err) {
    next(err)
  }
})

// Serve the built frontend in production, if present.
const distDir = path.join(process.cwd(), 'dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api error]', err)
  res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })
const manager = new RunManager()

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

wss.on('connection', (ws: WebSocket) => {
  send(ws, { t: 'hello', agents: agentsWithStatus() })
  ws.on('message', (data) => {
    let message: ClientMessage
    try {
      message = JSON.parse(data.toString()) as ClientMessage
    } catch {
      send(ws, { t: 'error', message: 'Invalid JSON message' })
      return
    }
    try {
      manager.handle(message, ws)
    } catch (err) {
      send(ws, { t: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  })
  ws.on('close', () => manager.removeClient(ws))
  ws.on('error', () => manager.removeClient(ws))
})

server.listen(PORT, () => {
  console.log(`\n  AgentPrism backend listening on http://localhost:${PORT}`)
  console.log(`  WebSocket:        ws://localhost:${PORT}/ws`)
  console.log(`  Default work dir: ${DEFAULT_CWD}`)
  console.log(`  Agents installed: ${agentsWithStatus().filter((a) => a.installed).map((a) => a.id).join(', ') || 'none (will use npx)'}\n`)
})
