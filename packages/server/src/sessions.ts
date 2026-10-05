import { randomUUID } from 'node:crypto'
import type { ChatMessage, ModelSelection, SessionInfo, ToolOrigin } from '@sre/protocol'
import type { AppConfig } from './config.ts'
import type { Logger } from './log.ts'
import type { Store } from './store.ts'
import type { KernelRegistry } from './kernels/registry.ts'
import type { SessionRuntime } from './kernels/types.ts'

export interface CreateSessionRequest {
  title?: string
  cwd?: string
  model?: ModelSelection
  origin?: ToolOrigin
  allowedTools?: string[]
  parentSessionId?: string
  runbookId?: string
  alertId?: string
}

export interface SessionServiceDeps {
  store: Store
  config: AppConfig
  log: Logger
  registry: KernelRegistry
  onSessionUpdated(session: SessionInfo, reason: 'created' | 'message' | 'model' | 'status'): void
  /** Resolves when the kernel reports the session idle again (unattended runs). */
  waitForIdle(sessionId: string, timeoutMs: number): Promise<boolean>
  /**
   * Memory bridging hook: the platform may prefix a turn with recalled context.
   * Returning undefined leaves the prompt untouched.
   */
  memoryPrefix?: (sessionId: string, text: string) => string | undefined
}

const DEFAULT_TITLE = '新会话'

/**
 * Platform-side session lifecycle. The kernel keeps its own session record; this
 * service is the source of truth for the UI, the audit trail and the permission
 * scope attached to each session.
 */
export class SessionService {
  private readonly deps: SessionServiceDeps

  constructor(deps: SessionServiceDeps) {
    this.deps = deps
  }

  async create(request: CreateSessionRequest = {}): Promise<SessionInfo> {
    const { store, config, registry } = this.deps
    const now = Date.now()
    const origin = request.origin ?? 'chat'
    const session: SessionInfo = {
      id: randomUUID(),
      kernel: registry.activeId(),
      title: request.title ?? DEFAULT_TITLE,
      cwd: request.cwd ?? config.workspace,
      origin,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
      ...(request.runbookId === undefined ? {} : { runbookId: request.runbookId }),
      ...(request.alertId === undefined ? {} : { alertId: request.alertId }),
    }
    store.insertSession(session, request.allowedTools)
    store.audit({
      actor: 'operator',
      action: 'session.create',
      subject: session.id,
      detail: { kernel: session.kernel, origin, runbook: request.runbookId },
    })

    const runtime: SessionRuntime = {
      sessionId: session.id,
      origin,
      ...(request.allowedTools === undefined ? {} : { allowedTools: request.allowedTools }),
    }
    await registry.activeAdapter().openSession(session, runtime)
    this.deps.onSessionUpdated(session, 'created')
    return session
  }

  /** Re-open a persisted session after a restart or kernel switch. */
  async reopen(session: SessionInfo): Promise<void> {
    const allowedTools = this.deps.store.getSessionAllowedTools(session.id)
    await this.deps.registry.activeAdapter().openSession(session, {
      sessionId: session.id,
      origin: session.origin,
      ...(allowedTools === undefined ? {} : { allowedTools }),
    })
  }

  list(limit = 100): SessionInfo[] {
    return this.deps.store.listSessions({ limit })
  }

  get(id: string): SessionInfo | undefined {
    return this.deps.store.getSession(id)
  }

  messages(id: string): ChatMessage[] {
    return this.deps.store.listMessages(id)
  }

  async prompt(id: string, text: string): Promise<void> {
    const session = this.deps.store.getSession(id)
    if (session === undefined) throw new Error(`session ${id} does not exist`)
    // Automatic memory recall happens here, at the platform level, so every
    // kernel (pi, dsh, CLI) gets the same behaviour without knowing about memory.
    const recalled = this.deps.memoryPrefix?.(id, text)
    const effective = recalled === undefined ? text : `${recalled}\n\n${text}`
    await this.deps.registry.activeAdapter().prompt(id, effective)

    const messages = this.deps.store.listMessages(id, 50)
    const userMessages = messages.filter((message) => message.role === 'user')
    if (session.title === DEFAULT_TITLE && userMessages.length <= 1) {
      const title = text.trim().split('\n')[0]?.slice(0, 60) ?? DEFAULT_TITLE
      this.deps.store.updateSession(id, { title, updatedAt: Date.now() })
      const updated = this.deps.store.getSession(id)
      if (updated !== undefined) this.deps.onSessionUpdated(updated, 'created')
    } else {
      this.deps.store.updateSession(id, { updatedAt: Date.now() })
    }
  }

  async waitForIdle(id: string, timeoutMs: number): Promise<boolean> {
    return this.deps.waitForIdle(id, timeoutMs)
  }

  async abort(id: string): Promise<void> {
    await this.deps.registry.activeAdapter().abort(id)
  }

  async setModel(id: string, selection: ModelSelection): Promise<void> {
    await this.deps.registry.activeAdapter().setModel(id, selection)
    this.deps.store.updateSession(id, { model: selection })
    const session = this.deps.store.getSession(id)
    if (session !== undefined) this.deps.onSessionUpdated(session, 'model')
  }

  async delete(id: string): Promise<void> {
    await this.deps.registry.activeAdapter().closeSession(id)
    this.deps.store.deleteSession(id)
    this.deps.store.audit({ actor: 'operator', action: 'session.delete', subject: id })
  }
}
