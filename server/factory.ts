// server/factory.ts
//
// The "./server" export: build the IDE's HTTP + WebSocket host as a THIN adapter
// over the runtime. `createServer(runtime)` returns an Express app (all /api/*
// routes), a WebSocketServer bridging the WS protocol to the runtime, and a
// `listen()` helper. The server constructs NO engine and holds NO resolution
// logic of its own — every request routes `:workspaceId` to
// `runtime.workspaces.getOrThrow(id)` and PROJECTS the Workspace/Runtime to JSON.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import { validateWorkflow } from '../shared/validate.ts'
import type {
  AgentsResponse,
  CapabilitiesResponse,
  ClientMessage,
  PromptsResponse,
  ServerMessage,
  WorkspaceInfo,
  WorkspacesResponse,
} from '../shared/protocol.ts'
import { PORT, PACKAGE_ROOT } from './config.ts'
import { RunManager } from './run-manager.ts'
import type { Runtime } from '../runtime/index.ts'
import type { Workspace } from '../runtime/workspace.ts'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      workspace: Workspace
    }
  }
}

export interface CreateServerOptions {
  /** Secret source for capability secret-status (NEVER values). Defaults to
   *  process.env; pass the same env the runtime was created with for parity. */
  env?: NodeJS.ProcessEnv
}

export interface CreatedServer {
  app: express.Express
  server: http.Server
  wss: WebSocketServer
  /** Start listening (defaults to config PORT), print the startup banner, and
   *  invoke the optional callback once bound. */
  listen: (port?: number, onListening?: () => void) => http.Server
}

type Tier = 'project' | 'user'
function asTier(value: string): Tier {
  if (value === 'project' || value === 'user') return value
  throw new Error('Unknown tier')
}

/**
 * Build the IDE server as a pure consumer of {@link Runtime}. The WS bridge maps
 * inbound ClientMessage → workspace handle calls and runtime events →
 * ServerMessage (see {@link RunManager}); the HTTP routes are the workspace-scoped
 * /api/* surface.
 */
export function createServer(runtime: Runtime, opts: CreateServerOptions = {}): CreatedServer {
  const env = opts.env ?? process.env
  const registry = runtime.workspaces

  const app = express()
  app.use(express.json({ limit: '4mb' }))

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.get('/api/agents', (_req, res) => {
    const body: AgentsResponse = { agents: runtime.listAgents(), defaultCwd: registry.default().root }
    res.json(body)
  })

  // --- Registry routes (unprefixed) ---------------------------------------
  app.get('/api/workspaces', (_req, res) => {
    const body: WorkspacesResponse = {
      workspaces: registry.list(),
      defaultWorkspaceId: registry.defaultId(),
    }
    res.json(body)
  })

  const openWorkspaceSchema = z.object({ root: z.string() })
  app.post('/api/workspaces', (req, res, next) => {
    let root: string
    try {
      ;({ root } = openWorkspaceSchema.parse(req.body))
    } catch {
      return res.status(400).json({ error: 'root is required' })
    }
    try {
      const ws = registry.open(path.resolve(root))
      const info: WorkspaceInfo = {
        id: ws.id,
        name: ws.name,
        root: ws.root,
        isDefault: ws.id === registry.defaultId(),
      }
      res.json(info)
    } catch (err) {
      next(err)
    }
  })

  app.delete('/api/workspaces/:workspaceId', async (req, res) => {
    try {
      await registry.close(req.params.workspaceId)
      res.json({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status =
        message === 'Cannot close the last open workspace'
          ? 409
          : message.startsWith('Unknown workspace')
            ? 404
            : 500
      res.status(status).json({ error: message })
    }
  })

  // --- Workspace-scoped resource router -----------------------------------
  const wsRouter = express.Router({ mergeParams: true })
  wsRouter.use((req, res, next) => {
    const ws = registry.get(String(req.params.workspaceId))
    if (!ws) return res.status(404).json({ error: 'Unknown workspace' })
    req.workspace = ws
    next()
  })

  wsRouter.get('/workflows', async (req, res, next) => {
    try {
      res.json(await req.workspace.listWorkflows())
    } catch (err) {
      next(err)
    }
  })

  wsRouter.get('/workflows/:name', async (req, res) => {
    try {
      const content = await req.workspace.readWorkflow(req.params.name)
      res.json({ name: req.params.name, content })
    } catch {
      res.status(404).json({ error: 'Workflow not found' })
    }
  })

  const saveSchema = z.object({ content: z.string() })
  wsRouter.put('/workflows/:name', async (req, res, next) => {
    try {
      const { content } = saveSchema.parse(req.body)
      const info = await req.workspace.writeWorkflow(req.params.name, content)
      res.json(info)
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: 'content is required' })
      next(err)
    }
  })

  wsRouter.delete('/workflows/:name', async (req, res, next) => {
    try {
      await req.workspace.deleteWorkflow(req.params.name)
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })

  wsRouter.get('/capabilities', async (req, res, next) => {
    try {
      const { entries } = await req.workspace.loadCapabilities(env)
      const body: CapabilitiesResponse = { capabilities: entries }
      res.json(body)
    } catch (err) {
      next(err)
    }
  })

  wsRouter.get('/prompts', async (req, res, next) => {
    try {
      const { entries } = await req.workspace.loadPrompts()
      const body: PromptsResponse = { prompts: entries }
      res.json(body)
    } catch (err) {
      next(err)
    }
  })

  wsRouter.get('/prompts/:tier/:name', async (req, res) => {
    try {
      const { content } = await req.workspace.readPromptFile(asTier(req.params.tier), req.params.name)
      res.json({ name: req.params.name, content })
    } catch {
      res.status(404).json({ error: 'Prompt not found' })
    }
  })

  const savePromptSchema = z.object({ content: z.string() })
  wsRouter.put('/prompts/:tier/:name', async (req, res, next) => {
    try {
      const { content } = savePromptSchema.parse(req.body)
      res.json(await req.workspace.writePromptFile(asTier(req.params.tier), req.params.name, content))
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: 'content is required' })
      next(err)
    }
  })

  wsRouter.get('/tools/:tier/:name', async (req, res) => {
    try {
      const { content } = await req.workspace.readToolFile(asTier(req.params.tier), req.params.name)
      res.json({ name: req.params.name, content })
    } catch {
      res.status(404).json({ error: 'Tool not found' })
    }
  })

  const saveToolSchema = z.object({ content: z.string() })
  wsRouter.put('/tools/:tier/:name', async (req, res, next) => {
    try {
      const { content } = saveToolSchema.parse(req.body)
      res.json(await req.workspace.writeToolFile(asTier(req.params.tier), req.params.name, content))
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: 'content is required' })
      next(err)
    }
  })

  const validateSchema = z.object({ source: z.string() })
  wsRouter.post('/validate', async (req, res, next) => {
    let source: string
    try {
      ;({ source } = validateSchema.parse(req.body))
    } catch {
      return res.status(400).json({ error: 'source is required' })
    }
    try {
      const { capabilities, prompts } = await req.workspace.catalogs()
      res.json(validateWorkflow(source, undefined, undefined, capabilities, prompts))
    } catch (err) {
      next(err)
    }
  })

  // Editor intellisense for tool/capability files — bridges the workspace's
  // node_modules to the browser's Monaco worker (which has no filesystem) so a
  // tool .ts buffer's sibling and npm imports resolve in-editor the same way they
  // already do at run time (host-loaded `await import()`).
  wsRouter.get('/tool-sources', (req, res, next) => {
    try {
      res.json({ libs: req.workspace.toolSources() })
    } catch (err) {
      next(err)
    }
  })

  const toolTypesSchema = z.object({ specifiers: z.array(z.string()) })
  wsRouter.post('/tool-types', (req, res, next) => {
    let specifiers: string[]
    try {
      ;({ specifiers } = toolTypesSchema.parse(req.body))
    } catch {
      return res.status(400).json({ error: 'specifiers must be a string array' })
    }
    try {
      res.json({ libs: req.workspace.resolveToolTypes(specifiers) })
    } catch (err) {
      next(err)
    }
  })

  app.use('/api/workspaces/:workspaceId', wsRouter)

  // Serve the built frontend from the installed package (NOT the user's cwd), so
  // `npx agentprism-ide` from an arbitrary directory still serves the bundled UI.
  const distDir = path.join(PACKAGE_ROOT, 'dist')
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
  const manager = new RunManager(registry)

  function send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  wss.on('connection', (ws: WebSocket) => {
    send(ws, {
      t: 'hello',
      agents: runtime.listAgents(),
      workspaces: registry.list(),
      defaultWorkspaceId: registry.defaultId(),
    })
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

  function listen(port: number = PORT, onListening?: () => void): http.Server {
    return server.listen(port, () => {
      console.log(`\n  AgentPrism backend listening on http://localhost:${port}`)
      console.log(`  WebSocket:        ws://localhost:${port}/ws`)
      console.log(`  Default work dir: ${registry.default().root}`)
      console.log(
        `  Agents installed: ${runtime.listAgents().filter((a) => a.installed).map((a) => a.id).join(', ') || 'none (will use npx)'}\n`,
      )
      onListening?.()
    })
  }

  return { app, server, wss, listen }
}
