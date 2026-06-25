import { spawn, type ChildProcess } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  client as createClient,
  ndJsonStream,
  methods,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import type {
  ClientConnection,
  ClientContext,
  ActiveSession,
} from '@agentclientprotocol/sdk'
import type {
  ContentBlock,
  InitializeResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk'
import type { AcpAgentSpec } from '../../shared/agents.ts'
import { AGENT_BINS } from '../config.ts'

export type LogFn = (level: string, type: string, text: string, data?: unknown) => void

export interface PermissionAsk {
  sessionId: string
  toolTitle: string
  toolKind?: string
  options: { optionId: string; name: string; kind: string }[]
}

export type PermissionDecider = (
  ask: PermissionAsk,
) => Promise<RequestPermissionResponse['outcome']>

export interface AcpConnectionHooks {
  log: LogFn
  decidePermission: PermissionDecider
}

export interface PromptTurnOptions {
  cwd: string
  modeId?: string
  config?: Record<string, string | boolean>
  prompt: ContentBlock[] | string
  onUpdate: (update: SessionUpdate, sessionId: string) => void
  onModes?: (modes: SessionModeState) => void
  onConfigOptions?: (opts: SessionConfigOption[]) => void
  onSession?: (sessionId: string) => void
  signal?: AbortSignal
}

export interface TokenUsage {
  input?: number
  output?: number
  total?: number
}

export interface PromptTurnResult {
  text: string
  stopReason: StopReason
  usage?: TokenUsage
  modes?: SessionModeState
  configOptions?: SessionConfigOption[]
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function normalizeUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const input = num(u.inputTokens) ?? num(u.input_tokens) ?? num(u.input)
  const output = num(u.outputTokens) ?? num(u.output_tokens) ?? num(u.output)
  const total = num(u.totalTokens) ?? num(u.total_tokens) ?? num(u.total) ?? (input ?? 0) + (output ?? 0)
  if (input === undefined && output === undefined && total === undefined) return undefined
  return { input, output, total }
}

/**
 * One spawned ACP agent subprocess + its client-side connection. Reused across
 * every agent() call in a run: each call opens an isolated ACP session.
 */
export class AcpAgentConnection {
  private child?: ChildProcess
  private conn?: ClientConnection
  private ctx?: ClientContext
  private closed = false
  private stderrBuf = ''

  constructor(
    private spec: AcpAgentSpec,
    private hooks: AcpConnectionHooks,
  ) {}

  get context(): ClientContext {
    if (!this.ctx) throw new Error('ACP connection not started')
    return this.ctx
  }

  /** Resolve the local binary if installed, else fall back to npx. */
  private resolveCommand(): { command: string; args: string[] } {
    const bin = AGENT_BINS[this.spec.id]
    if (bin) {
      const localBin = path.join(process.cwd(), 'node_modules', '.bin', bin)
      return { command: localBin, args: [] }
    }
    return { command: this.spec.command, args: this.spec.args }
  }

  async start(): Promise<InitializeResponse> {
    const { command, args } = this.resolveCommand()
    this.hooks.log('system', 'spawn', `Starting ${this.spec.name} agent: ${command} ${args.join(' ')}`.trim())

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    this.child = child

    child.on('error', (err) => {
      this.hooks.log('error', 'spawn', `Failed to start agent: ${String(err)}`)
    })
    child.on('exit', (code, signal) => {
      if (!this.closed) {
        this.hooks.log('warn', 'exit', `Agent process exited (code=${code}, signal=${signal ?? 'none'})`)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderrBuf += chunk
      const lines = this.stderrBuf.split('\n')
      this.stderrBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) this.hooks.log('system', 'stderr', line)
      }
    })

    const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>
    const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    const stream = ndJsonStream(output, input)

    this.conn = createClient({ name: 'AgentPrism' })
      .onRequest(methods.client.session.requestPermission, async (rpcCtx) => {
        const params = rpcCtx.params as RequestPermissionRequest
        const ask: PermissionAsk = {
          sessionId: params.sessionId,
          toolTitle: params.toolCall?.title ?? 'tool',
          toolKind: params.toolCall?.kind ?? undefined,
          options: (params.options ?? []).map((o) => ({
            optionId: o.optionId,
            name: o.name,
            kind: o.kind,
          })),
        }
        const outcome = await this.hooks.decidePermission(ask)
        return { outcome } satisfies RequestPermissionResponse
      })
      .onRequest(methods.client.fs.readTextFile, async (rpcCtx) => {
        const { path: filePath } = rpcCtx.params
        const content = await fs.readFile(filePath, 'utf8')
        return { content }
      })
      .onRequest(methods.client.fs.writeTextFile, async (rpcCtx) => {
        const { path: filePath, content } = rpcCtx.params
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, content, 'utf8')
        return {}
      })
      .connect(stream)

    this.ctx = this.conn.agent
    this.conn.closed.then(() => {
      if (!this.closed) this.hooks.log('warn', 'closed', 'ACP connection closed')
    })

    const init = (await this.ctx.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        session: { configOptions: { boolean: {} } },
      },
      clientInfo: { name: 'AgentPrism', version: '0.1.0' },
    })) as InitializeResponse

    this.hooks.log(
      'system',
      'initialize',
      `Connected to ${init.agentInfo?.name ?? this.spec.name} (protocol v${init.protocolVersion})`,
      init.agentCapabilities,
    )
    return init
  }

  /** Run one prompt turn in a fresh, isolated ACP session. */
  async runPrompt(opts: PromptTurnOptions): Promise<PromptTurnResult> {
    const ctx = this.context
    const session: ActiveSession = await ctx.buildSession(opts.cwd).start()
    opts.onSession?.(session.sessionId)
    const modes = session.modes ?? undefined
    if (modes) opts.onModes?.(modes)

    // Apply per-call session config (mode + model + any other options) against
    // the live config options advertised by this session.
    let liveConfig: SessionConfigOption[] = session.newSessionResponse.configOptions ?? []
    opts.onConfigOptions?.(liveConfig)

    // config.mode overrides modeId when both are present.
    const merged: Record<string, string | boolean> = {
      ...(opts.modeId ? { mode: opts.modeId } : {}),
      ...(opts.config ?? {}),
    }
    // Apply the model option first so dependent options resolve against it.
    const ordered = Object.entries(merged).sort(([a], [b]) =>
      a === 'model' ? -1 : b === 'model' ? 1 : 0,
    )

    for (const [configId, value] of ordered) {
      const opt = liveConfig.find((o) => o.id === configId)
      if (!opt) {
        this.hooks.log('warn', 'set_config', `unknown config id "${configId}" — ignored`)
        continue
      }
      if (opt.currentValue === value) continue
      const params =
        opt.type === 'boolean'
          ? { sessionId: session.sessionId, configId, type: 'boolean' as const, value: !!value }
          : { sessionId: session.sessionId, configId, value: String(value) }
      try {
        const res = (await ctx.request(methods.agent.session.setConfigOption, params)) as {
          configOptions?: SessionConfigOption[]
        }
        if (res?.configOptions) liveConfig = res.configOptions
      } catch (err) {
        this.hooks.log('warn', 'set_config', `failed to set ${configId}=${String(value)}: ${String(err)}`)
        continue
      }
    }

    const onAbort = () => {
      ctx
        .notify(methods.agent.session.cancel, { sessionId: session.sessionId })
        .catch(() => {})
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    let message = ''
    let usage: unknown
    const handle = (update: SessionUpdate) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        message += update.content.text
      }
      if (update.sessionUpdate === 'usage_update') {
        usage = update
      }
      opts.onUpdate(update, session.sessionId)
    }

    try {
      const promptP = session.prompt(opts.prompt)
      const drain = (async (): Promise<{ stopReason: StopReason; usage?: unknown }> => {
        for (;;) {
          const msg = await session.nextUpdate()
          if (msg.kind === 'stop') {
            return { stopReason: msg.stopReason, usage: msg.response.usage ?? usage }
          }
          handle(msg.update)
        }
      })()

      const out = await Promise.race([
        drain,
        promptP.then(
          (r: PromptResponse) => ({ stopReason: r.stopReason, usage: r.usage ?? usage }),
          (err: unknown) => {
            throw err
          },
        ),
      ])
      return {
        text: message,
        stopReason: out.stopReason,
        usage: normalizeUsage(out.usage),
        modes,
        configOptions: liveConfig,
      }
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      session.dispose()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.conn?.close()
    } catch {
      /* ignore */
    }
    // Closing stdin is the graceful shutdown signal for both agents.
    try {
      this.child?.stdin?.end()
    } catch {
      /* ignore */
    }
    const child = this.child
    if (child) {
      setTimeout(() => {
        if (!child.killed) child.kill('SIGTERM')
      }, 1500).unref?.()
    }
  }
}
