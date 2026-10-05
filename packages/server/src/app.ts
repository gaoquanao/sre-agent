import type { DatabaseSync } from 'node:sqlite'
import type {
  ApprovalRecord,
  BootstrapPayload,
  KernelEvent,
  KernelEventEnvelope,
  KernelId,
  McpServerSpec,
  ModelSelection,
  PermissionPreset,
  PermissionRule,
  ProviderSpec,
  RunRecord,
  RunbookSpec,
  ServerMessage,
  SessionInfo,
  SkillSpec,
  ToolOrigin,
} from '@sre/protocol'
import { resolveConfig, ensureDirs, type AppConfig } from './config.ts'
import { openDatabase } from './db.ts'
import { CliManager } from './climan.ts'
import { CredentialVault } from './vault.ts'
import { createBrowserDriver } from './browser.ts'
import { createComputerDriver } from './computer.ts'
import { createSandboxProvider } from './sandbox/index.ts'
import { MemoryService } from './memory.ts'
import { WorkflowEngine } from './workflows.ts'
import { AgentService } from './agents.ts'
import { Logger } from './log.ts'
import { Store } from './store.ts'
import { KnowledgeBase } from './knowledge.ts'
import { ApprovalService, PermissionEngine, riskOf } from './permission.ts'
import { createPlatformTools, type ToolRegistry } from './tools.ts'
import { KernelRegistry } from './kernels/registry.ts'
import type { KernelHost, SessionRuntime } from './kernels/types.ts'
import { clampText } from './kernels/types.ts'
import { SessionService } from './sessions.ts'
import { RunbookRunner } from './runbooks.ts'
import { AlertService, type AlertIngestPayload } from './alerts.ts'
import { Scheduler } from './scheduler.ts'

export const VERSION = '0.1.0'

export interface Hub {
  broadcast(message: ServerMessage): void
}

/**
 * Composition root. Also implements `KernelHost`: every capability a kernel
 * adapter needs (tools, policy, approvals, event sink, model selection) is
 * routed through here, so adapters stay free of platform policy.
 */
export class App implements KernelHost {
  readonly config: AppConfig
  readonly log: Logger
  readonly store: Store
  readonly kb: KnowledgeBase
  readonly permissions: PermissionEngine
  readonly approvals: ApprovalService
  readonly tools: ToolRegistry
  readonly registry: KernelRegistry
  readonly cli: CliManager
  readonly vault: CredentialVault
  readonly sandboxes: ReturnType<typeof createSandboxProvider>
  readonly memory: MemoryService
  readonly workflows: WorkflowEngine
  readonly agents: AgentService
  readonly sessions: SessionService
  readonly runner: RunbookRunner
  readonly alerts: AlertService
  readonly scheduler: Scheduler

  private readonly db: DatabaseSync
  private hub: Hub | undefined
  private readonly seq = new Map<string, number>()
  private readonly statuses = new Map<string, 'idle' | 'running'>()
  private readonly modelOverrides = new Map<string, ModelSelection>()
  private readonly sessionRuntime = new Map<string, SessionRuntime>()
  private sweepTimer: NodeJS.Timeout | undefined
  private readonly unsubscribeApprovals: () => void

  constructor(config: AppConfig = resolveConfig(), log?: Logger) {
    this.config = config
    this.log = log ?? new Logger('platform')
    ensureDirs(config)
    this.db = openDatabase(config.dbPath, this.log.child('db'))
    this.store = new Store(this.db)
    this.kb = new KnowledgeBase(this.db, this.log.child('kb'))
    this.permissions = new PermissionEngine(config.permissionPreset, this.store.listPermissionRules())
    this.approvals = new ApprovalService(this.store, this.log.child('approval'), config.approvalTimeoutMs)

    this.sandboxes = createSandboxProvider(config, this.log.child('sandbox'))
    // With a remote sandbox provider, browser tools attach to the browser-type
    // sandbox's DevTools endpoint (one shared sandbox for browser use); in
    // local mode they drive the host's own Chrome.
    const browserDriver = createBrowserDriver({}, {
      ...(config.sandbox.provider === 'local'
        ? {}
        : {
            cdpEndpoint: async () => {
              try {
                const handle = await this.sandboxes.get('browser')
                return await handle.cdpEndpoint()
              } catch (error) {
                this.log.warn(`sandbox browser endpoint unavailable: ${String(error)}`)
                return undefined
              }
            },
          }),
    })
    this.tools = createPlatformTools({
      config,
      log: this.log.child('tools'),
      kb: this.kb,
      store: this.store,
      browser: browserDriver,
      computer: createComputerDriver(),
      sandbox: this.sandboxes,
      runChecks: (runbookId) => this.runner.runChecksForTool(runbookId),
      // Late-bound: tools are built before these services exist, but only invoked later.
      memory: { search: (...args) => this.memory.search(...args), save: (...args) => this.memory.save(...args) } as MemoryService,
      workflows: { run: (...args) => this.workflows.run(...args) } as WorkflowEngine,
      agents: { list: () => this.agents.list(), listRuns: (limit, agentId) => this.agents.listRuns(limit, agentId) } as AgentService,
      delegate: async (input, ctx) => {
        if (this.sessionHasParent(ctx.sessionId)) {
          return {
            ok: false,
            content: '当前会话已是子任务，不再嵌套委派。请把子任务拆给同级会话或自行完成。',
            error: 'max-depth',
          }
        }
        const child = await this.sessions.create({
          title: `子任务：${input.objective.slice(0, 40)}`,
          origin: 'chat',
          parentSessionId: input.sessionId,
          ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
        })
        this.log.info(`delegate: session ${input.sessionId} -> child ${child.id}`)
        const prompt = [
          input.objective,
          ...(input.context === undefined ? [] : ['', '## 背景与已知信息', '', input.context]),
          '',
          '## 要求',
          '',
          '1. 这是父会话委派的一个独立子任务：聚焦完成目标，不要展开无关工作。',
          '2. 结论要自包含（父会话看不到你这里的中间过程），最后一段直接给可用结论。',
        ].join('\n')
        await this.sessions.prompt(child.id, prompt)
        const settled = await this.waitForIdle(child.id, 10 * 60 * 1000)
        const transcript = this.store.listMessages(child.id, 200)
        const answer = [...transcript].reverse().find((message) => message.role === 'assistant')
        return {
          ok: settled && answer !== undefined,
          content: clampText(
            answer?.text ?? '子任务未产出结论（可能未配置模型或执行超时）。',
            6000,
          ),
          detail: { childSessionId: child.id, settled },
        }
      },
      askUser: async (input) => {
        const record = await this.approvals.request({
          sessionId: input.sessionId,
          kernel: this.registry.activeId(),
          toolName: 'ask_user',
          args: {
            question: input.question,
            ...(input.choices === undefined ? {} : { choices: input.choices }),
            ...(input.context === undefined ? {} : { context: input.context }),
            allowCustom: true,
          },
          risk: 'low',
          reason: 'agent 请求操作者确认意图',
          origin: 'chat',
        })
        if (record.status === 'allowed-once' || record.status === 'allowed-session') {
          const answer = record.decisionReason ?? ''
          return { ok: true, content: answer.length > 0 ? `用户回答：${answer}` : '用户已确认。', detail: record }
        }
        return {
          ok: false,
          content:
            record.status === 'denied'
              ? `用户拒绝回答${record.decisionReason === undefined ? '' : `：${record.decisionReason}`}`
              : `提问超时/被取消（${record.status}）。请基于现有证据决策并记录理由。`,
          error: record.status,
        }
      },
    })

    this.cli = new CliManager(config, this.log.child('cli'))
    this.vault = new CredentialVault(this.store, this.log.child('vault'), config)

    this.registry = new KernelRegistry(this.log.child('kernel'), config.kernel, this.cli, this.vault)
    this.registry.setHost(this)
    this.sessions = new SessionService({
      store: this.store,
      config,
      log: this.log.child('session'),
      registry: this.registry,
      onSessionUpdated: (session, reason) => this.onSessionUpdated(session, reason),
      waitForIdle: (sessionId, timeoutMs) => this.waitForIdle(sessionId, timeoutMs),
      // Memory bridging, kernel-agnostic: recalled context is prepended to the
      // turn before it reaches whichever kernel is active.
      memoryPrefix: (_sessionId, text) => this.memory.recallBlock(text),
    })
    this.memory = new MemoryService(this.store, this.log.child('memory'))
    this.runner = new RunbookRunner({
      store: this.store,
      config,
      log: this.log.child('runbook'),
      sessions: this.sessions,
      waitForIdle: (sessionId, timeoutMs) => this.waitForIdle(sessionId, timeoutMs),
      onRunUpdated: (run) => this.onRunUpdated(run),
    })
    this.alerts = new AlertService({
      store: this.store,
      config,
      log: this.log.child('alert'),
      sessions: this.sessions,
      runner: this.runner,
      onAlert: (alert) => this.broadcast({ type: 'alert_received', alert }),
      dispatchToAgents: async (alert) => {
        const matches = this.agents.matchesAlert(alert)
        const dispatched: { agentId: string; runId: string; sessionId?: string }[] = []
        for (const agent of matches) {
          const run = await this.agents.run(agent.id, { trigger: 'alert', alertId: alert.id })
          dispatched.push({
            agentId: agent.id,
            runId: run.id,
            ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
          })
        }
        return dispatched
      },
    })
    this.workflows = new WorkflowEngine({
      store: this.store,
      config,
      log: this.log.child('workflow'),
      approvals: this.approvals,
      onRunUpdated: (run) => this.broadcast({ type: 'workflow_run_updated', run }),
    })
    this.agents = new AgentService({
      store: this.store,
      config,
      log: this.log.child('agent'),
      sessions: this.sessions,
      runner: this.runner,
      workflows: this.workflows,
      memory: this.memory,
      onRunUpdated: (run) => this.broadcast({ type: 'agent_run_updated', run }),
    })

    this.scheduler = new Scheduler({
      store: this.store,
      log: this.log.child('scheduler'),
      runner: this.runner,
      onFire: (scheduleId, runId, nextRunAt) => {
        this.broadcast({ type: 'schedule_fired', scheduleId, runId })
        this.log.info(`schedule ${scheduleId} fired run ${runId} next=${nextRunAt ?? 'n/a'}`)
      },
    })

    this.unsubscribeApprovals = this.approvals.onEvent((record, phase) => {
      if (phase === 'requested') this.broadcast({ type: 'approval_requested', approval: record })
      else {
        this.broadcast({
          type: 'approval_resolved',
          approvalId: record.id,
          decision: record.status,
          by: record.decidedBy ?? 'system',
        })
      }
    })
  }

  setHub(hub: Hub | undefined): void {
    this.hub = hub
  }

  async start(): Promise<void> {
    this.seedDefaults()
    // A kernel that fails to start (missing binary, bad credential, broken
    // profile) must not take the platform down: the UI needs to be reachable to
    // show what broke and let the operator fix it.
    try {
      await this.registry.startActive()
    } catch (error) {
      this.log.error(`kernel ${this.registry.activeId()} failed to start; platform continues in degraded mode`, error)
    }
    this.scheduler.start()
    this.agents.start()
    this.sweepTimer = setInterval(() => {
      this.approvals.sweep()
      void this.sandboxes.sweep(Date.now()).catch((error) => {
        this.log.warn(`sandbox sweep failed: ${String(error)}`)
      })
    }, 30_000)
    this.sweepTimer.unref?.()
    this.log.info(`platform ready: home=${this.config.home} kernel=${this.registry.activeId()}`)
  }

  async stop(): Promise<void> {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    this.scheduler.stop()
    this.agents.stop()
    this.approvals.cancelAll('platform stopped')
    this.unsubscribeApprovals()
    await this.sandboxes.releaseAll()
    await this.registry.stopActive()
    this.log.info('platform stopped')
  }

  // -- KernelHost ----------------------------------------------------------

  emit(sessionId: string, event: KernelEvent): void {
    const seq = (this.seq.get(sessionId) ?? 0) + 1
    this.seq.set(sessionId, seq)
    const envelope: KernelEventEnvelope = {
      kernel: this.registry.activeId(),
      sessionId,
      seq,
      ts: Date.now(),
      event,
    }
    if (event.type === 'agent_status') this.statuses.set(sessionId, event.status)
    if (event.type === 'agent_status' || event.type === 'turn_end') {
      this.store.updateSession(sessionId, { updatedAt: Date.now() })
    }
    this.broadcast({ type: 'kernel_event', envelope })
  }

  modelOverride(sessionId: string): ModelSelection | undefined {
    return this.modelOverrides.get(sessionId)
  }

  setModelOverride(sessionId: string, selection: ModelSelection): void {
    this.modelOverrides.set(sessionId, selection)
  }

  defaultModel(): ModelSelection | undefined {
    const explicit = this.store.getSetting<ModelSelection | undefined>('models.default', undefined)
    if (explicit !== undefined) return explicit
    const provider = this.store.listProviders().find((entry) => entry.enabled && entry.models.length > 0)
    if (provider === undefined) return undefined
    const model = provider.models[0]
    return model === undefined ? undefined : { provider: provider.id, model: model.id }
  }

  onSessionUpdated(session: SessionInfo, reason: 'created' | 'message' | 'model' | 'status'): void {
    this.broadcast({ type: 'session_updated', session, reason })
  }

  private onRunUpdated(run: RunRecord): void {
    this.broadcast({ type: 'run_updated', run })
  }

  private broadcast(message: ServerMessage): void {
    this.hub?.broadcast(message)
  }

  /** Poll-based idle wait: cheap, and immune to missed notifications. */
  async waitForIdle(sessionId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    const runDeadline = Date.now() + Math.min(5_000, timeoutMs)
    while (Date.now() < runDeadline) {
      if (this.statuses.get(sessionId) === 'running') break
      await delay(150)
    }
    if (this.statuses.get(sessionId) !== 'running') return true
    while (Date.now() < deadline) {
      if (this.statuses.get(sessionId) !== 'running') return true
      await delay(200)
    }
    return false
  }

  // -- platform operations used by the HTTP layer --------------------------

  bootstrap(): BootstrapPayload {
    const defaultModel = this.defaultModel()
    return {
      version: VERSION,
      kernels: [],
      selectedKernel: this.registry.activeId(),
      permissionPreset: this.permissions.getPreset(),
      pendingApprovals: this.approvals.pending().length,
      ...(defaultModel === undefined ? {} : { defaultModel }),
    }
  }

  permissionSnapshot(): { preset: PermissionPreset; rules: PermissionRule[] } {
    return { preset: this.permissions.getPreset(), rules: this.store.listPermissionRules() }
  }

  setPermissionPreset(preset: PermissionPreset): void {
    this.permissions.setPreset(preset)
    this.store.setSetting('permissions.preset', preset)
    this.store.audit({ actor: 'operator', action: 'permissions.preset', subject: preset })
    this.log.info(`permission preset -> ${preset}`)
  }

  savePermissionRule(rule: PermissionRule): void {
    this.store.upsertPermissionRule(rule)
    this.permissions.setRules(this.store.listPermissionRules())
    this.store.audit({ actor: 'operator', action: 'permissions.rule.save', subject: rule.id, detail: rule })
  }

  deletePermissionRule(id: string): void {
    this.store.deletePermissionRule(id)
    this.permissions.setRules(this.store.listPermissionRules())
    this.store.audit({ actor: 'operator', action: 'permissions.rule.delete', subject: id })
  }

  async resyncKernel(): Promise<{ id: KernelId; ok: boolean; detail: string }[]> {
    const results = await this.registry.resyncAll()
    this.store.audit({ actor: 'operator', action: 'kernel.resync', subject: this.registry.activeId(), detail: results })
    return results
  }

  async saveSkill(skill: SkillSpec): Promise<void> {
    this.store.upsertSkill(skill)
    await this.registry.activeAdapter().syncSkills(this.store.listSkills())
    this.store.audit({ actor: 'operator', action: 'skill.save', subject: skill.name })
  }

  async deleteSkill(name: string): Promise<void> {
    this.store.deleteSkill(name)
    await this.registry.activeAdapter().syncSkills(this.store.listSkills())
    this.store.audit({ actor: 'operator', action: 'skill.delete', subject: name })
  }

  async saveMcpServer(spec: McpServerSpec): Promise<void> {
    this.store.upsertMcpServer(spec)
    await this.registry.activeAdapter().syncMcpServers(this.store.listMcpServers())
    this.store.audit({ actor: 'operator', action: 'mcp.save', subject: spec.name, detail: { transport: spec.transport } })
  }

  async deleteMcpServer(name: string): Promise<void> {
    this.store.deleteMcpServer(name)
    await this.registry.activeAdapter().syncMcpServers(this.store.listMcpServers())
    this.store.audit({ actor: 'operator', action: 'mcp.delete', subject: name })
  }

  async saveProvider(spec: ProviderSpec): Promise<void> {
    this.store.upsertProvider(spec)
    await this.registry.activeAdapter().syncProviders(this.store.listProviders())
    this.store.audit({ actor: 'operator', action: 'provider.save', subject: spec.id, detail: { api: spec.api } })
  }

  async deleteProvider(id: string): Promise<void> {
    this.store.deleteProvider(id)
    await this.registry.activeAdapter().syncProviders(this.store.listProviders())
    this.store.audit({ actor: 'operator', action: 'provider.delete', subject: id })
  }

  saveRunbook(runbook: RunbookSpec): void {
    this.store.upsertRunbook({ ...runbook, updatedAt: Date.now() })
    this.store.audit({ actor: 'operator', action: 'runbook.save', subject: runbook.id })
  }

  deleteRunbook(id: string): void {
    this.store.deleteRunbook(id)
    this.store.audit({ actor: 'operator', action: 'runbook.delete', subject: id })
  }

  saveSchedule(spec: Parameters<Scheduler['refresh']>[0]): { ok: boolean; detail: string; nextRunAt?: number } {
    this.store.upsertSchedule(spec)
    const result = this.scheduler.refresh(spec)
    this.store.audit({ actor: 'operator', action: 'schedule.save', subject: spec.id, detail: result })
    return result
  }

  deleteSchedule(id: string): void {
    this.scheduler.remove(id)
    this.store.deleteSchedule(id)
    this.store.audit({ actor: 'operator', action: 'schedule.delete', subject: id })
  }

  saveWorkflow(spec: import('@sre/protocol').WorkflowSpec): void {
    this.store.upsertWorkflow({ ...spec, updatedAt: Date.now() })
    this.store.audit({ actor: 'operator', action: 'workflow.save', subject: spec.id, detail: { steps: spec.steps.length } })
  }

  deleteWorkflow(id: string): void {
    this.store.deleteWorkflow(id)
    this.store.audit({ actor: 'operator', action: 'workflow.delete', subject: id })
  }

  saveAgent(spec: import('@sre/protocol').AgentSpec): import('@sre/protocol').AgentSpec {
    const saved = this.agents.save(spec)
    return saved
  }

  deleteAgent(id: string): void {
    this.agents.delete(id)
  }

  async ingestAlert(payload: AlertIngestPayload): Promise<{ alertId: string; sessionId?: string; triaged: boolean }> {
    const result = await this.alerts.ingest(payload)
    return {
      alertId: result.alert.id,
      triaged: result.triaged,
      ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    }
  }

  async triageAlert(alertId: string): Promise<string | undefined> {
    const alert = this.store.listAlerts(500).find((entry) => entry.id === alertId)
    if (alert === undefined) return undefined
    return this.alerts.triage({
      id: alert.id,
      source: alert.source,
      fingerprint: alert.fingerprint,
      name: alert.name,
      severity: alert.severity as SessionInfo['origin'] extends never ? never : 'critical' | 'warning' | 'info',
      labels: alert.labels,
      status: alert.status === 'resolved' ? 'resolved' : 'firing',
      receivedAt: alert.receivedAt,
      ...(alert.target === undefined ? {} : { target: alert.target }),
      ...(alert.summary === undefined ? {} : { summary: alert.summary }),
      ...(alert.sessionId === undefined ? {} : { sessionId: alert.sessionId }),
    })
  }

  /** Snapshot used by the dsh bridge plugin's verdict endpoint. */
  sessionScope(sessionId: string): { origin: ToolOrigin; allowedTools?: string[] } | undefined {
    const runtime = this.sessionRuntime.get(sessionId)
    if (runtime !== undefined) {
      return runtime.allowedTools === undefined
        ? { origin: runtime.origin }
        : { origin: runtime.origin, allowedTools: runtime.allowedTools }
    }
    const session = this.store.getSession(sessionId)
    if (session === undefined) return undefined
    const allowedTools = this.store.getSessionAllowedTools(sessionId)
    return allowedTools === undefined ? { origin: session.origin } : { origin: session.origin, allowedTools }
  }

  registerSessionRuntime(runtime: SessionRuntime): void {
    this.sessionRuntime.set(runtime.sessionId, runtime)
  }

  riskOf = riskOf

  private sessionHasParent(sessionId: string): boolean {
    const session = this.store.getSession(sessionId)
    return session?.parentSessionId !== undefined
  }

  private seedDefaults(): void {
    if (this.store.listSkills().length === 0) {
      this.store.upsertSkill({
        name: 'sre-incident-triage',
        description:
          'Use when triaging an alert or investigating an incident: the standard order of operations, evidence to collect, and how to write the conclusion.',
        body: [
          '# 事故分诊标准流程',
          '',
          '1. 先确认影响面：受影响的服务、用户可见的错误率、是全局还是单实例。',
          '2. 用 `kb_search` 查该服务的 runbook 与历史复盘，避免重复排查。',
          '3. 取证优先级：指标 → 日志 → 配置变更 → 依赖状态。只读命令优先（kubectl get/describe、journalctl、ss、df）。',
          '4. 任何变更类命令都必须先说明理由并等待人工审批。',
          '5. 结论必须包含：影响范围、当前状态、最可能原因、建议动作、需要人工确认的事项。',
        ].join('\n'),
        enabled: true,
        source: 'builtin',
        updatedAt: Date.now(),
      })
    }
    if (this.store.listRunbooks().length === 0) {
      const runbook: RunbookSpec = {
        id: 'api-health',
        name: 'API 健康巡检',
        description: '对核心 HTTP 入口做可用性与延迟基线检查，并让模型给出结论。',
        prompt: '对核心 API 入口做健康巡检，重点关注可用性与响应时间是否偏离基线。',
        checks: [
          {
            id: 'gateway-health',
            kind: 'http',
            title: '网关健康检查端点',
            target: 'http://127.0.0.1:8787/api/health',
            method: 'GET',
            expectStatus: 200,
            timeoutSec: 10,
            critical: true,
          },
        ],
        allowedTools: ['kb_search', 'sre_http_probe', 'sre_runbook_run', 'sre_incident_note'],
        enabled: true,
        updatedAt: Date.now(),
      }
      this.store.upsertRunbook(runbook)
    }
    if (this.store.listWorkflows().length === 0) {
      this.store.upsertWorkflow({
        id: 'disk-pressure-cleanup',
        name: '磁盘压力标准处置',
        description: '固定处置路径示例：确认水位 → 定位占用 → 清理可回收日志 → 通知。全程无需模型。',
        enabled: true,
        updatedAt: Date.now(),
        steps: [
          {
            id: 'check-disk',
            type: 'check',
            kind: 'shell',
            title: '检查根分区水位',
            target: 'df -h / | tail -1',
            timeoutSec: 15,
            critical: false,
          },
          {
            id: 'approve-cleanup',
            type: 'approval',
            title: '批准清理可回收日志',
            reason: '即将删除 7 天前的压缩日志（remediation 需要人工确认）',
            timeoutMs: 900000,
            stopOnDeny: true,
            when: { stepId: 'check-disk', field: 'status', equals: 'ok' },
          },
          {
            id: 'cleanup',
            type: 'command',
            title: '清理 7 天前的压缩日志',
            command: 'find /tmp -maxdepth 1 -name "*.log.gz" -mtime +7 -delete -print | wc -l',
            timeoutSec: 60,
            stopOnFailure: true,
            when: { stepId: 'approve-cleanup', field: 'status', equals: 'approved' },
          },
          {
            id: 'notify',
            type: 'notify',
            title: '通知值班（示例 webhook）',
            url: 'http://127.0.0.1:9/unused-placeholder',
            when: { stepId: 'cleanup', field: 'ok', equals: 'true' },
          },
        ],
      })
    }
    if (this.store.listAgents().length === 0) {
      this.store.upsertAgent({
        id: 'disk-watchdog',
        name: '磁盘看护',
        role: '每 30 分钟检查各挂载点水位。水位超过 85% 时执行「磁盘压力标准处置」工作流；无法自动处理时记录记忆并升级。',
        kind: 'worker',
        cron: '*/30 * * * *',
        allowedTools: ['kb_search', 'memory_search', 'memory_save', 'sre_shell', 'workflow_run', 'sre_incident_note'],
        workflowId: 'disk-pressure-cleanup',
        enabled: false,
        updatedAt: Date.now(),
      })
      this.store.upsertAgent({
        id: 'incident-supervisor',
        name: '值守主管',
        role: '巡检各智能体的近期运行，发现未闭环的处置（失败、告警未处理、重复故障）时编排下一步：调用工作流、补充记忆、给出值班简报。',
        kind: 'supervisor',
        cron: '0 * * * *',
        allowedTools: ['kb_search', 'memory_search', 'memory_save', 'workflow_run', 'agent_status', 'sre_incident_note', 'ask_user'],
        enabled: false,
        updatedAt: Date.now(),
      })
    }
    const storedPreset = this.store.getSetting<PermissionPreset | undefined>('permissions.preset', undefined)
    if (storedPreset !== undefined) this.permissions.setPreset(storedPreset)
    else this.store.setSetting('permissions.preset', this.permissions.getPreset())
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export type { ApprovalRecord, SkillSpec }
