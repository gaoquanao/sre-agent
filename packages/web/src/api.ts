/**
 * REST client for the platform server.
 *
 * Every call goes through `request()`, which normalises failures into `ApiFailure`
 * and reports them through the injected error sink (wired to antd `message` in
 * `App.tsx`). Pages may set `silent: true` for calls whose failure is expected
 * (for example probing an endpoint before falling back to WebSocket).
 */
import type {
  AgentRun,
  AgentSpec,
  AlertEvent,
  ApprovalRecord,
  AuditEntry,
  BootstrapPayload,
  ChatMessage,
  CreateSessionOptions,
  KbDoc,
  KbHit,
  KernelId,
  KernelInfo,
  McpServerSpec,
  MemoryItem,
  MemorySearchHit,
  ModelSelection,
  PermissionPreset,
  PermissionRule,
  ProviderSpec,
  RunbookSpec,
  RunRecord,
  ScheduleSpec,
  SessionInfo,
  SkillSpec,
  SyncReport,
  WorkflowRun,
} from '@sre/protocol'
import type {
  AlertCreateResult,
  AlertInput,
  AlertTriageResult,
  AgentPayload,
  CliInstallResult,
  CliToolInfo,
  CredentialImportResult,
  CredentialInfo,
  CredentialPayload,
  ImportableKernelId,
  KbDocInput,
  McpServerPayload,
  MemoryInput,
  MemorySearchInput,
  PermissionsPayload,
  PlatformLog,
  SkillPayload,
  WorkflowPayload,
  WorkflowSpec,
} from './types'

export class ApiFailure extends Error {
  readonly status: number
  readonly code: string
  readonly detail: string | undefined

  constructor(status: number, code: string, detail?: string) {
    super(detail ? `${code}：${detail}` : code)
    this.name = 'ApiFailure'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/** Shown when the browser cannot reach the platform server at all. */
export const OFFLINE_MESSAGE = '未连接到平台服务（请确认后端 127.0.0.1:8787 已启动）'

type ErrorSink = (text: string) => void

let errorSink: ErrorSink = () => {
  /* replaced by the antd message bridge in App.tsx */
}

export function setApiErrorSink(sink: ErrorSink): void {
  errorSink = sink
}

export function apiErrorMessage(err: unknown, fallback = '请求失败'): string {
  if (err instanceof ApiFailure) return err.detail ? `${err.code}：${err.detail}` : err.code
  if (err instanceof Error && err.message) return err.message
  return fallback
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  /** Do not surface the failure through the global message sink. */
  silent?: boolean
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, silent = false } = options
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    if (!silent) errorSink(OFFLINE_MESSAGE)
    throw new ApiFailure(0, OFFLINE_MESSAGE)
  }

  if (!res.ok) {
    let code = `HTTP ${res.status}`
    let detail: string | undefined
    try {
      const data = (await res.json()) as { error?: unknown; detail?: unknown }
      if (typeof data.error === 'string' && data.error) code = data.error
      if (typeof data.detail === 'string' && data.detail) detail = data.detail
    } catch {
      /* error body was not JSON — keep the HTTP status */
    }
    const failure = new ApiFailure(res.status, code, detail)
    if (!silent) errorSink(apiErrorMessage(failure))
    throw failure
  }

  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    const failure = new ApiFailure(res.status, '响应不是合法 JSON')
    if (!silent) errorSink(apiErrorMessage(failure))
    throw failure
  }
}

const seg = (value: string): string => encodeURIComponent(value)

export const api = {
  offlineMessage: OFFLINE_MESSAGE,

  // --- platform ------------------------------------------------------------
  bootstrap: () => request<BootstrapPayload>('/api/bootstrap', { silent: true }),
  logs: (limit = 100) => request<PlatformLog[]>(`/api/logs?limit=${limit}`),

  // --- kernels -------------------------------------------------------------
  kernels: () => request<KernelInfo[]>('/api/kernels'),
  startKernel: (id: KernelId) => request<unknown>(`/api/kernels/${seg(id)}/start`, { method: 'POST' }),
  stopKernel: (id: KernelId) => request<unknown>(`/api/kernels/${seg(id)}/stop`, { method: 'POST' }),
  selectKernel: (kernel: KernelId) => request<unknown>('/api/kernels/select', { method: 'POST', body: { kernel } }),
  resyncKernels: () => request<SyncReport[]>('/api/kernels/resync', { method: 'POST' }),

  // --- CLI tool management ---------------------------------------------------
  clis: () => request<CliToolInfo[]>('/api/clis'),
  /** Installation may take 1-3 minutes; callers must show a loading state. */
  installCli: (name: string) => request<CliInstallResult>(`/api/clis/${seg(name)}/install`, { method: 'POST', body: {} }),

  // --- hosted credentials ------------------------------------------------------
  credentials: () => request<CredentialInfo[]>('/api/credentials'),
  putCredential: (ref: string, payload: CredentialPayload) =>
    request<CredentialInfo>(`/api/credentials/${seg(ref)}`, { method: 'PUT', body: payload }),
  deleteCredential: (ref: string) => request<void>(`/api/credentials/${seg(ref)}`, { method: 'DELETE' }),
  importCredentials: (kernel: ImportableKernelId) =>
    request<CredentialImportResult>('/api/credentials/import', { method: 'POST', body: { kernel } }),

  // --- sessions ------------------------------------------------------------
  sessions: () => request<SessionInfo[]>('/api/sessions'),
  createSession: (options: CreateSessionOptions) => request<SessionInfo>('/api/sessions', { method: 'POST', body: options }),
  session: (id: string) => request<SessionInfo>(`/api/sessions/${seg(id)}`),
  messages: (id: string) => request<ChatMessage[]>(`/api/sessions/${seg(id)}/messages`),
  deleteSession: (id: string) => request<void>(`/api/sessions/${seg(id)}`, { method: 'DELETE' }),
  prompt: (id: string, text: string, options: { silent?: boolean } = {}) =>
    request<unknown>(`/api/sessions/${seg(id)}/prompt`, { method: 'POST', body: { text }, silent: options.silent }),
  abort: (id: string) => request<unknown>(`/api/sessions/${seg(id)}/abort`, { method: 'POST' }),
  setSessionModel: (id: string, model: ModelSelection) =>
    request<unknown>(`/api/sessions/${seg(id)}/model`, { method: 'POST', body: model }),

  // --- approvals / audit ---------------------------------------------------
  approvals: (status: 'pending' | 'all' = 'pending') => request<ApprovalRecord[]>(`/api/approvals?status=${status}`),
  decide: (
    id: string,
    decision: 'allowed-once' | 'allowed-session' | 'denied',
    options?: { reason?: string; answer?: string },
  ) =>
    request<ApprovalRecord>(`/api/approvals/${seg(id)}/decide`, {
      method: 'POST',
      body: {
        decision,
        ...(options?.reason ? { reason: options.reason } : {}),
        // For `ask_user` approvals the operator's structured answer travels here.
        ...(options?.answer !== undefined && options.answer !== '' ? { answer: options.answer } : {}),
      },
    }),
  audit: (limit = 200) => request<AuditEntry[]>(`/api/audit?limit=${limit}`),

  // --- skills / mcp --------------------------------------------------------
  skills: () => request<SkillSpec[]>('/api/skills'),
  putSkill: (name: string, payload: SkillPayload) =>
    request<SkillSpec>(`/api/skills/${seg(name)}`, { method: 'PUT', body: payload }),
  deleteSkill: (name: string) => request<void>(`/api/skills/${seg(name)}`, { method: 'DELETE' }),

  mcpServers: () => request<McpServerSpec[]>('/api/mcp'),
  putMcp: (name: string, payload: McpServerPayload) =>
    request<McpServerSpec>(`/api/mcp/${seg(name)}`, { method: 'PUT', body: payload }),
  deleteMcp: (name: string) => request<void>(`/api/mcp/${seg(name)}`, { method: 'DELETE' }),

  // --- providers -----------------------------------------------------------
  providers: () => request<ProviderSpec[]>('/api/providers'),
  putProvider: (id: string, payload: ProviderSpec) =>
    request<ProviderSpec>(`/api/providers/${seg(id)}`, { method: 'PUT', body: payload }),
  deleteProvider: (id: string) => request<void>(`/api/providers/${seg(id)}`, { method: 'DELETE' }),

  // --- permissions ---------------------------------------------------------
  permissions: () => request<PermissionsPayload>('/api/permissions'),
  setPermissionPreset: (preset: PermissionPreset) =>
    request<PermissionsPayload>('/api/permissions/preset', { method: 'PUT', body: { preset } }),
  putPermissionRule: (id: string, rule: PermissionRule) =>
    request<PermissionRule>(`/api/permissions/rules/${seg(id)}`, { method: 'PUT', body: rule }),
  deletePermissionRule: (id: string) =>
    request<void>(`/api/permissions/rules/${seg(id)}`, { method: 'DELETE' }),

  // --- knowledge base ------------------------------------------------------
  kbDocs: () => request<KbDoc[]>('/api/kb/docs'),
  addKbDoc: (input: KbDocInput) => request<KbDoc>('/api/kb/docs', { method: 'POST', body: input }),
  deleteKbDoc: (id: string) => request<void>(`/api/kb/docs/${seg(id)}`, { method: 'DELETE' }),
  kbSearch: (body: { query: string; topK?: number; tags?: string[] }) =>
    request<KbHit[]>('/api/kb/search', { method: 'POST', body }),

  // --- runbooks / schedules / runs ----------------------------------------
  runbooks: () => request<RunbookSpec[]>('/api/runbooks'),
  putRunbook: (id: string, spec: RunbookSpec) =>
    request<RunbookSpec>(`/api/runbooks/${seg(id)}`, { method: 'PUT', body: spec }),
  deleteRunbook: (id: string) => request<void>(`/api/runbooks/${seg(id)}`, { method: 'DELETE' }),
  runRunbook: (id: string) => request<RunRecord>(`/api/runbooks/${seg(id)}/run`, { method: 'POST' }),

  schedules: () => request<ScheduleSpec[]>('/api/schedules'),
  putSchedule: (id: string, spec: ScheduleSpec) =>
    request<ScheduleSpec>(`/api/schedules/${seg(id)}`, { method: 'PUT', body: spec }),
  deleteSchedule: (id: string) => request<void>(`/api/schedules/${seg(id)}`, { method: 'DELETE' }),

  runs: (limit = 50, runbookId?: string) =>
    request<RunRecord[]>(`/api/runs?limit=${limit}${runbookId ? `&runbookId=${seg(runbookId)}` : ''}`),

  // --- alerts --------------------------------------------------------------
  alerts: (limit = 100) => request<AlertEvent[]>(`/api/alerts?limit=${limit}`),
  createAlert: (input: AlertInput) => request<AlertCreateResult>('/api/alerts', { method: 'POST', body: input }),
  triageAlert: (id: string) => request<AlertTriageResult>(`/api/alerts/${seg(id)}/triage`, { method: 'POST' }),

  // --- memory --------------------------------------------------------------
  memory: (limit = 200) => request<MemoryItem[]>(`/api/memory?limit=${limit}`),
  searchMemory: (body: MemorySearchInput) => request<MemorySearchHit[]>('/api/memory/search', { method: 'POST', body }),
  addMemory: (input: MemoryInput) => request<MemoryItem>('/api/memory', { method: 'POST', body: input }),
  deleteMemory: (id: string) => request<void>(`/api/memory/${seg(id)}`, { method: 'DELETE' }),

  // --- workflows -----------------------------------------------------------
  workflows: () => request<WorkflowSpec[]>('/api/workflows'),
  putWorkflow: (id: string, payload: WorkflowPayload) =>
    request<WorkflowSpec>(`/api/workflows/${seg(id)}`, { method: 'PUT', body: payload }),
  deleteWorkflow: (id: string) => request<void>(`/api/workflows/${seg(id)}`, { method: 'DELETE' }),
  /** Runs synchronously; approval steps block until the operator decides. */
  runWorkflow: (id: string) => request<WorkflowRun>(`/api/workflows/${seg(id)}/run`, { method: 'POST' }),
  workflowRuns: (limit = 50, workflowId?: string) =>
    request<WorkflowRun[]>(`/api/workflow-runs?limit=${limit}${workflowId ? `&workflowId=${seg(workflowId)}` : ''}`),

  // --- agents --------------------------------------------------------------
  agents: () => request<AgentSpec[]>('/api/agents'),
  putAgent: (id: string, payload: AgentPayload) =>
    request<AgentSpec>(`/api/agents/${seg(id)}`, { method: 'PUT', body: payload }),
  deleteAgent: (id: string) => request<void>(`/api/agents/${seg(id)}`, { method: 'DELETE' }),
  /** Manual trigger; returns the run record (may still be running). */
  runAgent: (id: string) => request<AgentRun>(`/api/agents/${seg(id)}/run`, { method: 'POST' }),
  agentRuns: (limit = 50, agentId?: string) =>
    request<AgentRun[]>(`/api/agent-runs?limit=${limit}${agentId ? `&agentId=${seg(agentId)}` : ''}`),
}
