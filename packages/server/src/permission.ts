import { randomUUID } from 'node:crypto'
import type {
  ApprovalRecord,
  ApprovalStatus,
  KernelId,
  PermissionDecision,
  PermissionEffect,
  PermissionPreset,
  PermissionRule,
  RiskLevel,
  ToolAnnotations,
  ToolOrigin,
} from '@sre/protocol'
import { Logger } from './log.ts'
import type { Store } from './store.ts'

export interface ToolVerdictInput {
  toolName: string
  args?: unknown
  annotations?: ToolAnnotations
  origin: ToolOrigin
  sessionId: string
  /** Set for unattended runs: the only tools the agent may use. */
  allowedTools?: string[]
  /** Tools that declared this origin as auto-approved. */
  permittedOrigins?: ToolOrigin[]
}

/**
 * Derives a risk level the same way for every kernel: explicit annotations when
 * the tool declares them (Pi and the platform do), name heuristics for kernel
 * builtins that do not.
 */
export function riskOf(toolName: string, annotations?: ToolAnnotations): RiskLevel {
  if (annotations?.destructiveHint === true) return 'high'
  if (annotations?.readOnlyHint === true) return 'low'
  if (annotations !== undefined && annotations.readOnlyHint === false) return 'medium'
  return RISK_BY_NAME(toolName)
}

const HIGH_RISK_PATTERN = /(^|_|\b)(rm|kill|delete|drop|truncate|restart|reboot|stop|scale|apply|deploy|rollback|patch|write|edit|chmod|chown|mv)(_|\b)/i
const LOW_RISK_PATTERN = /(read|grep|find|ls|list|get|status|search|query|probe|describe|logs?|fetch|view|show|inspect|diff|cat)/i

function riskByName(toolName: string): RiskLevel {
  if (HIGH_RISK_PATTERN.test(toolName)) return 'high'
  if (LOW_RISK_PATTERN.test(toolName)) return 'low'
  return 'medium'
}

const RISK_BY_NAME = riskByName

/**
 * Single policy authority for both kernels.
 *
 * Evaluation order: run-scoped allowlist -> explicit rules (by priority) ->
 * preset. Unattended origins (schedule/alert) never get an `ask`: there is no
 * human to answer, so the request becomes a denial.
 */
export class PermissionEngine {
  private preset: PermissionPreset
  private rules: PermissionRule[]

  constructor(preset: PermissionPreset, rules: PermissionRule[] = []) {
    this.preset = preset
    this.rules = [...rules].sort((a, b) => a.priority - b.priority)
  }

  setPreset(preset: PermissionPreset): void {
    this.preset = preset
  }

  getPreset(): PermissionPreset {
    return this.preset
  }

  setRules(rules: PermissionRule[]): void {
    this.rules = [...rules].sort((a, b) => a.priority - b.priority)
  }

  evaluate(input: ToolVerdictInput): PermissionDecision {
    const risk = riskOf(input.toolName, input.annotations)

    if (input.allowedTools !== undefined) {
      if (input.allowedTools.includes(input.toolName)) {
        return {
          effect: 'allow',
          by: 'runbook-allowlist',
          reason: `${input.toolName} is allowed by the runbook scope`,
        }
      }
      if (input.permittedOrigins?.includes(input.origin) === true) {
        return {
          effect: 'allow',
          by: 'tool-default-origin',
          reason: `${input.toolName} declares ${input.origin} as an auto-approved origin`,
        }
      }
      return {
        effect: 'deny',
        by: 'runbook-allowlist',
        reason: `${input.toolName} is outside the runbook tool scope`,
      }
    }

    for (const rule of this.rules) {
      if (!rule.enabled) continue
      if (rule.tool !== undefined && !matchGlob(rule.tool, input.toolName)) continue
      if (rule.risk !== undefined && rule.risk !== risk) continue
      if (rule.origins !== undefined && !rule.origins.includes(input.origin)) continue
      return {
        effect: rule.effect,
        by: `rule:${rule.id}`,
        reason: rule.description ?? `${rule.effect} by rule ${rule.id}`,
      }
    }

    if (input.permittedOrigins?.includes(input.origin) === true) {
      return {
        effect: 'allow',
        by: 'tool-default-origin',
        reason: `${input.toolName} declares ${input.origin} as an auto-approved origin`,
      }
    }

    const effect = presetEffect(this.preset, risk)
    const unattended = input.origin === 'schedule' || input.origin === 'alert'
    if (unattended && effect === 'ask') {
      return {
        effect: 'deny',
        by: 'unattended-default',
        reason: `${input.toolName} requires approval but no operator is attached to a ${input.origin} run`,
      }
    }
    return {
      effect,
      by: 'preset',
      reason: `${this.preset} preset maps ${risk} risk to ${effect}`,
    }
  }
}

function presetEffect(preset: PermissionPreset, risk: RiskLevel): PermissionEffect {
  switch (preset) {
    case 'read-only':
      return risk === 'low' ? 'allow' : 'deny'
    case 'full-access':
      return 'allow'
    case 'workspace-write':
    default:
      return risk === 'low' ? 'allow' : 'ask'
  }
}

export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

export interface ApprovalRequestInput {
  sessionId: string
  kernel: KernelId
  toolName: string
  args: unknown
  risk: RiskLevel
  reason: string
  origin: ToolOrigin
  /** Per-request timeout override (ms). */
  timeoutMs?: number
}

interface PendingWaiter {
  resolve: (record: ApprovalRecord) => void
  timer: NodeJS.Timeout
}

/**
 * Human-in-the-loop approvals. Requests block the kernel's tool-call gate until
 * an operator answers, the deadline passes, or the platform shuts down. Every
 * terminal state is fail-closed: only `allowed-once` / `allowed-session` let a
 * tool run.
 */
export class ApprovalService {
  private readonly store: Store
  private readonly log: Logger
  private readonly defaultTimeoutMs: number
  private readonly waiters = new Map<string, PendingWaiter>()
  private readonly listeners = new Set<(record: ApprovalRecord, phase: 'requested' | 'resolved') => void>()

  constructor(store: Store, log: Logger, defaultTimeoutMs: number) {
    this.store = store
    this.log = log
    this.defaultTimeoutMs = defaultTimeoutMs
  }

  onEvent(listener: (record: ApprovalRecord, phase: 'requested' | 'resolved') => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  pending(): ApprovalRecord[] {
    return this.store.listApprovals({ status: 'pending', limit: 100 })
  }

  listRecent(limit = 100): ApprovalRecord[] {
    return this.store.listApprovals({ limit })
  }

  get(id: string): ApprovalRecord | undefined {
    return this.store.getApproval(id)
  }

  /** Resolves once the approval reaches a terminal state. */
  async request(input: ApprovalRequestInput): Promise<ApprovalRecord> {
    const now = Date.now()
    const record: ApprovalRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      kernel: input.kernel,
      toolName: input.toolName,
      args: input.args ?? null,
      risk: input.risk,
      reason: input.reason,
      origin: input.origin,
      status: 'pending',
      requestedAt: now,
      expiresAt: now + (input.timeoutMs ?? this.defaultTimeoutMs),
    }
    this.store.insertApproval(record)
    this.store.audit({
      actor: 'kernel',
      action: 'approval.request',
      subject: record.id,
      detail: { tool: input.toolName, session: input.sessionId, origin: input.origin, risk: input.risk },
    })
    this.log.info(`approval requested: ${input.toolName} (${record.id}) session=${input.sessionId}`)
    for (const listener of this.listeners) listener(record, 'requested')

    return new Promise<ApprovalRecord>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(record.id, 'expired', 'system', 'approval timed out')
      }, Math.max(1_000, record.expiresAt - now))
      timer.unref?.()
      this.waiters.set(record.id, { resolve, timer })
    })
  }

  decide(
    id: string,
    decision: Extract<ApprovalStatus, 'allowed-once' | 'allowed-session' | 'denied' | 'cancelled'>,
    by: string,
    reason?: string,
  ): ApprovalRecord | undefined {
    return this.settle(id, decision, by, reason)
  }

  private settle(id: string, status: ApprovalStatus, by: string, reason?: string): ApprovalRecord | undefined {
    const record = this.store.getApproval(id)
    if (record === undefined) return undefined
    if (record.status !== 'pending') return record

    this.store.updateApproval(id, { status, decidedAt: Date.now(), decidedBy: by, decisionReason: reason })
    const updated: ApprovalRecord = {
      ...record,
      status,
      decidedAt: Date.now(),
      decidedBy: by,
      decisionReason: reason,
    }
    this.store.audit({
      actor: by,
      action: 'approval.decide',
      subject: id,
      detail: { tool: record.toolName, decision: status, reason },
    })
    this.log.info(`approval ${status}: ${record.toolName} (${id}) by ${by}`)

    const waiter = this.waiters.get(id)
    if (waiter !== undefined) {
      clearTimeout(waiter.timer)
      this.waiters.delete(id)
      waiter.resolve(updated)
    }
    for (const listener of this.listeners) listener(updated, 'resolved')
    return updated
  }

  /** Expire pending approvals past their deadline (called by a periodic sweep). */
  sweep(now = Date.now()): void {
    for (const id of this.store.expireApprovals(now)) {
      const waiter = this.waiters.get(id)
      if (waiter !== undefined) {
        clearTimeout(waiter.timer)
        this.waiters.delete(id)
      }
      const record = this.store.getApproval(id)
      if (record !== undefined) {
        for (const listener of this.listeners) listener(record, 'resolved')
      }
    }
  }

  /** Called on shutdown: anything still waiting is denied, never left hanging. */
  cancelAll(reason = 'platform shutting down'): void {
    for (const record of this.store.listApprovals({ status: 'pending', limit: 500 })) {
      this.settle(record.id, 'cancelled', 'system', reason)
    }
  }
}

export function isAllowed(record: ApprovalRecord): boolean {
  return record.status === 'allowed-once' || record.status === 'allowed-session'
}
