/** 对话页：会话列表 + 流式会话视图（打字机、思考块、工具卡片、审批内联卡）。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Collapse,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SendOutlined, StopOutlined } from '@ant-design/icons'
import type { ChatMessage, KernelCapabilities } from '@sre/protocol'
import { api, apiErrorMessage } from '../api'
import { useAppState } from '../state'
import { dispatchAbort, dispatchPrompt, useWsEvent } from '../ws'
import { useAsyncData, useQueryParam } from '../hooks'
import {
  appendUser,
  applyKernelEvent,
  fromHistory,
  mergeHistory,
  resolveApproval,
  upsertApproval,
  type TranscriptItem,
} from '../chatModel'
import ToolCallCard from '../components/ToolCallCard'
import ApprovalInlineCard from '../components/ApprovalInlineCard'
import {
  formatRelative,
  modelOptions,
  modelValue,
  originLabel,
  readLocalDefaultModel,
  splitModelValue,
} from '../utils'

/**
 * Folded "thinking" block. Open while the model is reasoning, and it stays open
 * afterwards so the trail is still readable — the open state is captured once at
 * mount on purpose (a live `defaultActiveKey` would collapse the panel when the
 * turn ends).
 */
function ReasoningBlock({ item }: { item: Extract<TranscriptItem, { kind: 'reasoning' }> }): JSX.Element {
  const [openKeys, setOpenKeys] = useState<string[]>(item.streaming ? [item.id] : [])

  useEffect(() => {
    if (!item.streaming) return
    setOpenKeys((keys) => (keys.includes(item.id) ? keys : [...keys, item.id]))
  }, [item.streaming, item.id])

  return (
    <Collapse
      size="small"
      style={{ maxWidth: 820, alignSelf: 'flex-start', width: '100%' }}
      activeKey={openKeys}
      onChange={(keys) => setOpenKeys(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
      items={[
        {
          key: item.id,
          label: item.streaming ? '思考中…' : '思考过程',
          children: <pre className="sre-json" style={{ maxHeight: 220 }}>{item.text}</pre>,
        },
      ]}
    />
  )
}

export default function ChatPage(): JSX.Element {
  const { message } = AntApp.useApp()
  const { bootstrap, refreshPendingApprovals } = useAppState()

  const [sessionId, setSessionId] = useQueryParam('session')
  const [filter, setFilter] = useState('')
  const [input, setInput] = useState('')
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [running, setRunning] = useState(false)
  const [sending, setSending] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)

  const [createOpen, setCreateOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newCwd, setNewCwd] = useState('')

  const scrollRef = useRef<HTMLDivElement | null>(null)

  const sessions = useAsyncData(() => api.sessions(), [])
  const providers = useAsyncData(() => api.providers(), [])
  const history = useAsyncData<ChatMessage[]>(
    () => (sessionId ? api.messages(sessionId) : Promise.resolve([])),
    [sessionId],
  )

  const session = useMemo(
    () => sessions.data?.find((entry) => entry.id === sessionId) ?? null,
    [sessions.data, sessionId],
  )
  const models = useMemo(() => modelOptions(providers.data ?? []), [providers.data])
  const selectedKernelInfo = useMemo(
    () => bootstrap?.kernels.find((kernel) => kernel.id === bootstrap.selectedKernel) ?? null,
    [bootstrap],
  )
  const capabilities: KernelCapabilities | null = selectedKernelInfo?.capabilities ?? null

  const filteredSessions = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    const list = sessions.data ?? []
    if (!keyword) return list
    return list.filter(
      (entry) =>
        entry.title.toLowerCase().includes(keyword) ||
        entry.id.toLowerCase().includes(keyword) ||
        entry.cwd.toLowerCase().includes(keyword),
    )
  }, [sessions.data, filter])

  // Persisted history seeds the transcript; live kernel events then mutate it in
  // place. History can resolve *after* the socket already delivered deltas, so the
  // two sources are merged instead of one replacing the other.
  useEffect(() => {
    if (!history.data) return
    setItems((prev) => mergeHistory(fromHistory(history.data ?? []), prev))
  }, [history.data])

  useEffect(() => {
    // Switching sessions resets the transcript, so live events always append to a
    // list that only contains items of the currently selected session.
    setItems([])
    setRunning(false)
    setAutoScroll(true)
  }, [sessionId])

  useWsEvent('kernel_event', (msg) => {
    const envelope = msg.envelope
    if (!sessionId || envelope.sessionId !== sessionId) return
    if (envelope.event.type === 'agent_status') {
      setRunning(envelope.event.status === 'running')
      return
    }
    if (envelope.event.type === 'tool_call') setRunning(true)
    if (envelope.event.type === 'turn_end') setRunning(false)
    setItems((prev) => applyKernelEvent(prev, envelope.event))
  })

  useWsEvent('approval_requested', (msg) => {
    if (msg.approval.sessionId !== sessionId) return
    setItems((prev) => upsertApproval(prev, msg.approval))
  })

  useWsEvent('approval_resolved', (msg) => {
    setItems((prev) => resolveApproval(prev, msg.approvalId, msg.decision, msg.by))
  })

  useWsEvent('session_updated', (msg) => {
    sessions.setData((prev) => {
      const list = prev ?? []
      const index = list.findIndex((entry) => entry.id === msg.session.id)
      if (index < 0) return [msg.session, ...list]
      return list.map((entry) => (entry.id === msg.session.id ? msg.session : entry))
    })
  })

  // Keep the transcript pinned to the bottom while streaming.
  useEffect(() => {
    const element = scrollRef.current
    if (!element || !autoScroll) return
    element.scrollTop = element.scrollHeight
  }, [items, autoScroll])

  async function handleSend(): Promise<void> {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    try {
      let target = sessionId
      if (!target) {
        const created = await api.createSession({ title: text.slice(0, 40) })
        target = created.id
        setSessionId(created.id)
        sessions.reload()
      }
      setInput('')
      setItems((prev) => appendUser(prev, text))
      setAutoScroll(true)
      setRunning(true)
      await dispatchPrompt(target, text)
    } catch (err) {
      // Both channels failed — the API layer stayed quiet for the fallback probe,
      // so the reason is surfaced here.
      setRunning(false)
      void message.error(apiErrorMessage(err, '发送失败'))
    } finally {
      setSending(false)
    }
  }

  async function handleAbort(): Promise<void> {
    if (!sessionId) return
    try {
      await dispatchAbort(sessionId)
      void message.info('已发送停止指令')
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function handleCreate(): Promise<void> {
    setSending(true)
    try {
      // Prefer the browser-local default model (set on the 模型 page) when the
      // server has not been told which model this session should use.
      const localDefault = readLocalDefaultModel()
      const created = await api.createSession({
        title: newTitle.trim() || undefined,
        cwd: newCwd.trim() || undefined,
        model: localDefault ?? bootstrap?.defaultModel ?? undefined,
      })
      setCreateOpen(false)
      setNewTitle('')
      setNewCwd('')
      setSessionId(created.id)
      sessions.reload()
      void message.success('会话已创建')
    } catch {
      /* surfaced by the API layer */
    } finally {
      setSending(false)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    try {
      await api.deleteSession(id)
      if (id === sessionId) setSessionId(null)
      sessions.reload()
      void message.success('会话已删除')
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function handleModelChange(value: string): Promise<void> {
    const model = splitModelValue(value)
    if (!model || !sessionId) return
    try {
      await api.setSessionModel(sessionId, model)
      sessions.reload()
      void message.success(`已切换模型：${model.provider} / ${model.model}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function handleDecide(
    approvalId: string,
    decision: 'allowed-once' | 'allowed-session' | 'denied',
    options?: { reason?: string; answer?: string },
  ): Promise<void> {
    try {
      await api.decide(approvalId, decision, options)
      setItems((prev) => resolveApproval(prev, approvalId, decision, '你'))
      void refreshPendingApprovals()
      void message.success(
        decision === 'denied'
          ? options?.answer === undefined && options?.reason === undefined
            ? '已拒绝该提问'
            : '已拒绝该工具调用'
          : options?.answer !== undefined
            ? '已提交回答'
            : '已批准该工具调用',
      )
    } catch {
      /* surfaced by the API layer */
    }
  }

  function renderItem(item: TranscriptItem): JSX.Element {
    switch (item.kind) {
      case 'message':
        return (
          <div
            key={item.id}
            className={`sre-bubble ${item.role === 'user' ? 'sre-bubble-user' : item.role === 'system' ? 'sre-bubble-system' : ''}`}
          >
            {item.role !== 'system' ? (
              <div className="sre-bubble-meta">
                {item.role === 'user' ? '你' : '助手'} · {formatRelative(item.createdAt)}
              </div>
            ) : null}
            <div className="sre-pre">
              {item.text}
              {item.streaming ? <span className="sre-caret" /> : null}
            </div>
          </div>
        )
      case 'reasoning':
        return <ReasoningBlock key={item.id} item={item} />
      case 'tool':
        return <ToolCallCard key={item.id} item={item} />
      case 'notice':
        return (
          <Alert
            key={item.id}
            style={{ maxWidth: 820 }}
            type={item.level === 'error' ? 'error' : item.level === 'warn' ? 'warning' : 'info'}
            showIcon
            message={<span className="sre-pre">{item.text}</span>}
          />
        )
      case 'approval':
        return (
          <ApprovalInlineCard
            key={item.id}
            item={item}
            onDecide={(decision, options) => handleDecide(item.approval.id, decision, options)}
          />
        )
    }
  }

  return (
    <div className="sre-chat">
      <aside className="sre-chat-side">
        <Space.Compact style={{ width: '100%' }}>
          <Input
            size="small"
            allowClear
            placeholder="过滤会话"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <Tooltip title="刷新会话列表">
            <Button size="small" icon={<ReloadOutlined />} onClick={sessions.reload} />
          </Tooltip>
        </Space.Compact>
        <Button type="primary" size="small" icon={<PlusOutlined />} block onClick={() => setCreateOpen(true)}>
          新建会话
        </Button>
        <div className="sre-scroll-y" style={{ flex: 1, marginTop: 4 }}>
          {sessions.loading && !sessions.data ? (
            <div className="sre-centered" style={{ height: 120 }}>
              <Spin />
            </div>
          ) : filteredSessions.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={sessions.error ? `会话列表加载失败：${sessions.error}` : '暂无会话'}
            />
          ) : (
            filteredSessions.map((entry) => (
              <div
                key={entry.id}
                className={`sre-session-item ${entry.id === sessionId ? 'sre-session-item-active' : ''}`}
                onClick={() => setSessionId(entry.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                  <Typography.Text ellipsis style={{ maxWidth: 132 }} delete={entry.status === 'archived'}>
                    {entry.title || '未命名会话'}
                  </Typography.Text>
                  <Popconfirm
                    title="删除该会话？"
                    description="会话及其消息将从平台移除。"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => void handleDelete(entry.id)}
                  >
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </Popconfirm>
                </div>
                <Space size={4} wrap>
                  {entry.parentSessionId ? (
                    <Tooltip title="来自父会话">
                      <Tag color="purple">子任务</Tag>
                    </Tooltip>
                  ) : null}
                  <Tag>{originLabel(entry.origin)}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {entry.kernel} · {formatRelative(entry.updatedAt)} · {entry.messageCount} 条
                  </Typography.Text>
                </Space>
              </div>
            ))
          )}
        </div>
      </aside>

      <section className="sre-chat-main">
        {session ? (
          <Space wrap style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
            <Space size={8} wrap>
              <Typography.Text strong>{session.title || '未命名会话'}</Typography.Text>
              <Tag color={running ? 'processing' : 'default'}>{running ? '运行中' : '空闲'}</Tag>
              <Tag>{session.kernel}</Tag>
              {session.parentSessionId ? (
                <Tooltip title="来自父会话">
                  <Tag color="purple">子任务</Tag>
                </Tooltip>
              ) : null}
              <Typography.Text type="secondary" className="mono">
                {session.cwd}
              </Typography.Text>
            </Space>
            <Space size={8} wrap>
              <Select
                size="small"
                style={{ minWidth: 230 }}
                placeholder="默认模型"
                value={session.model ? modelValue(session.model.provider, session.model.model) : undefined}
                options={models.map((option) => ({ value: option.value, label: option.label }))}
                onChange={(value) => void handleModelChange(value)}
                notFoundContent={providers.loading ? <Spin size="small" /> : '未配置模型'}
              />
              <Tooltip title="重新加载历史消息">
                <Button size="small" icon={<ReloadOutlined />} onClick={history.reload} />
              </Tooltip>
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                disabled={!running}
                onClick={() => void handleAbort()}
              >
                停止
              </Button>
            </Space>
          </Space>
        ) : null}

        <div
          className="sre-transcript"
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget
            const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60
            setAutoScroll(nearBottom)
          }}
        >
          {!session ? (
            <div className="sre-centered" style={{ flex: 1 }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  history.error
                    ? `会话加载失败：${history.error}`
                    : '从左侧选择一个会话，或点击「新建会话」开始'
                }
              />
            </div>
          ) : history.loading && items.length === 0 ? (
            <div className="sre-centered" style={{ flex: 1 }}>
              <Spin />
            </div>
          ) : items.length === 0 ? (
            <div className="sre-centered" style={{ flex: 1 }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={history.error ? `消息加载失败：${history.error}` : '还没有消息，先在下方输入指令'}
              />
            </div>
          ) : (
            items.map((item) => renderItem(item))
          )}
        </div>

        <div className="sre-composer">
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {capabilities && capabilities.modelSwitch === 'session-recreate' ? (
              <Typography.Text type="secondary">
                当前内核（{selectedKernelInfo?.displayName}）不支持运行时切换模型，切换后对已有会话的后续轮次不生效。
              </Typography.Text>
            ) : null}
            <Input.TextArea
              autoFocus
              autoSize={{ minRows: 1, maxRows: 6 }}
              placeholder="输入指令，Enter 发送，Shift+Enter 换行"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onPressEnter={(event) => {
                if (event.shiftKey) return
                event.preventDefault()
                void handleSend()
              }}
              disabled={sending}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <Typography.Text type="secondary">Enter 发送 · Shift+Enter 换行</Typography.Text>
              <Space>
                {!autoScroll ? (
                  <Button size="small" onClick={() => setAutoScroll(true)}>
                    回到底部
                  </Button>
                ) : null}
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  loading={sending}
                  disabled={!input.trim()}
                  onClick={() => void handleSend()}
                >
                  发送
                </Button>
              </Space>
            </div>
          </Space>
        </div>
      </section>

      <Modal
        title="新建会话"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreate()}
        okText="创建"
        cancelText="取消"
        confirmLoading={sending}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Input
            placeholder="会话标题（留空由平台生成）"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
          />
          <Input
            placeholder="工作目录 cwd（留空使用服务端默认）"
            value={newCwd}
            onChange={(event) => setNewCwd(event.target.value)}
          />
          <Typography.Text type="secondary">
            会话默认模型：{bootstrap?.defaultModel ? `${bootstrap.defaultModel.provider} / ${bootstrap.defaultModel.model}` : '未设置'}
          </Typography.Text>
        </Space>
      </Modal>
    </div>
  )
}
