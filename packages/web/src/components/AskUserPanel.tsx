/**
 * Renderer for `ask_user` approvals — the channel the agent uses to ask the
 * operator a structured question. Picking a choice (or submitting a custom
 * answer) resolves the approval as `allowed-once` with the answer in the body;
 * "拒绝回答" resolves it as `denied`.
 */
import { useState } from 'react'
import { Button, Input, Space, Tag, Typography } from 'antd'
import { QuestionCircleOutlined } from '@ant-design/icons'
import type { AskUserArgs } from '../utils'

interface Props {
  args: AskUserArgs
  pending: boolean
  busy?: boolean
  /** The answer this operator submitted, echoed back after deciding. */
  answer?: string
  /** True when the operator rejected the question instead of answering. */
  rejected?: boolean
  onAnswer: (answer: string) => Promise<void> | void
  onReject: () => Promise<void> | void
}

export default function AskUserPanel({ args, pending, busy = false, answer, rejected, onAnswer, onReject }: Props): JSX.Element {
  const [custom, setCustom] = useState('')

  const allowCustom = args.allowCustom !== false
  const canSubmitCustom = custom.trim().length > 0

  if (!pending) {
    // Resolved: keep the question visible and echo the answer (or rejection) so
    // the transcript stays readable.
    return (
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{args.question}</Typography.Text>
        <Typography.Text type="secondary">
          {rejected ? (
            '已拒绝回答'
          ) : answer ? (
            <>
              已回答：<Typography.Text strong>{answer}</Typography.Text>
            </>
          ) : (
            '已处理'
          )}
        </Typography.Text>
      </Space>
    )
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text strong>
        <QuestionCircleOutlined style={{ color: '#faad14', marginRight: 6 }} />
        {args.question}
      </Typography.Text>
      {args.choices && args.choices.length > 0 ? (
        <Space size={6} wrap>
          {args.choices.map((choice) => (
            <Button key={choice} size="small" type="primary" ghost disabled={busy} onClick={() => void onAnswer(choice)}>
              {choice}
            </Button>
          ))}
        </Space>
      ) : null}
      {allowCustom ? (
        <Space.Compact style={{ width: '100%', maxWidth: 560 }}>
          <Input
            placeholder="自定义回答"
            value={custom}
            disabled={busy}
            onChange={(event) => setCustom(event.target.value)}
            onPressEnter={() => {
              if (canSubmitCustom && !busy) void onAnswer(custom.trim())
            }}
          />
          <Button type="primary" disabled={!canSubmitCustom} loading={busy} onClick={() => void onAnswer(custom.trim())}>
            提交回答
          </Button>
        </Space.Compact>
      ) : (
        <Tag>该问题不支持自定义回答，请从上方选项中选择</Tag>
      )}
      <div>
        <Button size="small" danger disabled={busy} onClick={() => void onReject()}>
          拒绝回答
        </Button>
      </div>
    </Space>
  )
}
