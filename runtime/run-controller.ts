// runtime/run-controller.ts
//
// The non-WS half of today's RunManager: a transport-agnostic registry of runs
// with multi-listener fan-out, replayable interaction correlation, and
// done-settlement. Each entry owns ONE WorkflowRun (the single engine) and a set
// of listeners; events fan out to all of them. Interaction requests (permission +
// human-in-the-loop input) seen via notifyPermission/notifyInput are tracked in a
// per-run pending registry and replayed to late subscribers, so attaching after a
// request was raised still surfaces it. Runs persist after every listener detaches
// (never auto-cancelled); the registry prunes to the 25 most-recent finished.
//
// RunHandle is a thin facade over a controller entry; the IDE WS adapter (UNIT C)
// and headless hosts (UNIT E) both consume it.
import { customAlphabet } from 'nanoid'
import { WorkflowRun } from './engine/run.ts'
import type { RunCallbacks } from './engine/run.ts'
import type { Workspace } from './workspace.ts'
import type { RunEvent, RunSnapshot, RunStats } from '../shared/events.ts'
import type {
  InputRequest,
  InputResponse,
  PermissionRequest,
  PermissionResponse,
  RunRequest,
} from '../shared/protocol.ts'
import type { AcpAgentId } from '../shared/agents.ts'
import type { Json } from '../shared/capability.ts'

const newRunId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)

/** Keep at most this many finished runs around for late-attach inspection. */
const MAX_FINISHED = 25

/** The terminal outcome of a run, resolved on `RunHandle.done`. */
export interface RunResult {
  runId: string
  status: 'completed' | 'failed' | 'cancelled'
  result?: unknown
  error?: string
}

/** Per-run options. Mirrors the relevant RunRequest fields plus the two
 *  interaction-resolver ergonomics (engine awaits the resolver directly). */
export interface RunOptions {
  agent?: AcpAgentId
  modeId?: string
  cwd?: string
  breakpoints?: number[]
  stepMode?: boolean
  maxConcurrency?: number
  tokenBudget?: number | null
  methodConfig?: Record<string, Record<string, unknown>>
  /** Auto-approve ACP permission requests (default true → today's behavior).
   *  Set false to route permissions to onPermission / respond(). */
  autoApprove?: boolean
  /** Resolver ergonomic: answer a permission request directly. When provided,
   *  permissions are routed to the host (manual approvals) and resolved here. */
  onPermission?: (req: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>
  /** Resolver ergonomic: answer a mid-run input (checkpoint) request directly. */
  onInput?: (req: InputRequest) => Json | Promise<Json>
}

/** One outstanding mid-run interaction request awaiting a response. */
export type RunInteraction =
  | { type: 'permission'; req: PermissionRequest }
  | { type: 'input'; req: InputRequest }

export interface RunHandle {
  readonly runId: string
  /** A defensive (structuredClone) copy of the run's current snapshot. */
  snapshot(): RunSnapshot

  // Event stream — both ergonomics over the single emit seam.
  /** Push: subscribe to every run event; returns an unsubscribe fn. */
  on(listener: (event: RunEvent) => void): () => void
  /** Pull: a buffered async iterable of run events (ends after run:finished). */
  events(): AsyncIterable<RunEvent>

  // Control (debug surface — the IDE uses these; production hosts may ignore).
  resume(): void
  step(): void
  cancel(): void
  setBreakpoints(lines: number[]): void

  /** Interaction ergonomic B: answer a request that arrived (with requestId)
   *  via onInteraction or the interaction:request event. Routes a
   *  PermissionResponse → resolvePermission, an InputResponse → resolveInput. */
  respond(requestId: string, response: PermissionResponse | InputResponse): void

  readonly done: Promise<RunResult>

  // --- Additive interaction surface (replayable; used by the WS adapter) ---
  /** Snapshot of interaction requests not yet answered (late-attach replay). */
  pending(): RunInteraction[]
  /** Subscribe to interaction requests. Immediately replays current pending
   *  requests to the new listener, then fires for each subsequent one. Attaching
   *  a listener also enables interactive input (checkpoints park for an answer). */
  onInteraction(listener: (interaction: RunInteraction) => void): () => void
  /** Subscribe to interaction resolutions (a pending request was answered). */
  onInteractionResolved(
    listener: (resolved: { requestId: string; type: 'permission' | 'input' }) => void,
  ): () => void
}

/** The async-prepared inputs to a run: a resolved source + validated args, or a
 *  list of input-validation errors (the run never starts). */
export type Prepared =
  | { ok: true; source: string; args: Record<string, Json> }
  | { ok: false; errors: string[] }

interface RunEntry {
  runId: string
  agent: AcpAgentId
  cwd: string
  run?: WorkflowRun
  handle?: RunHandle
  listeners: Set<(event: RunEvent) => void>
  interactionListeners: Set<(interaction: RunInteraction) => void>
  resolvedListeners: Set<(resolved: { requestId: string; type: 'permission' | 'input' }) => void>
  /** Outstanding interaction requests, keyed by requestId (replayed on attach). */
  pending: Map<string, RunInteraction>
  /** Snapshot returned before the engine exists / for validation-failed runs. */
  fallbackSnapshot: RunSnapshot
  finishedAt?: number
  result?: RunResult
  done: Promise<RunResult>
  settle: (result: RunResult) => void
  /** When true, checkpoint()/input() park for an answer (a host can respond). */
  interactive: boolean
  /** A cancel() arrived before the engine was constructed. */
  cancelRequested: boolean
}

function zeroStats(): RunStats {
  return { agentCount: 0, completed: 0, failed: 0, durationMs: 0, tokens: {} }
}

function emptySnapshot(runId: string, agent: AcpAgentId, cwd: string): RunSnapshot {
  return {
    runId,
    status: 'starting',
    agent,
    cwd,
    phases: [],
    agents: [],
    effects: [],
    log: [],
    stats: zeroStats(),
    breakpoints: [],
    startedAt: Date.now(),
  }
}

/**
 * Owns the lifecycle of every run and fans events out to all listeners. One
 * WorkflowRun per entry — the single engine, never duplicated.
 */
export class RunController {
  private runs = new Map<string, RunEntry>()
  private env: NodeJS.ProcessEnv
  private defaultCwd: string
  private workspace: Workspace

  constructor(opts: { env?: NodeJS.ProcessEnv; cwd?: string; workspace: Workspace }) {
    this.env = opts.env ?? process.env
    this.workspace = opts.workspace
    this.defaultCwd = opts.cwd ?? opts.workspace.root
  }

  get(runId: string): RunHandle | undefined {
    const entry = this.runs.get(runId)
    return entry ? this.handleFor(entry) : undefined
  }

  list(): RunHandle[] {
    return [...this.runs.values()].map((entry) => this.handleFor(entry))
  }

  /**
   * Register a run and kick off its async preparation. Returns the RunHandle
   * synchronously so a caller can subscribe (on/events/onInteraction) BEFORE the
   * engine starts — the prepare step is deferred to a microtask, so no event is
   * missed. `prepare` resolves the source + validates inputs; on failure the run
   * settles `failed` with a synthesized run:finished (identical surface for IDE
   * and host).
   */
  launch(prepare: () => Promise<Prepared>, options: RunOptions = {}): RunHandle {
    const runId = newRunId()
    const agent: AcpAgentId = options.agent ?? 'claude'
    const cwd = options.cwd ?? this.defaultCwd
    let settle!: (result: RunResult) => void
    const done = new Promise<RunResult>((resolve) => {
      settle = resolve
    })
    const entry: RunEntry = {
      runId,
      agent,
      cwd,
      listeners: new Set(),
      interactionListeners: new Set(),
      resolvedListeners: new Set(),
      pending: new Map(),
      fallbackSnapshot: emptySnapshot(runId, agent, cwd),
      done,
      settle: (result) => {
        if (entry.result) return
        entry.result = result
        settle(result)
      },
      interactive: !!options.onInput,
      cancelRequested: false,
    }
    this.runs.set(runId, entry)
    const handle = this.handleFor(entry)
    void this.boot(entry, prepare, options)
    return handle
  }

  /* ------------------------------ internals ------------------------------ */

  private async boot(
    entry: RunEntry,
    prepare: () => Promise<Prepared>,
    options: RunOptions,
  ): Promise<void> {
    let prepared: Prepared
    try {
      prepared = await prepare()
    } catch (err) {
      this.failRun(entry, err instanceof Error ? err.message : String(err))
      return
    }
    if (!prepared.ok) {
      this.failRun(entry, prepared.errors.join('; ') || 'Input validation failed')
      return
    }
    if (entry.cancelRequested) {
      this.cancelRun(entry)
      return
    }

    const request: RunRequest = {
      runId: entry.runId,
      source: prepared.source,
      agent: entry.agent,
      modeId: options.modeId,
      cwd: entry.cwd,
      workspaceId: this.workspace.id,
      args: prepared.args,
      breakpoints: options.breakpoints ?? [],
      stepMode: options.stepMode,
      // Route permissions to the host when a resolver is supplied, else honor
      // autoApprove (default true → today's auto-approve behavior).
      manualApprovals: options.onPermission ? true : !(options.autoApprove ?? true),
      maxConcurrency: options.maxConcurrency,
      tokenBudget: options.tokenBudget,
      methodConfig: options.methodConfig,
    }

    const callbacks: RunCallbacks = {
      emit: (event) => this.handleEvent(entry, event),
      notifyPermission: (req) => this.handlePermission(entry, options, req),
      notifyInput: (req) => this.handleInput(entry, options, req),
    }
    const run = new WorkflowRun(request, callbacks, { env: this.env, workspace: this.workspace })
    entry.run = run
    if (entry.interactive) run.setInteractiveInput(true)

    run.start().catch((err) => {
      // start() can reject before emitting run:finished (validation / config /
      // connection failures). Synthesize a failed run:finished so listeners and
      // done settle exactly as they do for an in-band failure.
      if (entry.finishedAt) return
      this.failRun(entry, err instanceof Error ? err.message : String(err))
    })
  }

  private handleEvent(entry: RunEntry, event: RunEvent): void {
    for (const listener of [...entry.listeners]) listener(event)
    if (event.type === 'interaction:resolved') {
      this.clearPending(entry, event.requestId)
    }
    if (event.type === 'run:finished') {
      entry.finishedAt = Date.now()
      entry.pending.clear()
      entry.settle({
        runId: entry.runId,
        status: event.status as RunResult['status'],
        result: event.result,
        error: event.error,
      })
      this.prune()
    }
  }

  /** Synthesize a failed run:finished (used for input-validation failures and
   *  start() rejections that never reach the engine's own finishRun). */
  private failRun(entry: RunEntry, error: string): void {
    if (entry.finishedAt) return
    entry.fallbackSnapshot.status = 'failed'
    entry.fallbackSnapshot.error = error
    entry.fallbackSnapshot.finishedAt = Date.now()
    this.handleEvent(entry, { type: 'run:finished', status: 'failed', error, stats: zeroStats() })
  }

  /** Synthesize a cancelled run:finished when cancel() arrived pre-start. */
  private cancelRun(entry: RunEntry): void {
    if (entry.finishedAt) return
    entry.fallbackSnapshot.status = 'cancelled'
    entry.fallbackSnapshot.finishedAt = Date.now()
    this.handleEvent(entry, { type: 'run:finished', status: 'cancelled', stats: zeroStats() })
  }

  private handlePermission(entry: RunEntry, options: RunOptions, req: PermissionRequest): void {
    if (options.onPermission) {
      Promise.resolve(options.onPermission(req)).then(
        (response) => entry.run?.resolvePermission(req.requestId, response),
        () => entry.run?.resolvePermission(req.requestId, { kind: 'cancelled' }),
      )
      return
    }
    const interaction: RunInteraction = { type: 'permission', req }
    entry.pending.set(req.requestId, interaction)
    for (const listener of [...entry.interactionListeners]) listener(interaction)
  }

  private handleInput(entry: RunEntry, options: RunOptions, req: InputRequest): void {
    if (options.onInput) {
      Promise.resolve(options.onInput(req)).then(
        (value) => entry.run?.resolveInput(req.requestId, { kind: 'value', value }),
        () => entry.run?.resolveInput(req.requestId, { kind: 'cancelled' }),
      )
      return
    }
    const interaction: RunInteraction = { type: 'input', req }
    entry.pending.set(req.requestId, interaction)
    for (const listener of [...entry.interactionListeners]) listener(interaction)
  }

  private clearPending(entry: RunEntry, requestId: string): void {
    const interaction = entry.pending.get(requestId)
    if (!interaction) return
    entry.pending.delete(requestId)
    for (const listener of [...entry.resolvedListeners]) {
      listener({ requestId, type: interaction.type })
    }
  }

  private respond(
    entry: RunEntry,
    requestId: string,
    response: PermissionResponse | InputResponse,
  ): void {
    const interaction = entry.pending.get(requestId)
    const type =
      interaction?.type ??
      (response.kind === 'selected' ? 'permission' : response.kind === 'value' ? 'input' : undefined)
    const run = entry.run
    if (run) {
      if (type === 'permission') {
        run.resolvePermission(requestId, response as PermissionResponse)
      } else if (type === 'input') {
        run.resolveInput(requestId, response as InputResponse)
      } else {
        // A bare 'cancelled' with no tracked interaction — both are no-ops when
        // the requestId isn't pending in the engine, so resolving both is safe.
        run.resolvePermission(requestId, { kind: 'cancelled' })
        run.resolveInput(requestId, { kind: 'cancelled' })
      }
    }
    // Permission resolution emits no engine event, so clear here; input also
    // emits interaction:resolved which clears again (idempotent via has-check).
    this.clearPending(entry, requestId)
  }

  private prune(): void {
    const finished = [...this.runs.entries()].filter(([, e]) => e.finishedAt)
    if (finished.length <= MAX_FINISHED) return
    finished
      .sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0))
      .slice(0, finished.length - MAX_FINISHED)
      .forEach(([id]) => this.runs.delete(id))
  }

  private makeEvents(entry: RunEntry): AsyncIterable<RunEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        const buffer: RunEvent[] = []
        let ended = false
        let waiter: ((result: IteratorResult<RunEvent>) => void) | null = null
        const listener = (event: RunEvent): void => {
          if (waiter) {
            const resolve = waiter
            waiter = null
            resolve({ value: event, done: false })
          } else {
            buffer.push(event)
          }
          if (event.type === 'run:finished') ended = true
        }
        entry.listeners.add(listener)
        const cleanup = (): void => {
          entry.listeners.delete(listener)
        }
        return {
          next(): Promise<IteratorResult<RunEvent>> {
            if (buffer.length > 0) {
              return Promise.resolve({ value: buffer.shift()!, done: false })
            }
            if (ended || entry.finishedAt) {
              cleanup()
              return Promise.resolve({ value: undefined, done: true })
            }
            return new Promise((resolve) => {
              waiter = resolve
            })
          },
          return(): Promise<IteratorResult<RunEvent>> {
            cleanup()
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    }
  }

  private handleFor(entry: RunEntry): RunHandle {
    if (entry.handle) return entry.handle
    const controller = this
    const handle: RunHandle = {
      get runId(): string {
        return entry.runId
      },
      snapshot(): RunSnapshot {
        const snap = entry.run ? entry.run.getSnapshot() : entry.fallbackSnapshot
        return structuredClone(snap)
      },
      on(listener): () => void {
        entry.listeners.add(listener)
        return () => entry.listeners.delete(listener)
      },
      events(): AsyncIterable<RunEvent> {
        return controller.makeEvents(entry)
      },
      resume(): void {
        entry.run?.resume()
      },
      step(): void {
        entry.run?.step()
      },
      cancel(): void {
        if (entry.run) entry.run.cancel()
        else entry.cancelRequested = true
      },
      setBreakpoints(lines): void {
        entry.run?.setBreakpoints(lines)
      },
      respond(requestId, response): void {
        controller.respond(entry, requestId, response)
      },
      get done(): Promise<RunResult> {
        return entry.done
      },
      pending(): RunInteraction[] {
        return [...entry.pending.values()]
      },
      onInteraction(listener): () => void {
        entry.interactionListeners.add(listener)
        // A host can now answer inputs — enable interactive checkpoints.
        if (!entry.interactive) {
          entry.interactive = true
          entry.run?.setInteractiveInput(true)
        }
        // Replay outstanding requests so a late attacher isn't stuck.
        for (const interaction of entry.pending.values()) listener(interaction)
        return () => entry.interactionListeners.delete(listener)
      },
      onInteractionResolved(listener): () => void {
        entry.resolvedListeners.add(listener)
        return () => entry.resolvedListeners.delete(listener)
      },
    }
    entry.handle = handle
    return handle
  }
}
