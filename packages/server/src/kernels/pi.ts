import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  KernelCapabilities,
  KernelHealth,
  KernelId,
  McpServerSpec,
  ModelSelection,
  PlatformToolSpec,
  ProviderSpec,
  SessionInfo,
  SkillSpec,
  SyncReport,
} from '@sre/protocol'
import type { KernelAdapter, KernelHost, SessionRuntime } from './types.ts'
import { clampText } from './types.ts'
import { evaluateToolCall } from './verdict.ts'
import { jsonSchemaToTypeBox } from './pi-schema.ts'

/**
 * Pi adapter — the kernel runs inside the platform process.
 *
 * Isolation contract (verified against pi 1.0.2):
 * - `agentDir` points at `<home>/kernels/pi`, so `auth.json`, `models.json`,
 *   `mcp.json` and session files never touch the user's `~/.pi`.
 * - skills come from `additionalSkillPaths` with `noSkills: true`, so the
 *   user's own skill directories are not scanned.
 * - the permission gate is an inline extension (`tool_call` -> `{block:true}`),
 *   which is the only native way to stop a Pi tool call before it runs.
 */

type PiModule = typeof import('@earendil-works/pi-coding-agent')

interface LiveSession {
  session: PiSession
  runtime: SessionRuntime
  unsubscribe: () => void
  seq: number
}

type PiSession = {
  prompt(text: string): Promise<void>
  abort(): Promise<void>
  dispose(): void
  subscribe(listener: (event: PiEvent) => void): () => void
  getActiveToolNames(): string[]
  getLastAssistantText(): string | undefined
  setModel(model: unknown): Promise<void>
  sessionId: string
  messages: unknown[]
}

type PiEvent = {
  type: string
  message?: { role?: string; content?: unknown }
  assistantMessageEvent?: { type: string; delta?: string; toolCall?: { id: string; name: string; arguments?: unknown } }
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: { content?: unknown; isError?: boolean; details?: unknown }
  isError?: boolean
  willRetry?: boolean
}

export class PiKernelAdapter implements KernelAdapter {
  readonly id: KernelId = 'pi'
  readonly displayName = 'Pi (in-process)'

  private host: KernelHost | undefined
  private pi: PiModule | undefined
  private modelRuntime: unknown
  private readonly sessions = new Map<string, LiveSession>()
  /** Kernel event types we do not map yet, reported once each for visibility. */
  private readonly unknownEvents = new Set<string>()
  /** Full kernel event trace on the platform log (SRE_AGENT_DEBUG). */
  private readonly trace = process.env.SRE_AGENT_DEBUG !== undefined && process.env.SRE_AGENT_DEBUG !== ''
  private startedAt = 0
  private lastError: string | undefined

  capabilities(): KernelCapabilities {
    return {
      inProcess: true,
      nativeApproval: false,
      toolRegistration: true,
      skillSync: 'files',
      mcpSync: 'files',
      modelSwitch: 'runtime',
      tokenStreaming: true,
      sessionResume: true,
    }
  }

  async start(host: KernelHost): Promise<void> {
    this.host = host
    this.pi = (await import('@earendil-works/pi-coding-agent')) as PiModule
    mkdirSync(host.config.piHome, { recursive: true })
    mkdirSync(host.config.piSessions, { recursive: true })
    mkdirSync(host.config.piSkills, { recursive: true })
    await this.syncProviders(host.store.listProviders())
    host.log.info(`pi kernel ready (home=${host.config.piHome})`)
    this.startedAt = Date.now()
  }

  async stop(): Promise<void> {
    for (const [sessionId, live] of this.sessions) {
      try {
        live.unsubscribe()
        live.session.dispose()
      } catch (error) {
        this.host?.log.warn(`disposing pi session ${sessionId} failed: ${String(error)}`)
      }
      this.sessions.delete(sessionId)
    }
    this.modelRuntime = undefined
    this.host = undefined
  }

  async health(): Promise<KernelHealth> {
    const sessions = this.sessions.size
    if (this.host === undefined || this.pi === undefined) {
      return { status: 'stopped', sessions, detail: this.lastError }
    }
    return {
      status: this.lastError === undefined ? 'ready' : 'degraded',
      sessions,
      since: this.startedAt,
      detail: this.lastError ?? `pi ${(this.pi as { VERSION?: string }).VERSION ?? ''} embedded in-process`,
    }
  }

  private async ensureModelRuntime(): Promise<unknown> {
    if (this.modelRuntime !== undefined) return this.modelRuntime
    const host = this.requireHost()
    const pi = this.requirePi()
    const runtime = await pi.ModelRuntime.create({
      authPath: host.config.piAuthPath,
      modelsPath: host.config.piModelsPath,
      modelsStorePath: join(host.config.piHome, 'models-store.json'),
      refreshOnCreate: false,
    })
    this.modelRuntime = runtime
    // Keys set through `setRuntimeApiKey` live in memory for that runtime only,
    // so a freshly constructed runtime must be re-keyed from the provider store.
    await this.applyProviderKeys(runtime)
    return runtime
  }

  private async applyProviderKeys(runtime: unknown): Promise<void> {
    const host = this.requireHost()
    const target = runtime as { setRuntimeApiKey(provider: string, key: string): Promise<void> }
    for (const provider of host.store.listProviders()) {
      if (!provider.enabled) continue
      if (provider.apiKey === undefined || provider.apiKey.length === 0) continue
      await target.setRuntimeApiKey(provider.id, provider.apiKey)
    }
  }

  private resolveModel(selection: ModelSelection | undefined): unknown {
    const runtime = this.modelRuntime as
      | { getModel(provider: string, model: string): unknown; getProviders(): readonly { id: string }[]; getModels(provider?: string): readonly { id: string }[] }
      | undefined
    if (runtime === undefined || selection === undefined) return undefined
    const direct = runtime.getModel(selection.provider, selection.model)
    if (direct !== undefined) return direct
    // Provider ids drift between kernel versions; fall back to a model-id search.
    for (const provider of runtime.getProviders()) {
      for (const model of runtime.getModels(provider.id)) {
        if (model.id === selection.model) return runtime.getModel(provider.id, model.id)
      }
    }
    return undefined
  }

  async openSession(info: SessionInfo, runtime: SessionRuntime): Promise<void> {
    const host = this.requireHost()
    const pi = this.requirePi()
    if (this.sessions.has(info.id)) return

    const modelRuntime = await this.ensureModelRuntime()
    const selection = info.model ?? host.modelOverride(info.id) ?? host.defaultModel()
    const model = this.resolveModel(selection)
    if (model === undefined) {
      // A missing model makes the kernel run empty turns with no error, so say
      // so loudly instead of letting the UI look like it is working.
      const detail =
        selection === undefined
          ? '未配置模型：请在「模型」页添加一个 Provider 并设为默认。'
          : `模型 ${selection.provider}/${selection.model} 不可用：请检查 Provider 配置（baseUrl / api / 密钥）。`
      host.log.warn(`pi session ${info.id}: ${detail}`)
      this.lastError = detail
      host.emit(info.id, { type: 'notice', level: 'warn', text: detail })
    }

    const loader = new pi.DefaultResourceLoader({
      cwd: info.cwd,
      agentDir: host.config.piHome,
      extensionFactories: this.buildExtensionFactories(info.id, runtime),
      additionalSkillPaths: [host.config.skillsDir],
      noSkills: true,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    await loader.reload()

    const { session } = await pi.createAgentSession({
      cwd: info.cwd,
      agentDir: host.config.piHome,
      modelRuntime: modelRuntime as never,
      ...(model === undefined ? {} : { model: model as never }),
      resourceLoader: loader,
      sessionManager: pi.SessionManager.create(info.cwd, host.config.piSessions),
      settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: true } }),
      // Keep the read-only builtins; command execution goes through the
      // audited, approval-gated `sre_shell` instead of a second shell.
      excludeTools: ['bash', 'edit', 'write', 'powershell'],
    })

    const live: LiveSession = { session: session as unknown as PiSession, runtime, unsubscribe: () => {}, seq: 0 }
    live.unsubscribe = live.session.subscribe((event) => this.handlePiEvent(info.id, live, event))
    this.sessions.set(info.id, live)

    host.store.updateSession(info.id, { kernelSessionId: live.session.sessionId })
    const effective = (live.session as unknown as { model?: { provider?: string; id?: string } }).model
    host.log.info(
      `pi session ${info.id} tools=${live.session.getActiveToolNames().join(',')} model=${
        effective === undefined ? 'none' : `${effective.provider ?? '?'}/${effective.id ?? '?'}`
      } selection=${selection === undefined ? 'none' : `${selection.provider}/${selection.model}`} resolved=${
        model === undefined ? 'no' : 'yes'
      }`,
    )
  }

  private buildExtensionFactories(sessionId: string, runtime: SessionRuntime) {
    const host = this.requireHost()
    const self = this
    return [
      (pi: { on(event: string, handler: (...args: never[]) => unknown): void; registerTool(tool: unknown): void }) => {
        pi.on('tool_call', async (event: { toolName: string; input: unknown }) => {
          const verdict = await evaluateToolCall(self.verdictDeps(), {
            sessionId,
            kernel: 'pi',
            toolName: event.toolName,
            args: event.input,
            annotations: host.tools.annotationsOf(event.toolName),
            origin: runtime.origin,
            ...(runtime.allowedTools === undefined ? {} : { allowedTools: runtime.allowedTools }),
            ...(host.tools.permittedOriginsOf(event.toolName) === undefined
              ? {}
              : { permittedOrigins: host.tools.permittedOriginsOf(event.toolName) }),
          })
          if (verdict.effect === 'deny') return { block: true, reason: verdict.reason }
          return undefined
        })
        for (const spec of host.tools.list()) {
          pi.registerTool(self.toPiTool(spec, sessionId, runtime))
        }
      },
    ] as never
  }

  private verdictDeps() {
    const host = this.requireHost()
    return {
      permissions: host.permissions,
      approvals: host.approvals,
      log: host.log,
      sessionScope: (sessionId: string) => {
        const live = this.sessions.get(sessionId)
        if (live !== undefined) {
          return live.runtime.allowedTools === undefined
            ? { origin: live.runtime.origin }
            : { origin: live.runtime.origin, allowedTools: live.runtime.allowedTools }
        }
        const stored = host.store.getSessionAllowedTools(sessionId)
        const session = host.store.getSession(sessionId)
        const origin = session?.origin ?? 'chat'
        return stored === undefined ? { origin } : { origin, allowedTools: stored }
      },
    }
  }

  /**
   * Platform tools are registered per session so their executor knows which
   * session (and therefore which permission scope) the call belongs to.
   */
  private toPiTool(spec: PlatformToolSpec, sessionId: string, runtime: SessionRuntime) {
    const pi = this.requirePi()
    const host = this.requireHost()
    return (pi as unknown as { defineTool(def: unknown): unknown }).defineTool({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: jsonSchemaToTypeBox(spec.parameters),
      annotations: spec.annotations,
      execute: async (toolCallId: string, params: Record<string, unknown>) => {
        const result = await host.tools.execute(spec.name, params, {
          sessionId,
          origin: runtime.origin,
          callId: toolCallId,
        })
        const images = (result.images ?? []).map((image) => ({
          type: 'image' as const,
          mimeType: image.mimeType,
          data: image.base64,
        }))
        return {
          content: [...(images as { type: string }[]), { type: 'text', text: clampText(result.content) }],
          details: result.detail ?? {},
          isError: result.ok ? undefined : true,
        }
      },
    })
  }

  private handlePiEvent(sessionId: string, live: LiveSession, event: PiEvent): void {
    const host = this.host
    if (host === undefined) return
    const emit = (payload: Parameters<KernelHost['emit']>[1]) => host.emit(sessionId, payload)
    if (this.trace) {
      const inner = event.assistantMessageEvent
      host.log.debug(
        `pi event ${event.type}${inner?.type === undefined ? '' : `/${inner.type}`}${
          inner?.delta === undefined ? '' : ` delta=${JSON.stringify(inner.delta.slice(0, 40))}`
        }${event.willRetry === undefined ? '' : ` willRetry=${String(event.willRetry)}`}`,
      )
    }

    switch (event.type) {
      case 'agent_start':
        emit({ type: 'agent_status', status: 'running' })
        emit({ type: 'turn_start' })
        break
      case 'message_update': {
        const inner = event.assistantMessageEvent
        if (inner?.type === 'text_delta' && typeof inner.delta === 'string') {
          emit({ type: 'assistant_delta', text: inner.delta })
        } else if (inner?.type === 'thinking_delta' && typeof inner.delta === 'string') {
          emit({ type: 'reasoning_delta', text: inner.delta })
        }
        break
      }
      case 'tool_execution_start':
        if (event.toolCallId !== undefined && event.toolName !== undefined) {
          emit({ type: 'tool_call', callId: event.toolCallId, name: event.toolName, args: event.args ?? {} })
        }
        break
      case 'tool_execution_end': {
        if (event.toolCallId === undefined || event.toolName === undefined) break
        const text = extractText(event.result?.content)
        emit({
          type: 'tool_result',
          callId: event.toolCallId,
          name: event.toolName,
          ok: event.isError !== true,
          content: clampText(text),
          detail: event.result?.details,
        })
        host.store.appendMessage({
          sessionId,
          role: 'tool',
          text: clampText(text),
          toolName: event.toolName,
          callId: event.toolCallId,
          ok: event.isError !== true,
          createdAt: Date.now(),
        })
        break
      }
      case 'message_end': {
        if (event.message?.role !== 'assistant') break
        const text = extractText(event.message.content) || (live.session.getLastAssistantText() ?? '')
        if (text.length > 0) {
          emit({ type: 'assistant_message', text })
          host.store.appendMessage({ sessionId, role: 'assistant', text, createdAt: Date.now() })
        }
        break
      }
      case 'turn_end':
        emit({ type: 'turn_end' })
        break
      case 'auto_retry_start':
        emit({
          type: 'notice',
          level: 'warn',
          text: `model call failed, retrying (${String((event as { attempt?: number }).attempt ?? '?')}/${String((event as { maxAttempts?: number }).maxAttempts ?? '?')}): ${String((event as { errorMessage?: string }).errorMessage ?? 'unknown error')}`,
        })
        break
      case 'auto_retry_end':
        if ((event as { success?: boolean }).success === false) {
          emit({
            type: 'error',
            message: String((event as { finalError?: string }).finalError ?? 'model call failed after retries'),
          })
        }
        break
      case 'compaction_start':
        emit({ type: 'notice', level: 'info', text: 'context compaction started' })
        break
      case 'compaction_end':
        emit({ type: 'notice', level: 'info', text: 'context compaction finished' })
        break
      case 'agent_end':
        emit({ type: 'agent_status', status: 'idle' })
        host.store.updateSession(sessionId, { updatedAt: Date.now() })
        break
      default:
        // Report unknown types once each: a kernel upgrade that adds events must
        // not be able to swallow failures silently again.
        if (!this.unknownEvents.has(event.type)) {
          this.unknownEvents.add(event.type)
          host.log.debug(`pi session ${sessionId}: unhandled kernel event "${event.type}"`)
        }
        break
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId)
    if (live === undefined) return
    this.sessions.delete(sessionId)
    try {
      live.unsubscribe()
      live.session.dispose()
    } catch (error) {
      this.host?.log.warn(`pi session ${sessionId} dispose failed: ${String(error)}`)
    }
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const live = this.requireLive(sessionId)
    const host = this.requireHost()
    host.store.appendMessage({ sessionId, role: 'user', text, createdAt: Date.now() })
    host.emit(sessionId, { type: 'user_message', text })
    try {
      await live.session.prompt(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message
      host.emit(sessionId, { type: 'error', message })
      throw error
    }
  }

  async abort(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId)
    if (live === undefined) return
    await live.session.abort()
    this.host?.emit(sessionId, { type: 'notice', level: 'info', text: 'aborted' })
  }

  async setModel(sessionId: string, selection: ModelSelection): Promise<void> {
    const live = this.requireLive(sessionId)
    const model = this.resolveModel(selection)
    if (model === undefined) {
      throw new Error(
        `model ${selection.provider}/${selection.model} is not available; configure the provider first`,
      )
    }
    await live.session.setModel(model)
    this.host?.log.info(`pi session ${sessionId} model -> ${selection.provider}/${selection.model}`)
  }

  /**
   * Providers are written to the platform-owned `models.json` (so a fresh
   * process boots with them) *and* registered on the live model runtime: the
   * runtime reads that file once at construction, so a provider added from the
   * UI would otherwise stay invisible until a kernel restart.
   */
  async syncProviders(providers: ProviderSpec[]): Promise<SyncReport> {
    const host = this.requireHost()
    const models: Record<string, unknown> = {}
    const keys: { id: string; key: string }[] = []
    for (const provider of providers.filter((entry) => entry.enabled)) {
      models[provider.id] = {
        name: provider.name,
        baseUrl: provider.baseUrl,
        api: provider.api,
        ...(provider.apiKeyEnv !== undefined && provider.apiKeyEnv.length > 0
          ? { apiKey: `$${provider.apiKeyEnv}` }
          : {}),
        models: provider.models.map((model) => ({
          id: model.id,
          ...(model.name === undefined ? {} : { name: model.name }),
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
          ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        })),
      }
      if (provider.apiKey !== undefined && provider.apiKey.length > 0) {
        keys.push({ id: provider.id, key: provider.apiKey })
      }
    }
    mkdirSync(host.config.piHome, { recursive: true })
    writeFileSync(host.config.piModelsPath, `${JSON.stringify({ providers: models }, null, 2)}\n`, 'utf8')

    const runtime = (await this.ensureModelRuntime()) as {
      setRuntimeApiKey(provider: string, key: string): Promise<void>
      registerProvider(provider: string, config: unknown): void
      unregisterProvider(provider: string): void
      getRegisteredProviderConfig?(provider: string): unknown
    }
    for (const entry of keys) await runtime.setRuntimeApiKey(entry.id, entry.key)

    // The runtime composes providers from `models.json` when it is constructed,
    // so the reliable way to publish a provider change is to rebuild it. New
    // sessions then build from the fresh catalog (existing ones keep the runtime
    // they were created with). `registerProvider` is deliberately not used: it
    // replaces the composed model entry with the raw one, dropping the defaults
    // pi needs (input/cost/contextWindow) and making the model call silently
    // return an empty message.
    this.modelRuntime = undefined

    return {
      target: 'pi:providers',
      ok: true,
      written: [host.config.piModelsPath],
      message: `${providers.length} provider(s) synced to the platform-owned Pi config; new sessions pick them up immediately`,
    }
  }

  async syncSkills(skills: SkillSpec[]): Promise<SyncReport> {
    const host = this.requireHost()
    const written = writeSkillFiles(host.config.skillsDir, skills)
    return { target: 'pi:skills', ok: true, written, message: `${skills.length} skill(s) available to Pi` }
  }

  async syncMcpServers(servers: McpServerSpec[]): Promise<SyncReport> {
    const host = this.requireHost()
    const mcpServers: Record<string, unknown> = {}
    for (const server of servers.filter((entry) => entry.enabled)) {
      mcpServers[server.name] =
        server.transport === 'stdio'
          ? {
              command: server.command,
              args: server.args ?? [],
              ...(server.env === undefined ? {} : { env: server.env }),
              ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
              ...(server.timeoutSec === undefined ? {} : { timeout: server.timeoutSec }),
            }
          : {
              url: server.url,
              ...(server.headers === undefined ? {} : { headers: server.headers }),
              ...(server.timeoutSec === undefined ? {} : { timeout: server.timeoutSec }),
            }
    }
    mkdirSync(host.config.piHome, { recursive: true })
    writeFileSync(host.config.piMcpPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, 'utf8')
    return {
      target: 'pi:mcp.json',
      ok: true,
      written: [host.config.piMcpPath],
      message: `${Object.keys(mcpServers).length} MCP server(s) written; Pi connects them on next session start`,
    }
  }

  async listKernelSessions(): Promise<{ id: string; title?: string; updatedAt?: number }[]> {
    const host = this.requireHost()
    const pi = this.requirePi()
    const infos = await pi.SessionManager.listAll(host.config.piSessions)
    return infos.map((info) => {
      const updatedAt = toMillis(info.modified)
      return {
        id: info.id,
        ...(info.name === undefined ? {} : { title: info.name }),
        ...(updatedAt === undefined ? {} : { updatedAt }),
      }
    })
  }

  private requireHost(): KernelHost {
    if (this.host === undefined) throw new Error('pi adapter is not started')
    return this.host
  }

  private requirePi(): PiModule {
    if (this.pi === undefined) throw new Error('pi module is not loaded')
    return this.pi
  }

  private requireLive(sessionId: string): LiveSession {
    const live = this.sessions.get(sessionId)
    if (live === undefined) throw new Error(`pi session ${sessionId} is not open`)
    return live
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block !== null && typeof block === 'object' && 'text' in block) return String((block as { text: unknown }).text)
      return ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
}

/** Pi types session timestamps as `Date` in 1.0.x; tolerate strings too. */
function toMillis(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/**
 * Skills are authored once in the platform and mirrored to disk in the layout
 * both kernels understand (`<name>/SKILL.md` with YAML frontmatter).
 */
export function writeSkillFiles(skillsDir: string, skills: SkillSpec[]): string[] {
  const written: string[] = []
  if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true })
  for (const skill of skills) {
    const dir = join(skillsDir, skill.name)
    if (!skill.enabled) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      continue
    }
    mkdirSync(dir, { recursive: true })
    const body = [
      '---',
      `name: ${skill.name}`,
      `description: ${JSON.stringify(skill.description)}`,
      '---',
      '',
      skill.body,
      '',
    ].join('\n')
    const file = join(dir, 'SKILL.md')
    writeFileSync(file, body, 'utf8')
    written.push(file)
  }
  return written
}
