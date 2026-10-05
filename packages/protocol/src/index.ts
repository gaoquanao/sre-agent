/**
 * @sre/protocol — kernel-agnostic domain model and wire contracts.
 *
 * Everything the web UI, the platform server and the kernel adapters agree on
 * lives here. Kernel-specific shapes (Pi extension events, dsh session events)
 * never leak past the adapter layer: adapters translate into `KernelEvent`.
 */

// ---------------------------------------------------------------------------
// Kernels
// ---------------------------------------------------------------------------

export type KernelId = 'pi' | 'dsh' | 'claude-code' | 'codex' | 'qoder'

export type KernelStatus = 'stopped' | 'starting' | 'ready' | 'degraded' | 'error'

export interface KernelCapabilities {
  /** Runs inside the platform process (Pi) vs. as a managed subprocess (dsh). */
  inProcess: boolean
  /** Kernel ships its own approval service and can block a tool call for a human. */
  nativeApproval: boolean
  /** Kernel can register platform tools at runtime. */
  toolRegistration: boolean
  /** How platform skills reach the kernel. */
  skillSync: 'files' | 'plugin' | 'none'
  /** How MCP servers reach the kernel. */
  mcpSync: 'files' | 'plugin' | 'none'
  /** `runtime` switches models mid-session, `session-recreate` needs a new session, `none` cannot. */
  modelSwitch: 'runtime' | 'session-recreate' | 'none'
  /** Token-level deltas are available (not just finished messages). */
  tokenStreaming: boolean
  /** Kernel persists sessions that can be listed/resumed by the platform. */
  sessionResume: boolean
  /**
   * Every tool call can be gated by the platform's permission engine before it
   * runs (Pi extension gate / dsh pre-execute). CLI kernels run their tools
   * inside their own process; the platform can only steer them via flags, so
   * this is false there and the UI must say so.
   */
  platformApprovalGate?: boolean
}

export interface KernelHealth {
  status: KernelStatus
  detail?: string
  /** Tools the kernel currently exposes to the model, when discoverable. */
  tools?: string[]
  /** Kernel-owned session ids seen so far. */
  sessions?: number
  since?: number
}

export interface KernelInfo {
  id: KernelId
  displayName: string
  version?: string
  capabilities: KernelCapabilities
  health: KernelHealth
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * JSON Schema (draft 2020-12 subset) used as the platform's single tool-parameter
 * description language. Both adapters translate from this: Pi into TypeBox,
 * dsh into its property-map DSL.
 */
export type JsonSchema = Record<string, unknown> & {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  format?: string
  description?: string
  title?: string
  default?: unknown
  examples?: unknown
  additionalProperties?: boolean | JsonSchema
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
}

export interface ToolAnnotations {
  /** No side effects; safe to auto-approve in every preset. */
  readOnlyHint?: boolean
  /** May destroy data or change production state. */
  destructiveHint?: boolean
  /** Repeated calls with the same args are safe / convergent. */
  idempotentHint?: boolean
  /** Touches systems outside the platform's own boundary. */
  openWorldHint?: boolean
}

export type RiskLevel = 'low' | 'medium' | 'high'

export interface PlatformToolSpec {
  name: string
  description: string
  parameters: JsonSchema
  annotations: ToolAnnotations
  /** Which origins may call the tool without an approval prompt. */
  origins?: ToolOrigin[]
}

export interface ToolCallResult {
  ok: boolean
  /** Model-facing text. */
  content: string
  /** Structured payload for the UI/audit trail. */
  detail?: unknown
  /** Screenshots and other images the model should see (base64, no data: prefix). */
  images?: { mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; base64: string }[]
  durationMs?: number
  error?: string
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillSpec {
  /** kebab-case, doubles as the on-disk directory name. */
  name: string
  description: string
  /** Markdown body (without frontmatter). */
  body: string
  enabled: boolean
  source: 'platform' | 'builtin' | 'imported'
  updatedAt: number
}

export interface SyncReport {
  target: string
  ok: boolean
  written?: string[]
  removed?: string[]
  message?: string
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export type McpTransport = 'stdio' | 'http'

export interface McpServerSpec {
  name: string
  transport: McpTransport
  enabled: boolean
  /** stdio */
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** http */
  url?: string
  headers?: Record<string, string>
  /** Seconds. */
  timeoutSec?: number
  description?: string
}

export interface McpHealth {
  name: string
  ok: boolean
  detail?: string
  checkedAt: number
}

// ---------------------------------------------------------------------------
// Models / providers
// ---------------------------------------------------------------------------

/** Wire protocol family; both kernels ultimately speak one of these. */
export type ProviderApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export interface ModelSpec {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
}

export interface ProviderSpec {
  id: string
  name: string
  api: ProviderApi
  baseUrl: string
  /** Name of an env var holding the key, or a literal `env:NAME` reference. Never a raw secret in the DB unless `apiKeyInline`. */
  apiKeyEnv?: string
  /** Direct key entry from the UI; stored encrypted-at-rest is out of scope for v1 — surfaced as a warning in the UI. */
  apiKey?: string
  models: ModelSpec[]
  enabled: boolean
}

export interface ModelSelection {
  provider: string
  model: string
}

// ---------------------------------------------------------------------------
// Permissions / approvals
// ---------------------------------------------------------------------------

/** Permission presets mirror dsh's three tiers so both kernels behave the same. */
export type PermissionPreset = 'read-only' | 'workspace-write' | 'full-access'

export type PermissionEffect = 'allow' | 'ask' | 'deny'

export type ToolOrigin = 'chat' | 'schedule' | 'alert' | 'api'

export interface PermissionRule {
  id: string
  /** Lower number = evaluated first. */
  priority: number
  enabled: boolean
  /** Glob-ish match (`*` wildcard) against the tool name. */
  tool?: string
  /** Match on risk derived from annotations. */
  risk?: RiskLevel
  /** Only apply to these origins. */
  origins?: ToolOrigin[]
  effect: PermissionEffect
  description?: string
}

export interface PermissionDecision {
  effect: PermissionEffect
  /** Rule id that decided, or 'preset' / 'unattended-default'. */
  by: string
  reason: string
}

export type ApprovalStatus = 'pending' | 'allowed-once' | 'allowed-session' | 'denied' | 'expired' | 'cancelled'

export interface ApprovalRecord {
  id: string
  sessionId: string
  kernel: KernelId
  toolName: string
  args: unknown
  risk: RiskLevel
  reason: string
  origin: ToolOrigin
  status: ApprovalStatus
  requestedAt: number
  expiresAt: number
  decidedAt?: number
  decidedBy?: string
  decisionReason?: string
}

// ---------------------------------------------------------------------------
// Sessions / messages
// ---------------------------------------------------------------------------

export interface CreateSessionOptions {
  title?: string
  cwd?: string
  model?: ModelSelection
  origin?: ToolOrigin
  /** Restrict the toolset (platform tools are always allowed unless listed here). */
  enabledPlatformTools?: string[]
  /** Runbook that spawned this session, if any. */
  runbookId?: string
  alertId?: string
}

export interface SessionInfo {
  id: string
  kernel: KernelId
  /** Kernel-side session id (Pi session file id / dsh session id). */
  kernelSessionId?: string
  title: string
  model?: ModelSelection
  cwd: string
  origin: ToolOrigin
  status: 'active' | 'archived'
  /** Set when this session was spawned by `sre_delegate` from another session. */
  parentSessionId?: string
  runbookId?: string
  alertId?: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatMessage {
  id: number
  sessionId: string
  role: MessageRole
  text: string
  /** Tool name for `tool` messages. */
  toolName?: string
  callId?: string
  ok?: boolean
  createdAt: number
}

// ---------------------------------------------------------------------------
// Normalized kernel events
// ---------------------------------------------------------------------------

export type KernelEvent =
  | { type: 'agent_status'; status: 'idle' | 'running' }
  | { type: 'turn_start'; turn?: number }
  | { type: 'turn_end'; turn?: number; reason?: string }
  | { type: 'assistant_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'assistant_message'; text: string }
  | { type: 'user_message'; text: string }
  | { type: 'tool_call'; callId: string; name: string; args: unknown }
  | {
      type: 'tool_result'
      callId: string
      name: string
      ok: boolean
      content: string
      durationMs?: number
      detail?: unknown
    }
  | { type: 'approval_requested'; approvalId: string; toolName: string; args: unknown; risk: RiskLevel }
  | { type: 'approval_resolved'; approvalId: string; decision: ApprovalStatus; by: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'error'; message: string }

export interface KernelEventEnvelope {
  kernel: KernelId
  sessionId: string
  seq: number
  ts: number
  event: KernelEvent
}

// ---------------------------------------------------------------------------
// Runbooks / schedules / runs
// ---------------------------------------------------------------------------

export type CheckKind = 'http' | 'shell' | 'tcp'

export interface RunbookCheck {
  id: string
  kind: CheckKind
  /** Human description used in the prompt and the report. */
  title: string
  /** http: URL. shell: command. tcp: host:port. */
  target: string
  /** http */
  method?: 'GET' | 'POST' | 'HEAD'
  expectStatus?: number
  /** shell */
  cwd?: string
  /** Seconds. */
  timeoutSec?: number
  /** Treat a non-zero exit / non-2xx as a failure (default true). */
  critical?: boolean
  /** Assertion on stdout: substring that must (not) appear. */
  expectContains?: string
  expectNotContains?: string
}

export interface RunbookSpec {
  id: string
  name: string
  description: string
  /** Prompt handed to the agent for the investigative part of the run. */
  prompt: string
  checks: RunbookCheck[]
  /** Tools the agent may use unattended. Everything else is denied. */
  allowedTools: string[]
  model?: ModelSelection
  /** Send the report to these webhook URLs. */
  notify?: string[]
  enabled: boolean
  updatedAt: number
}

export interface ScheduleSpec {
  id: string
  runbookId: string
  /** Standard 5-field cron, local time unless `timezone` is set. */
  cron: string
  timezone?: string
  enabled: boolean
  lastRunAt?: number
  nextRunAt?: number
}

export type RunStatus = 'running' | 'ok' | 'warn' | 'fail' | 'error'

export interface RunRecord {
  id: string
  runbookId: string
  runbookName?: string
  sessionId?: string
  status: RunStatus
  startedAt: number
  finishedAt?: number
  /** Rendered markdown report. */
  report?: string
  findings: CheckFinding[]
  error?: string
}

export interface CheckFinding {
  checkId: string
  title: string
  kind: CheckKind
  target: string
  status: 'ok' | 'fail' | 'error' | 'skipped'
  detail: string
  durationMs?: number
  /** Raw captured output, truncated. */
  output?: string
  critical?: boolean
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type AlertSeverity = 'critical' | 'warning' | 'info'

export interface AlertEvent {
  id: string
  source: string
  /** Stable identity for de-duplication across re-fires. */
  fingerprint: string
  name: string
  severity: AlertSeverity
  target?: string
  summary?: string
  labels: Record<string, string>
  status: 'firing' | 'resolved'
  sessionId?: string
  receivedAt: number
  raw?: unknown
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export type MemoryKind = 'fact' | 'episode' | 'preference'

export interface MemoryItem {
  id: string
  kind: MemoryKind
  /** What this memory is about: a service name, 'global', an incident id... */
  subject: string
  text: string
  tags: string[]
  /** 1-5; higher survives pruning longer. */
  importance: number
  source: 'agent' | 'operator' | 'system'
  sourceSessionId?: string
  createdAt: number
  lastAccessedAt: number
  accessCount: number
}

export interface MemorySearchHit extends MemoryItem {
  score: number
}

// ---------------------------------------------------------------------------
// Workflows (deterministic, LLM-free procedures)
// ---------------------------------------------------------------------------

export type WorkflowStepType = 'check' | 'command' | 'approval' | 'notify'

/** Evaluate a step only when this predicate matches an earlier step's result. */
export interface WorkflowWhen {
  stepId: string
  field: 'ok' | 'status' | 'exitCode'
  /** String comparison; numbers compare numerically when both parse. */
  equals: string | number
}

export type WorkflowStep =
  | ({ id: string; type: 'check'; when?: WorkflowWhen } & RunbookCheck)
  | {
      id: string
      type: 'command'
      title: string
      /** Operator-authored deterministic command; audited, host-executed. */
      command: string
      cwd?: string
      timeoutSec?: number
      stopOnFailure?: boolean
      when?: WorkflowWhen
    }
  | {
      id: string
      type: 'approval'
      title: string
      reason: string
      timeoutMs?: number
      stopOnDeny?: boolean
      when?: WorkflowWhen
    }
  | {
      id: string
      type: 'notify'
      title: string
      url: string
      payload?: Record<string, unknown>
      when?: WorkflowWhen
    }

export interface WorkflowSpec {
  id: string
  name: string
  description: string
  steps: WorkflowStep[]
  enabled: boolean
  updatedAt: number
  /** Alert triggers: matching alerts fire this workflow. */
  alertMatchers?: AlertMatcher[]
}

export type WorkflowStepStatus = 'ok' | 'fail' | 'error' | 'skipped' | 'approved' | 'denied' | 'notified' | 'notify-failed'

export interface WorkflowStepResult {
  stepId: string
  type: WorkflowStepType
  title: string
  status: WorkflowStepStatus
  detail: string
  output?: string
  durationMs?: number
}

export interface WorkflowRun {
  id: string
  workflowId: string
  workflowName?: string
  trigger: 'manual' | 'schedule' | 'alert' | 'agent'
  sessionId?: string
  status: 'running' | 'ok' | 'warn' | 'fail' | 'error'
  startedAt: number
  finishedAt?: number
  steps: WorkflowStepResult[]
  report?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Defined agents (monitor / alert-triage / self-heal / supervisor)
// ---------------------------------------------------------------------------

export interface AlertMatcher {
  severity?: AlertSeverity
  /** Substring or glob-ish match on the alert name. */
  namePattern?: string
  source?: string
}

export interface AgentSpec {
  id: string
  name: string
  /** What this agent is responsible for; becomes its role instructions. */
  role: string
  /** `worker` runs its procedure on trigger; `supervisor` also receives digests of recent worker runs. */
  kind: 'worker' | 'supervisor'
  /** Cron trigger (monitor agents). */
  cron?: string
  timezone?: string
  /** Alert trigger matchers (alert agents). */
  alertMatchers?: AlertMatcher[]
  model?: ModelSelection
  /** Tools this agent may use unattended; everything else is denied. */
  allowedTools: string[]
  /** Fixed procedure to run first on trigger. */
  workflowId?: string
  /** Runbook to execute on trigger (checks + agent analysis). */
  runbookId?: string
  escalation?: {
    notifyUrls?: string[]
  }
  maxRuntimeMs?: number
  enabled: boolean
  updatedAt: number
}

export interface AgentRun {
  id: string
  agentId: string
  agentName?: string
  trigger: 'manual' | 'schedule' | 'alert'
  alertId?: string
  sessionId?: string
  workflowRunId?: string
  status: 'running' | 'ok' | 'warn' | 'fail' | 'error'
  summary?: string
  startedAt: number
  finishedAt?: number
  error?: string
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export interface KbDoc {
  id: string
  title: string
  source: string
  tags: string[]
  mime: string
  hash: string
  chunkCount: number
  createdAt: number
}

export interface KbHit {
  docId: string
  title: string
  source: string
  tags: string[]
  chunkId: number
  ord: number
  text: string
  score: number
  /** How the hit was found. */
  via: 'bm25' | 'vector' | 'hybrid'
}

export interface KbSearchOptions {
  topK?: number
  tags?: string[]
  /** Restrict to one document. */
  docId?: string
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: number
  ts: number
  actor: string
  action: string
  subject: string
  detail?: unknown
}

// ---------------------------------------------------------------------------
// Wire protocol: REST payloads
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string
  detail?: string
}

export interface BootstrapPayload {
  version: string
  kernels: KernelInfo[]
  selectedKernel: KernelId
  defaultModel?: ModelSelection
  permissionPreset: PermissionPreset
  pendingApprovals: number
}

// ---------------------------------------------------------------------------
// Wire protocol: WebSocket
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'hello'; kernel: KernelId; serverTime: number }
  | { type: 'kernel_event'; envelope: KernelEventEnvelope }
  | { type: 'approval_requested'; approval: ApprovalRecord }
  | { type: 'approval_resolved'; approvalId: string; decision: ApprovalStatus; by: string }
  | { type: 'session_updated'; session: SessionInfo; reason: 'created' | 'message' | 'model' | 'status' }
  | { type: 'run_updated'; run: RunRecord }
  | { type: 'workflow_run_updated'; run: WorkflowRun }
  | { type: 'agent_run_updated'; run: AgentRun }
  | { type: 'alert_received'; alert: AlertEvent }
  | { type: 'kernel_status'; kernel: KernelId; health: KernelHealth }
  | { type: 'schedule_fired'; scheduleId: string; runId: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; scope: string; text: string }
  | { type: 'error'; message: string }

export type ClientMessage =
  | { type: 'ping' }
  | { type: 'prompt'; sessionId: string; text: string }
  | { type: 'abort'; sessionId: string }
  | {
      type: 'approval_decide'
      approvalId: string
      decision: 'allowed-once' | 'allowed-session' | 'denied'
      reason?: string
      /** For `ask_user` approvals: the operator's structured answer. */
      answer?: string
    }

// ---------------------------------------------------------------------------
// Translators: JSON Schema -> kernel DSLs
// ---------------------------------------------------------------------------

type DshProp = Record<string, unknown> & { required?: true }

/**
 * Translate a JSON Schema fragment into dsh's `ValueSchemaSpec`.
 *
 * Rules verified against dsh 0.2.0-rc.2 (`parameterSchemaSpecToJsonSchema`):
 * - scalars keep `enum` / `const` / annotations
 * - arrays carry `items`
 * - objects require an explicit boolean `additionalProperties`
 * - anything unrepresentable degrades to `{ type: 'json' }` (accepts any JSON)
 */
export function jsonSchemaToDshValue(schema: JsonSchema | undefined | boolean): DshProp {
  if (schema === undefined || schema === true || typeof schema === 'boolean') return { type: 'json' }
  const out: DshProp = {}

  const annotations = ['description', 'title', 'default', 'examples'] as const
  for (const key of annotations) {
    if (schema[key] !== undefined) out[key] = schema[key]
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length >= 2) {
    const branches = schema.oneOf.map((s) => jsonSchemaToDshValue(s))
    // dsh requires at least two branches; drop empty ones.
    if (branches.length >= 2) out.oneOf = branches
    return Object.keys(out).length ? out : { type: 'json' }
  }

  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type

  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      out.type = type
      if (Array.isArray(schema.enum)) out.enum = schema.enum
      return out
    }
    case 'array': {
      out.type = 'array'
      if (schema.items) out.items = jsonSchemaToDshValue(schema.items)
      return out
    }
    case 'object': {
      out.type = 'object'
      if (schema.properties) out.properties = jsonSchemaToDshParameters(schema.properties, schema.required)
      // dsh requires the flag explicitly and only supports a boolean; a schema
      // value (a "string map") is expressed as an open object.
      out.additionalProperties = schema.additionalProperties !== false
      return out
    }
    default:
      return Object.keys(out).length ? out : { type: 'json' }
  }
}

/** Translate a JSON Schema object into dsh's `ParameterSchemaSpec` (property map). */
export function jsonSchemaToDshParameters(
  schema: JsonSchema | undefined,
  requiredOverride?: string[],
): Record<string, DshProp> {
  if (!schema || schema.type !== 'object' || !schema.properties) return {}
  const required = new Set(requiredOverride ?? schema.required ?? [])
  const out: Record<string, DshProp> = {}
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const translated = jsonSchemaToDshValue(propSchema)
    if (required.has(key)) translated.required = true
    out[key] = translated
  }
  return out
}

/**
 * Approximate reverse mapping, used when the platform reads tool definitions back
 * out of a kernel (e.g. rendering dsh plugin tools in the UI).
 */
export function dshParametersToJsonSchema(params: Record<string, DshProp>): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [key, prop] of Object.entries(params)) {
    const { required: isRequired, ...rest } = prop
    properties[key] = rest as JsonSchema
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}
