import type { ClientMessage, ServerMessage } from '@shared/protocol'

export type WsStatus = 'connecting' | 'open' | 'closed'

export interface WsClient {
  send: (msg: ClientMessage) => void
  close: () => void
}

export function createWsClient(handlers: {
  onMessage: (msg: ServerMessage) => void
  onStatus: (status: WsStatus) => void
}): WsClient {
  let ws: WebSocket | null = null
  let queue: ClientMessage[] = []
  let closedByUser = false
  let reconnectTimer: number | undefined

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

  function connect() {
    handlers.onStatus('connecting')
    ws = new WebSocket(url)
    ws.onopen = () => {
      handlers.onStatus('open')
      for (const m of queue) ws!.send(JSON.stringify(m))
      queue = []
    }
    ws.onmessage = (ev) => {
      try {
        handlers.onMessage(JSON.parse(ev.data) as ServerMessage)
      } catch {
        /* ignore malformed */
      }
    }
    ws.onclose = () => {
      handlers.onStatus('closed')
      ws = null
      if (!closedByUser) reconnectTimer = window.setTimeout(connect, 1200)
    }
    ws.onerror = () => ws?.close()
  }

  connect()

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
      else queue.push(msg)
    },
    close() {
      closedByUser = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    },
  }
}
