/** 智能体页：worker/supervisor 规格、触发器配置、手动运行与运行历史。 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Form,
  Input,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { DeleteOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { AgentRun, AgentSpec, AlertSeverity } from '@sre/protocol'
import { api } from '../api'
import { useAsyncData } from '../hooks'
import { useWsEvent } from '../ws'
import { RunStatusTag } from '../components/StatusTags'
import { formatDuration, formatRelative, formatTime, isKebabCase, modelOptions, splitModelValue, toKebabCase, severityMeta } from '../utils'

/** Platform tool catalogue; agents may only use what is whitelisted here. */
const PLATFORM_TOOLS = [
  'kb_search',
  'sre_http_probe',
  'sre_shell',
  'sre_runbook_run',
  'sre_incident_note',
  'ask_user',
  'sre_delegate',
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_fill',
  'browser_close',
  'computer_screenshot',
  'computer_frontmost',
  'computer_click',
  'computer_type',
  'computer_key',
  'memory_search',
  'memory_save',
  'workflow_run',
  'agent_status',
].map((tool) => ({ value: tool, label: tool }))

const KIND_META: Record<AgentSpec['kind'], { label: string; color: string }> = {
  worker: { label: 'worker', color: 'blue' },
  supervisor: { label: 'supervisor', color: 'purple' },
}

const RUN_TRIGGER_LABEL: Record<AgentRun['trigger'], string> = {
  manual: '手动',
  schedule: '定时',
  alert: '告警',
}

interface MatcherRow {
  key: string
  severity?: AlertSeverity
  namePattern?: string
}

interface AgentFormValues {
  id: string
  name: string
  role: string
  kind: AgentSpec['kind']
  cron?: string
  timezone?: string
  modelValue?: string
  allowedTools?: string[]
  workflowId?: string
  runbookId?: string
  notifyUrls?: string[]
  enabled: boolean
}

/** Trigger chips shown on the agent card. */
function TriggerChips({ spec }: { spec: AgentSpec }): JSX.Element {
  const chips: ReactNode[] = []
  if (spec.cron) {
    chips.push(
      <Tooltip key="cron" title={`cron 定时触发${spec.timezone ? `，时区 ${spec.timezone}` : ''}`}>
        <Tag color="purple">定时 {spec.cron}</Tag>
      </Tooltip>,
    )
  }
  if (spec.alertMatchers && spec.alertMatchers.length > 0) {
    const text = spec.alertMatchers
      .map((matcher) => {
        const severity = matcher.severity ? severityMeta(matcher.severity).label : '任意级别'
        const name = matcher.namePattern ? `名称含「${matcher.namePattern}」` : '任意名称'
        return `${severity} · ${name}`
      })
      .join('；')
    chips.push(
      <Tooltip key="alerts" title={`告警匹配触发：${text}`}>
        <Tag color="orange">告警匹配 {spec.alertMatchers.length} 条</Tag>
      </Tooltip>,
    )
  }
  if (chips.length === 0) chips.push(<Tag key="manual">手动触发</Tag>)
  return <Space size={4} wrap>{chips}</Space>
}

export default function AgentsPage(): JSX.Element {
  const { message } = AntApp.useApp()

  const agents = useAsyncData(() => api.agents(), [])
  const workflows = useAsyncData(() => api.workflows(), [])
  const runbooks = useAsyncData(() => api.runbooks(), [])
  const providers = useAsyncData(() => api.providers(), [])
  const runs = useAsyncData(() => api.agentRuns(50), [])

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [matchers, setMatchers] = useState<MatcherRow[]>([])
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<AgentFormValues>()

  const [runningId, setRunningId] = useState<string | null>(null)

  useWsEvent('agent_run_updated', (msg) => {
    runs.setData((prev) => {
      const list = prev ?? []
      const index = list.findIndex((entry) => entry.id === msg.run.id)
      if (index < 0) return [msg.run, ...list]
      return list.map((entry) => (entry.id === msg.run.id ? msg.run : entry))
    })
  })

  // --- editor ----------------------------------------------------------------

  function openEditor(spec?: AgentSpec): void {
    setEditingId(spec?.id ?? null)
    form.setFieldsValue({
      id: spec?.id ?? '',
      name: spec?.name ?? '',
      role: spec?.role ?? '',
      kind: spec?.kind ?? 'worker',
      cron: spec?.cron ?? '',
      timezone: spec?.timezone ?? '',
      modelValue: spec?.model ? `${spec.model.provider}::${spec.model.model}` : undefined,
      allowedTools: spec?.allowedTools ?? [],
      workflowId: spec?.workflowId,
      runbookId: spec?.runbookId,
      notifyUrls: spec?.escalation?.notifyUrls ?? [],
      enabled: spec?.enabled ?? true,
    })
    setMatchers(
      (spec?.alertMatchers ?? []).map((matcher, index) => ({
        key: `m-${index}-${matcher.severity ?? ''}-${matcher.namePattern ?? ''}`,
        severity: matcher.severity,
        namePattern: matcher.namePattern,
      })),
    )
    setEditorOpen(true)
  }

  async function saveAgent(): Promise<void> {
    let values: AgentFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    const model = values.modelValue ? splitModelValue(values.modelValue) : null
    const payload = {
      name: values.name.trim(),
      role: values.role,
      kind: values.kind,
      cron: values.cron?.trim() || undefined,
      timezone: values.timezone?.trim() || undefined,
      alertMatchers:
        matchers.length > 0
          ? matchers
              .filter((row) => row.severity || (row.namePattern ?? '').trim())
              .map((row) => ({
                ...(row.severity ? { severity: row.severity } : {}),
                ...(row.namePattern && row.namePattern.trim() ? { namePattern: row.namePattern.trim() } : {}),
              }))
          : undefined,
      model: model ?? undefined,
      allowedTools: (values.allowedTools ?? []).filter(Boolean),
      workflowId: values.workflowId || undefined,
      runbookId: values.runbookId || undefined,
      escalation:
        values.notifyUrls && values.notifyUrls.length > 0 ? { notifyUrls: values.notifyUrls.map((url) => url.trim()).filter(Boolean) } : undefined,
      enabled: values.enabled,
    }
    setSaving(true)
    try {
      await api.putAgent(values.id.trim(), payload)
      setEditorOpen(false)
      agents.reload()
      void message.success(`智能体已保存：${payload.name}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setSaving(false)
    }
  }

  async function deleteAgent(spec: AgentSpec): Promise<void> {
    try {
      await api.deleteAgent(spec.id)
      agents.reload()
      runs.reload()
      void message.success(`已删除智能体：${spec.name}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function toggleAgent(spec: AgentSpec, enabled: boolean): Promise<void> {
    try {
      await api.putAgent(spec.id, {
        name: spec.name,
        role: spec.role,
        kind: spec.kind,
        cron: spec.cron,
        timezone: spec.timezone,
        alertMatchers: spec.alertMatchers,
        model: spec.model,
        allowedTools: spec.allowedTools,
        workflowId: spec.workflowId,
        runbookId: spec.runbookId,
        escalation: spec.escalation,
        enabled,
      })
      agents.reload()
      void message.success(enabled ? `已启用：${spec.name}` : `已停用：${spec.name}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function runNow(spec: AgentSpec): Promise<void> {
    setRunningId(spec.id)
    try {
      const record = await api.runAgent(spec.id)
      runs.reload()
      void message.success(
        `已触发智能体：${spec.name}（运行 ${record.id}，状态：${record.status === 'running' ? '执行中' : record.status}）`,
      )
    } catch {
      /* surfaced by the API layer */
    } finally {
      setRunningId(null)
    }
  }

  // --- render ----------------------------------------------------------------

  const runColumns: ColumnsType<AgentRun> = [
    { title: '状态', dataIndex: 'status', width: 90, render: (_v, record) => <RunStatusTag status={record.status} /> },
    {
      title: '智能体',
      dataIndex: 'agentName',
      width: 180,
      render: (_v, record) => (
        <Space size={4} direction="vertical">
          <span>{record.agentName ?? record.agentId}</span>
          <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
            {record.agentId}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '触发',
      dataIndex: 'trigger',
      width: 90,
      render: (_v, record) => (
        <Tooltip title={record.alertId ? `告警 ${record.alertId}` : undefined}>
          <Tag color="blue">{RUN_TRIGGER_LABEL[record.trigger] ?? record.trigger}</Tag>
        </Tooltip>
      ),
    },
    { title: '开始时间', dataIndex: 'startedAt', width: 170, render: (_v, record) => formatTime(record.startedAt) },
    {
      title: '时长',
      dataIndex: 'finishedAt',
      width: 100,
      render: (_v, record) => formatDuration((record.finishedAt ?? Date.now()) - record.startedAt),
    },
    {
      title: '摘要',
      dataIndex: 'summary',
      render: (_v, record) =>
        record.summary ? (
          <Tooltip title={record.summary} placement="topLeft">
            <Typography.Text type="secondary" ellipsis style={{ maxWidth: 380 }}>
              {record.summary}
            </Typography.Text>
          </Tooltip>
        ) : (
          '-'
        ),
    },
  ]

  const agentRuns = runs.data ?? []

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {agents.error ? <Alert type="error" showIcon message={`智能体加载失败：${agents.error}`} /> : null}

      <Alert
        type="info"
        showIcon
        message="worker agent 按触发器持续运行（cron / 告警匹配 / 手动），工具范围外一律拒绝；supervisor 额外收到近期 worker 运行摘要，可调用 workflow_run / memory_* 编排处置"
      />

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>
            新建智能体
          </Button>
          <Button icon={<ReloadOutlined />} onClick={agents.reload} loading={agents.loading}>
            刷新
          </Button>
        </Space>

        {agents.loading ? null : (agents.data ?? []).length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无智能体，点击「新建智能体」创建" />
        ) : (
          <Row gutter={[12, 12]}>
            {(agents.data ?? []).map((spec) => {
              const latest = agentRuns.find((entry) => entry.agentId === spec.id)
              const kindMeta = KIND_META[spec.kind] ?? { label: spec.kind, color: 'default' }
              return (
                <Col key={spec.id} xs={24} md={12} xl={8}>
                  <Card
                    size="small"
                    title={
                      <Space size={6}>
                        <span>{spec.name}</span>
                        <Tag color={kindMeta.color}>{kindMeta.label}</Tag>
                      </Space>
                    }
                    extra={<Switch size="small" checked={spec.enabled} onChange={(checked) => void toggleAgent(spec, checked)} />}
                  >
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }} ellipsis={{ rows: 2 }}>
                        {spec.role || '（未填写角色说明）'}
                      </Typography.Paragraph>

                      <Space size={4} wrap>
                        <Typography.Text type="secondary">触发：</Typography.Text>
                        <TriggerChips spec={spec} />
                      </Space>

                      <Space size={4} wrap>
                        <Typography.Text type="secondary">工具：</Typography.Text>
                        {spec.allowedTools.length === 0 ? (
                          <Typography.Text type="secondary">未配置</Typography.Text>
                        ) : (
                          <Space size={4} wrap>
                            {spec.allowedTools.slice(0, 5).map((tool) => (
                              <Tag key={tool} className="mono">
                                {tool}
                              </Tag>
                            ))}
                            {spec.allowedTools.length > 5 ? <Tag>+{spec.allowedTools.length - 5}</Tag> : null}
                          </Space>
                        )}
                      </Space>

                      {spec.workflowId || spec.runbookId ? (
                        <Space size={4} wrap>
                          <Typography.Text type="secondary">绑定：</Typography.Text>
                          {spec.workflowId ? (
                            <Tag className="mono">workflow: {workflows.data?.find((entry) => entry.id === spec.workflowId)?.name ?? spec.workflowId}</Tag>
                          ) : null}
                          {spec.runbookId ? (
                            <Tag className="mono">runbook: {runbooks.data?.find((entry) => entry.id === spec.runbookId)?.name ?? spec.runbookId}</Tag>
                          ) : null}
                        </Space>
                      ) : null}

                      <Space size={6} wrap>
                        <Typography.Text type="secondary">最近运行：</Typography.Text>
                        {latest ? (
                          <>
                            <RunStatusTag status={latest.status} />
                            <Typography.Text type="secondary">{formatRelative(latest.startedAt)}</Typography.Text>
                          </>
                        ) : (
                          <Typography.Text type="secondary">从未运行</Typography.Text>
                        )}
                      </Space>

                      <Space size={4} style={{ marginTop: 4 }}>
                        <Button
                          size="small"
                          type="primary"
                          icon={<PlayCircleOutlined />}
                          loading={runningId === spec.id}
                          onClick={() => void runNow(spec)}
                        >
                          手动运行
                        </Button>
                        <Button size="small" onClick={() => openEditor(spec)}>
                          编辑
                        </Button>
                        <Popconfirm title="删除该智能体？" okText="删除" cancelText="取消" onConfirm={() => void deleteAgent(spec)}>
                          <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </Space>
                    </Space>
                  </Card>
                </Col>
              )
            })}
          </Row>
        )}
      </Space>

      <Card
        size="small"
        title="运行历史"
        extra={
          <Space>
            <Typography.Text type="secondary">agent_run_updated 实时刷新</Typography.Text>
            <Button size="small" icon={<ReloadOutlined />} onClick={runs.reload} loading={runs.loading} />
          </Space>
        }
      >
        <Table<AgentRun>
          size="small"
          rowKey="id"
          loading={runs.loading}
          dataSource={agentRuns}
          columns={runColumns}
          scroll={{ x: 1000 }}
          pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }}
          locale={{ emptyText: '暂无运行记录' }}
          expandable={{
            expandedRowRender: (record) => (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {record.error ? <Alert type="error" showIcon message={record.error} /> : null}
                <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                  {record.summary ?? '（无摘要）'}
                </Typography.Paragraph>
                {record.sessionId ? (
                  <Typography.Text type="secondary" className="mono">
                    会话 {record.sessionId}
                  </Typography.Text>
                ) : null}
              </Space>
            ),
            rowExpandable: (record) => Boolean(record.summary || record.error),
          }}
        />
      </Card>

      <Drawer
        title={editingId ? `编辑智能体：${editingId}` : '新建智能体'}
        width={720}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setEditorOpen(false)}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => void saveAgent()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form<AgentFormValues> form={form} layout="vertical" initialValues={{ kind: 'worker', enabled: true }}>
          <Form.Item
            name="id"
            label="智能体 ID"
            tooltip="kebab-case，作为存储与调用的唯一标识"
            rules={[
              { required: true, message: '请输入智能体 ID' },
              {
                validator: (_rule, value: string) =>
                  !value || isKebabCase(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error('只能使用小写字母、数字和连字符，例如 disk-watchdog')),
              },
            ]}
          >
            <Input
              disabled={editingId !== null}
              placeholder="disk-watchdog"
              onChange={(event) => {
                if (editingId !== null) return
                const next = toKebabCase(event.target.value)
                const name = form.getFieldValue('name') as string | undefined
                if (!name) form.setFieldValue('name', next)
              }}
            />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="磁盘监控智能体" />
          </Form.Item>
          <Form.Item name="role" label="角色说明" tooltip="成为该 agent 的角色指令；supervisor 会额外收到近期 worker 运行摘要">
            <Input.TextArea rows={3} placeholder="负责巡检磁盘水位，发现压力时按处置手册清理并上报" />
          </Form.Item>
          <Form.Item name="kind" label="类型" rules={[{ required: true, message: '请选择类型' }]}>
            <Select
              options={[
                { value: 'worker', label: 'worker（按触发器执行流程）' },
                { value: 'supervisor', label: 'supervisor（额外接收 worker 摘要，可编排处置）' },
              ]}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="cron" label="cron 触发" tooltip="标准 5 段 cron；留空表示不由定时触发">
                <Input className="mono" placeholder="*/15 * * * *" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="timezone" label="时区">
                <Input placeholder="Asia/Shanghai" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item label="告警匹配触发" tooltip="命中的告警会触发该智能体；与 cron 可同时配置">
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {matchers.map((row, index) => (
                <Space key={row.key} size={8} wrap>
                  <Select
                    size="small"
                    allowClear
                    style={{ width: 140 }}
                    placeholder="级别（可留空）"
                    value={row.severity}
                    onChange={(value) =>
                      setMatchers((prev) => prev.map((entry, i) => (i === index ? { ...entry, severity: value } : entry)))
                    }
                    options={[
                      { value: 'critical', label: '严重 critical' },
                      { value: 'warning', label: '警告 warning' },
                      { value: 'info', label: '提示 info' },
                    ]}
                  />
                  <Input
                    size="small"
                    style={{ width: 260 }}
                    placeholder="告警名称匹配（子串或 glob），如 Disk*"
                    value={row.namePattern}
                    onChange={(event) =>
                      setMatchers((prev) => prev.map((entry, i) => (i === index ? { ...entry, namePattern: event.target.value } : entry)))
                    }
                  />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => setMatchers((prev) => prev.filter((_, i) => i !== index))}
                  />
                </Space>
              ))}
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() =>
                  setMatchers((prev) => [...prev, { key: `m-${prev.length}-${Math.random().toString(36).slice(2, 6)}` }])
                }
              >
                添加匹配器
              </Button>
            </Space>
          </Form.Item>

          <Form.Item name="allowedTools" label="允许的工具" tooltip="无人值守时只允许以下工具，范围外一律拒绝">
            <Select mode="multiple" showSearch optionFilterProp="label" placeholder="选择允许使用的平台工具" options={PLATFORM_TOOLS} />
          </Form.Item>
          <Form.Item name="modelValue" label="模型" tooltip="留空使用平台默认模型">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="provider / model"
              options={modelOptions(providers.data ?? [])}
            />
          </Form.Item>
          <Form.Item name="workflowId" label="绑定工作流" tooltip="触发后先执行该确定性流程">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="选择工作流（可留空）"
              options={(workflows.data ?? []).map((spec) => ({ value: spec.id, label: `${spec.name}（${spec.id}）` }))}
            />
          </Form.Item>
          <Form.Item name="runbookId" label="绑定巡检手册" tooltip="触发后执行该巡检（检查 + agent 分析）">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="选择巡检手册（可留空）"
              options={(runbooks.data ?? []).map((spec) => ({ value: spec.id, label: `${spec.name}（${spec.id}）` }))}
            />
          </Form.Item>
          <Form.Item name="notifyUrls" label="升级通知 Webhook">
            <Select mode="tags" tokenSeparators={[',']} placeholder="https://…（回车添加）" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </Space>
  )
}
