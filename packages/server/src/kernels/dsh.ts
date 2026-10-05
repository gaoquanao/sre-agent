import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  KernelId,
  McpServerSpec,
  ModelSelection,
  ProviderSpec,
  SessionInfo,
  SkillSpec,
  SyncReport,
} from '@sre/protocol'
import { clampText, type KernelAdapter, type KernelHost, type SessionRuntime } from './types.ts'
import { writeSkillFiles } from './pi.ts'

const PLUGIN_PACKAGE = 'sre-agent-dsh-bridge'

/**
 * dsh adapter — the kernel runs as a managed subprocess (`--profile sre-agent`).
 *
 * Why a subprocess rather than an in-process mount:
 * - the sdk profile's stdio JSON-RPC surface is tiny and version-stable, and a
 *   crash or runaway turn cannot take the platform down with it;
 * - everything dsh owns (DSH_HOME, sessions, storages) stays inside the platform
 *   home, so the user's `~/.dsh` is never touched.
 *
 * The generated profile stacks three things on top of `dsh-base` + `dsh-sdk-app`:
 * plaintext session history, a watched skill root, and our bridge plugin (tool
 * injection, approval gate, event relay, per-session model override).
 */
export class DshKernelAdapter implements KernelAdapter {
  readonly id: KernelId = 'dsh'
  readonly displayName = 'DeepSeek Harness (subprocess)'

  private host: KernelHost | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private startedAt = 0
  private lastError: string | undefined
  private status: KernelHealth['status'] = 'stopped'
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private nextRequestId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly callNames = new Map<string, string>()
  private initialized = false
  private model: ModelSelection | undefined

  capabilities(): KernelCapabilities {
    return {
      inProcess: false,
      nativeApproval: true,
      toolRegistration: true,
      skillSync: 'files',
      mcpSync: 'plugin',
      modelSwitch: 'runtime',
      tokenStreaming: true,
      sessionResume: true,
    }
  }

  async start(host: KernelHost): Promise<void> {
    this.host = host
    if (host.config.mockLlm) {
      this.model = { provider: 'sre-mock', model: 'mock-1' }
    } else {
      const provider = host.store.listProviders().find((entry) => entry.enabled && entry.models.length > 0)
      this.model =
        host.defaultModel() ??
        (provider === undefined
          ? { provider: 'deepseek-official', model: 'deepseek-flash' }
          : { provider: provider.id, model: provider.models[0]?.id ?? 'default' })
    }

    this.writeProfilePackage()
    this.writeProfilePatch({})
    await this.spawnProcess()
    host.log.info(
      `dsh kernel ready (profile=${host.config.dshProfile}, model=${this.model.provider}/${this.model.model})`,
    )
    this.startedAt = Date.now()
  }

  async stop(): Promise<void> {
    this.initialized = false
    this.status = 'stopped'
    const child = this.child
    this.child = undefined
    if (child === undefined) return
    try {
      if (child.exitCode === null) {
        await this.request('shutdown', undefined, 3_000).catch(() => undefined)
        child.kill('SIGTERM')
        await new Promise<void>((resolvePromise) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            resolvePromise()
          }, 2_000)
          child.once('exit', () => {
            clearTimeout(timer)
            resolvePromise()
          })
        })
      }
    } catch (error) {
      this.host?.log.warn(`dsh shutdown failed: ${String(error)}`)
    }
    this.host = undefined
  }

  async health(): Promise<KernelHealth> {
    if (this.child === undefined) {
      return { status: this.status === 'error' ? 'error' : 'stopped', detail: this.lastError }
    }
    const exit = this.child.exitCode
    if (exit !== null) return { status: 'error', detail: `dsh exited with code ${exit}` }
    return {
      status: this.initialized ? 'ready' : 'starting',
      since: this.startedAt,
      sessions: this.runtimes.size,
      detail: this.lastError ?? `profile ${this.host?.config.dshProfile ?? ''}`,
    }
  }

  async openSession(info: SessionInfo, runtime: SessionRuntime): Promise<void> {
    this.runtimes.set(info.id, runtime)
    // dsh creates the agent lazily on the first `session/prompt`, keyed by the
    // session id we pass — which is the platform session id itself.
    this.host?.store.updateSession(info.id, { kernelSessionId: info.id })
  }

  async closeSession(sessionId: string): Promise<void> {
    this.runtimes.delete(sessionId)
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const host = this.requireHost()
    host.store.appendMessage({ sessionId, role: 'user', text, createdAt: Date.now() })
    host.emit(sessionId, { type: 'user_message', text })
    try {
      await this.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text }] }, 30_000)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message
      host.emit(sessionId, { type: 'error', message })
      throw error
    }
  }

  /**
   * The sdk wire has no per-turn cancel (a client abandons a turn by closing the
   * runtime), so this reports the limitation instead of pretending to abort.
   */
  async abort(sessionId: string): Promise<void> {
    this.host?.emit(sessionId, {
      type: 'notice',
      level: 'warn',
      text: 'DeepSeek Harness sdk profile cannot cancel a turn in flight; wait for it to finish or restart the kernel.',
    })
  }

  async setModel(sessionId: string, selection: ModelSelection): Promise<void> {
    this.host?.setModelOverride(sessionId, selection)
    this.host?.log.info(`dsh session ${sessionId} model override -> ${selection.provider}/${selection.model}`)
  }

  async syncSkills(skills: SkillSpec[]): Promise<SyncReport> {
    const host = this.requireHost()
    const written = writeSkillFiles(host.config.skillsDir, skills)
    return {
      target: 'dsh:skills',
      ok: true,
      written,
      message: `${skills.length} skill(s) mirrored into the watched root`,
    }
  }

  async syncMcpServers(servers: McpServerSpec[]): Promise<SyncReport> {
    const rows = servers
      .filter((server) => server.enabled)
      .map((server) => ({
        id: `mcp-${server.name}`,
        name: '@deepseek-ai/dsh-mcp-client',
        config:
          server.transport === 'stdio'
            ? {
                transport: 'stdio',
                serverName: server.name,
                command: server.command ?? '',
                args: server.args ?? [],
                env: server.env ?? {},
                ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
                ...(server.timeoutSec === undefined ? {} : { toolCallTimeoutMs: server.timeoutSec * 1000 }),
              }
            : {
                transport: 'streamable-http',
                serverName: server.name,
                url: server.url ?? '',
                headers: server.headers ?? {},
                ...(server.timeoutSec === undefined ? {} : { toolCallTimeoutMs: server.timeoutSec * 1000 }),
              },
      }))
    const path = this.writeProfilePatch({ mcpRows: rows })
    return {
      target: 'dsh:profile',
      ok: true,
      written: [path],
      message: `${rows.length} MCP server row(s) written; restart the dsh kernel to apply`,
    }
  }

  async syncProviders(providers: ProviderSpec[]): Promise<SyncReport> {
    const enabled = providers.filter((provider) => provider.enabled)
    const profiles: Record<string, unknown> = {}
    for (const provider of enabled) {
      profiles[provider.id] = {
        displayName: provider.name,
        api: provider.api,
        baseURL: provider.baseUrl,
        ...(provider.apiKeyEnv === undefined || provider.apiKeyEnv.length === 0
          ? {}
          : { apiKeyEnv: provider.apiKeyEnv }),
        models: provider.models.map((model) => ({
          id: model.id,
          ...(model.name === undefined ? {} : { displayName: model.name }),
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        })),
      }
    }
    const path = this.writeProfilePatch({ providers: profiles })
    return {
      target: 'dsh:profile',
      ok: true,
      written: [path],
      message: `${enabled.length} provider(s) written to the dsh profile; restart to apply`,
    }
  }

  // -- profile generation --------------------------------------------------

  private bridgePluginDir(): string {
    const here = dirname(fileURLToPath(import.meta.url))
    // src/kernels -> packages/dsh-bridge-plugin (same depth from dist/).
    return resolve(here, '..', '..', '..', 'dsh-bridge-plugin')
  }

  /**
   * Patch semantics that matter here (verified against cordis-plugin-include):
   * `config` replaces the target row's whole config object, and a patch can only
   * address a row that exists when it is applied — so the `insert` of our bridge
   * row must come before the patch that sets its config.
   */
  private writeProfilePatch(extra: { mcpRows?: unknown[]; providers?: Record<string, unknown> }): string {
    const host = this.requireHost()
    const profile = host.config.dshProfile
    if (!existsSync(profile)) mkdirSync(profile, { recursive: true })

    const lines: string[] = [
      '# Generated by SRE Agent. Manual edits are overwritten on the next sync.',
      '',
      '# Plain JSONL history so the platform can list and audit runs directly.',
      '- id: session-persistence-jsonl',
      '  config:',
      `    root: ${join(host.config.dshHome, 'sessions')}`,
      '    compression: none',
      '',
      '# Platform-authored skills live in a dedicated watched root; user and',
      '# repository roots stay enabled so local skills keep working.',
      '- id: skill-filesystem',
      '  config:',
      `    dshHome: ${host.config.dshHome}`,
      `    agentsHome: ${join(host.config.dshHome, 'agents')}`,
      '    includeDefaultRoots: true',
      `    customSkillDirs: [${host.config.skillsDir}]`,
      '    watch: true',
      '',
    ]

    if (extra.providers !== undefined && Object.keys(extra.providers).length > 0) {
      // JSON is valid YAML, which keeps nested provider profiles unambiguous.
      lines.push('- id: llm-pi-ai', '  config:', `    providers: ${JSON.stringify(extra.providers)}`, '')
    }

    // Insert our rows first so the config patches below can target them.
    lines.push('- insert:')
    lines.push('    - id: sre-agent-bridge', `      name: ${PLUGIN_PACKAGE}`)
    for (const row of extra.mcpRows ?? []) {
      lines.push(`    - ${JSON.stringify(row)}`)
    }
    lines.push('')

    lines.push(
      '- id: sre-agent-bridge',
      '  config:',
      `    platformBase: http://${host.config.host}:${host.config.port}`,
      `    token: ${host.config.internalToken}`,
      '    approvalTimeoutMs: 600000',
      '    relayStreamFrames: true',
      '    enableModelOverride: true',
      '',
    )

    if (host.config.mockLlm) {
      // Key-less demo/test seam: a deterministic adapter replaces the provider.
      lines.push(
        '- insert:',
        '    - id: sre-agent-mock-llm',
        `      name: ${PLUGIN_PACKAGE}/mock-llm`,
        '      config:',
        '        provider: sre-mock',
        '        model: mock-1',
        `        debugResolve: ${process.env.SRE_AGENT_DEBUG ? 'true' : 'false'}`,
        `        toolName: ${host.config.mockLlmTool}`,
        `        toolArguments: ${JSON.stringify(host.config.mockLlmToolArguments)}`,
        `        finalText: ${JSON.stringify(host.config.mockLlmFinalText)}`,
        '',
      )
    }

    const path = join(profile, 'cordis.patch.yml')
    writeFileSync(path, lines.join('\n'), 'utf8')
    return path
  }

  private writeProfilePackage(): void {
    const host = this.requireHost()
    const profile = host.config.dshProfile
    const bridgeDir = this.bridgePluginDir()
    mkdirSync(profile, { recursive: true })

    const manifest = {
      name: 'dsh-profile-sre-agent',
      private: true,
      dependencies: { [PLUGIN_PACKAGE]: `file:${bridgeDir}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } },
    }
    writeFileSync(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    // dsh resolves profile plugins from `<profile>/node_modules` and routes their
    // `@deepseek-ai/*` imports to the harness's own installation. That routing
    // only applies to a plugin that really lives inside the profile, so the
    // plugin is copied — a symlink would resolve from the repository instead and
    // could pick up a second copy of a harness package (verified failure mode:
    // duplicated `dsh-tools` breaks tool dispatch, because its scheduler handle
    // is keyed by a module-local Symbol).
    const target = join(profile, 'node_modules', PLUGIN_PACKAGE)
    rmSync(target, { recursive: true, force: true })
    copyDirectory(bridgeDir, target, new Set(['node_modules', '.git']))
  }

  // -- process + transport -------------------------------------------------

  private resolveDshBinary(): string {
    const candidates = [
      resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules', '.bin', 'dsh'),
      join(process.cwd(), 'node_modules', '.bin', 'dsh'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return 'dsh'
  }

  private async spawnProcess(): Promise<void> {
    const host = this.requireHost()
    const binary = this.resolveDshBinary()
    mkdirSync(host.config.workspace, { recursive: true })
    mkdirSync(host.config.dshHome, { recursive: true })

    const child = spawn(binary, ['--profile', 'sre-agent'], {
      cwd: host.config.workspace,
      env: {
        ...process.env,
        DSH_HOME: host.config.dshHome,
        DSH_TELEMETRY_DISABLED: '1',
        // 'ask' keeps the approval gate live; our bridge answers every request,
        // so this is what routes decisions through the platform.
        DSH_PERMISSION_MODE: 'workspace-write',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    this.child = child
    this.status = 'starting'

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk
      const lines = this.stderrBuffer.split('\n')
      this.stderrBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length > 0) host.log.debug(`dsh: ${line.trim()}`)
      }
    })
    child.on('exit', (code, signal) => {
      this.initialized = false
      this.status = code === 0 ? 'stopped' : 'error'
      this.lastError = `dsh exited (code=${code ?? 'null'} signal=${signal ?? 'none'})`
      for (const [, pending] of this.pending) pending.reject(new Error(this.lastError))
      this.pending.clear()
      host.log.warn(this.lastError)
    })

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('dsh did not start within 30s')), 30_000)
      child.once('spawn', () => {
        clearTimeout(timer)
        resolvePromise()
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      })
    })

    await this.request(
      'initialize',
      {
        cwd: host.config.workspace,
        provider: this.model?.provider ?? 'deepseek-official',
        model: this.model?.model ?? 'deepseek-flash',
      },
      20_000,
    )
    this.initialized = true
    this.status = 'ready'
  }

  private request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const child = this.child
    if (child === undefined) return Promise.reject(new Error('dsh is not running'))
    const id = this.nextRequestId++
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new Error(`dsh ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolvePromise(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          rejectPromise(error)
        },
      })
      child.stdin.write(payload)
    })
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let index = this.stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line.length > 0) this.handleFrame(line)
      index = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleFrame(line: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      // stdout belongs to the protocol; anything else is noise we drop.
      return
    }
    if (typeof frame.id === 'number' && typeof frame.method !== 'string') {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      this.pending.delete(frame.id)
      const error = frame.error as { message?: string } | undefined
      if (error !== undefined) pending.reject(new Error(error.message ?? 'dsh request failed'))
      else pending.resolve(frame.result)
      return
    }
    if (typeof frame.method !== 'string') return
    if (frame.method === 'session.event') this.handleSessionEvent(frame.params as Record<string, unknown>)
    else if (frame.method === 'session.status') this.handleSessionStatus(frame.params as Record<string, unknown>)
    else if (frame.method === 'subagent.started' || frame.method === 'subagent.finished') {
      const params = frame.params as { parentSessionId?: string; status?: string }
      if (params.parentSessionId !== undefined) {
        this.host?.emit(params.parentSessionId, {
          type: 'notice',
          level: 'info',
          text: `subagent ${frame.method === 'subagent.started' ? 'started' : `finished (${params.status ?? 'done'})`}`,
        })
      }
    }
  }

  /** Translate a durable dsh `SessionEvent` into the platform's event model. */
  private handleSessionEvent(params: Record<string, unknown>): void {
    const host = this.host
    if (host === undefined) return
    const sessionId = String(params.sessionId ?? '')
    if (sessionId.length === 0) return
    if (!this.runtimes.has(sessionId) && host.store.getSession(sessionId) === undefined) return

    const event = params.event as { type?: string; data?: Record<string, unknown> } | undefined
    if (event?.type === undefined) return
    const data = event.data ?? {}
    const emit = (payload: KernelEvent) => host.emit(sessionId, payload)

    switch (event.type) {
      case 'turn/start':
        emit({ type: 'agent_status', status: 'running' })
        emit({ type: 'turn_start', turn: numberOrUndefined(data.turn) })
        break
      case 'turn/end': {
        const reason = data.reason as { kind?: string } | undefined
        emit({ type: 'turn_end', turn: numberOrUndefined(data.turn), reason: reason?.kind })
        emit({ type: 'agent_status', status: 'idle' })
        break
      }
      case 'assistant/message': {
        const message = data.message as { content?: unknown } | undefined
        const text = extractText(message?.content)
        if (text.length > 0) {
          emit({ type: 'assistant_message', text })
          host.store.appendMessage({ sessionId, role: 'assistant', text, createdAt: Date.now() })
        }
        const usage = data.usage as { input?: number; output?: number } | undefined
        if (usage !== undefined) {
          emit({
            type: 'usage',
            inputTokens: numberOrUndefined(usage.input),
            outputTokens: numberOrUndefined(usage.output),
          })
        }
        break
      }
      case 'tool/call': {
        const callId = String(data.callId ?? '')
        const name = String(data.name ?? '')
        if (callId.length === 0 || name.length === 0) break
        this.callNames.set(callId, name)
        emit({ type: 'tool_call', callId, name, args: parseArguments(data.arguments) })
        break
      }
      case 'tool/result': {
        const message = data.message as { content?: unknown; isError?: boolean; toolCallId?: string } | undefined
        const callId = String(message?.toolCallId ?? data.callId ?? '')
        if (callId.length === 0) break
        const name = String(data.name ?? this.callNames.get(callId) ?? 'tool')
        const text = extractText(message?.content)
        const failed = message?.isError === true || data.error !== undefined
        emit({ type: 'tool_result', callId, name, ok: !failed, content: clampText(text), detail: data.error })
        host.store.appendMessage({
          sessionId,
          role: 'tool',
          text: clampText(text),
          toolName: name,
          callId,
          ok: !failed,
          createdAt: Date.now(),
        })
        break
      }
      case 'session/title': {
        const title = String(data.title ?? '')
        if (title.length === 0) break
        host.store.updateSession(sessionId, { title })
        const session = host.store.getSession(sessionId)
        if (session !== undefined) host.onSessionUpdated(session, 'created')
        break
      }
      case 'approval/asked':
        emit({ type: 'notice', level: 'info', text: `approval requested for ${String(data.toolName ?? 'tool')}` })
        break
      case 'approval/decided':
        emit({ type: 'notice', level: 'info', text: `approval ${String(data.outcome ?? 'decided')}` })
        break
      default:
        break
    }
  }

  private handleSessionStatus(params: Record<string, unknown>): void {
    const sessionId = String(params.sessionId ?? '')
    if (sessionId.length === 0) return
    const status = String(params.status ?? '')
    if (this.runtimes.has(sessionId) || this.host?.store.getSession(sessionId) !== undefined) {
      this.host?.emit(sessionId, { type: 'agent_status', status: status === 'running' ? 'running' : 'idle' })
    }
  }

  async listKernelSessions(): Promise<{ id: string; title?: string; updatedAt?: number }[]> {
    const host = this.requireHost()
    const root = join(host.config.dshHome, 'sessions')
    if (!existsSync(root)) return []
    const out: { id: string; title?: string; updatedAt?: number }[] = []
    for (const projectDir of readdirSync(root)) {
      const projectPath = join(root, projectDir)
      if (!statSync(projectPath).isDirectory()) continue
      for (const sessionDir of readdirSync(projectPath)) {
        const sessionPath = join(projectPath, sessionDir)
        if (!existsSync(join(sessionPath, 'session.v4.jsonl'))) continue
        out.push({ id: sessionDir, updatedAt: statSync(sessionPath).mtimeMs })
      }
    }
    return out
  }

  private requireHost(): KernelHost {
    if (this.host === undefined) throw new Error('dsh adapter is not started')
    return this.host
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: raw }
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

function copyDirectory(from: string, to: string, skip: Set<string>): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    if (skip.has(entry)) continue
    const source = join(from, entry)
    const target = join(to, entry)
    if (statSync(source).isDirectory()) copyDirectory(source, target, skip)
    else copyFileSync(source, target)
  }
}
