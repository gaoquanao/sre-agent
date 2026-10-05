import type { ApprovalRecord, KernelId, PermissionDecision, ToolAnnotations, ToolOrigin } from '@sre/protocol'
import type { ApprovalService, PermissionEngine } from '../permission.ts'
import { isAllowed, riskOf } from '../permission.ts'
import type { Logger } from '../log.ts'

export interface ToolVerdictRequest {
  sessionId: string
  kernel: KernelId
  toolName: string
  args: unknown
  annotations?: ToolAnnotations
  origin: ToolOrigin
  allowedTools?: string[]
  permittedOrigins?: ToolOrigin[]
}

export interface ToolVerdict {
  effect: 'allow' | 'deny'
  reason: string
  decision: PermissionDecision
  approval?: ApprovalRecord
}

export interface VerdictDeps {
  permissions: PermissionEngine
  approvals: ApprovalService
  log: Logger
  /** Session metadata lookup for origin / runbook tool scope. */
  sessionScope(sessionId: string): { origin: ToolOrigin; allowedTools?: string[] } | undefined
}

/**
 * The single gate every tool call passes through, for both kernels.
 *
 * Pi calls this from an inline `tool_call` extension; dsh calls it through the
 * bridge plugin's `tools/pre-execute` handler hitting `/internal/tool-verdict`.
 * Fail-closed: an unresolved approval is a denial.
 */
export async function evaluateToolCall(deps: VerdictDeps, request: ToolVerdictRequest): Promise<ToolVerdict> {
  const scope = deps.sessionScope(request.sessionId)
  const allowedTools = request.allowedTools ?? scope?.allowedTools
  const origin = scope?.origin ?? request.origin

  const decision = deps.permissions.evaluate({
    toolName: request.toolName,
    args: request.args,
    annotations: request.annotations,
    origin,
    sessionId: request.sessionId,
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(request.permittedOrigins === undefined ? {} : { permittedOrigins: request.permittedOrigins }),
  })

  if (decision.effect === 'allow') {
    return { effect: 'allow', reason: decision.reason, decision }
  }
  if (decision.effect === 'deny') {
    deps.log.warn(`tool denied: ${request.toolName} (${decision.by}) — ${decision.reason}`)
    return { effect: 'deny', reason: decision.reason, decision }
  }

  const approval = await deps.approvals.request({
    sessionId: request.sessionId,
    kernel: request.kernel,
    toolName: request.toolName,
    args: request.args,
    risk: riskOf(request.toolName, request.annotations),
    reason: decision.reason,
    origin,
  })

  if (isAllowed(approval)) {
    return { effect: 'allow', reason: `approved by ${approval.decidedBy ?? 'operator'}`, decision, approval }
  }
  return {
    effect: 'deny',
    reason:
      approval.status === 'expired'
        ? `approval for ${request.toolName} timed out`
        : approval.status === 'cancelled'
          ? `approval for ${request.toolName} was cancelled`
          : `operator denied ${request.toolName}${approval.decisionReason === undefined ? '' : `: ${approval.decisionReason}`}`,
    decision,
    approval,
  }
}
