import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import type { AgentRun, AgentSpec, AlertEvent, SessionInfo, WorkflowRun } from '@sre/protocol'
import type { AppConfig } from './config.ts'
import type { Logger } from './log.ts'
import type { MemoryService } from './memory.ts'
import type { RunbookRunner } from './runbooks.ts'
import type { SessionService } from './sessions.ts'
import type { Store } from './store.ts'
import type { WorkflowEngine } from './workflows.ts'

export interface AgentServiceDeps {
  store: Store
  config: AppConfig
  log: Logger
  sessions: SessionService
  runner: RunbookRunner
  workflows: WorkflowEngine
  memory: MemoryService
  onRunUpdated(run: AgentRun): void
}

const DIGEST_RUNS = 5
const RUN_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Defined agents: monitor, alert-triage, self-heal, and supervisors.
 *
 * The architecture is a reactor, not a process per agent: every defined agent is
 * a spec plus triggers (cron / alert match / manual), and a trigger starts a
 * *scoped, unattended run* — a session whose tool allowlist is the agent's, whose
 * approvals can never block (no human is attached), and whose outcome is recorded
 * as an AgentRun. That is what "continuously running" means here: the platform
 * stays up and cheap, agents wake on what they watch.
 *
 * Main-agent oversight is expressed two ways: workers report structured runs
 * that the UI and the operator can see, and `supervisor` agents receive a digest
 * of recent worker runs in their prompt, so a coordinating agent can react to
 * what the fleet did without polling each one.
 */
export class AgentService {
  private readonly deps: AgentServiceDeps
  private readonly jobs = new Map<string, Cron>()
  private readonly running = new Set<string>()
  private started = false

  constructor(deps: AgentServiceDeps) {
    this.deps = deps
  }

  start(): void {
    this.started = true
    for (const agent of this.deps.store.listAgents()) {
      if (agent.enabled && agent.cron !== undefined) this.arm(agent)
    }
    this.deps.log.info(`agent service started with ${this.jobs.size} scheduled agent(s)`)
  }

  stop(): void {
    this.started = false
    for (const [, job] of this.jobs) job.stop()
    this.jobs.clear()
  }

  list(): AgentSpec[] {
    return this.deps.store.listAgents()
  }

  get(id: string): AgentSpec | undefined {
    return this.deps.store.getAgent(id)
  }

  listRuns(limit = 20, agentId?: string): AgentRun[] {
    return this.deps.store.listAgentRuns(limit, agentId)
  }

  save(spec: AgentSpec): AgentSpec {
    const normalized: AgentSpec = { ...spec, updatedAt: Date.now() }
    this.deps.store.upsertAgent(normalized)
    this.disarm(spec.id)
    if (normalized.enabled && normalized.cron !== undefined) this.arm(normalized)
    this.deps.store.audit({ actor: 'operator', action: 'agent.save', subject: spec.id, detail: { kind: spec.kind, cron: spec.cron } })
    return normalized
  }

  delete(id: string): void {
    this.disarm(id)
    this.deps.store.deleteAgent(id)
    this.deps.store.audit({ actor: 'operator', action: 'agent.delete', subject: id })
  }

  /** Enabled agents whose matchers accept this alert. */
  matchesAlert(alert: AlertEvent): AgentSpec[] {
    return this.deps.store.listAgents().filter((agent) => {
      if (!agent.enabled || agent.alertMatchers === undefined) return false
      return agent.alertMatchers.some((matcher) => {
        if (matcher.severity !== undefined && matcher.severity !== alert.severity) return false
        if (matcher.source !== undefined && matcher.source !== alert.source) return false
        if (matcher.namePattern !== undefined && !nameMatches(matcher.namePattern, alert.name)) return false
        return true
      })
    })
  }

  /** Recent worker outcomes, used as the supervisor's situational awareness. */
  digest(limit = DIGEST_RUNS): string {
    const runs = this.deps.store
      .listAgentRuns(40)
      .filter((run) => run.status !== 'running')
      .slice(0, limit)
    if (runs.length === 0) return '（近期没有其他智能体的运行记录）'
    return runs
      .map((run) => {
        const agent = this.deps.store.getAgent(run.agentId)
        const name = agent?.name ?? run.agentId
        const ago = Math.round((Date.now() - run.startedAt) / 60000)
        return `- ${name}（${run.trigger}，${ago} 分钟前）：${run.status}${run.summary === undefined ? '' : ` — ${run.summary.replace(/\s+/g, ' ').slice(0, 200)}`}`
      })
      .join('\n')
  }

  async run(agentId: string, options: { trigger: AgentRun['trigger']; alertId?: string; extraContext?: string } = { trigger: 'manual' }): Promise<AgentRun> {
    const { store, log } = this.deps
    const agent = store.getAgent(agentId)
    if (agent === undefined) throw new Error(`unknown agent: ${agentId}`)
    if (this.running.has(agentId)) {
      log.warn(`agent ${agentId} is still running from the previous trigger; skipping`)
      const skipped: AgentRun = {
        id: randomUUID(),
        agentId,
        agentName: agent.name,
        trigger: options.trigger,
        status: 'warn',
        summary: '上一次运行尚未结束，本次触发被跳过',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ...(options.alertId === undefined ? {} : { alertId: options.alertId }),
      }
      return skipped
    }

    const runId = randomUUID()
    const startedAt = Date.now()
    store.insertAgentRun({
      id: runId,
      agentId,
      trigger: options.trigger,
      startedAt,
      ...(options.alertId === undefined ? {} : { alertId: options.alertId }),
    })
    const running: AgentRun = {
      id: runId,
      agentId,
      agentName: agent.name,
      trigger: options.trigger,
      status: 'running',
      startedAt,
      ...(options.alertId === undefined ? {} : { alertId: options.alertId }),
    }
    this.deps.onRunUpdated(running)
    this.running.add(agentId)
    log.info(`agent ${agentId} (${agent.kind}) run ${runId} started via ${options.trigger}`)

    try {
      const outcome = await this.execute(agent, options)
      const finished: AgentRun = {
        ...running,
        status: outcome.status,
        finishedAt: Date.now(),
        ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
        ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
        ...(outcome.workflowRunId === undefined ? {} : { workflowRunId: outcome.workflowRunId }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      }
      store.finishAgentRun(runId, {
        status: finished.status,
        finishedAt: finished.finishedAt ?? Date.now(),
        ...(finished.summary === undefined ? {} : { summary: finished.summary }),
        ...(finished.sessionId === undefined ? {} : { sessionId: finished.sessionId }),
        ...(finished.workflowRunId === undefined ? {} : { workflowRunId: finished.workflowRunId }),
        ...(finished.error === undefined ? {} : { error: finished.error }),
      })
      this.deps.onRunUpdated(finished)
      if (finished.status !== 'ok') await this.escalate(agent, finished)
      log.info(`agent ${agentId} run ${runId} finished: ${finished.status}`)
      return finished
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const finished: AgentRun = { ...running, status: 'error', finishedAt: Date.now(), error: message }
      store.finishAgentRun(runId, { status: 'error', finishedAt: finished.finishedAt ?? Date.now(), error: message })
      this.deps.onRunUpdated(finished)
      await this.escalate(agent, finished)
      log.error(`agent ${agentId} run ${runId} failed`, error)
      return finished
    } finally {
      this.running.delete(agentId)
    }
  }

  private async execute(
    agent: AgentSpec,
    options: { trigger: AgentRun['trigger']; alertId?: string; extraContext?: string },
  ): Promise<{ status: AgentRun['status']; summary?: string; sessionId?: string; workflowRunId?: string; error?: string }> {
    // 1. Fixed procedure: a workflow runs with zero model calls.
    if (agent.workflowId !== undefined) {
      const workflowRun: WorkflowRun = await this.deps.workflows.run(agent.workflowId, { trigger: 'agent' })
      return {
        status: mapWorkflowStatus(workflowRun.status),
        summary: workflowRun.report?.split('\n').slice(0, 6).join(' ').slice(0, 400) ?? `工作流 ${workflowRun.status}`,
        workflowRunId: workflowRun.id,
        ...(workflowRun.error === undefined ? {} : { error: workflowRun.error }),
      }
    }

    // 2. A runbook: deterministic checks, then agent analysis.
    if (agent.runbookId !== undefined) {
      const run: import('@sre/protocol').RunRecord = await this.deps.runner.run(agent.runbookId, {
        trigger: options.trigger === 'alert' ? 'alert' : 'schedule',
        ...(options.alertId === undefined ? {} : { alertId: options.alertId }),
        ...(options.extraContext === undefined ? {} : { extraContext: options.extraContext }),
      })
      return {
        status: run.status === 'running' ? 'warn' : run.status,
        summary: run.report?.split('\n').filter((line) => line.trim().length > 0).slice(0, 4).join(' ').slice(0, 400) ?? `runbook ${run.status}`,
        ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
        ...(run.error === undefined ? {} : { error: run.error }),
      }
    }

    // 3. Free-form investigation under the agent's own tool scope.
    const session = await this.deps.sessions.create({
      title: `${agent.name}（${options.trigger}）`,
      origin: options.trigger === 'alert' ? 'alert' : 'schedule',
      allowedTools: agent.allowedTools,
      ...(agent.model === undefined ? {} : { model: agent.model }),
    })
    const prompt = this.buildPrompt(agent, options)
    await this.deps.sessions.prompt(session.id, prompt)
    const settled = await this.deps.sessions.waitForIdle(session.id, agent.maxRuntimeMs ?? RUN_TIMEOUT_MS)
    const transcript = this.deps.store.listMessages(session.id, 200)
    const answer = [...transcript].reverse().find((message) => message.role === 'assistant')
    const status: AgentRun['status'] = answer === undefined ? 'warn' : settled ? 'ok' : 'warn'
    return {
      status,
      sessionId: session.id,
      summary: answer?.text.replace(/\s+/g, ' ').slice(0, 400) ?? '该轮未产出结论（可能未配置模型或内核不可用）',
      ...(settled ? {} : { error: 'agent run exceeded its runtime budget' }),
    }
  }

  private buildPrompt(agent: AgentSpec, options: { trigger: AgentRun['trigger']; alertId?: string; extraContext?: string }): string {
    const lines = [
      `你是「${agent.name}」，一个持续值守的 SRE 智能体。`,
      '',
      '## 你的职责',
      '',
      agent.role.trim(),
      '',
      '## 本次触发',
      '',
      `- 触发方式：${options.trigger === 'schedule' ? '定时' : options.trigger === 'alert' ? '告警' : '手动'}`,
      `- 可用工具：${agent.allowedTools.length === 0 ? '（无，仅分析）' : agent.allowedTools.join(', ')}`,
      '- 这是无人值守运行：需要人工审批的操作会被直接拒绝，只做只读诊断与平台允许的动作。',
    ]
    if (options.extraContext !== undefined && options.extraContext.trim().length > 0) {
      lines.push('', '## 附加上下文', '', options.extraContext.trim())
    }
    if (agent.kind === 'supervisor') {
      lines.push(
        '',
        '## 其他智能体的近期运行（供你判断与编排）',
        '',
        this.digest(),
        '',
        '## 编排要求',
        '',
        '1. 先判断这些运行里有没有需要你介入的异常（失败、告警未闭环、处置未完成）。',
        '2. 需要走固定处置路径时用 `workflow_run` 执行工作流，不要手工重复步骤。',
        '3. 有新结论或环境事实时用 `memory_save` 落库（subject 用服务名或 "global"）。',
        '4. 用 `agent_status` 查看某个智能体的最近运行细节再决定下一步。',
        '5. 最后给出简报：现状、已处置、待人工确认。',
      )
    } else {
      lines.push(
        '',
        '## 要求',
        '',
        '1. 先查记忆与知识库（`memory_search` / `kb_search`），确认是否已有既知结论或处置手册。',
        '2. 只使用允许的工具做只读诊断；不要尝试变更操作。',
        '3. 关键观察、结论、建议动作用 `sre_incident_note` 记录。',
        '4. 输出简短结论（中文）：现状、风险、建议动作、是否需要人工介入。',
      )
    }
    return lines.join('\n')
  }

  private async escalate(agent: AgentSpec, run: AgentRun): Promise<void> {
    const urls = agent.escalation?.notifyUrls ?? []
    if (urls.length === 0) return
    const payload = {
      agent: agent.id,
      agentName: agent.name,
      runId: run.id,
      status: run.status,
      trigger: run.trigger,
      summary: run.summary ?? null,
      error: run.error ?? null,
      sessionId: run.sessionId ?? null,
      at: new Date().toISOString(),
    }
    for (const url of urls) {
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        })
      } catch (error) {
        this.deps.log.warn(`agent ${agent.id} escalation to ${url} failed: ${String(error)}`)
      }
    }
    this.deps.log.info(`agent ${agent.id} escalated (${run.status}) to ${urls.length} endpoint(s)`)
  }

  private arm(agent: AgentSpec): void {
    try {
      const job = new Cron(
        agent.cron ?? '',
        {
          ...(agent.timezone === undefined ? {} : { timezone: agent.timezone }),
          name: `agent:${agent.id}`,
          protect: true,
          unref: true,
        },
        () => {
          if (!this.started) return
          void this.run(agent.id, { trigger: 'schedule' }).catch((error) => {
            this.deps.log.error(`agent ${agent.id} scheduled run failed`, error)
          })
        },
      )
      this.jobs.set(agent.id, job)
      this.deps.log.info(`agent ${agent.id} armed: ${agent.cron} next=${job.nextRun()?.toISOString() ?? 'never'}`)
    } catch (error) {
      this.deps.log.warn(`agent ${agent.id} has an invalid cron "${agent.cron}": ${String(error)}`)
    }
  }

  private disarm(id: string): void {
    const job = this.jobs.get(id)
    if (job === undefined) return
    job.stop()
    this.jobs.delete(id)
  }
}

function mapWorkflowStatus(status: WorkflowRun['status']): AgentRun['status'] {
  if (status === 'ok') return 'ok'
  if (status === 'warn') return 'warn'
  if (status === 'fail') return 'fail'
  if (status === 'error') return 'error'
  return 'warn'
}

function nameMatches(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(escaped, 'i').test(name)
}

export type { SessionInfo }
