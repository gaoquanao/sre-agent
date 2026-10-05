import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { CheckFinding, RunbookCheck, RunbookSpec, RunRecord, ToolCallResult } from '@sre/protocol'
import type { AppConfig } from './config.ts'
import type { Logger } from './log.ts'
import type { SessionService } from './sessions.ts'
import type { Store } from './store.ts'

const MAX_CAPTURED = 4000

export interface CheckRunnerContext {
  workspace: string
  log: Logger
}

/** Execute one deterministic check. Never throws: a failure is a finding. */
export async function executeCheck(check: RunbookCheck, ctx: CheckRunnerContext): Promise<CheckFinding> {
  const started = Date.now()
  const timeoutMs = Math.max(1, check.timeoutSec ?? 15) * 1000
  const base = { checkId: check.id, title: check.title, kind: check.kind, target: check.target }
  try {
    switch (check.kind) {
      case 'http':
        return { ...base, ...(await runHttpCheck(check, timeoutMs)), durationMs: Date.now() - started }
      case 'shell':
        return { ...base, ...(await runShellCheck(check, ctx, timeoutMs)), durationMs: Date.now() - started }
      case 'tcp':
        return { ...base, ...(await runTcpCheck(check, timeoutMs)), durationMs: Date.now() - started }
      default:
        return { ...base, status: 'skipped', detail: `unsupported check kind: ${String(check.kind)}` }
    }
  } catch (error) {
    return {
      ...base,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
      critical: check.critical,
    }
  }
}

async function runHttpCheck(
  check: RunbookCheck,
  timeoutMs: number,
): Promise<{ status: CheckFinding['status']; detail: string; output?: string; critical?: boolean }> {
  const method = check.method ?? 'GET'
  const response = await fetch(check.target, { method, signal: AbortSignal.timeout(timeoutMs) })
  const body = method === 'HEAD' ? '' : truncate(await safeText(response))
  const expected = check.expectStatus ?? undefined
  const statusOk = expected === undefined ? response.status < 400 : response.status === expected
  const containsOk = check.expectContains === undefined || body.includes(check.expectContains)
  const notContainsOk = check.expectNotContains === undefined || !body.includes(check.expectNotContains)
  const ok = statusOk && containsOk && notContainsOk
  const reasons: string[] = [`HTTP ${response.status}`]
  if (!statusOk) reasons.push(expected === undefined ? 'expected < 400' : `expected ${expected}`)
  if (!containsOk) reasons.push(`missing expected text "${check.expectContains}"`)
  if (!notContainsOk) reasons.push(`found forbidden text "${check.expectNotContains}"`)
  return { status: ok ? 'ok' : 'fail', detail: reasons.join('; '), output: body, critical: check.critical }
}

async function runShellCheck(
  check: RunbookCheck,
  ctx: CheckRunnerContext,
  timeoutMs: number,
): Promise<{ status: CheckFinding['status']; detail: string; output?: string; critical?: boolean }> {
  const cwd = check.cwd ?? ctx.workspace
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolvePromise) => {
      const child = execFile(
        'sh',
        ['-lc', check.target],
        { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          const code =
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === 'number'
                ? ((error as { code?: number }).code ?? 1)
                : 1
          resolvePromise({
            code,
            stdout: String(stdout),
            stderr: String(stderr),
            timedOut: (error as { killed?: boolean } | null)?.killed === true,
          })
        },
      )
      child.on('error', () => resolvePromise({ code: 1, stdout: '', stderr: 'spawn failed', timedOut: false }))
    },
  )

  const combined = truncate(`${result.stdout}${result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : ''}`)
  const containsOk = check.expectContains === undefined || combined.includes(check.expectContains)
  const notContainsOk = check.expectNotContains === undefined || !combined.includes(check.expectNotContains)
  const ok = result.code === 0 && !result.timedOut && containsOk && notContainsOk
  const reasons = [`exit ${result.code}`]
  if (result.timedOut) reasons.push(`timed out after ${timeoutMs}ms`)
  if (!containsOk) reasons.push(`missing expected text "${check.expectContains}"`)
  if (!notContainsOk) reasons.push(`found forbidden text "${check.expectNotContains}"`)
  return { status: ok ? 'ok' : 'fail', detail: reasons.join('; '), output: combined, critical: check.critical }
}

async function runTcpCheck(
  check: RunbookCheck,
  timeoutMs: number,
): Promise<{ status: CheckFinding['status']; detail: string; critical?: boolean }> {
  const [host, portRaw] = check.target.split(':')
  const port = Number.parseInt(portRaw ?? '', 10)
  if (host === undefined || !Number.isInteger(port)) {
    return { status: 'error', detail: `tcp target must be host:port, got "${check.target}"` }
  }
  const started = Date.now()
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port })
    const finish = (status: CheckFinding['status'], detail: string) => {
      socket.destroy()
      resolvePromise({ status, detail, ...(check.critical === undefined ? {} : { critical: check.critical }) })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish('ok', `connected in ${Date.now() - started}ms`))
    socket.once('timeout', () => finish('fail', `connect timed out after ${timeoutMs}ms`))
    socket.once('error', (error: Error) => finish('fail', error.message))
  })
}

export interface RunbookRunnerDeps {
  store: Store
  config: AppConfig
  log: Logger
  sessions: SessionService
  /** Resolves when the kernel reports the session idle again. */
  waitForIdle(sessionId: string, timeoutMs: number): Promise<boolean>
  onRunUpdated(run: RunRecord): void
}

/**
 * Runbooks are the platform's inspection primitive: deterministic checks first
 * (so a run is useful even when the model is unavailable), then an agent session
 * that interprets the findings under a scoped tool allowlist.
 */
export class RunbookRunner {
  private readonly deps: RunbookRunnerDeps

  constructor(deps: RunbookRunnerDeps) {
    this.deps = deps
  }

  /** Used by the `sre_runbook_run` platform tool. */
  async runChecksForTool(runbookId: string): Promise<ToolCallResult> {
    const runbook = this.deps.store.getRunbook(runbookId)
    if (runbook === undefined) {
      return { ok: false, content: `Unknown runbook: ${runbookId}`, error: 'unknown-runbook' }
    }
    const findings = await this.executeChecks(runbook)
    const failed = findings.filter((finding) => finding.status === 'fail' || finding.status === 'error')
    const text = findings
      .map(
        (finding) =>
          `- [${finding.status.toUpperCase()}] ${finding.title} (${finding.kind}: ${finding.target}) — ${finding.detail}\n${finding.output === undefined ? '' : `\`\`\`\n${finding.output}\n\`\`\``}`,
      )
      .join('\n')
    return {
      ok: failed.length === 0,
      content: `${findings.length} checks, ${failed.length} failed\n${text}`,
      detail: { findings },
    }
  }

  async executeChecks(runbook: RunbookSpec): Promise<CheckFinding[]> {
    const ctx: CheckRunnerContext = { workspace: this.deps.config.workspace, log: this.deps.log }
    const findings: CheckFinding[] = []
    for (const check of runbook.checks) {
      const finding = await executeCheck(check, ctx)
      this.deps.log.info(`check ${check.id} (${check.kind}) -> ${finding.status}: ${finding.detail}`)
      findings.push(finding)
    }
    return findings
  }

  async run(
    runbookId: string,
    options: { trigger: 'schedule' | 'manual' | 'alert'; alertId?: string; extraContext?: string } = {
      trigger: 'manual',
    },
  ): Promise<RunRecord> {
    const { store, log, sessions } = this.deps
    const runbook = store.getRunbook(runbookId)
    if (runbook === undefined) throw new Error(`unknown runbook: ${runbookId}`)

    const runId = randomUUID()
    const startedAt = Date.now()
    const origin = options.trigger === 'schedule' ? 'schedule' : options.trigger === 'alert' ? 'alert' : 'chat'
    const session = await sessions.create({
      title: `巡检：${runbook.name}`,
      origin,
      allowedTools: runbook.allowedTools,
      runbookId: runbook.id,
      ...(runbook.model === undefined ? {} : { model: runbook.model }),
      ...(options.alertId === undefined ? {} : { alertId: options.alertId }),
    })
    store.insertRun({ id: runId, runbookId, sessionId: session.id, status: 'running', startedAt })
    const running: RunRecord = {
      id: runId,
      runbookId,
      runbookName: runbook.name,
      sessionId: session.id,
      status: 'running',
      startedAt,
      findings: [],
    }
    this.deps.onRunUpdated(running)

    try {
      const findings = await this.executeChecks(runbook)
      const failedCritical = findings.filter(
        (finding) => finding.critical !== false && (finding.status === 'fail' || finding.status === 'error'),
      )
      const failedSoft = findings.filter(
        (finding) => finding.critical === false && (finding.status === 'fail' || finding.status === 'error'),
      )

      const prompt = buildInspectionPrompt(runbook, findings, options)
      await sessions.prompt(session.id, prompt)
      // dsh acknowledges the enqueue immediately; wait for the turn to settle so
      // the report reflects the finished analysis.
      const settled = await this.deps.waitForIdle(session.id, 10 * 60 * 1000)

      const transcript = store.listMessages(session.id, 400)
      const assistant = [...transcript].reverse().find((message) => message.role === 'assistant')
      const report = [
        `# 巡检报告：${runbook.name}`,
        '',
        `- 触发方式：${options.trigger}`,
        `- 开始时间：${new Date(startedAt).toISOString()}`,
        `- 检查项：${findings.length}（失败 ${failedCritical.length + failedSoft.length}）`,
        '',
        '## 检查结果',
        '',
        '| 状态 | 检查项 | 类型 | 目标 | 详情 |',
        '| --- | --- | --- | --- | --- |',
        ...findings.map(
          (finding) =>
            `| ${finding.status} | ${finding.title} | ${finding.kind} | ${finding.target} | ${finding.detail.replace(/\|/g, '\\|')} |`,
        ),
        '',
        '## 分析',
        '',
        assistant?.text ?? '_模型未产出分析（可能未配置模型或内核不可用）。_',
        ...(settled ? [] : ['', '> 注意：等待模型结束时超时，分析可能不完整。']),
      ].join('\n')

      const status: RunRecord['status'] =
        failedCritical.length > 0 ? 'fail' : failedSoft.length > 0 ? 'warn' : 'ok'
      const finished: RunRecord = {
        id: runId,
        runbookId,
        runbookName: runbook.name,
        sessionId: session.id,
        status,
        startedAt,
        finishedAt: Date.now(),
        report,
        findings,
      }
      store.finishRun(runId, {
        status,
        finishedAt: finished.finishedAt ?? Date.now(),
        report,
        findings,
      })
      this.deps.onRunUpdated(finished)
      void this.notify(runbook, finished)
      return finished
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const finished: RunRecord = {
        id: runId,
        runbookId,
        runbookName: runbook.name,
        sessionId: session.id,
        status: 'error',
        startedAt,
        finishedAt: Date.now(),
        findings: [],
        error: message,
      }
      store.finishRun(runId, {
        status: 'error',
        finishedAt: finished.finishedAt ?? Date.now(),
        error: message,
        findings: [],
      })
      this.deps.onRunUpdated(finished)
      log.error(`runbook ${runbookId} failed`, error)
      return finished
    }
  }

  private async notify(runbook: RunbookSpec, run: RunRecord): Promise<void> {
    for (const url of runbook.notify ?? []) {
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runbook: runbook.id, name: runbook.name, status: run.status, report: run.report }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch (error) {
        this.deps.log.warn(`notify ${url} failed: ${String(error)}`)
      }
    }
  }
}

function buildInspectionPrompt(
  runbook: RunbookSpec,
  findings: CheckFinding[],
  options: { trigger: string; alertId?: string; extraContext?: string },
): string {
  const lines = [
    runbook.prompt.trim(),
    '',
    '## 平台已执行的确定性检查',
    '',
    ...findings.map(
      (finding) =>
        `### ${finding.title} — ${finding.status.toUpperCase()} (${finding.kind}: ${finding.target})\n${finding.detail}\n${
          finding.output === undefined ? '' : `\n\`\`\`\n${finding.output}\n\`\`\`\n`
        }`,
    ),
    '## 要求',
    '',
    '1. 先用 `kb_search` 查知识库（runbook、复盘、告警手册），确认这些现象是否已有既知结论或处置步骤。',
    '2. 对失败项做根因分析；需要更多证据时使用允许的工具（只读优先）。',
    '3. 用 `sre_incident_note` 记录关键观察、结论与建议动作。',
    '4. 最后输出一份给值班人看的中文结论：现状、风险、建议动作、需要人工确认的事项。',
  ]
  if (options.trigger !== 'manual') {
    lines.push('', `> 本次为${options.trigger === 'schedule' ? '定时' : '告警触发'}的无人值守执行：需要人工审批的操作会被直接拒绝，请只做只读诊断。`)
  }
  if (options.extraContext !== undefined && options.extraContext.length > 0) {
    lines.push('', '## 附加上下文', '', options.extraContext)
  }
  return lines.join('\n')
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_CAPTURED) return text
  return `${text.slice(0, MAX_CAPTURED)}\n…[truncated ${text.length - MAX_CAPTURED} chars]`
}
