import type { WebSocket } from 'ws'
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts'
import type { RunSnapshot } from '../shared/events.ts'
import type { Runtime, RunHandle, RunInteraction } from '../runtime/index.ts'

/** Keep at most this many finished runs around for late-attach inspection. */
const MAX_FINISHED = 25

interface RunEntry {
  /** The runtime handle this entry adapts. */
  handle: RunHandle
  /** WebSocket clients receiving this run's broadcasts. */
  subscribers: Set<WebSocket>
  /** Detach every runtime listener registered for this run. */
  unsubscribe: () => void
  finishedAt?: number
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

/**
 * The thin WS subscription/broadcast adapter over the runtime controller. It no
 * longer constructs `WorkflowRun`; it drives `runtime.run()`/`runtime.get()` and
 * forwards runtime events/interactions onto the WebSocket protocol — the IDE
 * server is nothing but a consumer of the runtime.
 *
 * The map is keyed by the CLIENT-supplied runId (from the `start` message), which
 * the frontend correlates against. The runtime controller generates its own
 * engine runId, so every outbound `snapshot`/`event`/`permission`/`input` carries
 * the client runId (the snapshot's internal `runId` is rewritten to match).
 */
export class RunManager {
  private runs = new Map<string, RunEntry>()

  constructor(private runtime: Runtime) {}

  private broadcast(clientRunId: string, msg: ServerMessage): void {
    const entry = this.runs.get(clientRunId)
    if (!entry) return
    for (const ws of entry.subscribers) send(ws, msg)
  }

  /** Present a runtime snapshot under the client's runId (the engine runId
   *  differs; the frontend keys everything off the runId it chose). */
  private withRunId(snapshot: RunSnapshot, runId: string): RunSnapshot {
    return { ...snapshot, runId }
  }

  private prune(): void {
    const finished = [...this.runs.entries()].filter(([, e]) => e.finishedAt)
    if (finished.length <= MAX_FINISHED) return
    finished
      .sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0))
      .slice(0, finished.length - MAX_FINISHED)
      .forEach(([id, entry]) => {
        entry.unsubscribe()
        this.runs.delete(id)
      })
  }

  start(message: Extract<ClientMessage, { t: 'start' }>, ws: WebSocket): void {
    const { run: request } = message
    const clientRunId = request.runId
    const existing = this.runs.get(clientRunId)
    if (existing && !existing.finishedAt) {
      send(ws, { t: 'error', runId: clientRunId, message: 'A run with this id is already active.' })
      return
    }
    // Replace a stale finished entry sharing the same client runId.
    if (existing) {
      existing.unsubscribe()
      this.runs.delete(clientRunId)
    }

    const subscribers = new Set<WebSocket>([ws])
    // The controller returns the handle synchronously and defers the engine boot
    // to a microtask, so listeners registered here (and the snapshot sent below)
    // are wired up BEFORE the engine starts — no event is missed.
    const handle = this.runtime.run(
      { source: request.source },
      request.args as Record<string, unknown> | undefined,
      {
        agent: request.agent,
        modeId: request.modeId,
        cwd: request.cwd,
        breakpoints: request.breakpoints,
        stepMode: request.stepMode,
        maxConcurrency: request.maxConcurrency,
        tokenBudget: request.tokenBudget,
        methodConfig: request.methodConfig,
        // WS path resolves permissions via the dedicated {t:'permission'} message
        // (no onPermission resolver), so manualApprovals === !autoApprove.
        autoApprove: !request.manualApprovals,
      },
    )

    const offEvent = handle.on((event) => {
      // Interactions are delivered via the dedicated permission/input messages,
      // never the {t:'event'} channel (two-transport rule, design §10.D).
      if (event.type === 'interaction:request' || event.type === 'interaction:resolved') return
      this.broadcast(clientRunId, { t: 'event', runId: clientRunId, event })
      if (event.type === 'run:finished') {
        const entry = this.runs.get(clientRunId)
        if (entry) {
          entry.finishedAt = Date.now()
          this.prune()
        }
      }
    })
    const offInteraction = handle.onInteraction((interaction: RunInteraction) => {
      if (interaction.type === 'permission') {
        this.broadcast(clientRunId, { t: 'permission', runId: clientRunId, req: interaction.req })
      } else {
        this.broadcast(clientRunId, { t: 'input', runId: clientRunId, req: interaction.req })
      }
    })
    const offResolved = handle.onInteractionResolved(({ requestId, type }) => {
      if (type === 'permission') {
        this.broadcast(clientRunId, { t: 'permission:resolved', runId: clientRunId, requestId })
      } else {
        this.broadcast(clientRunId, { t: 'input:resolved', runId: clientRunId, requestId })
      }
    })

    this.runs.set(clientRunId, {
      handle,
      subscribers,
      unsubscribe: () => {
        offEvent()
        offInteraction()
        offResolved()
      },
    })
    send(ws, { t: 'snapshot', snapshot: this.withRunId(handle.snapshot(), clientRunId) })
  }

  subscribe(clientRunId: string, ws: WebSocket): void {
    const entry = this.runs.get(clientRunId)
    if (!entry) {
      send(ws, { t: 'error', runId: clientRunId, message: 'Run not found.' })
      return
    }
    entry.subscribers.add(ws)
    send(ws, { t: 'snapshot', snapshot: this.withRunId(entry.handle.snapshot(), clientRunId) })
    // Replay outstanding interactions so a late attacher isn't stuck waiting.
    for (const interaction of entry.handle.pending()) {
      if (interaction.type === 'permission') {
        send(ws, { t: 'permission', runId: clientRunId, req: interaction.req })
      } else {
        send(ws, { t: 'input', runId: clientRunId, req: interaction.req })
      }
    }
  }

  handle(message: ClientMessage, ws: WebSocket): void {
    switch (message.t) {
      case 'start':
        this.start(message, ws)
        break
      case 'subscribe':
        this.subscribe(message.runId, ws)
        break
      case 'resume':
        this.runs.get(message.runId)?.handle.resume()
        break
      case 'step':
        this.runs.get(message.runId)?.handle.step()
        break
      case 'cancel':
        this.runs.get(message.runId)?.handle.cancel()
        break
      case 'setBreakpoints':
        this.runs.get(message.runId)?.handle.setBreakpoints(message.lines)
        break
      case 'permission':
        this.runs.get(message.runId)?.handle.respond(message.requestId, message.response)
        break
      case 'input':
        this.runs.get(message.runId)?.handle.respond(message.requestId, message.response)
        break
      case 'ping':
        send(ws, { t: 'pong' })
        break
    }
  }

  removeClient(ws: WebSocket): void {
    for (const entry of this.runs.values()) entry.subscribers.delete(ws)
  }
}
