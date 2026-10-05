import { randomUUID } from 'node:crypto'
import type { RunbookCheck, WorkflowRun, WorkflowSpec, WorkflowStep, WorkflowStepResult, WorkflowWhen } from '@sre/protocol'
import type { AppConfig } from './config.ts'
import type { Logger } from './log.ts'
import { executeCheck } from './runbooks.ts'
import type { ApprovalService } from './permission.ts'
import type { Store } from './store.ts'

export interface WorkflowEngineDeps {
  store: Store
  config: AppConfig
  log: Logger
  approvals: ApprovalService
  onRunUpdated(run: WorkflowRun): void
}

/**
 * Deterministic workflow engine — zero LLM.
 *
 * The point of a workflow is that a known problem follows a known procedure:
 * checking, remediating and notifying are all decided in advance, so running
 * the procedure must not depend on a model's judgement (or availability).
 * Steps execute in order, `when` conditions can skip a step based on an earlier
 * result, and `approval` steps block on the platform's human-approval channel —
 * the only place a human is needed.
 *
 * Commands run on the host (operator-authored, audited), not in a sandbox: a
 * workflow is trusted configuration, unlike agent-generated commands.
 */
export class WorkflowEngine {
  private readonly deps: WorkflowEngineDeps

  constructor(deps: WorkflowEngineDeps) {
    this.deps = deps
  }

  async run(
    workflowId: string,
    options: { trigger: WorkflowRun['trigger']; sessionId?: string } = { trigger: 'manual' },
  ): Promise<WorkflowRun> {
    const { store, log, approvals } = this.deps
    const workflow = store.getWorkflow(workflowId)
    if (workflow === undefined) throw new Error(`unknown workflow: ${workflowId}`)

    const runId = randomUUID()
    const startedAt = Date.now()
    store.insertWorkflowRun({
      id: runId,
      workflowId,
      trigger: options.trigger,
      startedAt,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    })
    const running: WorkflowRun = {
      id: runId,
      workflowId,
      workflowName: workflow.name,
      trigger: options.trigger,
      status: 'running',
      startedAt,
      steps: [],
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    }
    this.deps.onRunUpdated(running)
    log.info(`workflow ${workflowId} started (${options.trigger}, run ${runId})`)

    const results: WorkflowStepResult[] = []
    let failure: string | undefined
    try {
      for (const step of workflow.steps) {
        const skip = evaluateWhen(step.when, results)
        if (skip !== undefined) {
          results.push({
            stepId: step.id,
            type: step.type,
            title: stepTitle(step),
            status: 'skipped',
            detail: skip,
          })
          continue
        }
        const result = await this.executeStep(step, options, runId, approvals)
        results.push(result)
        const stop = shouldStop(step, result)
        if (stop !== undefined) {
          failure = stop
          break
        }
      }

      const hasFailure = results.some((result) => result.status === 'fail' || result.status === 'error' || result.status === 'denied' || result.status === 'notify-failed')
      const status: WorkflowRun['status'] = failure !== undefined ? 'fail' : hasFailure ? 'warn' : 'ok'
      const finished: WorkflowRun = {
        id: runId,
        workflowId,
        workflowName: workflow.name,
        trigger: options.trigger,
        status,
        startedAt,
        finishedAt: Date.now(),
        steps: results,
        report: renderReport(workflow, results),
        ...(failure === undefined ? {} : { error: failure }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      }
      store.finishWorkflowRun(runId, {
        status,
        finishedAt: finished.finishedAt ?? Date.now(),
        steps: results,
        report: finished.report ?? '',
        ...(failure === undefined ? {} : { error: failure }),
      })
      this.deps.onRunUpdated(finished)
      log.info(`workflow ${workflowId} finished: ${status} (${results.length} steps)`)
      return finished
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const finished: WorkflowRun = {
        id: runId,
        workflowId,
        workflowName: workflow.name,
        trigger: options.trigger,
        status: 'error',
        startedAt,
        finishedAt: Date.now(),
        steps: results,
        error: message,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      }
      store.finishWorkflowRun(runId, {
        status: 'error',
        finishedAt: finished.finishedAt ?? Date.now(),
        steps: results,
        error: message,
      })
      this.deps.onRunUpdated(finished)
      log.error(`workflow ${workflowId} failed`, error)
      return finished
    }
  }

  private async executeStep(
    step: WorkflowStep,
    options: { sessionId?: string },
    runId: string,
    approvals: ApprovalService,
  ): Promise<WorkflowStepResult> {
    const { store, config, log } = this.deps
    const base = { stepId: step.id, type: step.type, title: stepTitle(step) }
    const started = Date.now()

    if (step.type === 'check') {
      const check: RunbookCheck = { ...step, kind: step.kind, target: step.target, title: step.title }
      const finding = await executeCheck(check, { workspace: config.workspace, log })
      return {
        ...base,
        status: finding.status === 'skipped' ? 'skipped' : finding.status,
        detail: finding.detail,
        ...(finding.output === undefined ? {} : { output: finding.output }),
        durationMs: Date.now() - started,
      }
    }

    if (step.type === 'command') {
      const timeoutMs = Math.max(1, (step.timeoutSec ?? 60)) * 1000
      const result = await runCommand(step.command, step.cwd ?? config.workspace, timeoutMs)
      store.audit({
        actor: `workflow:${runId}`,
        action: 'workflow.command',
        subject: step.command.slice(0, 200),
        detail: { exitCode: result.exitCode, stepId: step.id },
      })
      return {
        ...base,
        status: result.exitCode === 0 ? 'ok' : 'fail',
        detail: `exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`,
        output: truncate(`${result.stdout}${result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : ''}`),
        durationMs: Date.now() - started,
      }
    }

    if (step.type === 'notify') {
      try {
        const response = await fetch(step.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workflowRunId: runId,
            stepId: step.id,
            title: step.title,
            ...(step.payload ?? {}),
          }),
          signal: AbortSignal.timeout(10_000),
        })
        return {
          ...base,
          status: response.ok ? 'notified' : 'notify-failed',
          detail: `HTTP ${response.status} -> ${step.url}`,
          durationMs: Date.now() - started,
        }
      } catch (error) {
        return {
          ...base,
          status: 'notify-failed',
          detail: `${step.url}: ${error instanceof Error ? error.message : String(error)}`,
          durationMs: Date.now() - started,
        }
      }
    }

    // approval: the only step that needs a human; blocks on the shared channel.
    const timeoutMs = step.timeoutMs ?? 15 * 60 * 1000
    log.info(`workflow ${runId} step ${step.id} awaiting approval: ${step.reason}`)
    const record = await approvals.request({
      sessionId: options.sessionId ?? `workflow:${runId}`,
      kernel: 'pi',
      toolName: 'workflow_step',
      args: { workflowRunId: runId, stepId: step.id, title: step.title, reason: step.reason },
      risk: 'medium',
      reason: step.reason,
      origin: 'chat',
      timeoutMs,
    })
    const approved = record.status === 'allowed-once' || record.status === 'allowed-session'
    return {
      ...base,
      status: approved ? 'approved' : 'denied',
      detail: approved
        ? `批准人 ${record.decidedBy ?? 'operator'}${record.decisionReason === undefined ? '' : `：${record.decisionReason}`}`
        : `未批准（${record.status}）${record.decisionReason === undefined ? '' : `：${record.decisionReason}`}`,
      durationMs: Date.now() - started,
    }
  }
}

function evaluateWhen(when: WorkflowWhen | undefined, results: WorkflowStepResult[]): string | undefined {
  if (when === undefined) return undefined
  const referenced = results.find((result) => result.stepId === when.stepId)
  if (referenced === undefined) return `前置步骤 ${when.stepId} 尚未执行，条件不成立`
  const actual = when.field === 'ok' ? (referenced.status === 'ok' ? 'true' : 'false') : when.field === 'exitCode' ? extractExitCode(referenced) : referenced.status
  const expected = String(when.equals)
  const match = actual === expected || toNumber(actual) === toNumber(expected)
  return match ? undefined : `条件不满足：${when.stepId}.${when.field}=${actual} ≠ ${expected}`
}

function extractExitCode(result: WorkflowStepResult): string {
  const match = /exit (\d+)/.exec(result.detail)
  return match?.[1] ?? '0'
}

function toNumber(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function shouldStop(step: WorkflowStep, result: WorkflowStepResult): string | undefined {
  if (step.type === 'command' && step.stopOnFailure === true && result.status !== 'ok') {
    return `步骤 ${step.id} 失败（${result.detail}），已停止`
  }
  if (step.type === 'approval' && step.stopOnDeny !== false && result.status === 'denied') {
    return `审批步骤 ${step.id} 未获批准，流程停止`
  }
  if (step.type === 'check' && step.critical === true && (result.status === 'fail' || result.status === 'error')) {
    return `关键检查 ${step.id} 失败（${result.detail}），已停止`
  }
  return undefined
}

function stepTitle(step: WorkflowStep): string {
  return 'title' in step && typeof step.title === 'string' && step.title.length > 0 ? step.title : step.id
}

function renderReport(workflow: WorkflowSpec, results: WorkflowStepResult[]): string {
  const lines = [
    `# 工作流报告：${workflow.name}`,
    '',
    `- 步骤数：${results.length}`,
    `- 结果：${results.filter((result) => result.status === 'ok' || result.status === 'approved' || result.status === 'notified').length} 成功 / ${
      results.filter((result) => result.status === 'fail' || result.status === 'error' || result.status === 'denied' || result.status === 'notify-failed').length
    } 未通过 / ${results.filter((result) => result.status === 'skipped').length} 跳过`,
    '',
    '| 步骤 | 类型 | 状态 | 详情 |',
    '| --- | --- | --- | --- |',
    ...results.map(
      (result) => `| ${result.title} | ${result.type} | ${result.status} | ${result.detail.replace(/\|/g, '\\|').slice(0, 160)} |`,
    ),
  ]
  return lines.join('\n')
}

function truncate(text: string, limit = 4000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return import('node:child_process').then(
    ({ execFile }) =>
      new Promise((resolvePromise) => {
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
            resolvePromise({
              exitCode,
              stdout: String(stdout),
              stderr: String(stderr),
              timedOut: (error as { killed?: boolean } | null)?.killed === true,
            })
          },
        )
        child.on('error', () => resolvePromise({ exitCode: 1, stdout: '', stderr: 'spawn failed', timedOut: false }))
      }),
  )
}
