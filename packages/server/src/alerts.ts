import { randomUUID } from 'node:crypto'
import type { AlertEvent, AlertSeverity, SessionInfo } from '@sre/protocol'
import type { AppConfig } from './config.ts'
import type { Logger } from './log.ts'
import type { RunbookRunner } from './runbooks.ts'
import type { SessionService } from './sessions.ts'
import type { Store } from './store.ts'

export interface AlertIngestPayload {
  source?: string
  name?: string
  alertname?: string
  severity?: string
  level?: string
  target?: string
  instance?: string
  host?: string
  summary?: string
  description?: string
  message?: string
  status?: string
  fingerprint?: string
  dedupKey?: string
  labels?: Record<string, string>
  raw?: unknown
}

export interface AlertServiceDeps {
  store: Store
  config: AppConfig
  log: Logger
  sessions: SessionService
  runner: RunbookRunner
  onAlert(alert: AlertEvent): void
  /**
   * Alert-triggered agents. Checked before the runbook/default triage: a defined
   * agent is a more specific answer to "who handles this alert" than a generic
   * investigation. Returns the sessions/agent runs started.
   */
  dispatchToAgents?: (alert: AlertEvent) => Promise<{ agentId: string; runId: string; sessionId?: string }[]>
}

const DEDUPE_WINDOW_MS = 15 * 60 * 1000

/** Tools an unattended alert triage may use without a human. */
const TRIAGE_ALLOWED_TOOLS = ['kb_search', 'sre_http_probe', 'sre_runbook_run', 'sre_incident_note']

/**
 * Alert intake. Alerts are normalized, deduplicated and (by default) triaged:
 * either by running a configured alert runbook or by opening a scoped agent
 * session whose tool allowlist is read-only.
 */
export class AlertService {
  private readonly deps: AlertServiceDeps

  constructor(deps: AlertServiceDeps) {
    this.deps = deps
  }

  async ingest(payload: AlertIngestPayload): Promise<{ alert: AlertEvent; sessionId?: string; triaged: boolean }> {
    const { store, log } = this.deps
    const name = payload.name ?? payload.alertname ?? 'unnamed-alert'
    const source = payload.source ?? 'webhook'
    const severity = normalizeSeverity(payload.severity ?? payload.level)
    const target = payload.target ?? payload.instance ?? payload.host
    const summary = payload.summary ?? payload.description ?? payload.message
    const labels = payload.labels ?? {}
    const fingerprint = payload.fingerprint ?? payload.dedupKey ?? `${source}:${name}:${target ?? ''}`
    const status = payload.status === 'resolved' ? 'resolved' : 'firing'

    const alert: AlertEvent = {
      id: randomUUID(),
      source,
      fingerprint,
      name,
      severity,
      labels,
      status,
      receivedAt: Date.now(),
      ...(target === undefined ? {} : { target }),
      ...(summary === undefined ? {} : { summary }),
      ...(payload.raw === undefined ? {} : { raw: payload.raw }),
    }
    store.insertAlert({
      ...alert,
      raw: alert.raw,
    })
    this.deps.onAlert(alert)
    log.info(`alert received: [${severity}] ${name} ${target ?? ''} (${fingerprint})`)

    if (status === 'resolved') return { alert, triaged: false }

    const recent = store.findAlertByFingerprint(fingerprint)
    const alreadyHandled =
      recent !== undefined &&
      recent.id !== alert.id &&
      recent.sessionId !== undefined &&
      alert.receivedAt - recent.receivedAt < DEDUPE_WINDOW_MS
    if (alreadyHandled) {
      store.attachAlertSession(alert.id, recent.sessionId ?? '')
      return { alert: { ...alert, sessionId: recent.sessionId }, sessionId: recent.sessionId, triaged: false }
    }

    // 1. Defined agents that match this alert fire first.
    if (this.deps.dispatchToAgents !== undefined) {
      try {
        const dispatched = await this.deps.dispatchToAgents({ ...alert })
        if (dispatched.length > 0) {
          const first = dispatched[0]
          if (first?.sessionId !== undefined) store.attachAlertSession(alert.id, first.sessionId)
          log.info(`alert ${alert.id} dispatched to agent(s): ${dispatched.map((entry) => entry.agentId).join(', ')}`)
          return {
            alert: { ...alert, ...(first?.sessionId === undefined ? {} : { sessionId: first.sessionId }) },
            ...(first?.sessionId === undefined ? {} : { sessionId: first.sessionId }),
            triaged: true,
          }
        }
      } catch (error) {
        log.error(`alert agent dispatch failed`, error)
      }
    }

    if (!this.autoTriageEnabled()) return { alert, triaged: false }

    try {
      const sessionId = await this.triage(alert)
      return { alert: { ...alert, sessionId }, sessionId, triaged: sessionId !== undefined }
    } catch (error) {
      log.error(`alert triage failed for ${alert.id}`, error)
      return { alert, triaged: false }
    }
  }

  private autoTriageEnabled(): boolean {
    return this.deps.store.getSetting<boolean>('alerts.autoTriage', true)
  }

  /** Open (or reuse) a scoped session for an alert and start the investigation. */
  async triage(alert: AlertEvent): Promise<string | undefined> {
    const { store, log, sessions, runner } = this.deps
    if (alert.sessionId !== undefined && store.getSession(alert.sessionId) !== undefined) {
      return alert.sessionId
    }

    const runbookId = store.getSetting<string | undefined>('alerts.runbookId', undefined)
    if (runbookId !== undefined && store.getRunbook(runbookId) !== undefined) {
      const run = await runner.run(runbookId, {
        trigger: 'alert',
        alertId: alert.id,
        extraContext: renderAlert(alert),
      })
      if (run.sessionId !== undefined) {
        store.attachAlertSession(alert.id, run.sessionId)
        return run.sessionId
      }
      return undefined
    }

    const session: SessionInfo = await sessions.create({
      title: `告警：${alert.name}${alert.target === undefined ? '' : ` @ ${alert.target}`}`,
      origin: 'alert',
      allowedTools: TRIAGE_ALLOWED_TOOLS,
      alertId: alert.id,
    })
    store.attachAlertSession(alert.id, session.id)

    const prompt = [
      `收到一条 ${alert.severity} 级告警，请做初步分诊（无人值守运行，只有只读工具可用）。`,
      '',
      renderAlert(alert),
      '',
      '## 要求',
      '',
      '1. 用 `kb_search` 查询该告警名称/目标相关的既知处置手册与历史复盘。',
      '2. 用 `sre_http_probe` / `sre_runbook_run`（如存在相关 runbook）做只读验证，不要尝试任何变更操作。',
      '3. 用 `sre_incident_note` 记录：观察到的现象、最可能的原因、建议的下一步、是否需要人工介入。',
      '4. 输出简短结论（中文），明确回答：影响范围、紧急程度、建议动作、需要升级给谁。',
    ].join('\n')

    try {
      await sessions.prompt(session.id, prompt)
      log.info(`alert ${alert.id} triaged in session ${session.id}`)
    } catch (error) {
      log.warn(`alert triage prompt failed: ${String(error)}`)
    }
    return session.id
  }
}

export function renderAlert(alert: AlertEvent): string {
  return [
    '```yaml',
    `name: ${alert.name}`,
    `severity: ${alert.severity}`,
    `source: ${alert.source}`,
    ...(alert.target === undefined ? [] : [`target: ${alert.target}`]),
    `status: ${alert.status}`,
    `receivedAt: ${new Date(alert.receivedAt).toISOString()}`,
    `fingerprint: ${alert.fingerprint}`,
    ...(Object.keys(alert.labels).length === 0
      ? []
      : ['labels:', ...Object.entries(alert.labels).map(([key, value]) => `  ${key}: ${value}`)]),
    '```',
    ...(alert.summary === undefined ? [] : ['', alert.summary]),
  ].join('\n')
}

function normalizeSeverity(raw: string | undefined): AlertSeverity {
  const value = (raw ?? '').toLowerCase()
  if (['critical', 'fatal', 'emergency', 'p1', 'page'].includes(value)) return 'critical'
  if (['warning', 'warn', 'p2', 'p3'].includes(value)) return 'warning'
  return 'info'
}
