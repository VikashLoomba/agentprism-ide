import type { WebSocket } from 'ws'
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts'
import type { RunEvent } from '../shared/events.ts'
import { WorkflowRun } from './workflow/run.ts'

interface RunEntry {
  run: WorkflowRun
  subscribers: Set<WebSocket>
  finishedAt?: number
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

/**
 * Owns the lifecycle of every workflow run and fans run events out to the
 * WebSocket clients subscribed to each run.
 */
export class RunManager {
  private runs = new Map<string, RunEntry>()

  private broadcast(runId: string, msg: ServerMessage): void {
    const entry = this.runs.get(runId)
    if (!entry) return
    for (const ws of entry.subscribers) send(ws, msg)
  }

  private prune(): void {
    const finished = [...this.runs.entries()].filter(([, e]) => e.finishedAt)
    if (finished.length <= 25) return
    finished
      .sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0))
      .slice(0, finished.length - 25)
      .forEach(([id]) => this.runs.delete(id))
  }

  start(message: Extract<ClientMessage, { t: 'start' }>, ws: WebSocket): void {
    const { run: request } = message
    if (this.runs.has(request.runId) && !this.runs.get(request.runId)!.run.isDone()) {
      send(ws, { t: 'error', runId: request.runId, message: 'A run with this id is already active.' })
      return
    }
    const subscribers = new Set<WebSocket>([ws])
    const run = new WorkflowRun(request, {
      emit: (event: RunEvent) => {
        this.broadcast(request.runId, { t: 'event', runId: request.runId, event })
        if (event.type === 'run:finished') {
          const entry = this.runs.get(request.runId)
          if (entry) {
            entry.finishedAt = Date.now()
            this.prune()
          }
        }
      },
      notifyPermission: (req) => this.broadcast(request.runId, { t: 'permission', runId: request.runId, req }),
    })
    this.runs.set(request.runId, { run, subscribers })
    send(ws, { t: 'snapshot', snapshot: run.getSnapshot() })
    run.start().catch((err) => {
      this.broadcast(request.runId, {
        t: 'error',
        runId: request.runId,
        message: err instanceof Error ? err.message : String(err),
      })
    })
  }

  subscribe(runId: string, ws: WebSocket): void {
    const entry = this.runs.get(runId)
    if (!entry) {
      send(ws, { t: 'error', runId, message: 'Run not found.' })
      return
    }
    entry.subscribers.add(ws)
    send(ws, { t: 'snapshot', snapshot: entry.run.getSnapshot() })
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
        this.runs.get(message.runId)?.run.resume()
        break
      case 'step':
        this.runs.get(message.runId)?.run.step()
        break
      case 'cancel':
        this.runs.get(message.runId)?.run.cancel()
        break
      case 'setBreakpoints':
        this.runs.get(message.runId)?.run.setBreakpoints(message.lines)
        break
      case 'permission': {
        const entry = this.runs.get(message.runId)
        entry?.run.resolvePermission(message.requestId, message.response)
        this.broadcast(message.runId, { t: 'permission:resolved', runId: message.runId, requestId: message.requestId })
        break
      }
      case 'ping':
        send(ws, { t: 'pong' })
        break
    }
  }

  removeClient(ws: WebSocket): void {
    for (const entry of this.runs.values()) entry.subscribers.delete(ws)
  }
}
