/**
 * Inline approval prompt shown in the transcript when the kernel blocks a tool
 * call. Decisions can also be made on the 审批 page; both paths hit the same API.
 *
 * `ask_user` approvals (the agent asking the operator a structured question)
 * render the question with clickable choices instead of the usual allow/deny
 * buttons, and echo the submitted answer once decided.
 */
import { useState } from 'react'
import { Alert, Button, Input, Space, Typography } from 'antd'
import { originLabel, readAskUserArgs } from '../utils'
import JsonBlock from './JsonBlock'
import AskUserPanel from './AskUserPanel'
import { ApprovalStatusTag, RiskTag } from './StatusTags'
import type { ApprovalItem } from '../chatModel'

/** Decision payload: a reason for rejections, or the operator's answer for `ask_user`. */
export interface DecideOptions {
  reason?: string
  answer?: string
}

interface Props {
  item: ApprovalItem
  onDecide: (
    decision: 'allowed-once' | 'allowed-session' | 'denied',
    options?: DecideOptions,
  ) => Promise<void>
}

export default function ApprovalInlineCard({ item, onDecide }: Props): JSX.Element {
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [busy, setBusy] = useState(false)
  // Local echo of this operator's ask_user decision; the WS `approval_resolved`
  // only carries the status, not the answer that was given.
  const [submittedAnswer, setSubmittedAnswer] = useState<string | null>(null)
  const [rejectedHere, setRejectedHere] = useState(false)
  const approval = item.approval
  const pending = approval.status === 'pending'
  const askUser = approval.toolName === 'ask_user' ? readAskUserArgs(approval.args) : null

  const decide = async (decision: 'allowed-once' | 'allowed-session' | 'denied', options?: DecideOptions): Promise<void> => {
    setBusy(true)
    try {
      await onDecide(decision, options)
      setRejecting(false)
      setReason('')
    } finally {
      setBusy(false)
    }
  }

  const header = (
    <Space size={6} wrap>
      <span>{askUser ? 'Agent 提问' : '工具审批'}：</span>
      <span className="mono">{approval.toolName}</span>
      {!askUser ? <RiskTag risk={approval.risk} /> : null}
      <Typography.Text type="secondary">来源 {originLabel(approval.origin)}</Typography.Text>
      {pending ? null : <ApprovalStatusTag status={approval.status} />}
    </Space>
  )

  // --- ask_user path ---------------------------------------------------------
  if (askUser) {
    let description: JSX.Element
    if (pending) {
      description = (
        <AskUserPanel
          args={askUser}
          pending
          busy={busy}
          onAnswer={(answer) => {
            setSubmittedAnswer(answer)
            return decide('allowed-once', { answer })
          }}
          onReject={() => {
            setRejectedHere(true)
            return decide('denied')
          }}
        />
      )
    } else if (submittedAnswer) {
      description = <AskUserPanel args={askUser} pending={false} answer={submittedAnswer} onAnswer={() => undefined} onReject={() => undefined} />
    } else if (rejectedHere || approval.status === 'denied') {
      description = <AskUserPanel args={askUser} pending={false} rejected onAnswer={() => undefined} onReject={() => undefined} />
    } else {
      description = (
        <Typography.Text type="secondary">
          {item.decision ? `${item.decision.by} 已处理该提问` : '已处理'}
          {approval.decisionReason ? `：${approval.decisionReason}` : ''}
        </Typography.Text>
      )
    }
    return (
      <Alert
        type={pending ? 'warning' : approval.status === 'denied' ? 'error' : 'success'}
        showIcon
        style={{ maxWidth: 820 }}
        message={header}
        description={description}
      />
    )
  }

  // --- regular tool approval path ---------------------------------------------
  return (
    <Alert
      type={pending ? 'warning' : approval.status === 'denied' ? 'error' : 'success'}
      showIcon
      style={{ maxWidth: 820 }}
      message={header}
      description={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {approval.reason ? <Typography.Text>{approval.reason}</Typography.Text> : null}
          <JsonBlock value={approval.args} maxHeight={160} />
          {pending ? (
            rejecting ? (
              <Space.Compact style={{ width: '100%', maxWidth: 520 }}>
                <Input
                  placeholder="拒绝理由（可选）"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <Button danger loading={busy} onClick={() => void decide('denied', { reason: reason.trim() || undefined })}>
                  确认拒绝
                </Button>
                <Button onClick={() => setRejecting(false)}>取消</Button>
              </Space.Compact>
            ) : (
              <Space wrap>
                <Button type="primary" loading={busy} onClick={() => void decide('allowed-once')}>
                  允许一次
                </Button>
                <Button loading={busy} onClick={() => void decide('allowed-session')}>
                  本次会话允许
                </Button>
                <Button danger onClick={() => setRejecting(true)}>
                  拒绝
                </Button>
              </Space>
            )
          ) : (
            <Typography.Text type="secondary">
              {item.decision ? `${item.decision.by} 已${item.decision.status === 'denied' ? '拒绝' : '批准'}` : '已处理'}
              {approval.decisionReason ? `：${approval.decisionReason}` : ''}
            </Typography.Text>
          )}
        </Space>
      }
    />
  )
}
