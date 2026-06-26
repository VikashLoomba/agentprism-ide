import path from 'node:path'
import { customAlphabet } from 'nanoid'
import { ACP_AGENTS } from '../../shared/agents.ts'
import type { AcpAgentId, SessionModeState } from '../../shared/agents.ts'
import { MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from '../../shared/dsl.ts'
import type { AgentOptions, WorkflowMeta } from '../../shared/dsl.ts'
import { DSL_METHODS, resolveMethodConfig, validateMethodConfig } from '../../shared/dsl-registry.ts'
import { validateWorkflow } from '../../shared/validate.ts'
import type {
  AcpEventLevel,
  AcpLogEntry,
  AgentCallState,
  AgentCallStatus,
  AgentTokenUsage,
  EffectCallState,
  LiveConfigOption,
  PauseInfo,
  PhaseState,
  RunEvent,
  RunSnapshot,
  RunStats,
  RunStatus,
  ToolCallState,
} from '../../shared/events.ts'
import type { InputRequest, InputResponse, PermissionRequest, PermissionResponse, RunRequest } from '../../shared/protocol.ts'
import type { Capability, CapabilityContext, Json } from '../../shared/capability.ts'
import type { CapabilityCatalog } from '../../shared/capability-resolve.ts'
import { AcpAgentConnection, type PermissionAsk } from '../acp/connection.ts'
import type { RequestPermissionResponse, SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk'
import { buildSandboxGlobals, runVm, type CheckpointOptions, type MethodConfigMap, type SandboxHost } from './executor.ts'
import { instrumentWorkflow, sourceLineFromStack } from './instrument.ts'
import { inlineHelpers } from './inline.ts'
import { getCapabilityModules, type LoadedCapabilities } from './capability-loader.ts'
import { getPromptTemplates, type LoadedPrompts } from './prompt-loader.ts'
import type { Workspace } from '../workspace.ts'
import type { PromptTemplate } from '../../shared/prompt-template.ts'
import type { PromptCatalog } from '../../shared/prompt-resolve.ts'
import { AgentLimitError, NonRecoverableWorkflowError, TokenBudgetError, WorkflowAbortError, isNonRecoverable } from './errors.ts'

const shortid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8)

/** Hard ceiling on recorded capability effects per run (mirrors MAX_AGENTS_PER_RUN). */
const MAX_EFFECTS_PER_RUN = 1000

/** Non-recoverable: the per-run effect ceiling was hit (propagates, never → null). */
class EffectLimitError extends NonRecoverableWorkflowError {
  constructor(max: number) {
    super('EFFECT_LIMIT_EXCEEDED', `Effect limit exceeded (max ${max} per run)`)
  }
}

type PermissionOutcome = RequestPermissionResponse['outcome']

export interface RunCallbacks {
  emit: (event: RunEvent) => void
  notifyPermission: (req: PermissionRequest) => void
  /** Surface a mid-run human-in-the-loop input request to the host. The host
   *  answers it later via resolveInput(); mirrors notifyPermission. */
  notifyInput: (req: InputRequest) => void
}

interface PauseRecord {
  info: PauseInfo
  resolve: () => void
  reject: (err: unknown) => void
}

interface Releaser {
  (): void
}

/** FIFO concurrency limiter (mirrors pi's createLimiter). */
class Limiter {
  private active = 0
  private queue: Array<() => void> = []
  constructor(private max: number) {}
  async acquire(): Promise<Releaser> {
    while (this.active >= this.max) {
      await new Promise<void>((res) => this.queue.push(res))
    }
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

function defaultLabel(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 6).join(' ')
  return words.length > 48 ? words.slice(0, 45) + '…' : words || 'agent'
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Best-effort JSON extraction from an agent's free-text reply. */
function parseStructured(text: string): unknown {
  const stripped = text.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```$/, '').trim()
  for (const candidate of [stripped, text.trim()]) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* try extraction */
    }
    const start = candidate.search(/[[{]/)
    if (start >= 0) {
      const open = candidate[start]
      const close = open === '{' ? '}' : ']'
      let depth = 0
      let inStr = false
      let esc = false
      for (let i = start; i < candidate.length; i++) {
        const ch = candidate[i]
        if (inStr) {
          if (esc) esc = false
          else if (ch === '\\') esc = true
          else if (ch === '"') inStr = false
        } else if (ch === '"') inStr = true
        else if (ch === open) depth++
        else if (ch === close) {
          depth--
          if (depth === 0) {
            try {
              return JSON.parse(candidate.slice(start, i + 1))
            } catch {
              break
            }
          }
        }
      }
    }
  }
  return undefined
}

export class WorkflowRun {
  readonly runId: string
  private callbacks: RunCallbacks
  private request: RunRequest
  private cwd: string
  private modeId?: string
  private autoApprove: boolean
  private stepMode: boolean
  /** Secret source for capabilities (default process.env); never serialized. */
  private env: NodeJS.ProcessEnv
  /** The owning workspace — source of catalogs, tool dirs, and default cwd. */
  private workspace: Workspace
  /** When true, checkpoint()/input() interactions park and await resolveInput
   *  (a UI subscriber or onInput handler is attached). When false (default),
   *  they resolve synchronously via the headless policy (opts.headless),
   *  preserving today's auto-return behavior. The controller flips this. */
  private interactiveInput = false

  private connections = new Map<AcpAgentId, AcpAgentConnection>()
  private connecting = new Map<AcpAgentId, Promise<AcpAgentConnection>>()
  private limiter: Limiter
  private headerLines = 0
  private agentCounter = 0
  private effectCounter = 0
  private spentTokens = 0
  private tokenBudget: number | null
  private methodConfigs: MethodConfigMap = {}

  /** Resolved + loaded capability namespaces for this run (declared in meta.capabilities). */
  private capabilityModules = new Map<string, Capability>()
  /** Run-time capability catalog (project>user), threaded into validateWorkflow. */
  private capabilityCatalog?: CapabilityCatalog

  /** Resolved + loaded prompt templates for this run (declared in meta.prompts). */
  private promptModules = new Map<string, PromptTemplate>()
  /** Run-time prompt catalog (project>user), threaded into validateWorkflow. */
  private promptCatalog?: PromptCatalog

  private aborted = false
  private finished = false
  private currentPhase = ''

  private snapshot: RunSnapshot
  private agentMap = new Map<string, AgentCallState>()
  private effectMap = new Map<string, EffectCallState>()
  private sessionToAgent = new Map<string, string>()
  private breakpoints: Set<number>

  private currentPause?: PauseRecord
  private waitingPauses: PauseRecord[] = []
  private pendingPermissions = new Map<string, (outcome: PermissionOutcome) => void>()
  private pendingInputs = new Map<string, (response: InputResponse) => void>()
  private lastModesJson = ''

  constructor(request: RunRequest, callbacks: RunCallbacks, opts: { env?: NodeJS.ProcessEnv; workspace: Workspace }) {
    this.runId = request.runId
    this.request = request
    this.callbacks = callbacks
    this.env = opts.env ?? process.env
    this.workspace = opts.workspace
    this.cwd = request.cwd
    this.modeId = request.modeId
    this.autoApprove = !request.manualApprovals
    this.stepMode = !!request.stepMode
    this.tokenBudget = request.tokenBudget ?? null
    this.breakpoints = new Set(request.breakpoints ?? [])
    this.limiter = new Limiter(Math.min(MAX_CONCURRENCY, Math.max(1, request.maxConcurrency ?? 8)))
    this.snapshot = {
      runId: this.runId,
      status: 'starting',
      agent: request.agent,
      cwd: this.cwd,
      phases: [],
      agents: [],
      effects: [],
      log: [],
      stats: { agentCount: 0, completed: 0, failed: 0, durationMs: 0, tokens: {} },
      breakpoints: [...this.breakpoints],
      startedAt: Date.now(),
    }
  }

  getSnapshot(): RunSnapshot {
    return this.snapshot
  }

  isDone(): boolean {
    return this.finished
  }

  /* ----------------------------- emit helpers ----------------------------- */

  private emit(event: RunEvent): void {
    this.callbacks.emit(event)
  }

  private setStatus(status: RunStatus): void {
    this.snapshot.status = status
    this.emit({ type: 'run:status', status })
  }

  private logAcp(level: AcpEventLevel, type: string, text: string, data?: unknown, agentId?: string): void {
    const entry: AcpLogEntry = {
      id: shortid(),
      ts: Date.now(),
      agentId,
      agentLabel: agentId ? this.agentMap.get(agentId)?.label : undefined,
      level,
      type,
      text,
      data,
    }
    this.snapshot.log.push(entry)
    if (this.snapshot.log.length > 3000) this.snapshot.log.splice(0, this.snapshot.log.length - 3000)
    this.emit({ type: 'acp', entry })
  }

  private handleModes(modes: SessionModeState): void {
    const json = JSON.stringify(modes)
    if (json === this.lastModesJson) return
    this.lastModesJson = json
    this.snapshot.modes = modes
    this.emit({ type: 'session:modes', modes })
  }

  private emitConfigOptions(agentId: string, sdk: SessionConfigOption[]): void {
    const mapped: LiveConfigOption[] = sdk.map((o) => ({
      id: o.id,
      name: o.name,
      type: o.type,
      currentValue: o.currentValue,
      values:
        o.type === 'select' && 'options' in o && Array.isArray((o as any).options)
          ? (o as any).options.map((x: any) => ({ value: x.value, name: x.name }))
          : undefined,
    }))
    this.snapshot.configOptions = mapped
    this.emit({ type: 'session:configOptions', agentId, options: mapped })
  }

  /* ------------------------------ public ops ------------------------------ */

  setBreakpoints(lines: number[]): void {
    this.breakpoints = new Set(lines)
    this.snapshot.breakpoints = [...this.breakpoints]
    this.emit({ type: 'breakpoint:set', lines: this.snapshot.breakpoints })
  }

  /** Controller hook: declare whether mid-run input requests (checkpoint/input)
   *  will be answered by a host (UI subscriber or onInput resolver). When off
   *  (default), checkpoint() stays headless and resolves via opts.headless. */
  setInteractiveInput(on: boolean): void {
    this.interactiveInput = on
  }

  resume(): void {
    this.stepMode = false
    this.releasePause()
  }

  step(): void {
    this.stepMode = true
    this.releasePause()
  }

  private releasePause(): void {
    const rec = this.currentPause
    if (!rec) return
    this.currentPause = undefined
    this.snapshot.pause = undefined
    this.emit({ type: 'breakpoint:resumed', pauseId: rec.info.id })
    rec.resolve()
    const next = this.waitingPauses.shift()
    if (next) this.activatePause(next)
    else if (!this.finished) this.setStatus('running')
  }

  private activatePause(rec: PauseRecord): void {
    this.currentPause = rec
    this.snapshot.pause = rec.info
    this.setStatus('paused')
    this.emit({ type: 'breakpoint:hit', pause: rec.info })
  }

  private requestPause(info: PauseInfo): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.aborted) {
        reject(new WorkflowAbortError())
        return
      }
      const rec: PauseRecord = { info, resolve, reject }
      if (!this.currentPause) this.activatePause(rec)
      else this.waitingPauses.push(rec)
    })
  }

  cancel(): void {
    if (this.finished || this.aborted) return
    this.aborted = true
    this.logAcp('warn', 'cancel', 'Run cancelled by user')
    // Wake all paused agents so they observe the abort and unwind.
    const pauses = [this.currentPause, ...this.waitingPauses].filter(Boolean) as PauseRecord[]
    this.currentPause = undefined
    this.waitingPauses = []
    this.snapshot.pause = undefined
    for (const p of pauses) p.reject(new WorkflowAbortError())
    // Resolve any pending permissions as cancelled.
    for (const resolve of this.pendingPermissions.values()) resolve({ outcome: 'cancelled' })
    this.pendingPermissions.clear()
    // Wake any parked input interactions as cancelled so checkpoints unwind.
    for (const resolve of this.pendingInputs.values()) resolve({ kind: 'cancelled' })
    this.pendingInputs.clear()
  }

  resolvePermission(requestId: string, response: PermissionResponse): void {
    const resolve = this.pendingPermissions.get(requestId)
    if (!resolve) return
    this.pendingPermissions.delete(requestId)
    resolve(response.kind === 'cancelled' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: response.optionId })
  }

  /** Resolve a parked checkpoint/input interaction. Mirrors resolvePermission;
   *  driven by the host's UI message or onInput handler via the controller. */
  resolveInput(requestId: string, response: InputResponse): void {
    const resolve = this.pendingInputs.get(requestId)
    if (!resolve) return
    this.pendingInputs.delete(requestId)
    resolve(response)
  }

  /* ------------------------------ permissions ----------------------------- */

  private async decidePermission(ask: PermissionAsk): Promise<PermissionOutcome> {
    const agentId = this.sessionToAgent.get(ask.sessionId)
    this.logAcp('permission', 'request', `Permission requested: ${ask.toolTitle}`, ask.options, agentId)
    if (this.autoApprove) {
      const opt =
        ask.options.find((o) => o.kind === 'allow_once') ??
        ask.options.find((o) => o.kind?.startsWith('allow')) ??
        ask.options[0]
      if (!opt) return { outcome: 'cancelled' }
      this.logAcp('permission', 'auto', `Auto-approved: ${opt.name}`, undefined, agentId)
      return { outcome: 'selected', optionId: opt.optionId }
    }
    const requestId = shortid()
    return new Promise<PermissionOutcome>((resolve) => {
      this.pendingPermissions.set(requestId, resolve)
      this.callbacks.notifyPermission({
        requestId,
        agentId: agentId ?? '',
        agentLabel: agentId ? this.agentMap.get(agentId)?.label : undefined,
        toolTitle: ask.toolTitle,
        toolKind: ask.toolKind,
        options: ask.options,
      })
    })
  }

  /* -------------------------- agent state helpers ------------------------- */

  private ensurePhase(title: string): PhaseState {
    let phase = this.snapshot.phases.find((p) => p.title === title)
    if (!phase) {
      phase = { title, agentIds: [] }
      this.snapshot.phases.push(phase)
    }
    return phase
  }

  private finishAgent(state: AgentCallState, status: AgentCallStatus, error?: string): void {
    state.status = status
    state.finishedAt = Date.now()
    if (error) state.error = error
    this.emit({
      type: 'agent:finished',
      agentId: state.id,
      status,
      output: state.output,
      resultJson: state.resultJson,
      error,
      tokens: state.tokens,
    })
    const label = state.label
    if (status === 'completed') this.logAcp('info', 'agent_done', `✓ ${label}`, undefined, state.id)
    else if (status === 'failed') this.logAcp('error', 'agent_fail', `✗ ${label}: ${error ?? 'failed'}`, undefined, state.id)
  }

  private handleAgentUpdate(agentId: string, update: SessionUpdate): void {
    const state = this.agentMap.get(agentId)
    if (!state) return
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          state.message += update.content.text
          this.emit({ type: 'agent:delta', agentId, channel: 'message', text: update.content.text })
        }
        break
      case 'agent_thought_chunk':
        if (update.content.type === 'text') {
          state.thoughts += update.content.text
          this.emit({ type: 'agent:delta', agentId, channel: 'thought', text: update.content.text })
        }
        break
      case 'tool_call': {
        const tool: ToolCallState = {
          id: update.toolCallId,
          title: update.title,
          kind: update.kind ?? undefined,
          status: update.status ?? 'pending',
          locations: update.locations?.map((l) => l.path),
        }
        state.toolCalls.push(tool)
        this.emit({ type: 'agent:tool', agentId, tool })
        this.logAcp('tool', 'tool_call', `▶ ${tool.title}`, undefined, agentId)
        break
      }
      case 'tool_call_update': {
        const tool = state.toolCalls.find((t) => t.id === update.toolCallId)
        if (tool) {
          if (update.status) tool.status = update.status
          if (update.title) tool.title = update.title
          if (update.kind) tool.kind = update.kind
          this.emit({ type: 'agent:tool', agentId, tool })
          if (update.status) this.logAcp('tool', 'tool_update', `${tool.title} → ${update.status}`, undefined, agentId)
        }
        break
      }
      case 'plan':
        this.logAcp(
          'plan',
          'plan',
          'Plan: ' + update.entries.map((e) => `[${e.status}] ${e.content}`).join(' | '),
          update.entries,
          agentId,
        )
        break
      case 'current_mode_update':
        this.logAcp('info', 'mode', `Mode → ${update.currentModeId}`, undefined, agentId)
        break
      case 'available_commands_update':
        this.logAcp('info', 'commands', `${update.availableCommands.length} slash commands available`, undefined, agentId)
        break
      default:
        break
    }
  }

  /* ------------------------------ host: agent ----------------------------- */

  private buildPrompt(prompt: string, opts: AgentOptions): string {
    let out = ''
    if (opts.label) out += `Task: ${opts.label}\n\n`
    out += prompt
    if (opts.schema) {
      out +=
        '\n\n---\nIMPORTANT: Reply with ONLY a single JSON value conforming to this JSON Schema. ' +
        'No prose, no markdown fences.\nJSON Schema:\n' +
        JSON.stringify(opts.schema)
    }
    return out
  }

  private runAgent = async (prompt: string, opts: AgentOptions = {}): Promise<unknown> => {
    const stack = new Error().stack
    const line = sourceLineFromStack(stack, this.headerLines)
    if (this.aborted) throw new WorkflowAbortError()
    if (this.agentCounter >= MAX_AGENTS_PER_RUN) throw new AgentLimitError(MAX_AGENTS_PER_RUN)
    this.agentCounter++
    if (this.tokenBudget != null && this.spentTokens >= this.tokenBudget) throw new TokenBudgetError()
    const callIndex = this.agentCounter
    const id = `a${callIndex}-${shortid()}`
    const agentId: AcpAgentId = opts.agent ?? this.request.agent
    const phaseTitle = opts.phase || this.currentPhase || (this.snapshot.phases[0]?.title ?? 'main')
    const state: AgentCallState = {
      id,
      callIndex,
      agent: agentId,
      label: opts.label || defaultLabel(prompt),
      phase: phaseTitle,
      prompt,
      line,
      config: opts.config,
      structured: !!opts.schema,
      status: 'running',
      message: '',
      thoughts: '',
      toolCalls: [],
      startedAt: Date.now(),
    }
    this.agentMap.set(id, state)
    this.snapshot.agents.push(state)
    this.ensurePhase(phaseTitle).agentIds.push(id)
    this.emit({ type: 'agent:started', agent: state })
    this.logAcp('info', 'agent_start', `● ${state.label}`, undefined, id)
    if (opts.config && Object.keys(opts.config).length) {
      this.logAcp(
        'info',
        'config',
        `config (${agentId}): ` + Object.entries(opts.config).map(([k, v]) => `${k}=${v}`).join(' '),
        undefined,
        id,
      )
    }

    let result: unknown = null
    const release = await this.limiter.acquire()
    try {
      if (this.aborted) throw new WorkflowAbortError()
      const isDefaultBackend = agentId === this.request.agent
      const conn = await this.getConnection(agentId)
      const turn = await conn.runPrompt({
        cwd: opts.cwd ? path.resolve(this.cwd, opts.cwd) : this.cwd,
        // The run-wide mode selector only governs the DEFAULT backend; a
        // non-default backend's mode comes purely from opts.config.mode.
        modeId: isDefaultBackend ? this.modeId : undefined,
        prompt: this.buildPrompt(prompt, opts),
        config: opts.config,
        signal: undefined,
        onSession: (sid) => this.sessionToAgent.set(sid, id),
        // Only the default backend updates the single shared mode picker so two
        // backends don't fight over snapshot.modes.
        onModes: (modes) => {
          if (isDefaultBackend) this.handleModes(modes)
        },
        onConfigOptions: (o) => this.emitConfigOptions(id, o),
        onUpdate: (u) => this.handleAgentUpdate(id, u),
      })
      if (turn.usage?.total) {
        this.spentTokens += turn.usage.total
        state.tokens = turn.usage
      }
      if (turn.stopReason === 'cancelled') throw new WorkflowAbortError()

      if (opts.schema) {
        const parsed = parseStructured(turn.text)
        if (parsed === undefined) {
          this.finishAgent(state, 'failed', 'Agent did not return JSON matching the requested schema')
          result = null
        } else {
          state.resultJson = parsed
          state.output = turn.text.trim()
          result = parsed
          this.finishAgent(state, 'completed')
        }
      } else {
        const text = turn.text.trim()
        if (!text) {
          this.finishAgent(state, 'failed', `Empty output (stopReason=${turn.stopReason})`)
          result = null
        } else {
          state.output = text
          result = text
          this.finishAgent(state, 'completed')
        }
      }
    } catch (err) {
      if (err instanceof WorkflowAbortError) {
        this.finishAgent(state, 'skipped', 'aborted')
        release()
        throw err
      }
      if (isNonRecoverable(err)) {
        this.finishAgent(state, 'failed', err.message)
        release()
        throw err
      }
      this.finishAgent(state, 'failed', err instanceof Error ? err.message : String(err))
      result = null
    } finally {
      release()
    }

    // Breakpoint: pause AFTER the agent so its output can be inspected.
    if (!this.aborted && line != null && (this.breakpoints.has(line) || this.stepMode)) {
      await this.requestPause({
        id: shortid(),
        line,
        kind: 'after-agent',
        phase: phaseTitle,
        agentId: id,
        label: state.label,
        prompt,
        output: state.output,
        resultJson: state.resultJson,
      })
    }
    return result
  }

  /* ---------------------------- host: capabilities ------------------------ */

  /** Build the trusted ctx for one capability: declared secret VALUES (never
   *  cross into the sandbox) + a structured logger that writes to the acp log. */
  private ctxFor(cap: Capability): CapabilityContext {
    const secrets: Record<string, string | undefined> = {}
    // Project overrides user at the process.env layer already (a single flat env);
    // we expose ONLY this capability's declared names, never the whole env.
    for (const name of cap.secrets) {
      const val = this.env[name]
      secrets[name] = typeof val === 'string' && val.length > 0 ? val : undefined
    }
    return {
      secrets: Object.freeze(secrets),
      // Secret VALUES live only in the closure above; the log carries author text.
      log: (message: string, data?: Json) => this.logAcp('info', 'effect_log', `↯ ${cap.name}: ${message}`, data),
    }
  }

  /** Bind one capability into a frozen namespace object for the vm scope.
   *  Each effect is wrapped so the host injects ctx, records a run-tree node,
   *  and translates recoverable failures to null. */
  private bindCapability = (cap: Capability, ctx: CapabilityContext): Readonly<Record<string, (args: Json) => Promise<Json | null>>> => {
    const ns: Record<string, (args: Json) => Promise<Json | null>> = {}
    for (const method of Object.keys(cap.effects)) {
      ns[method] = (args: Json) => this.runEffect(cap, ctx, method, args)
    }
    return Object.freeze(ns) // prevents sandbox monkey-patching of methods
  }

  /** The RECORDED effect — modeled 1:1 on runAgent. */
  private runEffect = async (
    cap: Capability,
    ctx: CapabilityContext,
    method: string,
    args: Json,
  ): Promise<Json | null> => {
    const stack = new Error().stack // capture BEFORE any await
    const line = sourceLineFromStack(stack, this.headerLines)
    if (this.aborted) throw new WorkflowAbortError()
    if (this.effectCounter >= MAX_EFFECTS_PER_RUN) throw new EffectLimitError(MAX_EFFECTS_PER_RUN)
    this.effectCounter++
    const callIndex = this.effectCounter
    const id = `e${callIndex}-${shortid()}`
    const phaseTitle = this.currentPhase || (this.snapshot.phases[0]?.title ?? 'main')
    const state: EffectCallState = {
      id,
      callIndex,
      capability: cap.name,
      method,
      phase: phaseTitle,
      line,
      args,
      status: 'running',
      startedAt: Date.now(),
    }
    this.effectMap.set(id, state)
    this.snapshot.effects.push(state)
    ;(this.ensurePhase(phaseTitle).effectIds ??= []).push(id)
    this.emit({ type: 'effect:started', effect: state })
    this.logAcp('info', 'effect_start', `↯ ${cap.name}.${method}`)
    try {
      const result = (await cap.effects[method](ctx, args)) as Json
      state.result = result
      state.status = 'ok'
      state.finishedAt = Date.now()
      this.emit({ type: 'effect:finished', effectId: id, status: 'ok', result, durationMs: state.finishedAt - state.startedAt! })
      this.logAcp('info', 'effect_done', `↯ ${cap.name}.${method} ✓`)
      return result
    } catch (err) {
      if (isNonRecoverable(err)) throw err // abort/limit propagate
      state.status = 'error'
      state.error = err instanceof Error ? err.message : String(err)
      state.finishedAt = Date.now()
      this.emit({ type: 'effect:finished', effectId: id, status: 'error', error: state.error, durationMs: state.finishedAt - state.startedAt! })
      this.logAcp('warn', 'effect_fail', `↯ ${cap.name}.${method} failed: ${state.error}`)
      return null // recoverable => null (like runAgent)
    }
  }

  /* ----------------------------- host: prompts ---------------------------- */

  /** Build the single `prompts` namespace object: { name: (data)=>string }.
   *  Pure + synchronous: NO ctxFor (no secrets/log), NO runEffect (no counter, no
   *  EffectCallState, no effect:* events, no null-on-failure, no abort plumbing).
   *  Frozen to block sandbox monkey-patching, mirroring bindCapability's freeze. */
  private bindPrompts(): Readonly<Record<string, (data: Json) => string>> {
    const ns: Record<string, (data: Json) => string> = {}
    for (const [name, tpl] of this.promptModules) {
      ns[name] = (data: Json) => tpl.render(data) // key == name == identifier
    }
    return Object.freeze(ns)
  }

  /* --------------------------- host: phase/log ---------------------------- */

  private phaseFn = (title: string): void => {
    this.currentPhase = title
    this.ensurePhase(title)
    this.emit({ type: 'phase:enter', title })
    this.logAcp('info', 'phase', `— Phase: ${title} —`)
  }

  private logFn = (message?: unknown): void => {
    this.logAcp('info', 'log', asText(message ?? ''))
  }

  private checkpointFn = async (promptText: string, opts: CheckpointOptions = {}): Promise<unknown> => {
    if (this.aborted) throw new WorkflowAbortError()

    // Headless back-compat: no UI subscriber / onInput handler attached. The
    // engine resolves synchronously per opts.headless, preserving today's
    // auto-return behavior (the controller flips interactiveInput on when a
    // host can answer).
    if (!this.interactiveInput) {
      if (opts.headless === 'abort') {
        this.logAcp('warn', 'checkpoint', `Checkpoint aborted (headless): ${promptText}`)
        throw new WorkflowAbortError()
      }
      const value = opts.default ?? true
      this.logAcp('info', 'checkpoint', `Checkpoint: ${promptText} → ${asText(value)} (auto)`)
      return value
    }

    // Interactive: surface the request and park until resolveInput() answers it.
    const requestId = shortid()
    const req: InputRequest = {
      requestId,
      kind: opts.kind ?? 'confirm',
      prompt: promptText,
    }
    if (opts.choices?.length) req.options = opts.choices.map((c) => ({ id: c, label: c }))
    if (opts.default !== undefined) req.default = opts.default as Json
    this.logAcp('info', 'checkpoint', `Checkpoint: ${promptText} (awaiting input)`)
    const response = await new Promise<InputResponse>((resolve) => {
      this.pendingInputs.set(requestId, resolve)
      this.emit({ type: 'interaction:request', req })
      this.callbacks.notifyInput(req)
    })
    this.emit({ type: 'interaction:resolved', requestId })
    // A run-level cancel() resolves parked inputs as cancelled — unwind here.
    if (this.aborted) throw new WorkflowAbortError()
    if (response.kind === 'cancelled') {
      if (opts.headless === 'abort') throw new WorkflowAbortError()
      const value = opts.default ?? true
      this.logAcp('info', 'checkpoint', `Checkpoint cancelled: ${promptText} → ${asText(value)} (default)`)
      return value
    }
    this.logAcp('info', 'checkpoint', `Checkpoint: ${promptText} → ${asText(response.value)}`)
    return response.value
  }

  private runNested = async (script: string, args: unknown): Promise<unknown> => {
    if (typeof script !== 'string' || !/export\s+const\s+meta/.test(script)) {
      throw new Error('workflow(): only inline workflow scripts are supported (pass a script string starting with `export const meta`).')
    }
    const v = validateWorkflow(script, this.request.agent, undefined, this.capabilityCatalog, this.promptCatalog)
    if (!v.ok) throw new Error('Nested workflow failed validation: ' + v.diagnostics.map((d) => d.message).join('; '))
    const { source, headerBindings } = inlineHelpers(v.normalized, {
      toolsDirs: this.workspace.capabilityDirs.map((d) => d.dir),
      projectToolsDir: this.workspace.dirs.tools,
    })
    const { code } = instrumentWorkflow(source, headerBindings)
    const globals = buildSandboxGlobals(this.hostHooks(args), this.resolveConfigs(v.meta, false))
    return runVm(code, globals)
  }

  /**
   * Resolve every configurable method's tunables: the script's `meta.config`
   * layered under the per-run UI overrides (request.methodConfig wins), parsed
   * through each method's Zod schema so defaults fill the gaps.
   */
  private resolveConfigs(meta: WorkflowMeta | undefined, includeRequestOverrides = true): MethodConfigMap {
    const out: MethodConfigMap = {}
    for (const d of DSL_METHODS) {
      if (!d.configSchema) continue
      out[d.name] = includeRequestOverrides
        ? resolveMethodConfig(d.name, meta?.config?.[d.name], this.request.methodConfig?.[d.name])
        : resolveMethodConfig(d.name, meta?.config?.[d.name])
    }
    return out
  }

  private hostHooks(argsOverride?: unknown): SandboxHost {
    return {
      agent: this.runAgent,
      phase: this.phaseFn,
      log: this.logFn,
      checkpoint: this.checkpointFn,
      runNested: this.runNested,
      budget: {
        total: this.tokenBudget,
        spent: () => this.spentTokens,
        remaining: () => (this.tokenBudget == null ? Infinity : Math.max(0, this.tokenBudget - this.spentTokens)),
      },
      args: argsOverride !== undefined ? argsOverride : this.request.args,
      cwd: this.cwd,
      capabilities: Object.fromEntries(
        [...this.capabilityModules].map(([ns, cap]) => [ns, this.bindCapability(cap, this.ctxFor(cap))]),
      ),
      prompts: this.bindPrompts(),
    }
  }

  /* -------------------------------- lifecycle ----------------------------- */

  /**
   * Lazily spawn + start the ACP connection for one backend. Concurrent calls
   * to the same backend share the single in-flight promise so we never spawn a
   * subprocess twice. One run can drive Claude AND Codex concurrently.
   */
  private getConnection(agentId: AcpAgentId): Promise<AcpAgentConnection> {
    const existing = this.connections.get(agentId)
    if (existing) return Promise.resolve(existing)
    let p = this.connecting.get(agentId)
    if (!p) {
      p = (async () => {
        const spec = ACP_AGENTS[agentId]
        const conn = new AcpAgentConnection(spec, {
          log: (level, type, text, data) => this.logAcp(level as AcpEventLevel, type, text, data),
          decidePermission: (ask) => this.decidePermission(ask),
        })
        await conn.start()
        this.connections.set(agentId, conn)
        return conn
      })()
      this.connecting.set(agentId, p)
    }
    return p.finally(() => this.connecting.delete(agentId))
  }

  async start(): Promise<void> {
    // Load the trusted capability catalog/modules once for this run. Best-effort:
    // a loader failure leaves the catalog undefined so validateWorkflow skips
    // capability resolution gracefully rather than crashing the run.
    let loaded: LoadedCapabilities | undefined
    try {
      loaded = await this.workspace.loadCapabilities(this.env)
      this.capabilityCatalog = loaded.catalog
    } catch (err) {
      this.logAcp('warn', 'capabilities', `Failed to load capabilities: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Load the prompt-template catalog/modules once for this run. Prompts have NO
    // secrets (no process.env arg). Best-effort: a loader failure leaves the catalog
    // undefined so validateWorkflow skips prompt resolution gracefully.
    let loadedPrompts: LoadedPrompts | undefined
    try {
      loadedPrompts = await this.workspace.loadPrompts()
      this.promptCatalog = loadedPrompts.catalog
    } catch (err) {
      this.logAcp('warn', 'prompts', `Failed to load prompts: ${err instanceof Error ? err.message : String(err)}`)
    }

    const validation = validateWorkflow(this.request.source, this.request.agent, undefined, this.capabilityCatalog, this.promptCatalog)
    if (!validation.ok || !validation.meta) {
      const msg = validation.diagnostics.find((d) => d.severity === 'error')?.message ?? 'Invalid workflow'
      this.snapshot.error = msg
      this.emit({ type: 'run:started', meta: { name: 'invalid', description: '' }, phases: [], agent: this.request.agent, cwd: this.cwd })
      this.logAcp('error', 'validate', `Validation failed: ${msg}`)
      this.finishRun('failed', msg)
      return
    }
    const meta = validation.meta
    this.snapshot.meta = meta
    // Resolve the workflow's declared capability namespaces (project>user) to the
    // already-loaded modules so hostHooks() injects only declared+resolved globals.
    if (loaded && meta.capabilities?.length) {
      this.capabilityModules = getCapabilityModules(loaded, meta.capabilities)
    }
    // Resolve the workflow's declared prompt namespaces (project>user) to the
    // already-loaded templates so hostHooks() injects only declared+resolved renders.
    if (loadedPrompts && meta.prompts?.length) {
      this.promptModules = getPromptTemplates(loadedPrompts, meta.prompts)
    }
    for (const d of validation.diagnostics) {
      if (d.severity === 'warning') this.logAcp('warn', 'validate', d.message)
    }
    for (const [method, value] of Object.entries(this.request.methodConfig ?? {})) {
      const msg = validateMethodConfig(method, value)
      if (msg) {
        const errText = `Invalid run config for ${method}: ${msg}`
        this.snapshot.error = errText
        this.emit({ type: 'run:started', meta, phases: [], agent: this.request.agent, cwd: this.cwd })
        this.logAcp('error', 'validate', errText)
        this.finishRun('failed', errText)
        return
      }
    }
    this.methodConfigs = this.resolveConfigs(meta)
    if (meta.phases?.length) {
      this.snapshot.phases = meta.phases.map((p) => ({ title: p.title, detail: p.detail, agentIds: [] }))
      this.currentPhase = meta.phases[0].title
    }
    this.emit({ type: 'run:started', meta, phases: this.snapshot.phases, agent: this.request.agent, cwd: this.cwd })

    this.setStatus('running')
    // Pre-warm the DEFAULT backend so its modes/config surface immediately
    // (preserving the "modes appear right away" UX). Non-default backends spawn
    // lazily on their first agent() call. Only a DEFAULT-backend start failure
    // fails the run; a non-default failure is a recoverable per-call error.
    try {
      await this.getConnection(this.request.agent)
    } catch (err) {
      const spec = ACP_AGENTS[this.request.agent]
      this.finishRun('failed', `Failed to start ${spec.name} agent: ${err instanceof Error ? err.message : String(err)}`)
      for (const conn of this.connections.values()) conn.close()
      this.connections.clear()
      return
    }

    try {
      // Inline pure tools/ helpers into the header, THEN instrument; headerLines is
      // computed from the emitted prefix so the source-line mapping stays correct.
      const { source, headerBindings } = inlineHelpers(validation.normalized, {
        toolsDirs: this.workspace.capabilityDirs.map((d) => d.dir),
        projectToolsDir: this.workspace.dirs.tools,
      })
      const { code, headerLines } = instrumentWorkflow(source, headerBindings)
      this.headerLines = headerLines
      const result = await runVm(code, buildSandboxGlobals(this.hostHooks(), this.methodConfigs))
      if (this.aborted) this.finishRun('cancelled')
      else this.finishRun('completed', undefined, result)
    } catch (err) {
      if (err instanceof WorkflowAbortError || this.aborted) this.finishRun('cancelled')
      else this.finishRun('failed', err instanceof Error ? err.message : String(err))
    } finally {
      for (const conn of this.connections.values()) conn.close()
      this.connections.clear()
    }
  }

  private finishRun(status: RunStatus, error?: string, result?: unknown): void {
    if (this.finished) return
    this.finished = true
    this.snapshot.finishedAt = Date.now()
    if (error) this.snapshot.error = error
    if (result !== undefined) this.snapshot.result = result
    const stats: RunStats = {
      agentCount: this.agentCounter,
      completed: this.snapshot.agents.filter((a) => a.status === 'completed').length,
      failed: this.snapshot.agents.filter((a) => a.status === 'failed').length,
      durationMs: this.snapshot.finishedAt - this.snapshot.startedAt,
      tokens: { total: this.spentTokens || undefined } as AgentTokenUsage,
    }
    this.snapshot.stats = stats
    this.snapshot.status = status
    if (error) this.logAcp('error', 'run_error', error)
    this.logAcp('system', 'run_done', `Run ${status} — ${stats.agentCount} agents, ${stats.completed} ok, ${stats.failed} failed in ${(stats.durationMs / 1000).toFixed(1)}s`)
    this.emit({ type: 'run:finished', status, result: this.snapshot.result, error, stats })
  }
}
