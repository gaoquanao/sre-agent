/**
 * Local UI types.
 *
 * The platform HTTP contract documents a handful of payload shapes that
 * `@sre/protocol` does not export (log records, composite payloads and a few
 * create/update request bodies). They are declared here instead of editing the
 * protocol package, which is owned by another workstream.
 */
import type {
  AgentSpec,
  AlertEvent,
  AlertSeverity,
  McpServerSpec,
  MemoryKind,
  PermissionPreset,
  PermissionRule,
  SkillSpec,
  WorkflowStep,
} from '@sre/protocol'

export type ThemeMode = 'light' | 'dark'

/** Item of `GET /api/logs`, and the payload of the WS `log` message (plus a local `ts`). */
export interface PlatformLog {
  ts: number
  level: 'info' | 'warn' | 'error'
  scope: string
  text: string
}

/** Response of `GET /api/permissions`. */
export interface PermissionsPayload {
  preset: PermissionPreset
  rules: PermissionRule[]
}

/** Request body of `POST /api/kb/docs`. */
export interface KbDocInput {
  title?: string
  source: string
  tags?: string[]
  mime?: string
  text: string
}

/** Request body of `POST /api/alerts`. */
export interface AlertInput {
  name: string
  severity?: AlertSeverity
  target?: string
  summary?: string
  source?: string
  labels?: Record<string, string>
  fingerprint?: string
}

/** Response of `POST /api/alerts`. */
export interface AlertCreateResult {
  alert: AlertEvent
  sessionId?: string
}

/** Response of `POST /api/alerts/:id/triage`. */
export interface AlertTriageResult {
  sessionId: string
}

/** Request body of `PUT /api/skills/:name`. */
export type SkillPayload = Pick<SkillSpec, 'description' | 'body' | 'enabled'>

/** Request body of `PUT /api/mcp/:name` (same shape as a stored MCP server, keyed by name). */
export type McpServerPayload = Omit<McpServerSpec, 'name'>

/** Connection state of the platform WebSocket. */
export type WsState = 'connecting' | 'open' | 'closed'

/** Stable key for a (provider, model) pair used by select controls. */
export interface ModelOption {
  value: string
  label: string
  provider: string
  model: string
}

export const MODEL_VALUE_SEPARATOR = '::'

// --- CLI tool management (`GET /api/clis`, `POST /api/clis/:name/install`) ---
// Not exported by @sre/protocol yet; declared locally per the API contract.

/** One row of `GET /api/clis`. */
export interface CliToolInfo {
  /** Kernel id the CLI belongs to: 'pi' | 'dsh' | 'claude-code' | 'codex' | 'qoder'. */
  name: string
  /** Command name, e.g. 'claude'. */
  bin: string
  /** npm package name (qoder may be undefined). */
  pkg?: string
  installed: boolean
  version?: string
  source?: 'path' | 'platform' | 'missing'
  note?: string
}

/** Response of `POST /api/clis/:name/install` (installs may take 1-3 minutes). */
export interface CliInstallResult {
  ok: boolean
  log?: string
}

// --- hosted credentials (`/api/credentials`) --------------------------------
// Not exported by @sre/protocol yet; declared locally per the API contract.
// The server only ever returns masked summaries — plaintext never leaves it.

export type CredentialKind = 'oauth' | 'api-key' | 'env-json'

/** One row of `GET /api/credentials`. */
export interface CredentialInfo {
  ref: string
  kind: CredentialKind
  /** Masked summary, e.g. 'sk-…abc4'. Never the plaintext secret. */
  masked: string
  hasRefresh?: boolean
  updatedAt: number
}

/** Request body of `PUT /api/credentials/:ref`, discriminated by `kind`. */
export type CredentialPayload =
  | { kind: 'oauth'; token: string; refreshToken?: string; expiresAt?: number; account?: string }
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'env-json'; env: Record<string, string> }

/** Kernels whose credentials can be imported from the local machine. */
export type ImportableKernelId = 'claude-code' | 'codex' | 'qoder'

/** Response of `POST /api/credentials/import`. */
export interface CredentialImportResult {
  imported: string[]
  missing: string[]
}

// --- memory (`/api/memory`) --------------------------------------------------

/** Request body of `POST /api/memory`. */
export interface MemoryInput {
  kind: MemoryKind
  subject: string
  text: string
  tags?: string[]
  /** 1-5; higher survives pruning longer. */
  importance?: number
}

/** Request body of `POST /api/memory/search`. */
export interface MemorySearchInput {
  query: string
  kind?: MemoryKind
  topK?: number
}

// --- workflows (`/api/workflows`) --------------------------------------------

/**
 * Shape of `GET /api/workflows` items. `@sre/protocol` does not export
 * `WorkflowSpec` yet (only the step/run types), so it is declared here per the
 * HTTP contract instead of editing the protocol package.
 */
export interface WorkflowSpec {
  id: string
  name: string
  description: string
  steps: WorkflowStep[]
  enabled: boolean
  updatedAt?: number
}

/** Request body of `PUT /api/workflows/:id` (the id travels in the URL). */
export interface WorkflowPayload {
  name: string
  description: string
  steps: WorkflowStep[]
  enabled: boolean
}

// --- agents (`/api/agents`) --------------------------------------------------

/** Request body of `PUT /api/agents/:id` (same shape as a stored agent, keyed by id). */
export type AgentPayload = Omit<AgentSpec, 'id' | 'updatedAt'>
