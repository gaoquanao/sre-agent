/**
 * Presentation helpers: label / colour maps for protocol enums, formatters and
 * small pure utilities shared by the pages.
 */
import type {
  AlertSeverity,
  ApprovalStatus,
  CheckKind,
  KernelStatus,
  ModelSelection,
  PermissionEffect,
  PermissionPreset,
  ProviderSpec,
  RiskLevel,
  RunStatus,
  ToolOrigin,
} from '@sre/protocol'
import { MODEL_VALUE_SEPARATOR, type ModelOption } from './types'

export interface TagMeta {
  label: string
  color: string
}

// --- time ------------------------------------------------------------------

export function formatTime(ts: number | undefined | null): string {
  if (!ts) return '-'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '-'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`
}

export function formatTimeShort(ts: number | undefined | null): string {
  if (!ts) return '-'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '-'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatRelative(ts: number | undefined | null): string {
  if (!ts) return '-'
  const diff = Date.now() - ts
  if (diff < 0) return formatTime(ts)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return formatTime(ts)
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return '-'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m} min ${s} s`
}

// --- json / text -----------------------------------------------------------

export function prettyJson(value: unknown): string {
  if (value === undefined) return '-'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function oneLineJson(value: unknown, max = 120): string {
  if (value === undefined || value === null) return '-'
  let text: string
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function truncate(text: string | undefined, max: number): string {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// --- enum labels -----------------------------------------------------------

export const RISK_META: Record<RiskLevel, TagMeta> = {
  low: { label: '低风险', color: 'green' },
  medium: { label: '中风险', color: 'orange' },
  high: { label: '高风险', color: 'red' },
}

export function riskMeta(risk: RiskLevel | undefined): TagMeta {
  return risk ? (RISK_META[risk] ?? { label: risk, color: 'default' }) : { label: '未知', color: 'default' }
}

export const APPROVAL_STATUS_META: Record<ApprovalStatus, TagMeta> = {
  pending: { label: '待审批', color: 'gold' },
  'allowed-once': { label: '允许一次', color: 'blue' },
  'allowed-session': { label: '本次会话允许', color: 'cyan' },
  denied: { label: '已拒绝', color: 'red' },
  expired: { label: '已过期', color: 'default' },
  cancelled: { label: '已取消', color: 'default' },
}

export function approvalStatusMeta(status: ApprovalStatus | undefined): TagMeta {
  return status ? (APPROVAL_STATUS_META[status] ?? { label: status, color: 'default' }) : { label: '-', color: 'default' }
}

export const ORIGIN_LABEL: Record<ToolOrigin, string> = {
  chat: '对话',
  schedule: '定时任务',
  alert: '告警',
  api: 'API',
}

export function originLabel(origin: ToolOrigin | undefined): string {
  return origin ? (ORIGIN_LABEL[origin] ?? origin) : '-'
}

export const SEVERITY_META: Record<AlertSeverity, TagMeta> = {
  critical: { label: '严重', color: 'red' },
  warning: { label: '警告', color: 'orange' },
  info: { label: '提示', color: 'blue' },
}

export function severityMeta(sev: AlertSeverity | undefined): TagMeta {
  return sev ? (SEVERITY_META[sev] ?? { label: sev, color: 'default' }) : { label: '未知', color: 'default' }
}

export const RUN_STATUS_META: Record<RunStatus, TagMeta> = {
  running: { label: '执行中', color: 'processing' },
  ok: { label: '正常', color: 'green' },
  warn: { label: '告警', color: 'orange' },
  fail: { label: '失败', color: 'red' },
  error: { label: '错误', color: 'magenta' },
}

export function runStatusMeta(status: RunStatus | undefined): TagMeta {
  return status ? (RUN_STATUS_META[status] ?? { label: status, color: 'default' }) : { label: '-', color: 'default' }
}

export function findingStatusMeta(status: 'ok' | 'fail' | 'error' | 'skipped'): TagMeta {
  switch (status) {
    case 'ok':
      return { label: '通过', color: 'green' }
    case 'fail':
      return { label: '失败', color: 'red' }
    case 'error':
      return { label: '错误', color: 'magenta' }
    case 'skipped':
      return { label: '跳过', color: 'default' }
  }
}

export const CHECK_KIND_LABEL: Record<CheckKind, string> = { http: 'HTTP', shell: 'Shell', tcp: 'TCP' }

export const KERNEL_STATUS_META: Record<KernelStatus, TagMeta> = {
  stopped: { label: '已停止', color: 'default' },
  starting: { label: '启动中', color: 'processing' },
  ready: { label: '就绪', color: 'green' },
  degraded: { label: '降级', color: 'orange' },
  error: { label: '错误', color: 'red' },
}

export function kernelStatusMeta(status: KernelStatus | undefined): TagMeta {
  return status ? (KERNEL_STATUS_META[status] ?? { label: status, color: 'default' }) : { label: '未知', color: 'default' }
}

export const EFFECT_META: Record<PermissionEffect, TagMeta> = {
  allow: { label: '放行', color: 'green' },
  ask: { label: '需审批', color: 'gold' },
  deny: { label: '拒绝', color: 'red' },
}

export function effectMeta(effect: PermissionEffect | undefined): TagMeta {
  return effect ? (EFFECT_META[effect] ?? { label: effect, color: 'default' }) : { label: '-', color: 'default' }
}

export interface PresetMeta extends TagMeta {
  description: string
}

export const PERMISSION_PRESET_META: Record<PermissionPreset, PresetMeta> = {
  'read-only': {
    label: '只读 (read-only)',
    color: 'blue',
    description: '只读访问：任何写文件、改状态或调用外部系统的操作都会转为人工审批。',
  },
  'workspace-write': {
    label: '工作区可写 (workspace-write)',
    color: 'cyan',
    description: '工作区内读写自动放行；越出工作区、破坏性操作或外部系统调用需要审批。',
  },
  'full-access': {
    label: '完全访问 (full-access)',
    color: 'red',
    description: '除显式 deny 规则外全部放行，无人工审批兜底，仅用于受控环境。',
  },
}

export function presetMeta(preset: PermissionPreset | undefined): PresetMeta {
  return preset
    ? (PERMISSION_PRESET_META[preset] ?? { label: preset, color: 'default', description: '' })
    : { label: '未知', color: 'default', description: '' }
}

export const LOG_LEVEL_COLOR: Record<string, string> = {
  info: 'var(--sre-log-info)',
  warn: 'var(--sre-log-warn)',
  error: 'var(--sre-log-error)',
}

// --- models ----------------------------------------------------------------

export function modelValue(provider: string, model: string): string {
  return `${provider}${MODEL_VALUE_SEPARATOR}${model}`
}

export function splitModelValue(value: string): ModelSelection | null {
  const idx = value.indexOf(MODEL_VALUE_SEPARATOR)
  if (idx <= 0) return null
  const provider = value.slice(0, idx)
  const model = value.slice(idx + MODEL_VALUE_SEPARATOR.length)
  if (!provider || !model) return null
  return { provider, model }
}

export function modelOptions(providers: ProviderSpec[]): ModelOption[] {
  const out: ModelOption[] = []
  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const model of provider.models) {
      out.push({
        value: modelValue(provider.id, model.id),
        label: `${provider.name} / ${model.name ?? model.id}`,
        provider: provider.id,
        model: model.id,
      })
    }
  }
  return out
}

const LOCAL_DEFAULT_MODEL_KEY = 'sre-agent.defaultModel'

/**
 * Browser-local preference for the model used when creating a new session.
 * The platform-level default lives on the server (`bootstrap.defaultModel`).
 */
export function readLocalDefaultModel(): ModelSelection | null {
  const raw = window.localStorage.getItem(LOCAL_DEFAULT_MODEL_KEY)
  if (!raw) return null
  return splitModelValue(raw)
}

export function writeLocalDefaultModel(selection: ModelSelection | null): void {
  if (!selection) {
    window.localStorage.removeItem(LOCAL_DEFAULT_MODEL_KEY)
    return
  }
  window.localStorage.setItem(LOCAL_DEFAULT_MODEL_KEY, modelValue(selection.provider, selection.model))
}

// --- validation ------------------------------------------------------------

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isKebabCase(name: string): boolean {
  return KEBAB_RE.test(name)
}

export function toKebabCase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`
}

// --- ask_user (structured questions over the approval channel) ---------------

/** Shape of the `args` carried by `toolName === 'ask_user'` approvals. */
export interface AskUserArgs {
  question: string
  choices?: string[]
  /** When false the operator must pick one of `choices` (no free-text answer). */
  allowCustom?: boolean
}

/**
 * Safely parses the `args` of an approval as an ask_user question. Returns null
 * for anything that does not carry a non-empty string `question`, so regular
 * tool approvals never take the ask_user path.
 */
export function readAskUserArgs(args: unknown): AskUserArgs | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const record = args as Record<string, unknown>
  if (typeof record.question !== 'string' || record.question.trim() === '') return null
  const choices = Array.isArray(record.choices)
    ? record.choices.filter((choice): choice is string => typeof choice === 'string' && choice.trim() !== '')
    : []
  return {
    question: record.question,
    ...(choices.length > 0 ? { choices } : {}),
    ...(typeof record.allowCustom === 'boolean' ? { allowCustom: record.allowCustom } : {}),
  }
}
