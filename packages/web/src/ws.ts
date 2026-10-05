/**
 * Singleton platform WebSocket.
 *
 * One socket per browser tab, shared by every page through the `useWsEvent` /
 * `useWsStatus` hooks. Reconnects with exponential backoff, keeps the connection
 * alive with a `ping` frame, and drops malformed frames instead of throwing.
 */
import { useEffect, useRef, useState } from 'react'
import type { ClientMessage, ServerMessage } from '@sre/protocol'
import { api } from './api'
import type { WsState } from './types'

const PING_INTERVAL_MS = 20_000
const MAX_BACKOFF_MS = 15_000

type MessageListener = (msg: ServerMessage) => void
type StateListener = (state: WsState, error: string | null) => void

function socketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws`
}

class WsClient {
  private socket: WebSocket | null = null
  private readonly messageListeners = new Set<MessageListener>()
  private readonly stateListeners = new Set<StateListener>()
  private state: WsState = 'closed'
  private lastError: string | null = null
  private retry = 0
  private reconnectTimer: number | null = null
  private pingTimer: number | null = null
  private started = false

  /** Idempotent: opens the socket on first call. */
  start(): void {
    if (this.started) return
    this.started = true
    this.open()
  }

  getState(): WsState {
    return this.state
  }

  getLastError(): string | null {
    return this.lastError
  }

  /** Sends a client frame; returns false when the socket is not open. */
  send(message: ClientMessage): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  subscribe<T extends ServerMessage['type']>(
    type: T,
    handler: (msg: Extract<ServerMessage, { type: T }>) => void,
  ): () => void {
    const wrapped: MessageListener = (msg) => {
      if (msg.type !== type) return
      handler(msg as Extract<ServerMessage, { type: T }>)
    }
    this.messageListeners.add(wrapped)
    this.start()
    return () => {
      this.messageListeners.delete(wrapped)
    }
  }

  subscribeAll(handler: MessageListener): () => void {
    this.messageListeners.add(handler)
    this.start()
    return () => {
      this.messageListeners.delete(handler)
    }
  }

  subscribeState(handler: StateListener): () => void {
    this.stateListeners.add(handler)
    this.start()
    return () => {
      this.stateListeners.delete(handler)
    }
  }

  private setState(state: WsState, error: string | null = this.lastError): void {
    this.state = state
    this.lastError = error
    for (const listener of this.stateListeners) {
      try {
        listener(state, error)
      } catch {
        /* a subscriber must not break the socket */
      }
    }
  }

  private emit(msg: ServerMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(msg)
      } catch (err) {
        // One broken subscriber must not stop the fan-out, but it should be visible.
        console.error('[ws] subscriber failed', msg.type, err)
      }
    }
  }

  private open(): void {
    if (typeof WebSocket === 'undefined') return
    this.clearReconnect()
    this.setState('connecting')

    let socket: WebSocket
    try {
      socket = new WebSocket(socketUrl())
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : 'WebSocket 创建失败')
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.retry = 0
      this.setState('open', null)
      this.startPing()
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        return
      }
      if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
        this.emit(parsed as ServerMessage)
      }
    }
    socket.onerror = () => {
      this.lastError = 'WebSocket 连接错误'
    }
    socket.onclose = () => {
      this.stopPing()
      if (this.socket === socket) this.socket = null
      this.setState('closed', this.lastError)
      this.scheduleReconnect(this.lastError)
    }
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = window.setInterval(() => {
      if (!this.send({ type: 'ping' })) this.stopPing()
    }, PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private scheduleReconnect(reason: string | null): void {
    if (!this.started || this.reconnectTimer !== null) return
    this.lastError = reason ?? this.lastError
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.retry) + Math.random() * 400
    this.retry = Math.min(this.retry + 1, 6)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }
}

export const wsClient = new WsClient()

// --- hooks -----------------------------------------------------------------

/** Subscribes to one server message type; the handler may change every render. */
export function useWsEvent<T extends ServerMessage['type']>(
  type: T,
  handler: (msg: Extract<ServerMessage, { type: T }>) => void,
): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => wsClient.subscribe(type, (msg) => ref.current(msg)), [type])
}

/** Current socket state plus the last connection error, for status displays. */
export function useWsStatus(): { state: WsState; error: string | null } {
  const [snapshot, setSnapshot] = useState<{ state: WsState; error: string | null }>(() => ({
    state: wsClient.getState(),
    error: wsClient.getLastError(),
  }))
  useEffect(() => wsClient.subscribeState((state, error) => setSnapshot({ state, error })), [])
  return snapshot
}

// --- send helpers ----------------------------------------------------------

/**
 * Deliver a prompt. The contract exposes both channels: the REST endpoint is
 * tried first because its failure is observable (the turn is then definitely not
 * running), with the `prompt` frame as the fallback for deployments that only
 * wire the socket. The first attempt stays silent so a 404/405 fallback does not
 * shout at the user, and the original error is re-thrown when both channels fail.
 */
export async function dispatchPrompt(sessionId: string, text: string): Promise<'rest' | 'ws'> {
  try {
    await api.prompt(sessionId, text, { silent: true })
    return 'rest'
  } catch (restError) {
    if (wsClient.send({ type: 'prompt', sessionId, text })) return 'ws'
    throw restError
  }
}

/** Abort the current turn, same channel order as `dispatchPrompt`. */
export async function dispatchAbort(sessionId: string): Promise<void> {
  try {
    await api.abort(sessionId)
  } catch (restError) {
    if (!wsClient.send({ type: 'abort', sessionId })) throw restError
  }
}
