import type {
  KernelEvent,
  KernelEventEnvelope,
  KernelHealth,
  KernelId,
  KernelCapabilities,
  McpServerSpec,
  ModelSelection,
  ProviderSpec,
  SessionInfo,
  SkillSpec,
  SyncReport,
  ToolOrigin,
} from '@sre/protocol'
import type { AppConfig } from '../config.ts'
import type { Logger } from '../log.ts'
import type { ApprovalService, PermissionEngine } from '../permission.ts'
import type { Store } from '../store.ts'
import type { ToolRegistry } from '../tools.ts'

/** Services an adapter may use. Adapters never build their own policy. */
export interface KernelHost {
  config: AppConfig
  log: Logger
  tools: ToolRegistry
  permissions: PermissionEngine
  approvals: ApprovalService
  store: Store
  /** Push a normalized event to the platform (WS hub + persistence). */
  emit(sessionId: string, event: KernelEvent): void
  /** Per-session model override chosen in the UI, if any. */
  modelOverride(sessionId: string): ModelSelection | undefined
  /** Record a model override (used by adapters whose wire has no model switch). */
  setModelOverride(sessionId: string, selection: ModelSelection): void
  /** Fallback model when a session has no explicit selection. */
  defaultModel(): ModelSelection | undefined
  /** Let the platform react to a kernel-side metadata change (e.g. title). */
  onSessionUpdated(session: SessionInfo, reason: 'created' | 'message' | 'model' | 'status'): void
}

/** Per-session context the adapter needs for policy decisions. */
export interface SessionRuntime {
  sessionId: string
  origin: ToolOrigin
  /** Set for unattended runbook/alert sessions. */
  allowedTools?: string[]
}

export interface KernelAdapter {
  readonly id: KernelId
  readonly displayName: string
  capabilities(): KernelCapabilities
  start(host: KernelHost): Promise<void>
  stop(): Promise<void>
  health(): Promise<KernelHealth>
  /** Create or restore the kernel-side session for a platform session. */
  openSession(info: SessionInfo, runtime: SessionRuntime): Promise<void>
  closeSession(sessionId: string): Promise<void>
  prompt(sessionId: string, text: string): Promise<void>
  abort(sessionId: string): Promise<void>
  setModel(sessionId: string, selection: ModelSelection): Promise<void>
  syncSkills(skills: SkillSpec[]): Promise<SyncReport>
  syncMcpServers(servers: McpServerSpec[]): Promise<SyncReport>
  syncProviders(providers: ProviderSpec[]): Promise<SyncReport>
  /** Kernel-side sessions found on disk, for import/recovery. */
  listKernelSessions?(): Promise<{ id: string; title?: string; updatedAt?: number }[]>
}

export function envelope(kernel: KernelId, sessionId: string, event: KernelEvent, seq: number): KernelEventEnvelope {
  return { kernel, sessionId, seq, ts: Date.now(), event }
}

/** Truncate long tool output before it hits the transcript/UI. */
export function clampText(text: string, limit = 8000): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`
}
