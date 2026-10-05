import { execFile } from 'node:child_process'
import type { ToolAnnotations, PlatformToolSpec, ToolCallResult, ToolOrigin, JsonSchema } from '@sre/protocol'
import type { AppConfig } from './config.ts'
import type { BrowserDriver } from './browser.ts'
import type { ComputerDriver } from './computer.ts'
import type { SandboxProvider } from './sandbox/types.ts'
import type { MemoryService } from './memory.ts'
import type { WorkflowEngine } from './workflows.ts'
import type { AgentService } from './agents.ts'
import type { KnowledgeBase } from './knowledge.ts'
import { Logger } from './log.ts'
import type { Store } from './store.ts'

const MAX_OUTPUT = 32 * 1024

export interface ToolExecutionContext {
  sessionId: string
  origin: ToolOrigin
  callId?: string
}

export interface PlatformTool {
  spec: PlatformToolSpec
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolCallResult>
}

export interface DelegateInput {
  sessionId: string
  objective: string
  context?: string
  allowedTools?: string[]
}

export interface AskUserInput {
  sessionId: string
  question: string
  choices?: string[]
  context?: string
  allowCustom?: boolean
}

export interface ToolRegistryDeps {
  config: AppConfig
  log: Logger
  kb: KnowledgeBase
  store: Store
  /** Injected by the app once the runbook runner exists (avoids a cycle). */
  runChecks?: (runbookId: string, ctx: ToolExecutionContext) => Promise<ToolCallResult>
  /** Spawn a child session for a subtask; wired by the app (avoids a cycle). */
  delegate?: (input: DelegateInput, ctx: ToolExecutionContext) => Promise<ToolCallResult>
  /** Ask the operator a structured question and block until answered. */
  askUser?: (input: AskUserInput, ctx: ToolExecutionContext) => Promise<ToolCallResult>
  /** Browser automation (playwright-core + local Chrome). Optional at runtime. */
  browser?: BrowserDriver
  /** Desktop control of the host machine. Optional at runtime. */
  computer?: ComputerDriver
  /** Execution layer for agent commands (host or a remote sandbox). */
  sandbox?: SandboxProvider
  /** Platform memory (tools + automatic recall). */
  memory?: MemoryService
  /** Deterministic workflow engine. */
  workflows?: WorkflowEngine
  /** Defined agents, for status queries. */
  agents?: AgentService
}

const UNATTENDED_ORIGINS: ToolOrigin[] = ['schedule', 'alert']

/**
 * The platform's tool set. Both kernels expose exactly these tools, so switching
 * kernels never changes what the agent can do — only who executes it.
 */
export function createPlatformTools(deps: ToolRegistryDeps): ToolRegistry {
  const { config, log, kb, store } = deps

  const kbSearch: PlatformTool = {
    spec: {
      name: 'kb_search',
      description:
        'Search the SRE knowledge base (runbooks, postmortems, service docs, alert playbooks). ' +
        'Use this before guessing: it returns the passages most relevant to the query, with their source.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      origins: ['chat', 'schedule', 'alert', 'api'],
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language or keyword query, e.g. "nginx upstream timeout".' },
          topK: { type: 'integer', description: 'How many passages to return (1-20).', default: 5 },
          tags: { type: 'array', items: { type: 'string' }, description: 'Restrict to documents carrying these tags.' },
        },
        required: ['query'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args) {
      const query = String(args.query ?? '')
      const topK = typeof args.topK === 'number' ? args.topK : 5
      const tags = Array.isArray(args.tags) ? args.tags.map((tag) => String(tag)) : undefined
      const hits = await kb.search(query, { topK, ...(tags === undefined ? {} : { tags }) })
      const text =
        hits.length === 0
          ? `No knowledge base match for "${query}".`
          : hits
              .map(
                (hit, index) =>
                  `[${index + 1}] ${hit.title} (source: ${hit.source}, score ${hit.score.toFixed(3)}, via ${hit.via})\n${hit.text}`,
              )
              .join('\n\n---\n\n')
      return { ok: true, content: text, detail: { hits: hits.length, query } }
    },
  }

  const httpProbe: PlatformTool = {
    spec: {
      name: 'sre_http_probe',
      description:
        'Probe an HTTP endpoint and report status, latency and a short body snippet. ' +
        'Read-only: use it to check health endpoints, dashboards or APIs during an investigation.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL.' },
          method: { type: 'string', enum: ['GET', 'POST', 'HEAD'], default: 'GET' },
          timeoutSec: { type: 'number', description: 'Request timeout in seconds (default 10).' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra request headers.' },
        },
        required: ['url'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args) {
      const url = String(args.url ?? '')
      if (!/^https?:\/\//i.test(url)) return { ok: false, content: `Invalid URL: ${url}`, error: 'invalid-url' }
      const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET'
      const timeoutMs = Math.max(1, Number(args.timeoutSec ?? 10)) * 1000
      const headers = (args.headers ?? {}) as Record<string, string>
      const started = Date.now()
      try {
        const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) })
        const body = method === 'HEAD' ? '' : truncate(await safeText(response), 4000)
        const durationMs = Date.now() - started
        return {
          ok: response.ok,
          content: `${method} ${url} -> HTTP ${response.status} in ${durationMs}ms\n${body}`,
          detail: { status: response.status, durationMs, url },
          durationMs,
        }
      } catch (error) {
        const durationMs = Date.now() - started
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          content: `${method} ${url} failed after ${durationMs}ms: ${message}`,
          error: message,
          durationMs,
        }
      }
    },
  }

  const shell: PlatformTool = {
    spec: {
      name: 'sre_shell',
      description:
        'Run a shell command in the workspace and return stdout/stderr/exit code. ' +
        'Commands are audited and require operator approval. Prefer read-only diagnostics ' +
        '(kubectl get/describe, journalctl, ss, df, curl) before any change.',
      annotations: { destructiveHint: true, openWorldHint: true },
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command line, executed with `sh -lc`.' },
          cwd: { type: 'string', description: 'Working directory (defaults to the session workspace).' },
          timeoutSec: { type: 'number', description: 'Kill the command after this many seconds (default 60).' },
        },
        required: ['command'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args, ctx) {
      const command = String(args.command ?? '').trim()
      if (command.length === 0) return { ok: false, content: 'Empty command.', error: 'empty-command' }
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : config.workspace
      const timeoutMs = Math.max(1, Math.min(Number(args.timeoutSec ?? 60), 900)) * 1000
      const started = Date.now()

      const remote = deps.sandbox !== undefined && deps.sandbox.id !== 'local'
      let result: { code: number | null; stdout: string; stderr: string; killed: boolean; sandboxId?: string }
      if (remote) {
        // Agent Use Sandbox: untrusted commands execute in the session's
        // isolated VM. The approval gate above is unchanged — this only moves
        // WHERE the command runs, not WHETHER it may run.
        const handle = await deps.sandbox!.get(ctx.sessionId)
        const exec = await handle.exec(command, { cwd, timeoutMs })
        result = {
          code: exec.exitCode,
          stdout: exec.stdout,
          stderr: exec.stderr,
          killed: false,
          sandboxId: handle.sandboxId,
        }
      } else {
        const local = await new Promise<{ code: number | null; stdout: string; stderr: string; killed: boolean }>(
          (resolve) => {
            const child = execFile(
              'sh',
              ['-lc', command],
              { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' },
              (error, stdout, stderr) => {
                const exitCode =
                  error === null
                    ? 0
                    : typeof (error as { code?: unknown }).code === 'number'
                      ? ((error as { code?: number }).code ?? 1)
                      : 1
                resolve({
                  code: exitCode,
                  stdout: String(stdout),
                  stderr: String(stderr),
                  killed: (error as { killed?: boolean } | null)?.killed === true,
                })
              },
            )
            child.on('error', () => resolve({ code: 1, stdout: '', stderr: 'spawn failed', killed: false }))
          },
        )
        result = local
      }

      const durationMs = Date.now() - started
      const payload = {
        command,
        exitCode: result.code,
        stdout: truncate(result.stdout, MAX_OUTPUT),
        stderr: truncate(result.stderr, MAX_OUTPUT),
        durationMs,
        timedOut: result.killed,
        sandbox: result.sandboxId === undefined ? 'host' : `${deps.sandbox!.id}:${result.sandboxId}`,
      }
      store.audit({
        actor: ctx.sessionId,
        action: 'tool.shell',
        subject: command.slice(0, 200),
        detail: { exitCode: result.code, durationMs, cwd, sandbox: payload.sandbox },
      })
      const where = result.sandboxId === undefined ? 'host' : `sandbox ${result.sandboxId}`
      return {
        ok: result.code === 0,
        content: `${result.stdout}${result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : ''}\n[exit ${result.code} in ${durationMs}ms on ${where}]`,
        detail: payload,
        durationMs,
      }
    },
  }

  const runbookRun: PlatformTool = {
    spec: {
      name: 'sre_runbook_run',
      description:
        'Execute the deterministic checks of a runbook (http/shell/tcp) and return their findings. ' +
        'Use it to gather evidence during an investigation instead of re-implementing checks by hand.',
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
      parameters: {
        type: 'object',
        properties: {
          runbookId: { type: 'string', description: 'Runbook id, as listed by the platform.' },
        },
        required: ['runbookId'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args, ctx) {
      const runbookId = String(args.runbookId ?? '')
      const runbook = store.getRunbook(runbookId)
      if (runbook === undefined) {
        return { ok: false, content: `Unknown runbook: ${runbookId}`, error: 'unknown-runbook' }
      }
      if (deps.runChecks === undefined) {
        return { ok: false, content: 'Check runner is not available.', error: 'no-runner' }
      }
      return deps.runChecks(runbookId, ctx)
    },
  }

  const incidentNote: PlatformTool = {
    spec: {
      name: 'sre_incident_note',
      description:
        'Record a finding, hypothesis or action in the incident timeline. Use it for anything an on-call ' +
        'human should see in the postmortem: what you observed, what you ruled out, what you changed.',
      annotations: { readOnlyHint: false, idempotentHint: false },
      origins: ['chat', 'schedule', 'alert', 'api'],
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Markdown note.' },
          kind: { type: 'string', enum: ['observation', 'hypothesis', 'action', 'finding'], default: 'observation' },
        },
        required: ['text'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args, ctx) {
      const text = String(args.text ?? '')
      const kind = String(args.kind ?? 'observation')
      log.info(`incident note (${kind}) session=${ctx.sessionId}: ${text.slice(0, 120)}`)
      store.audit({ actor: ctx.sessionId, action: `incident.${kind}`, subject: text.slice(0, 200) })
      return { ok: true, content: `Recorded ${kind}.`, detail: { kind, text } }
    },
  }

  const askUser: PlatformTool = {
    spec: {
      name: 'ask_user',
      description:
        'Ask the operator a structured question and wait for their answer. Use it when the intent is ' +
        'ambiguous and picking the wrong interpretation would waste work or cause harm: which environment ' +
        'to touch, which of several plausible root causes to pursue, whether to proceed with a risky action. ' +
        'Do NOT use it in unattended runs (no human is attached) and not for questions you can resolve ' +
        'yourself with read-only tools.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      origins: ['chat', 'api'],
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, phrased so each choice is a complete answer.' },
          choices: {
            type: 'array',
            items: { type: 'string' },
            description: '2-4 concrete options. Omit for a free-form question.',
          },
          context: { type: 'string', description: 'Optional background the operator needs to decide.' },
        },
        required: ['question'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args, ctx) {
      if (UNATTENDED_ORIGINS.includes(ctx.origin)) {
        return {
          ok: false,
          content: 'ask_user is unavailable in unattended runs: no operator is attached. Decide with the evidence you have and record the reasoning with sre_incident_note.',
          error: 'no-operator',
        }
      }
      if (deps.askUser === undefined) {
        return { ok: false, content: 'ask_user is not available.', error: 'no-asker' }
      }
      const question = String(args.question ?? '').trim()
      if (question.length === 0) return { ok: false, content: 'Empty question.', error: 'empty-question' }
      const choices = Array.isArray(args.choices) ? args.choices.map((choice) => String(choice)).slice(0, 6) : undefined
      return deps.askUser(
        {
          sessionId: ctx.sessionId,
          question,
          ...(choices === undefined ? {} : { choices }),
          ...(args.context === undefined ? {} : { context: String(args.context) }),
        },
        ctx,
      )
    },
  }

  const delegate: PlatformTool = {
    spec: {
      name: 'sre_delegate',
      description:
        'Spawn a child agent session for one focused subtask (e.g. "collect evidence for the 5xx spike on ' +
        'checkout-svc") and wait for its conclusion. Use it to decompose independent strands of an incident ' +
        'so each runs with its own context instead of polluting this conversation. The child runs with a ' +
        'restricted toolset; approvals still route to the operator. One level of nesting only.',
      annotations: { readOnlyHint: false, idempotentHint: false },
      origins: ['chat', 'api'],
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'Single, self-contained objective for the child agent.' },
          context: { type: 'string', description: 'Evidence and constraints the child should start from.' },
          allowedTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tool names the child may use. Defaults to the read-only diagnostics set.',
          },
        },
        required: ['objective'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args, ctx) {
      if (UNATTENDED_ORIGINS.includes(ctx.origin)) {
        return {
          ok: false,
          content: 'sre_delegate is unavailable in unattended runs: child sessions would multiply the blast radius without an operator watching.',
          error: 'no-operator',
        }
      }
      if (deps.delegate === undefined) {
        return { ok: false, content: 'sre_delegate is not available.', error: 'no-delegator' }
      }
      const objective = String(args.objective ?? '').trim()
      if (objective.length === 0) return { ok: false, content: 'Empty objective.', error: 'empty-objective' }
      const allowedTools = Array.isArray(args.allowedTools)
        ? args.allowedTools.map((tool) => String(tool)).slice(0, 12)
        : undefined
      return deps.delegate(
        {
          sessionId: ctx.sessionId,
          objective,
          ...(args.context === undefined ? {} : { context: String(args.context) }),
          ...(allowedTools === undefined ? {} : { allowedTools }),
        },
        ctx,
      )
    },
  }

  const memoryTools = deps.memory === undefined ? [] : buildMemoryTools(deps.memory, log)
  const orchestrationTools = [
    ...(deps.workflows === undefined ? [] : [buildWorkflowRunTool(deps.workflows)]),
    ...(deps.agents === undefined ? [] : [buildAgentStatusTool(deps.agents)]),
  ]
  const browserTools = deps.browser === undefined ? [] : buildBrowserTools(deps.browser, log)
  const computerTools = deps.computer === undefined ? [] : buildComputerTools(deps.computer, log)
  return new ToolRegistry([
    kbSearch,
    httpProbe,
    shell,
    runbookRun,
    incidentNote,
    askUser,
    delegate,
    ...memoryTools,
    ...orchestrationTools,
    ...browserTools,
    ...computerTools,
  ])
}

/**
 * Browser-use tools. Every tool is session-scoped: each platform session gets
 * its own page (tab), so concurrent investigations do not fight over state.
 */
function buildBrowserTools(browser: BrowserDriver, log: Logger): PlatformTool[] {
  const failIfUnready = async (): Promise<ToolCallResult | undefined> => {
    const state = await browser.provisioned()
    if (!state.ok) return { ok: false, content: state.detail, error: 'not-provisioned' }
    return undefined
  }
  const pageSummary = (info: { url: string; title: string; textExcerpt: string; links: string[] }): string =>
    [
      `URL: ${info.url}`,
      `标题: ${info.title}`,
      '',
      '页面文本（节选）:',
      info.textExcerpt,
      '',
      ...(info.links.length === 0 ? [] : ['链接:', ...info.links.map((link) => `- ${link}`)]),
    ].join('\n')

  const navigate: PlatformTool = {
    spec: {
      name: 'browser_navigate',
      description:
        'Open a URL in the session browser (headless Chrome) and return the page title, visible text and links. ' +
        'Each session has its own tab. Prefer kb_search for documentation; use this for live dashboards, status pages or admin UIs.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      origins: ['chat', 'api'],
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute http(s) URL.' } },
        required: ['url'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args, ctx) {
      const unready = await failIfUnready()
      if (unready !== undefined) return unready
      const url = String(args.url ?? '')
      if (!/^https?:\/\//i.test(url)) return { ok: false, content: `Invalid URL: ${url}`, error: 'invalid-url' }
      const info = await browser.navigate(ctx.sessionId, url)
      return { ok: true, content: pageSummary(info), detail: info }
    },
  }

  const snapshot: PlatformTool = {
    spec: {
      name: 'browser_snapshot',
      description: 'Re-read the current page in the session browser: title, visible text excerpt and links.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      origins: ['chat', 'api', 'schedule', 'alert'],
      parameters: { type: 'object', properties: {}, additionalProperties: false } satisfies JsonSchema,
    },
    async execute(_args, ctx) {
      const unready = await failIfUnready()
      if (unready !== undefined) return unready
      return { ok: true, content: pageSummary(await browser.snapshot(ctx.sessionId)) }
    },
  }

  const screenshot: PlatformTool = {
    spec: {
      name: 'browser_screenshot',
      description: 'Take a PNG screenshot of the session browser page; the image is returned to you directly.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      origins: ['chat', 'api', 'schedule', 'alert'],
      parameters: { type: 'object', properties: {}, additionalProperties: false } satisfies JsonSchema,
    },
    async execute(_args, ctx) {
      const unready = await failIfUnready()
      if (unready !== undefined) return unready
      const shot = await browser.screenshot(ctx.sessionId)
      return {
        ok: true,
        content: `Screenshot of ${shot.url} (${Math.round(shot.png.length / 1024)} KB) attached.`,
        images: [{ mimeType: 'image/png', base64: shot.png.toString('base64') }],
        detail: { url: shot.url },
      }
    },
  }

  const click: PlatformTool = {
    spec: {
      name: 'browser_click',
      description: 'Click an element in the session browser page, addressed by a CSS selector. Take a snapshot first to find selectors.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      origins: ['chat', 'api'],
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS selector, e.g. "button.submit" or "a:has-text(\"Grafana\")" is NOT valid here — use plain CSS.' } },
        required: ['selector'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args, ctx) {
      const unready = await failIfUnready()
      if (unready !== undefined) return unready
      await browser.click(ctx.sessionId, String(args.selector ?? ''))
      const info = await browser.snapshot(ctx.sessionId)
      return { ok: true, content: `Clicked. Page is now:\n\n${pageSummary(info)}` }
    },
  }

  const fill: PlatformTool = {
    spec: {
      name: 'browser_fill',
      description: 'Fill a form field in the session browser, addressed by a CSS selector, replacing its content.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      origins: ['chat', 'api'],
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the input element.' },
          text: { type: 'string', description: 'Text to enter.' },
        },
        required: ['selector', 'text'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args, ctx) {
      const unready = await failIfUnready()
      if (unready !== undefined) return unready
      await browser.fill(ctx.sessionId, String(args.selector ?? ''), String(args.text ?? ''))
      return { ok: true, content: `Filled ${String(args.selector ?? '')}.` }
    },
  }

  const close: PlatformTool = {
    spec: {
      name: 'browser_close',
      description: 'Close the session browser tab. Do this when you are done with a page.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      origins: ['chat', 'api'],
      parameters: { type: 'object', properties: {}, additionalProperties: false } satisfies JsonSchema,
    },
    async execute(_args, ctx) {
      await browser.close(ctx.sessionId)
      return { ok: true, content: 'Browser tab closed.' }
    },
  }

  log.info(`browser use tools registered (${browser.target})`)
  return [navigate, snapshot, screenshot, click, fill, close]
}

/**
 * Computer-use tools: the agent can see and operate the host machine's desktop.
 * Read-only observation (screenshot, frontmost app) is low risk; everything
 * that moves the mouse or types is high risk and therefore gated behind the
 * operator under every preset except full-access.
 */
function buildComputerTools(computer: ComputerDriver, log: Logger): PlatformTool[] {
  const failIfUnready = async (): Promise<ToolCallResult | undefined> => {
    const state = await computer.probe()
    if (!state.ok) return { ok: false, content: state.detail, error: 'not-available' }
    return undefined
  }

  const screenshot: PlatformTool = {
    spec: {
      name: 'computer_screenshot',
      description:
        'Take a PNG screenshot of the host machine screen (the machine running this platform, e.g. the Mac mini) and return it to you directly.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      origins: ['chat', 'api', 'schedule', 'alert'],
      parameters: { type: 'object', properties: {}, additionalProperties: false } satisfies JsonSchema,
    },
    async execute() {
      const unready = await failIfUnready()
      if (unready !== undefined) return unready
      const shot = await computer.screenshot()
      return {
        ok: true,
        content: `Screenshot captured (${Math.round(shot.png.length / 1024)} KB), attached.`,
        images: [{ mimeType: 'image/png', base64: shot.png.toString('base64') }],
      }
    },
  }

  const frontmost: PlatformTool = {
    spec: {
      name: 'computer_frontmost',
      description: 'Report which application is frontmost on the host machine right now.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      origins: ['chat', 'api', 'schedule', 'alert'],
      parameters: { type: 'object', properties: {}, additionalProperties: false } satisfies JsonSchema,
    },
    async execute() {
      const unready = await failIfUnready()
      if (unready !== undefined) return unready
      const app = await computer.frontmostApp()
      return { ok: true, content: `Frontmost app: ${app}` }
    },
  }

  const click: PlatformTool = {
    spec: {
      name: 'computer_click',
      description:
        'Click at absolute screen coordinates on the host machine. Take a screenshot first to aim. ' +
        'This acts on the REAL desktop: confirm the target from the latest screenshot before clicking.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer', description: 'X coordinate in points from the top-left of the main display.' },
          y: { type: 'integer', description: 'Y coordinate.' },
          button: { type: 'string', enum: ['left', 'right'], default: 'left' },
          double: { type: 'boolean', default: false },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args) {
      const unready = await failIfUnready()
      if (unready !== undefined) return unready
      await computer.click(Number(args.x ?? 0), Number(args.y ?? 0), {
        ...(args.button === 'right' ? { button: 'right' as const } : {}),
        ...(args.double === true ? { double: true } : {}),
      })
      return { ok: true, content: `Clicked at (${String(args.x)}, ${String(args.y)}).` }
    },
  }

  const type: PlatformTool = {
    spec: {
      name: 'computer_type',
      description: 'Type text into the focused window on the host machine (keystroke-level, unicode-aware).',
      annotations: { readOnlyHint: false, destructiveHint: true },
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to type.' } },
        required: ['text'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args) {
      const unready = await failIfUnready()
      if (unready !== undefined) return unready
      await computer.type(String(args.text ?? ''))
      return { ok: true, content: 'Typed.' }
    },
  }

  const key: PlatformTool = {
    spec: {
      name: 'computer_key',
      description: 'Press a key on the host machine: enter, tab, escape, space, delete, up/down/left/right, home, end, pageup, pagedown.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Key name, e.g. "enter".' } },
        required: ['key'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args) {
      const unready = await failIfUnready()
      if (unready !== undefined) return unready
      await computer.key(String(args.key ?? ''))
      return { ok: true, content: `Pressed ${String(args.key)}.` }
    },
  }

  log.info(`computer use tools registered (${computer.target})`)
  return [screenshot, frontmost, click, type, key]
}

export class ToolRegistry {
  private readonly tools: Map<string, PlatformTool>

  constructor(tools: PlatformTool[]) {
    this.tools = new Map(tools.map((tool) => [tool.spec.name, tool]))
  }

  list(): PlatformToolSpec[] {
    return [...this.tools.values()].map((tool) => tool.spec)
  }

  get(name: string): PlatformTool | undefined {
    return this.tools.get(name)
  }

  annotationsOf(name: string): ToolAnnotations | undefined {
    return this.tools.get(name)?.spec.annotations
  }

  permittedOriginsOf(name: string): ToolOrigin[] | undefined {
    return this.tools.get(name)?.spec.origins
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolCallResult> {
    const tool = this.tools.get(name)
    if (tool === undefined) {
      return { ok: false, content: `Unknown platform tool: ${name}`, error: 'unknown-tool' }
    }
    try {
      return await tool.execute(args ?? {}, ctx)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, content: `Tool ${name} failed: ${message}`, error: message }
    }
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/**
 * Memory tools. `memory_search` is available even in unattended runs (facts are
 * how a scheduled agent learns what previous runs discovered); writing is too,
 * because a run that learns nothing is a wasted run.
 */
function buildMemoryTools(memory: MemoryService, log: Logger): PlatformTool[] {
  const search: PlatformTool = {
    spec: {
      name: 'memory_search',
      description:
        'Search platform memory (facts, past incidents, operator preferences) for what is already known about a '
        + 'service, symptom or alert. Use it before re-deriving something the platform may have learned already.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      origins: ['chat', 'schedule', 'alert', 'api'],
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language or keyword query.' },
          kind: { type: 'string', enum: ['fact', 'episode', 'preference'], description: 'Restrict to one memory kind.' },
          topK: { type: 'integer', description: 'How many entries to return (1-20).', default: 5 },
        },
        required: ['query'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args) {
      const hits = memory.search(String(args.query ?? ''), {
        ...(args.kind === undefined ? {} : { kind: String(args.kind) as 'fact' | 'episode' | 'preference' }),
        ...(typeof args.topK === 'number' ? { topK: args.topK } : {}),
      })
      if (hits.length === 0) return { ok: true, content: '记忆库中没有相关内容。' }
      const text = hits
        .map((hit) => `- [${hit.kind}] ${hit.subject}（重要度 ${hit.importance}/5，命中 ${hit.score.toFixed(2)}）: ${hit.text}`)
        .join('\n')
      return { ok: true, content: `命中 ${hits.length} 条记忆：\n${text}`, detail: { hits: hits.length } }
    },
  }

  const save: PlatformTool = {
    spec: {
      name: 'memory_save',
      description:
        'Record something worth remembering across sessions: a durable fact about a service, the outcome of an '
        + 'incident (episode), or an operator preference. Do NOT store transient values (current metrics, one-off '
        + 'command output) — those belong in the conversation.',
      annotations: { readOnlyHint: false, idempotentHint: false },
      origins: ['chat', 'schedule', 'alert', 'api'],
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fact', 'episode', 'preference'], description: 'What kind of memory this is.' },
          subject: { type: 'string', description: 'What it is about: service name, "global", incident id...' },
          text: { type: 'string', description: 'The memory itself, one or two sentences, self-contained.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags for retrieval.' },
          importance: { type: 'integer', description: '1-5; higher survives pruning longer.', default: 3 },
        },
        required: ['kind', 'subject', 'text'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args, ctx) {
      const item = memory.save({
        kind: String(args.kind ?? 'fact') as 'fact' | 'episode' | 'preference',
        subject: String(args.subject ?? 'global'),
        text: String(args.text ?? ''),
        ...(Array.isArray(args.tags) ? { tags: args.tags.map((tag) => String(tag)) } : {}),
        ...(typeof args.importance === 'number' ? { importance: args.importance } : {}),
        source: 'agent',
        sourceSessionId: ctx.sessionId,
      })
      log.info(`memory saved by ${ctx.sessionId}: [${item.kind}] ${item.subject}`)
      return { ok: true, content: `已记住：[${item.kind}] ${item.subject}`, detail: { id: item.id } }
    },
  }

  return [search, save]
}

/** Let an agent run a fixed procedure instead of re-deriving it turn by turn. */
function buildWorkflowRunTool(workflows: WorkflowEngine): PlatformTool {
  return {
    spec: {
      name: 'workflow_run',
      description:
        'Execute a platform workflow: a fixed, deterministic procedure (checks, commands, approvals, notifications) '
        + 'that runs with no model calls. Use it when the situation matches a known procedure instead of improvising. '
        + 'Approval steps inside the workflow block on the operator.',
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
      origins: ['chat', 'api'],
      parameters: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: 'Workflow id, as listed by the platform.' },
        },
        required: ['workflowId'],
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args, ctx) {
      const workflowId = String(args.workflowId ?? '')
      const run = await workflows.run(workflowId, { trigger: 'agent', sessionId: ctx.sessionId })
      const failed = run.steps.filter(
        (step) => step.status === 'fail' || step.status === 'error' || step.status === 'denied' || step.status === 'notify-failed',
      )
      // Step output is the evidence a workflow produced; without it the agent
      // would have to re-run the checks to reason about what happened.
      const text = run.steps
        .map((step) => {
          const head = `- [${step.status}] ${step.type} ${step.title}: ${step.detail}`
          if (step.output === undefined || step.output.trim().length === 0) return head
          const indented = step.output.trim().split('\n').map((line) => `  ${line}`).join('\n')
          return `${head}\n  \`\`\`\n${indented}\n  \`\`\``
        })
        .join('\n')
      return {
        ok: run.status === 'ok',
        content: `工作流 ${workflowId} 执行完成：${run.status}\n${text}`,
        detail: { runId: run.id, status: run.status, failed: failed.length },
      }
    },
  }
}

/** Supervisors (and curious operators' agents) read recent agent activity. */
function buildAgentStatusTool(agents: AgentService): PlatformTool {
  return {
    spec: {
      name: 'agent_status',
      description:
        'Report recent runs of the platform\'s defined agents (monitors, triage, self-heal): status, trigger, '
        + 'summary and errors. Use it to decide whether a fleet-level intervention is needed.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      origins: ['chat', 'api'],
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Restrict to one agent; omit for all agents.' },
          limit: { type: 'integer', description: 'How many runs to summarise (1-20).', default: 5 },
        },
        additionalProperties: false,
      } satisfies JsonSchema,
    },
    async execute(args) {
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(20, args.limit)) : 5
      const agentId = args.agentId === undefined ? undefined : String(args.agentId)
      const runs = agents.listRuns(limit, agentId)
      const defined = agents
        .list()
        .map(
          (agent) => `${agent.id}/${agent.name}(${agent.kind}${agent.cron === undefined ? '' : `, ${agent.cron}`})`,
        )
      const text = [
        `已定义智能体：${defined.length === 0 ? '（无）' : defined.join(', ')}`,
        '',
        runs.length === 0
          ? '近期没有运行记录。'
          : runs
              .map(
                (run) =>
                  `- ${run.agentName ?? run.agentId} @ ${new Date(run.startedAt).toISOString()} (${run.trigger}): ${run.status} — ${run.summary ?? run.error ?? '（无摘要）'}`,
              )
              .join('\n'),
      ].join('\n')
      return { ok: true, content: text, detail: { runs: runs.length } }
    },
  }
}
