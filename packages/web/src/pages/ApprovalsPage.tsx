/** 审批页：安全关键路径，审批结果给出明确反馈。 */
import { useState } from 'react'
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Input,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { Link } from 'react-router-dom'
import type { ApprovalRecord } from '@sre/protocol'
import { api } from '../api'
import { useAppState } from '../state'
import { useAsyncData, useQueryParam, useTicker } from '../hooks'
import { useWsEvent } from '../ws'
import { ApprovalStatusTag, OriginTag, RiskTag } from '../components/StatusTags'
import AskUserPanel from '../components/AskUserPanel'
import JsonBlock from '../components/JsonBlock'
import { formatTime, oneLineJson, readAskUserArgs, truncate } from '../utils'

interface Feedback {
  kind: 'success' | 'info' | 'warning' | 'error'
  text: string
}

/** True when the approval is the agent asking the operator a structured question. */
function askUserArgsOf(record: ApprovalRecord) {
  return record.toolName === 'ask_user' ? readAskUserArgs(record.args) : null
}

export default function ApprovalsPage(): JSX.Element {
  const { message } = AntApp.useApp()
  const { pendingApprovals, refreshPendingApprovals } = useAppState()
  const [scope, setScope] = useState<'pending' | 'all'>('pending')
  const [focusId] = useQueryParam('focus')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rejectTarget, setRejectTarget] = useState<ApprovalRecord | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const now = useTicker(10_000)

  const approvals = useAsyncData(() => api.approvals(scope), [scope])

  useWsEvent('approval_requested', () => approvals.reload())
  useWsEvent('approval_resolved', () => approvals.reload())

  async function decide(
    record: ApprovalRecord,
    decision: 'allowed-once' | 'allowed-session' | 'denied',
    options?: { reason?: string; answer?: string },
  ): Promise<void> {
    setBusyId(record.id)
    try {
      await api.decide(record.id, decision, options)
      const askAnswer = record.toolName === 'ask_user' ? options?.answer : undefined
      const label = askAnswer
        ? '回答提问'
        : decision === 'allowed-once'
          ? '允许一次'
          : decision === 'allowed-session'
            ? '本次会话允许'
            : record.toolName === 'ask_user'
              ? '拒绝回答'
              : '拒绝'
      const suffix = askAnswer ? `，回答：${askAnswer}` : options?.reason ? `，理由：${options.reason}` : ''
      setFeedback({
        kind: decision === 'denied' ? 'warning' : 'success',
        text: `已对「${record.toolName}」执行「${label}」${suffix}（审批 id ${record.id}）。`,
      })
      if (decision === 'denied') void message.warning(`${label}：${record.toolName}`)
      else void message.success(`${label}：${record.toolName}`)
      approvals.reload()
      void refreshPendingApprovals()
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      setFeedback({ kind: 'error', text: `审批提交失败：${text}` })
    } finally {
      setBusyId(null)
    }
  }

  const columns: ColumnsType<ApprovalRecord> = [
    {
      title: '工具',
      dataIndex: 'toolName',
      width: 190,
      render: (_value, record) => (
        <Space size={4} direction="vertical">
          <span className="mono">{record.toolName}</span>
          <Space size={4}>
            <RiskTag risk={record.risk} />
            <Tag>{record.kernel}</Tag>
          </Space>
        </Space>
      ),
    },
    {
      title: '参数',
      dataIndex: 'args',
      render: (_value, record) => {
        // ask_user carries the question in args — show it as text, not raw JSON.
        const ask = askUserArgsOf(record)
        if (ask) {
          return (
            <Tooltip title={ask.question}>
              <Typography.Text strong>{truncate(ask.question, 70)}</Typography.Text>
            </Tooltip>
          )
        }
        return (
          <Tooltip title={<pre className="sre-json" style={{ maxWidth: 520 }}>{oneLineJson(record.args, 2000)}</pre>}>
            <Typography.Text className="mono" type="secondary">
              {oneLineJson(record.args, 70)}
            </Typography.Text>
          </Tooltip>
        )
      },
    },
    {
      title: '来源',
      dataIndex: 'origin',
      width: 90,
      render: (_value, record) => <OriginTag origin={record.origin} />,
    },
    {
      title: '会话',
      dataIndex: 'sessionId',
      width: 120,
      render: (_value, record) => (
        <Link to={`/?session=${encodeURIComponent(record.sessionId)}`} className="mono">
          {record.sessionId.slice(0, 8)}
        </Link>
      ),
    },
    {
      title: '请求时间',
      dataIndex: 'requestedAt',
      width: 160,
      render: (_value, record) => <Tooltip title={formatTime(record.requestedAt)}>{formatTime(record.requestedAt)}</Tooltip>,
    },
    {
      title: '有效期',
      dataIndex: 'expiresAt',
      width: 130,
      render: (_value, record) => {
        if (record.status !== 'pending') return <Typography.Text type="secondary">-</Typography.Text>
        const remaining = record.expiresAt - now
        if (remaining <= 0) return <Tag color="red">即将过期</Tag>
        return <Typography.Text type="secondary">剩余 {Math.max(0, Math.round(remaining / 1000))}s</Typography.Text>
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (_value, record) => (
        <Space size={4} direction="vertical">
          <ApprovalStatusTag status={record.status} />
          {record.decidedBy ? (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {record.decidedBy} · {formatTime(record.decidedAt)}
            </Typography.Text>
          ) : null}
          {record.decisionReason ? (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {record.decisionReason}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 340,
      render: (_value, record) => {
        if (record.status !== 'pending') {
          // For ask_user, decisions made elsewhere may carry the answer in decisionReason.
          return <Typography.Text type="secondary">已处理</Typography.Text>
        }
        const ask = askUserArgsOf(record)
        if (ask) {
          return (
            <AskUserPanel
              args={ask}
              pending
              busy={busyId === record.id}
              onAnswer={(answer) => decide(record, 'allowed-once', { answer })}
              onReject={() => decide(record, 'denied')}
            />
          )
        }
        return (
          <Space size={4} wrap>
            <Button
              size="small"
              type="primary"
              loading={busyId === record.id}
              onClick={() => void decide(record, 'allowed-once')}
            >
              允许一次
            </Button>
            <Button size="small" loading={busyId === record.id} onClick={() => void decide(record, 'allowed-session')}>
              本次会话允许
            </Button>
            <Button size="small" danger onClick={() => setRejectTarget(record)}>
              拒绝
            </Button>
          </Space>
        )
      },
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space size={12} wrap>
            <Badge count={pendingApprovals} size="small">
              <Typography.Text strong>待审批工具调用</Typography.Text>
            </Badge>
            <Segmented
              size="small"
              value={scope}
              onChange={(value) => setScope(value as 'pending' | 'all')}
              options={[
                { label: '待审批', value: 'pending' },
                { label: '全部记录', value: 'all' },
              ]}
            />
            <Button size="small" onClick={approvals.reload} loading={approvals.loading}>
              刷新
            </Button>
          </Space>
          <Alert
            type="warning"
            showIcon
            message="待审批的工具调用会被内核阻塞，模型会一直等待你的决定；超过有效期会自动失效。"
          />
          {feedback ? (
            <Alert type={feedback.kind} showIcon closable message={feedback.text} onClose={() => setFeedback(null)} />
          ) : null}
          {approvals.error ? <Alert type="error" showIcon message={`审批列表加载失败：${approvals.error}`} /> : null}
        </Space>
      </Card>

      <Table<ApprovalRecord>
        size="small"
        rowKey="id"
        loading={approvals.loading}
        dataSource={approvals.data ?? []}
        columns={columns}
        scroll={{ x: 1280 }}
        rowClassName={(record) => (record.id === focusId ? 'sre-session-item-active' : '')}
        expandable={{
          expandedRowRender: (record) => <JsonBlock value={record.args} maxHeight={200} />,
        }}
        pagination={{ pageSize: 20, size: 'small', showSizeChanger: false }}
      />

      <Modal
        title="拒绝对话中的工具调用"
        open={rejectTarget !== null}
        okText="确认拒绝"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        onCancel={() => {
          setRejectTarget(null)
          setRejectReason('')
        }}
        onOk={() => {
          const target = rejectTarget
          if (!target) return
          setRejectTarget(null)
          const reason = rejectReason.trim()
          setRejectReason('')
          void decide(target, 'denied', { reason: reason || undefined })
        }}
      >
        {rejectTarget ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text>
              工具：<span className="mono">{rejectTarget.toolName}</span>
            </Typography.Text>
            <Input.TextArea
              rows={3}
              placeholder="拒绝理由（可选，会写入审计日志）"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
            />
          </Space>
        ) : null}
      </Modal>
    </Space>
  )
}
