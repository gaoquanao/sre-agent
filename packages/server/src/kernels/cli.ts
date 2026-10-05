import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  KernelId,
  McpServerSpec,
  ModelSelection,
  PermissionPreset,
  ProviderSpec,
  SessionInfo,
  SkillSpec,
  SyncReport,
} from '@sre/protocol'
import { describeError } from '../log.ts'
import type { AppConfig } from '../config.ts'
import type { CliManager } from '../climan.ts'
import type { CredentialVault } from '../vault.ts'
import { clampText, type KernelAdapter, type KernelHost, type SessionRuntime } from './types.ts'

const TURN_TIMEOUT_MS = 15 * 60 * 1000
const REPLAY_MESSAGES = 8

export interface CliTurnContext {
  workspace: string
  model?: string
  permission: PermissionPreset
  /** Kernel-side session id from earlier turns (resume-capable profiles). */
  resumeId?: string
  /** Prior turns for replay-mode kernels, oldest last. */
  transcript: { role: string; text: string }[]
  /** MCP config file that exposes the platform's tools to this CLI. */
  mcpConfigPath?: string
}

export interface CliTurnPlan {
  args: string[]
  /** Whether the prompt was prefixed with the platform transcript (replay mode). */
  replayed: boolean
}

export interface CliParseState {
  sessionId?: string
  hasAssistantText: boolean
  toolSeq: number
  /** Plain-text accumulator for profiles without a structured protocol (qoder). */
  textBuffer?: string
}

/**
 * A CLI profile teaches the adapter how one external agent CLI is driven
 * non-interactively. Flags reflect the documented headless modes of each CLI;
 * output parsers are defensive by design (unknown lines are ignored, unknown
 * fields tolerated) because these wire formats evolve independently.
 */
export interface CliProfile {
  id: KernelId
  displayName: string
  bin: string
  note?: string
  modelSwitch: 'runtime' | 'none'
  sessionResume: boolean
  /** The CLI accepts an MCP config flag; the adapter then feeds platform tools in. */
  supportsPlatformMcp?: boolean
  capabilities(): KernelCapabilities
  buildTurn(prompt: string, ctx: CliTurnContext): CliTurnPlan
  parseLine(line: string, state: CliParseState, emit: (event: KernelEvent) => void): void
}

function claudePermissionMode(preset: PermissionPreset): string {
  // In print mode Claude Code cannot prompt a human, so `plan` (read-only) and
  // `bypassPermissions` bracket the useful range; `default` auto-denies tools.
  if (preset === 'read-only') return 'plan'
  if (preset === 'full-access') return 'bypassPermissions'
  return 'default'
}

const claudeCodeProfile: CliProfile = {
  id: 'claude-code',
  displayName: 'Claude Code CLI',
  bin: 'claude',
  modelSwitch: 'runtime',
  sessionResume: true,
  supportsPlatformMcp: true,
  capabilities: () => ({
    inProcess: false,
    nativeApproval: false,
    platformApprovalGate: false,
    toolRegistration: false,
    skillSync: 'none',
    mcpSync: 'none',
    modelSwitch: 'runtime',
    tokenStreaming: false,
    sessionResume: true,
  }),
  buildTurn(prompt, ctx) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose']
    if (ctx.resumeId !== undefined) args.push('--resume', ctx.resumeId)
    args.push('--permission-mode', claudePermissionMode(ctx.permission))
    if (ctx.model !== undefined && ctx.model.length > 0) args.push('--model', ctx.model)
    if (ctx.mcpConfigPath !== undefined) {
      // Platform tools (kb_search, browser/computer use, delegate, ask_user...)
      // ride in as an MCP server; --strict-mcp-config avoids the interactive
      // project-server trust prompt in print mode, and the allowlist admits the
      // platform's server without opening every MCP tool.
      args.push('--mcp-config', ctx.mcpConfigPath, '--strict-mcp-config', '--allowedTools', 'mcp__sre-platform')
    }
    return { args, replayed: false }
  },
  parseLine(line, state, emit) {
    const parsed = tryJson(line)
    if (parsed === undefined) return
    const record = parsed as Record<string, unknown>
    const type = String(record.type ?? '')
    if (type === 'system' && record.subtype === 'init') {
      const sessionId = record.session_id
      if (typeof sessionId === 'string') state.sessionId = sessionId
      return
    }
    if (type === 'assistant') {
      const message = record.message as { content?: unknown } | undefined
      emitBlocks(message?.content, state, emit)
      return
    }
    if (type === 'user') {
      const message = record.message as { content?: unknown } | undefined
      emitToolResults(message?.content, emit)
      return
    }
    if (type === 'result') {
      if (record.is_error === true) {
        emit({ type: 'error', message: String(record.result ?? 'claude turn failed') })
        return
      }
      const text = typeof record.result === 'string' ? record.result : ''
      // The result text repeats the last assistant message; only emit it when
      // no assistant block was streamed (keeps the transcript free of dupes).
      if (text.length > 0 && !state.hasAssistantText) {
        state.hasAssistantText = true
        emit({ type: 'assistant_message', text })
      }
    }
  },
}

const codexProfile: CliProfile = {
  id: 'codex',
  displayName: 'Codex CLI',
  bin: 'codex',
  modelSwitch: 'runtime',
  sessionResume: true,
  capabilities: () => ({
    inProcess: false,
    nativeApproval: false,
    platformApprovalGate: false,
    toolRegistration: false,
    skillSync: 'none',
    mcpSync: 'none',
    modelSwitch: 'runtime',
    tokenStreaming: false,
    sessionResume: true,
  }),
  buildTurn(prompt, ctx) {
    if (ctx.resumeId !== undefined) {
      // Verified against codex 0.160.0: `exec resume <id>` takes --json/-m but
      // no --sandbox (the resumed session keeps its own sandbox policy).
      const args = ['exec', 'resume', ctx.resumeId, '--json', '--skip-git-repo-check']
      if (ctx.model !== undefined && ctx.model.length > 0) args.push('-m', ctx.model)
      args.push(prompt)
      return { args, replayed: false }
    }
    const sandbox =
      ctx.permission === 'read-only' ? 'read-only' : ctx.permission === 'full-access' ? 'danger-full-access' : 'workspace-write'
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', sandbox]
    if (ctx.model !== undefined && ctx.model.length > 0) args.push('-m', ctx.model)
    const effective = ctx.transcript.length > 0 ? `${renderTranscript(ctx.transcript)}\n\n## 本轮任务\n\n${prompt}` : prompt
    args.push(effective)
    return { args, replayed: ctx.transcript.length > 0 }
  },
  parseLine(line, state, emit) {
    const parsed = tryJson(line)
    if (parsed === undefined) return
    const record = parsed as Record<string, unknown>
    const type = String(record.type ?? '')
    if (type === 'thread.started') {
      const threadId = record.thread_id
      if (typeof threadId === 'string') state.sessionId = threadId
      return
    }
    if (type === 'item.completed') {
      const item = record.item as Record<string, unknown> | undefined
      if (item === undefined) return
      const itemType = String(item.type ?? '')
      if (itemType === 'agent_message') {
        const text = String(item.text ?? '')
        if (text.length > 0) {
          state.hasAssistantText = true
          emit({ type: 'assistant_message', text })
        }
      } else if (itemType === 'command_execution') {
        state.toolSeq += 1
        const callId = typeof item.id === 'string' ? item.id : `codex-cmd-${state.toolSeq}`
        const command = String(item.command ?? '')
        emit({ type: 'tool_call', callId, name: 'shell', args: { command } })
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined
        emit({
          type: 'tool_result',
          callId,
          name: 'shell',
          ok: exitCode === undefined ? true : exitCode === 0,
          content: clampText(String(item.aggregated_output ?? '')),
          detail: { exitCode },
        })
      }
      return
    }
    if (type === 'error') {
      emit({ type: 'error', message: String(record.message ?? 'codex turn failed') })
    }
  },
}

const qoderProfile: CliProfile = {
  id: 'qoder',
  displayName: 'Qoder CLI (experimental)',
  bin: 'qoder',
  modelSwitch: 'none',
  sessionResume: false,
  capabilities: () => ({
    inProcess: false,
    nativeApproval: false,
    platformApprovalGate: false,
    toolRegistration: false,
    skillSync: 'none',
    mcpSync: 'none',
    modelSwitch: 'none',
    tokenStreaming: false,
    sessionResume: false,
  }),
  buildTurn(prompt, ctx) {
    // Qoder's headless protocol is not publicly documented; drive it with a
    // plain prompt and treat all stdout as the answer until proven otherwise.
    const effective = ctx.transcript.length > 0 ? `${renderTranscript(ctx.transcript)}\n\n## 本轮任务\n\n${prompt}` : prompt
    return { args: [effective], replayed: ctx.transcript.length > 0 }
  },
  parseLine(line, state, emit) {
    const parsed = tryJson(line)
    if (parsed === undefined) {
      // Non-JSON output: accumulate as plain text.
      state.textBuffer = (state.textBuffer === undefined ? '' : `${state.textBuffer}\n`) + line
      return
    }
    const record = parsed as Record<string, unknown>
    // Best-effort pass-through for event-shaped output; adjust as the real
    // protocol is confirmed.
    if (typeof record.text === 'string') {
      state.hasAssistantText = true
      emit({ type: 'assistant_message', text: record.text })
    }
  },
}

/**
 * Adapter for agent CLIs driven one turn at a time (`claude -p`, `codex exec`).
 *
 * Honest capability summary: these kernels run their tools inside their own
 * process, so the platform's per-call approval gate does not apply — the
 * platform can only constrain them via each CLI's own permission flags (mapped
 * from the platform preset) and by revoking credentials. Cancelling a turn
 * works by killing the CLI process, which is stronger than dsh's wire allows.
 */
export class CliKernelAdapter implements KernelAdapter {
  readonly id: KernelId
  readonly displayName: string

  private host: KernelHost | undefined
  private readonly profile: CliProfile
  private readonly cli: CliManager
  private readonly vault: CredentialVault
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly running = new Map<string, ChildProcessWithoutNullStreams>()
  private readonly cliSessionIds = new Map<string, string>()
  private readonly configs = new Map<string, { model?: string }>()
  private version: string | undefined
  private binPath: string | undefined
  private lastError: string | undefined
  private startedAt = 0

  constructor(profile: CliProfile, cli: CliManager, vault: CredentialVault) {
    this.profile = profile
    this.cli = cli
    this.vault = vault
    this.id = profile.id
    this.displayName = profile.displayName
  }

  capabilities(): KernelCapabilities {
    return this.profile.capabilities()
  }

  async start(host: KernelHost): Promise<void> {
    this.host = host
    const probe = await this.resolveBin()
    if (probe === undefined) {
      this.lastError = `未找到 ${this.profile.bin} 命令：可在「内核」页的 CLI 工具中安装，或手动安装后确保在 PATH 中。`
      host.log.warn(`${this.profile.id} kernel: ${this.lastError}`)
      return
    }
    this.binPath = probe
    this.lastError = undefined
    host.log.info(`${this.profile.id} kernel ready (${this.profile.bin} ${this.version ?? ''})`)
    this.startedAt = Date.now()
  }

  async stop(): Promise<void> {
    for (const [sessionId, child] of this.running) {
      try {
        child.kill('SIGTERM')
      } catch (error) {
        this.host?.log.warn(`stopping ${this.profile.id} turn ${sessionId} failed: ${String(error)}`)
      }
      this.running.delete(sessionId)
    }
    this.host = undefined
  }

  async health(): Promise<KernelHealth> {
    if (this.host === undefined) return { status: 'stopped', detail: this.lastError }
    if (this.binPath === undefined) {
      return { status: 'degraded', detail: this.lastError ?? `${this.profile.bin} not found` }
    }
    return {
      status: 'ready',
      since: this.startedAt,
      sessions: this.runtimes.size,
      detail: `${this.profile.bin}${this.version === undefined ? '' : ` ${this.version}`}${this.profile.note === undefined ? '' : ` · ${this.profile.note}`}`,
    }
  }

  async openSession(info: SessionInfo, runtime: SessionRuntime): Promise<void> {
    this.runtimes.set(info.id, runtime)
    if (info.kernelSessionId !== undefined) this.cliSessionIds.set(info.id, info.kernelSessionId)
  }

  async closeSession(sessionId: string): Promise<void> {
    this.runtimes.delete(sessionId)
    const child = this.running.get(sessionId)
    if (child !== undefined) {
      child.kill('SIGTERM')
      this.running.delete(sessionId)
    }
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const host = this.requireHost()
    const workspace = host.store.getSession(sessionId)?.cwd ?? host.config.workspace
    // Read the transcript before appending this turn's user message, so replay
    // mode does not duplicate the current prompt into its own history.
    const priorMessages = host.store
      .listMessages(sessionId, 200)
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-REPLAY_MESSAGES)
      .map((message) => ({ role: message.role, text: message.text }))
    host.store.appendMessage({ sessionId, role: 'user', text, createdAt: Date.now() })
    host.emit(sessionId, { type: 'user_message', text })

    const transcript =
      this.profile.sessionResume && this.cliSessionIds.has(sessionId) ? [] : priorMessages

    const ctx: CliTurnContext = {
      workspace,
      permission: host.permissions.getPreset(),
      transcript,
      ...(this.cliSessionIds.get(sessionId) === undefined ? {} : { resumeId: this.cliSessionIds.get(sessionId) }),
      ...(this.configs.get(sessionId)?.model === undefined ? {} : { model: this.configs.get(sessionId)?.model }),
    }
    if (this.profile.supportsPlatformMcp === true) {
      ctx.mcpConfigPath = this.writeMcpConfig(sessionId, host)
    }
    const plan = this.profile.buildTurn(text, ctx)

    const child = spawn(this.binPath ?? this.profile.bin, plan.args, {
      cwd: workspace,
      env: {
        ...process.env,
        PATH: [this.cli.pathPrefix, process.env.PATH].filter((entry) => entry !== undefined).join(':'),
        ...this.vault.envFor(this.profile.id),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams
    this.running.set(sessionId, child)
    host.emit(sessionId, { type: 'agent_status', status: 'running' })

    const state: CliParseState = { hasAssistantText: false, toolSeq: 0 }
    const emit = (event: KernelEvent): void => {
      host.emit(sessionId, event)
      this.persistEvent(sessionId, event)
    }

    let stdoutBuffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      let index = stdoutBuffer.indexOf('\n')
      while (index >= 0) {
        const line = stdoutBuffer.slice(0, index).trim()
        stdoutBuffer = stdoutBuffer.slice(index + 1)
        if (line.length > 0) this.parseSafe(line, state, emit)
        index = stdoutBuffer.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (process.env.SRE_AGENT_DEBUG !== undefined) host.log.debug(`${this.profile.id}: ${chunk.trim()}`)
    })

    const timer = setTimeout(() => {
      host.log.warn(`${this.profile.id} turn on ${sessionId} exceeded ${TURN_TIMEOUT_MS}ms; killing`)
      child.kill('SIGKILL')
    }, TURN_TIMEOUT_MS)
    timer.unref?.()

    await new Promise<void>((resolvePromise) => {
      child.once('exit', (code) => {
        clearTimeout(timer)
        this.running.delete(sessionId)
        // Profiles that accumulate plain text flush here.
        if (state.textBuffer !== undefined && state.textBuffer.trim().length > 0) {
          emit({ type: 'assistant_message', text: state.textBuffer.trim() })
        }
        if (state.sessionId !== undefined) {
          this.cliSessionIds.set(sessionId, state.sessionId)
          host.store.updateSession(sessionId, { kernelSessionId: state.sessionId })
        }
        if (code !== 0 && code !== null) {
          emit({ type: 'error', message: `${this.profile.bin} exited with code ${code}` })
        }
        emit({ type: 'agent_status', status: 'idle' })
        host.store.updateSession(sessionId, { updatedAt: Date.now() })
        resolvePromise()
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        this.running.delete(sessionId)
        this.lastError = describeError(error)
        emit({ type: 'error', message: this.lastError })
        emit({ type: 'agent_status', status: 'idle' })
        resolvePromise()
      })
    })
  }

  async abort(sessionId: string): Promise<void> {
    const child = this.running.get(sessionId)
    if (child === undefined) return
    child.kill('SIGTERM')
    this.host?.log.info(`${this.profile.id} turn on ${sessionId} aborted (SIGTERM)`)
  }

  async setModel(sessionId: string, selection: ModelSelection): Promise<void> {
    if (this.profile.modelSwitch === 'none') {
      this.host?.emit(sessionId, {
        type: 'notice',
        level: 'warn',
        text: `${this.displayName} 不支持按会话切换模型。`,
      })
      return
    }
    this.configs.set(sessionId, { model: selection.model })
    this.host?.log.info(`${this.profile.id} session ${sessionId} model -> ${selection.model} (next turn)`)
  }

  async syncSkills(_skills: SkillSpec[]): Promise<SyncReport> {
    return {
      target: `${this.profile.id}:skills`,
      ok: true,
      message: 'CLI 内核自行管理技能/配置，平台不做镜像。',
    }
  }

  async syncMcpServers(_servers: McpServerSpec[]): Promise<SyncReport> {
    return {
      target: `${this.profile.id}:mcp`,
      ok: true,
      message: 'CLI 内核自行管理 MCP 配置（各自的配置文件），平台不下发。',
    }
  }

  async syncProviders(_providers: ProviderSpec[]): Promise<SyncReport> {
    return {
      target: `${this.profile.id}:providers`,
      ok: true,
      message: 'CLI 内核使用自身登录态或凭证托管中的密钥（内核页可导入/维护）。',
    }
  }

  /**
   * Per-turn MCP config so the platform's tools reach the CLI with this exact
   * session's context. Regenerated every turn: the session id is baked into the
   * env block the bridge reads.
   */
  private writeMcpConfig(sessionId: string, host: KernelHost): string | undefined {
    try {
      const script = resolveMcpBridgeScript()
      if (script === undefined) {
        host.log.warn(`${this.profile.id}: mcp bridge script not built; platform tools unavailable to this CLI`)
        return undefined
      }
      const dir = join(host.config.home, 'cache', 'mcp')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${sessionId}.json`)
      const config = {
        mcpServers: {
          'sre-platform': {
            command: process.execPath,
            args: script.endsWith('.ts') ? ['--experimental-strip-types', script] : [script],
            env: {
              SRE_AGENT_URL: `http://${host.config.host}:${host.config.port}`,
              SRE_AGENT_HOME: host.config.home,
              SRE_AGENT_INTERNAL_TOKEN: host.config.internalToken,
              SRE_AGENT_SESSION_ID: sessionId,
            },
          },
        },
      }
      writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      return file
    } catch (error) {
      host.log.warn(`${this.profile.id}: failed to write mcp config: ${String(error)}`)
      return undefined
    }
  }

  private parseSafe(line: string, state: CliParseState, emit: (event: KernelEvent) => void): void {
    try {
      this.profile.parseLine(line, state, emit)
    } catch (error) {
      this.host?.log.debug(`${this.profile.id} parse error ignored: ${String(error)}`)
    }
  }

  private persistEvent(sessionId: string, event: KernelEvent): void {
    const host = this.host
    if (host === undefined) return
    if (event.type === 'assistant_message') {
      host.store.appendMessage({ sessionId, role: 'assistant', text: event.text, createdAt: Date.now() })
    } else if (event.type === 'tool_result') {
      host.store.appendMessage({
        sessionId,
        role: 'tool',
        text: event.content,
        toolName: event.name,
        callId: event.callId,
        ok: event.ok,
        createdAt: Date.now(),
      })
    }
  }

  private async resolveBin(): Promise<string | undefined> {
    const { execFile } = await import('node:child_process')
    const pathEnv = process.env.PATH ?? ''
    const dirs = [this.cli.pathPrefix, ...pathEnv.split(':').filter((dir) => dir.length > 0)]
    for (const dir of dirs) {
      const candidate = `${dir}/${this.profile.bin}`
      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          execFile('test', ['-x', candidate], (error) => (error === null ? resolvePromise() : rejectPromise(error)))
        })
        const version = await new Promise<string | undefined>((resolvePromise) => {
          execFile(candidate, ['--version'], { timeout: 5_000 }, (error, stdout) =>
            resolvePromise(error === null ? (String(stdout).trim().split('\n')[0] || undefined) : undefined),
          )
        })
        this.version = version
        return candidate
      } catch {
        continue
      }
    }
    return undefined
  }

  private requireHost(): KernelHost {
    if (this.host === undefined) throw new Error(`${this.profile.id} adapter is not started`)
    return this.host
  }
}

function emitBlocks(content: unknown, state: CliParseState, emit: (event: KernelEvent) => void): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string' && record.text.trim().length > 0) {
      state.hasAssistantText = true
      emit({ type: 'assistant_message', text: record.text })
    } else if (record.type === 'tool_use') {
      emit({
        type: 'tool_call',
        callId: String(record.id ?? `claude-tool-${state.toolSeq++}`),
        name: String(record.name ?? 'tool'),
        args: record.input ?? {},
      })
    }
  }
}

function emitToolResults(content: unknown, emit: (event: KernelEvent) => void): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type !== 'tool_result') continue
    const text =
      typeof record.content === 'string'
        ? record.content
        : Array.isArray(record.content)
          ? record.content
              .map((entry) => (entry !== null && typeof entry === 'object' && 'text' in entry ? String((entry as { text: unknown }).text) : ''))
              .join('\n')
          : ''
    emit({
      type: 'tool_result',
      callId: String(record.tool_use_id ?? ''),
      name: 'tool',
      ok: record.is_error !== true,
      content: clampText(text),
    })
  }
}

/**
 * Location of the compiled MCP bridge; undefined when the server runs from
 * TypeScript sources without a build.
 */
function resolveMcpBridgeScript(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, 'mcp-stdio.js'), join(here, '..', 'src', 'mcp-stdio.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function renderTranscript(transcript: { role: string; text: string }[]): string {
  const lines = transcript.map((message) => `${message.role === 'user' ? '用户' : '助手'}: ${message.text}`)
  return `## 对话历史（供延续上下文，勿重复回答）\n\n${lines.join('\n\n')}`
}

function tryJson(line: string): unknown | undefined {
  if (!line.startsWith('{') && !line.startsWith('[')) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

export { claudeCodeProfile, codexProfile, qoderProfile }
