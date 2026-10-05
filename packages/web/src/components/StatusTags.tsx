/** Tiny presentational tags for protocol enums, so every page renders them the same way. */
import { Tag, Tooltip } from 'antd'
import type {
  AlertSeverity,
  ApprovalStatus,
  CheckKind,
  KernelStatus,
  PermissionEffect,
  RiskLevel,
  RunStatus,
  ToolOrigin,
} from '@sre/protocol'
import {
  CHECK_KIND_LABEL,
  approvalStatusMeta,
  effectMeta,
  findingStatusMeta,
  kernelStatusMeta,
  originLabel,
  riskMeta,
  runStatusMeta,
  severityMeta,
} from '../utils'

export function RiskTag({ risk }: { risk: RiskLevel | undefined }): JSX.Element {
  const meta = riskMeta(risk)
  return <Tag color={meta.color}>{meta.label}</Tag>
}

export function SeverityTag({ severity }: { severity: AlertSeverity | undefined }): JSX.Element {
  const meta = severityMeta(severity)
  return <Tag color={meta.color}>{meta.label}</Tag>
}

export function RunStatusTag({ status }: { status: RunStatus | undefined }): JSX.Element {
  const meta = runStatusMeta(status)
  return <Tag color={meta.color}>{meta.label}</Tag>
}

export function FindingStatusTag({ status }: { status: 'ok' | 'fail' | 'error' | 'skipped' }): JSX.Element {
  const meta = findingStatusMeta(status)
  return <Tag color={meta.color}>{meta.label}</Tag>
}

export function KernelStatusTag({ status, detail }: { status: KernelStatus | undefined; detail?: string }): JSX.Element {
  const meta = kernelStatusMeta(status)
  const tag = <Tag color={meta.color}>{meta.label}</Tag>
  return detail ? <Tooltip title={detail}>{tag}</Tooltip> : tag
}

export function OriginTag({ origin }: { origin: ToolOrigin | undefined }): JSX.Element {
  return <Tag>{originLabel(origin)}</Tag>
}

export function EffectTag({ effect }: { effect: PermissionEffect | undefined }): JSX.Element {
  const meta = effectMeta(effect)
  return <Tag color={meta.color}>{meta.label}</Tag>
}

export function ApprovalStatusTag({ status }: { status: ApprovalStatus | undefined }): JSX.Element {
  const meta = approvalStatusMeta(status)
  return <Tag color={meta.color}>{meta.label}</Tag>
}

export function CheckKindTag({ kind }: { kind: CheckKind }): JSX.Element {
  return <Tag color="geekblue">{CHECK_KIND_LABEL[kind] ?? kind}</Tag>
}

export function BoolTag({ value, yes = '支持', no = '不支持' }: { value: boolean; yes?: string; no?: string }): JSX.Element {
  return value ? <Tag color="green">{yes}</Tag> : <Tag color="default">{no}</Tag>
}
