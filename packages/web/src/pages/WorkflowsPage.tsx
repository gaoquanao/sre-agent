/** 工作流页：零 LLM 确定性流程的编辑 / 运行 / 历史查看。 */
import { useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type {
  CheckKind,
  RunbookCheck,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepResult,
  WorkflowStepStatus,
  WorkflowStepType,
  WorkflowWhen,
} from '@sre/protocol'
import { api } from '../api'
import { useAsyncData } from '../hooks'
import { useWsEvent } from '../ws'
import { RunStatusTag } from '../components/StatusTags'
import { formatDuration, formatTime, isKebabCase, randomId, toKebabCase } from '../utils'
import type { TagMeta } from '../utils'
import type { WorkflowSpec } from '../types'

// --- presentation meta -------------------------------------------------------

const STEP_TYPE_META: Record<WorkflowStepType, { label: string; color: string }> = {
  check: { label: '检查', color: 'geekblue' },
  command: { label: '命令', color: 'orange' },
  approval: { label: '审批', color: 'gold' },
  notify: { label: '通知', color: 'cyan' },
}

const STEP_STATUS_META: Record<WorkflowStepStatus, TagMeta> = {
  ok: { label: '通过', color: 'green' },
  fail: { label: '失败', color: 'red' },
  error: { label: '错误', color: 'magenta' },
  skipped: { label: '跳过', color: 'default' },
  approved: { label: '已批准', color: 'cyan' },
  denied: { label: '已拒绝', color: 'red' },
  notified: { label: '已通知', color: 'blue' },
  'notify-failed': { label: '通知失败', color: 'orange' },
}

const TRIGGER_LABEL: Record<WorkflowRun['trigger'], string> = {
  manual: '手动',
  schedule: '定时',
  alert: '告警',
  agent: '智能体',
}

function StepStatusTag({ status }: { status: WorkflowStepStatus }): JSX.Element {
  const meta = STEP_STATUS_META[status] ?? { label: status, color: 'default' }
  return <Tag color={meta.color}>{meta.label}</Tag>
}

// --- editor row model --------------------------------------------------------
// WorkflowStep is a discriminated union; editing it directly is awkward, so the
// editor works on a flattened row shape and (de)serialises on open/save.

interface StepRow {
  id: string
  type: WorkflowStepType
  title: string
  /** check */
  kind: CheckKind
  target: string
  method?: 'GET' | 'POST' | 'HEAD'
  expectStatus?: number
  critical?: boolean
  expectContains?: string
  expectNotContains?: string
  /** check / command */
  cwd?: string
  timeoutSec?: number
  /** command */
  command: string
  stopOnFailure: boolean
  /** approval */
  reason: string
  timeoutMs?: number
  stopOnDeny: boolean
  /** notify */
  url: string
  /** conditional execution on an earlier step's result */
  whenEnabled: boolean
  whenStepId?: string
  whenField: WorkflowWhen['field']
  whenEquals: string
}

function stepToRow(step: WorkflowStep): StepRow {
  // The protocol's check variant omits `when` in its type even though the field
  // is part of the wire contract — read it through a safe widening cast.
  const when = (step as WorkflowStep & { when?: WorkflowWhen }).when
  const base: StepRow = {
    id: step.id,
    type: step.type,
    title: '',
    kind: 'http',
    target: '',
    command: '',
    stopOnFailure: true,
    reason: '',
    stopOnDeny: true,
    url: '',
    whenEnabled: when !== undefined,
    whenStepId: when?.stepId,
    whenField: when?.field ?? 'ok',
    whenEquals: when !== undefined ? String(when.equals) : '',
  }
  switch (step.type) {
    case 'check':
      return {
        ...base,
        kind: step.kind,
        title: step.title,
        target: step.target,
        method: step.method,
        expectStatus: step.expectStatus,
        cwd: step.cwd,
        timeoutSec: step.timeoutSec,
        critical: step.critical ?? true,
        expectContains: step.expectContains,
        expectNotContains: step.expectNotContains,
      }
    case 'command':
      return {
        ...base,
        title: step.title,
        command: step.command,
        cwd: step.cwd,
        timeoutSec: step.timeoutSec,
        stopOnFailure: step.stopOnFailure ?? true,
      }
    case 'approval':
      return { ...base, title: step.title, reason: step.reason, timeoutMs: step.timeoutMs, stopOnDeny: step.stopOnDeny ?? true }
    case 'notify':
      return { ...base, title: step.title, url: step.url }
  }
}

function parseWhenEquals(raw: string): string | number {
  const trimmed = raw.trim()
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed)
  return trimmed
}

function rowToStep(row: StepRow): WorkflowStep {
  const when: WorkflowWhen | undefined =
    row.whenEnabled && row.whenStepId
      ? { stepId: row.whenStepId, field: row.whenField, equals: parseWhenEquals(row.whenEquals) }
      : undefined
  const title = row.title.trim() || row.id
  if (row.type === 'check') {
    // `when` is not in the published check-variant type but is part of the wire
    // contract; the cast keeps the round-trip lossless.
    const checkStep: { id: string; type: 'check' } & RunbookCheck = {
      id: row.id,
      type: 'check',
      kind: row.kind,
      title,
      target: row.target.trim(),
      ...(row.method ? { method: row.method } : {}),
      ...(row.expectStatus !== undefined ? { expectStatus: row.expectStatus } : {}),
      ...(row.cwd ? { cwd: row.cwd } : {}),
      ...(row.timeoutSec !== undefined ? { timeoutSec: row.timeoutSec } : {}),
      ...(row.critical !== undefined ? { critical: row.critical } : {}),
      ...(row.expectContains ? { expectContains: row.expectContains } : {}),
      ...(row.expectNotContains ? { expectNotContains: row.expectNotContains } : {}),
    }
    return (when ? { ...checkStep, when } : checkStep) as WorkflowStep
  }
  if (row.type === 'command') {
    return {
      id: row.id,
      type: 'command',
      title,
      command: row.command,
      ...(row.cwd ? { cwd: row.cwd } : {}),
      ...(row.timeoutSec !== undefined ? { timeoutSec: row.timeoutSec } : {}),
      stopOnFailure: row.stopOnFailure,
      ...(when ? { when } : {}),
    }
  }
  if (row.type === 'approval') {
    return {
      id: row.id,
      type: 'approval',
      title,
      reason: row.reason,
      ...(row.timeoutMs !== undefined ? { timeoutMs: row.timeoutMs } : {}),
      stopOnDeny: row.stopOnDeny,
      ...(when ? { when } : {}),
    }
  }
  return {
    id: row.id,
    type: 'notify',
    title,
    url: row.url.trim(),
    ...(when ? { when } : {}),
  }
}

function newStepRow(type: WorkflowStepType): StepRow {
  return {
    id: randomId('step'),
    type,
    title: '',
    kind: 'http',
    target: '',
    command: '',
    stopOnFailure: true,
    reason: '',
    stopOnDeny: true,
    url: '',
    timeoutSec: type === 'command' || type === 'check' ? 30 : undefined,
    whenEnabled: false,
    whenField: 'ok',
    whenEquals: '',
  }
}

interface WorkflowFormValues {
  id: string
  name: string
  description?: string
  enabled: boolean
}

// --- run detail --------------------------------------------------------------

function WorkflowRunDetail({ run }: { run: WorkflowRun }): JSX.Element {
  const finishedAt = run.finishedAt ?? Date.now()
  const stepColumns: ColumnsType<WorkflowStepResult> = [
    { title: '步骤', dataIndex: 'stepId', width: 150, render: (_v, record) => <span className="mono">{record.stepId}</span> },
    {
      title: '类型',
      dataIndex: 'type',
      width: 80,
      render: (_v, record) => <Tag color={STEP_TYPE_META[record.type]?.color}>{STEP_TYPE_META[record.type]?.label ?? record.type}</Tag>,
    },
    { title: '标题', dataIndex: 'title', width: 180 },
    { title: '状态', dataIndex: 'status', width: 90, render: (_v, record) => <StepStatusTag status={record.status} /> },
    {
      title: '说明',
      dataIndex: 'detail',
      render: (_v, record) => (
        <Tooltip title={record.detail} placement="topLeft">
          <Typography.Text type="secondary" ellipsis style={{ maxWidth: 320 }}>
            {record.detail}
          </Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 90,
      render: (_v, record) => formatDuration(record.durationMs),
    },
  ]
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={8} wrap>
        <RunStatusTag status={run.status} />
        {run.workflowName ? <Tag>{run.workflowName}</Tag> : <Tag>{run.workflowId}</Tag>}
        <Tag color="blue">{TRIGGER_LABEL[run.trigger] ?? run.trigger}</Tag>
        <Typography.Text type="secondary">开始 {formatTime(run.startedAt)}</Typography.Text>
        <Typography.Text type="secondary">耗时 {formatDuration(finishedAt - run.startedAt)}</Typography.Text>
        <Typography.Text type="secondary" className="mono">
          {run.id}
        </Typography.Text>
      </Space>
      {run.error ? <Alert type="error" showIcon message={run.error} /> : null}
      <Table<WorkflowStepResult>
        size="small"
        rowKey={(record) => record.stepId}
        dataSource={run.steps}
        columns={stepColumns}
        pagination={false}
        expandable={{
          expandedRowRender: (record) =>
            record.output ? <pre className="sre-json" style={{ maxHeight: 240 }}>{record.output}</pre> : null,
          rowExpandable: (record) => Boolean(record.output),
        }}
      />
      {run.report ? (
        <Card size="small" title="执行报告">
          <pre className="sre-pre">{run.report}</pre>
        </Card>
      ) : null}
    </Space>
  )
}

// --- page --------------------------------------------------------------------

export default function WorkflowsPage(): JSX.Element {
  const { message } = AntApp.useApp()
  const [tab, setTab] = useState('flows')

  const workflows = useAsyncData(() => api.workflows(), [])
  const [runFilter, setRunFilter] = useState<string | undefined>(undefined)
  const runs = useAsyncData(() => api.workflowRuns(50, runFilter), [runFilter])

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [steps, setSteps] = useState<StepRow[]>([])
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<WorkflowFormValues>()

  const [runningId, setRunningId] = useState<string | null>(null)
  const [activeRun, setActiveRun] = useState<WorkflowRun | null>(null)

  useWsEvent('workflow_run_updated', (msg) => {
    runs.setData((prev) => {
      const list = prev ?? []
      const index = list.findIndex((entry) => entry.id === msg.run.id)
      if (index < 0) return [msg.run, ...list]
      return list.map((entry) => (entry.id === msg.run.id ? msg.run : entry))
    })
    setActiveRun((prev) => (prev && prev.id === msg.run.id ? msg.run : prev))
  })

  // --- editor ----------------------------------------------------------------

  function openEditor(spec?: WorkflowSpec): void {
    setEditingId(spec?.id ?? null)
    form.setFieldsValue({
      id: spec?.id ?? '',
      name: spec?.name ?? '',
      description: spec?.description ?? '',
      enabled: spec?.enabled ?? true,
    })
    setSteps(spec ? spec.steps.map(stepToRow) : [])
    setEditorOpen(true)
  }

  function updateRow(index: number, patch: Partial<StepRow>): void {
    setSteps((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function moveRow(index: number, delta: -1 | 1): void {
    setSteps((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(index, 1)
      if (moved === undefined) return prev
      next.splice(target, 0, moved)
      return next
    })
  }

  /** Validates the flattened rows; returns presentation errors, or null when ok. */
  function validateRows(): string | null {
    const ids = new Set<string>()
    for (let i = 0; i < steps.length; i++) {
      const row = steps[i]
      if (!row) continue
      const label = `第 ${i + 1} 步`
      const id = row.id.trim()
      if (!id) return `${label}：步骤 ID 不能为空`
      if (!isKebabCase(id)) return `${label}：步骤 ID「${id}」需为 kebab-case（小写字母、数字、连字符）`
      if (ids.has(id)) return `${label}：步骤 ID「${id}」重复`
      ids.add(id)
      if (row.type === 'check' && !row.target.trim()) return `${label}：检查目标不能为空`
      if (row.type === 'command' && !row.command.trim()) return `${label}：命令不能为空`
      if (row.type === 'approval' && !row.reason.trim()) return `${label}：审批事由不能为空`
      if (row.type === 'notify' && !row.url.trim()) return `${label}：通知 URL 不能为空`
      if (row.whenEnabled) {
        if (!row.whenStepId) return `${label}：条件执行未选择前置步骤`
        const refIndex = steps.findIndex((entry) => entry.id === row.whenStepId)
        if (refIndex < 0 || refIndex >= i) return `${label}：条件只能引用当前步骤之前的结果`
        if (row.whenEquals.trim() === '') return `${label}：条件「等于」值不能为空`
      }
    }
    return null
  }

  async function saveWorkflow(): Promise<void> {
    let values: WorkflowFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    const problem = validateRows()
    if (problem) {
      void message.error(problem)
      return
    }
    const id = values.id.trim()
    const payload = {
      name: values.name.trim(),
      description: values.description?.trim() ?? '',
      steps: steps.map(rowToStep),
      enabled: values.enabled,
    }
    setSaving(true)
    try {
      await api.putWorkflow(id, payload)
      setEditorOpen(false)
      workflows.reload()
      void message.success(`工作流已保存：${payload.name}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setSaving(false)
    }
  }

  async function deleteWorkflow(spec: WorkflowSpec): Promise<void> {
    try {
      await api.deleteWorkflow(spec.id)
      workflows.reload()
      void message.success(`已删除工作流：${spec.name}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function runNow(spec: WorkflowSpec): Promise<void> {
    setRunningId(spec.id)
    try {
      const record = await api.runWorkflow(spec.id)
      setActiveRun(record)
      runs.reload()
      setTab('runs')
      void message.success(`工作流已执行完成：${spec.name}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setRunningId(null)
    }
  }

  // --- render ----------------------------------------------------------------

  const workflowColumns: ColumnsType<WorkflowSpec> = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 220,
      render: (_v, record) => (
        <Space size={4} direction="vertical">
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
            {record.id}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '描述', dataIndex: 'description', render: (_v, record) => record.description || '-' },
    {
      title: '步骤',
      dataIndex: 'steps',
      width: 240,
      render: (_v, record) => (
        <Space size={4} wrap>
          {(Object.keys(STEP_TYPE_META) as WorkflowStepType[]).map((type) => {
            const count = record.steps.filter((step) => step.type === type).length
            if (count === 0) return null
            return (
              <Tag key={type} color={STEP_TYPE_META[type].color}>
                {STEP_TYPE_META[type].label} {count}
              </Tag>
            )
          })}
          {record.steps.length === 0 ? <Typography.Text type="secondary">无步骤</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (_v, record) => (record.enabled ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
    },
    { title: '更新时间', dataIndex: 'updatedAt', width: 160, render: (_v, record) => formatTime(record.updatedAt) },
    {
      title: '操作',
      key: 'ops',
      width: 210,
      fixed: 'right',
      render: (_v, record) => (
        <Space size={4}>
          <Tooltip title="同步执行；含审批步骤的流程会等待操作者处理">
            <Button
              size="small"
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={runningId === record.id}
              onClick={() => void runNow(record)}
            >
              运行
            </Button>
          </Tooltip>
          <Button size="small" onClick={() => openEditor(record)}>
            编辑
          </Button>
          <Popconfirm title="删除该工作流？" okText="删除" cancelText="取消" onConfirm={() => void deleteWorkflow(record)}>
            <Button size="small" danger type="text" icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const runColumns: ColumnsType<WorkflowRun> = [
    { title: '状态', dataIndex: 'status', width: 90, render: (_v, record) => <RunStatusTag status={record.status} /> },
    {
      title: '工作流',
      dataIndex: 'workflowName',
      width: 200,
      render: (_v, record) => record.workflowName ?? record.workflowId,
    },
    {
      title: '触发方式',
      dataIndex: 'trigger',
      width: 90,
      render: (_v, record) => <Tag color="blue">{TRIGGER_LABEL[record.trigger] ?? record.trigger}</Tag>,
    },
    { title: '开始时间', dataIndex: 'startedAt', width: 170, render: (_v, record) => formatTime(record.startedAt) },
    {
      title: '耗时',
      dataIndex: 'finishedAt',
      width: 100,
      render: (_v, record) => formatDuration((record.finishedAt ?? Date.now()) - record.startedAt),
    },
    {
      title: '步骤结果',
      dataIndex: 'steps',
      width: 200,
      render: (_v, record) => {
        const ok = record.steps.filter((step) => step.status === 'ok' || step.status === 'approved' || step.status === 'notified')
          .length
        const bad = record.steps.filter((step) =>
          ['fail', 'error', 'denied', 'notify-failed'].includes(step.status),
        ).length
        return (
          <Space size={4}>
            <Tag color="green">成功 {ok}</Tag>
            {bad > 0 ? <Tag color="red">异常 {bad}</Tag> : null}
            <Typography.Text type="secondary">共 {record.steps.length}</Typography.Text>
          </Space>
        )
      },
    },
    {
      title: '操作',
      key: 'ops',
      width: 100,
      render: (_v, record) => (
        <Button size="small" onClick={() => setActiveRun(record)}>
          详情
        </Button>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {workflows.error ? <Alert type="error" showIcon message={`工作流加载失败：${workflows.error}`} /> : null}

      <Alert
        type="info"
        showIcon
        message="工作流是零 LLM 的确定性流程：固定处理路径直接执行，command / approval 步骤全部审计；审批步骤会创建待审批并阻塞等待"
      />

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'flows',
            label: '流程',
            children: (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Space>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>
                    新建工作流
                  </Button>
                  <Button icon={<ReloadOutlined />} onClick={workflows.reload} loading={workflows.loading}>
                    刷新
                  </Button>
                </Space>
                <Table<WorkflowSpec>
                  size="small"
                  rowKey="id"
                  loading={workflows.loading}
                  dataSource={workflows.data ?? []}
                  columns={workflowColumns}
                  scroll={{ x: 1100 }}
                  pagination={false}
                  locale={{ emptyText: '暂无工作流，点击「新建工作流」创建确定性处置流程' }}
                />
              </Space>
            ),
          },
          {
            key: 'runs',
            label: '运行历史',
            children: (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Space size={8} wrap>
                  <Button icon={<ReloadOutlined />} onClick={runs.reload} loading={runs.loading}>
                    刷新
                  </Button>
                  <Select
                    size="small"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    style={{ minWidth: 220 }}
                    placeholder="按工作流过滤（可留空）"
                    value={runFilter}
                    onChange={(value) => setRunFilter(value)}
                    options={(workflows.data ?? []).map((spec) => ({ value: spec.id, label: `${spec.name}（${spec.id}）` }))}
                  />
                  <Typography.Text type="secondary">最近 50 条运行记录，状态经 WebSocket 实时刷新</Typography.Text>
                </Space>
                <Table<WorkflowRun>
                  size="small"
                  rowKey="id"
                  loading={runs.loading}
                  dataSource={runs.data ?? []}
                  columns={runColumns}
                  scroll={{ x: 1050 }}
                  pagination={false}
                  locale={{ emptyText: '暂无运行记录' }}
                />
              </Space>
            ),
          },
        ]}
      />

      <Drawer
        title={editingId ? `编辑工作流：${editingId}` : '新建工作流'}
        width={880}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setEditorOpen(false)}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => void saveWorkflow()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form<WorkflowFormValues> form={form} layout="vertical">
          <Form.Item
            name="id"
            label="工作流 ID"
            tooltip="kebab-case，作为存储与调用的唯一标识"
            rules={[
              { required: true, message: '请输入工作流 ID' },
              {
                validator: (_rule, value: string) =>
                  !value || isKebabCase(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error('只能使用小写字母、数字和连字符，例如 disk-cleanup')),
              },
            ]}
          >
            <Input
              disabled={editingId !== null}
              placeholder="disk-cleanup"
              onChange={(event) => {
                if (editingId !== null) return
                const next = toKebabCase(event.target.value)
                const name = form.getFieldValue('name') as string | undefined
                if (!name) form.setFieldValue('name', next)
              }}
            />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="磁盘清理处置" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input placeholder="一句话说明这条固定处理路径做什么" />
          </Form.Item>
        </Form>

        <Typography.Title level={5} style={{ marginTop: 8 }}>
          步骤（按顺序执行）
        </Typography.Title>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {steps.map((row, index) => {
            const typeMeta = STEP_TYPE_META[row.type] ?? { label: row.type, color: 'default' }
            const previousSteps = steps
              .slice(0, index)
              .filter((entry) => entry.id.trim())
              .map((entry) => ({ value: entry.id, label: `${entry.id}（${STEP_TYPE_META[entry.type]?.label ?? entry.type}）` }))
            return (
              <Card
                key={index}
                size="small"
                title={
                  <Space size={6}>
                    <span className="mono">#{index + 1}</span>
                    <Tag color={typeMeta.color}>{typeMeta.label}</Tag>
                    {row.whenEnabled ? <Tag color="purple">条件执行</Tag> : null}
                  </Space>
                }
                extra={
                  <Space size={0}>
                    <Tooltip title="上移">
                      <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => moveRow(index, -1)} />
                    </Tooltip>
                    <Tooltip title="下移">
                      <Button
                        size="small"
                        type="text"
                        icon={<ArrowDownOutlined />}
                        disabled={index === steps.length - 1}
                        onClick={() => moveRow(index, 1)}
                      />
                    </Tooltip>
                    <Popconfirm
                      title="删除该步骤？"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => setSteps((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                }
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Space size={8} wrap>
                    <span>
                      步骤 ID{' '}
                      <Input
                        size="small"
                        className="mono"
                        style={{ width: 180 }}
                        value={row.id}
                        onChange={(event) => updateRow(index, { id: event.target.value })}
                      />
                    </span>
                    <span>
                      标题{' '}
                      <Input
                        size="small"
                        style={{ width: 220 }}
                        placeholder="用于报告与审计的名称"
                        value={row.title}
                        onChange={(event) => updateRow(index, { title: event.target.value })}
                      />
                    </span>
                  </Space>

                  {row.type === 'check' ? (
                    <Space size={8} wrap>
                      <span>
                        检查类型{' '}
                        <Select
                          size="small"
                          style={{ width: 100 }}
                          value={row.kind}
                          onChange={(value) => updateRow(index, { kind: value })}
                          options={[
                            { value: 'http', label: 'HTTP' },
                            { value: 'shell', label: 'Shell' },
                            { value: 'tcp', label: 'TCP' },
                          ]}
                        />
                      </span>
                      <span>
                        目标{' '}
                        <Input
                          size="small"
                          className="mono"
                          style={{ width: 280 }}
                          placeholder={row.kind === 'http' ? 'https://…' : row.kind === 'tcp' ? 'host:port' : '命令'}
                          value={row.target}
                          onChange={(event) => updateRow(index, { target: event.target.value })}
                        />
                      </span>
                      {row.kind === 'http' ? (
                        <>
                          <span>
                            方法{' '}
                            <Select
                              size="small"
                              allowClear
                              style={{ width: 90 }}
                              value={row.method}
                              onChange={(value) => updateRow(index, { method: value })}
                              options={[
                                { value: 'GET', label: 'GET' },
                                { value: 'POST', label: 'POST' },
                                { value: 'HEAD', label: 'HEAD' },
                              ]}
                            />
                          </span>
                          <span>
                            期望状态码{' '}
                            <InputNumber
                              size="small"
                              value={row.expectStatus}
                              placeholder="200"
                              onChange={(value) => updateRow(index, { expectStatus: value ?? undefined })}
                            />
                          </span>
                        </>
                      ) : null}
                      <span>
                        超时(s){' '}
                        <InputNumber
                          size="small"
                          min={1}
                          value={row.timeoutSec}
                          onChange={(value) => updateRow(index, { timeoutSec: value ?? undefined })}
                        />
                      </span>
                      <span>
                        关键 <Switch size="small" checked={row.critical ?? true} onChange={(value) => updateRow(index, { critical: value })} />
                      </span>
                    </Space>
                  ) : null}

                  {row.type === 'command' ? (
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      <Input.TextArea
                        rows={2}
                        className="mono"
                        placeholder="确定执行的运维命令，例如 df -h / && journalctl -u nginx --since '10 min ago'"
                        value={row.command}
                        onChange={(event) => updateRow(index, { command: event.target.value })}
                      />
                      <Space size={8} wrap>
                        <span>
                          工作目录{' '}
                          <Input
                            size="small"
                            className="mono"
                            style={{ width: 200 }}
                            placeholder="留空使用默认"
                            value={row.cwd ?? ''}
                            onChange={(event) => updateRow(index, { cwd: event.target.value || undefined })}
                          />
                        </span>
                        <span>
                          超时(s){' '}
                          <InputNumber
                            size="small"
                            min={1}
                            value={row.timeoutSec}
                            onChange={(value) => updateRow(index, { timeoutSec: value ?? undefined })}
                          />
                        </span>
                        <span>
                          失败即停 <Switch size="small" checked={row.stopOnFailure} onChange={(value) => updateRow(index, { stopOnFailure: value })} />
                        </span>
                      </Space>
                    </Space>
                  ) : null}

                  {row.type === 'approval' ? (
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      <Input.TextArea
                        rows={2}
                        placeholder="向操作者说明为什么需要审批，例如：将删除 /var/log 下 30 天前的归档日志"
                        value={row.reason}
                        onChange={(event) => updateRow(index, { reason: event.target.value })}
                      />
                      <Space size={8} wrap>
                        <span>
                          超时(ms){' '}
                          <InputNumber
                            size="small"
                            min={1000}
                            step={60000}
                            value={row.timeoutMs}
                            placeholder="留空不限"
                            onChange={(value) => updateRow(index, { timeoutMs: value ?? undefined })}
                          />
                        </span>
                        <span>
                          拒绝即停 <Switch size="small" checked={row.stopOnDeny} onChange={(value) => updateRow(index, { stopOnDeny: value })} />
                        </span>
                      </Space>
                    </Space>
                  ) : null}

                  {row.type === 'notify' ? (
                    <Input
                      className="mono"
                      placeholder="https://hook.example.com/…"
                      addonBefore="Webhook"
                      value={row.url}
                      onChange={(event) => updateRow(index, { url: event.target.value })}
                    />
                  ) : null}

                  <div>
                    <Checkbox checked={row.whenEnabled} onChange={(event) => updateRow(index, { whenEnabled: event.target.checked })}>
                      条件执行（仅当前置步骤结果匹配时执行）
                    </Checkbox>
                    {row.whenEnabled ? (
                      <Space size={8} wrap style={{ marginTop: 6 }}>
                        <span>
                          前置步骤{' '}
                          <Select
                            size="small"
                            style={{ width: 220 }}
                            placeholder="选择之前的步骤"
                            value={row.whenStepId}
                            onChange={(value) => updateRow(index, { whenStepId: value })}
                            options={previousSteps}
                          />
                        </span>
                        <span>
                          字段{' '}
                          <Select
                            size="small"
                            style={{ width: 180 }}
                            value={row.whenField}
                            onChange={(value) => updateRow(index, { whenField: value })}
                            options={[
                              { value: 'ok', label: 'ok（是否成功）' },
                              { value: 'status', label: 'status（状态）' },
                              { value: 'exitCode', label: 'exitCode（退出码）' },
                            ]}
                          />
                        </span>
                        <span>
                          等于{' '}
                          <Input
                            size="small"
                            className="mono"
                            style={{ width: 120 }}
                            placeholder="true / 0"
                            value={row.whenEquals}
                            onChange={(event) => updateRow(index, { whenEquals: event.target.value })}
                          />
                        </span>
                      </Space>
                    ) : null}
                  </div>
                </Space>
              </Card>
            )
          })}

          <Space size={8} wrap>
            <Button icon={<PlusOutlined />} onClick={() => setSteps((prev) => [...prev, newStepRow('command')])}>
              添加命令步骤
            </Button>
            <Button icon={<PlusOutlined />} onClick={() => setSteps((prev) => [...prev, newStepRow('check')])}>
              添加检查步骤
            </Button>
            <Button icon={<PlusOutlined />} onClick={() => setSteps((prev) => [...prev, newStepRow('approval')])}>
              添加审批步骤
            </Button>
            <Button icon={<PlusOutlined />} onClick={() => setSteps((prev) => [...prev, newStepRow('notify')])}>
              添加通知步骤
            </Button>
            {steps.length === 0 ? (
              <Typography.Text type="secondary">尚无步骤，至少添加一步；步骤顺序即执行顺序</Typography.Text>
            ) : null}
          </Space>
        </Space>
      </Drawer>

      <Modal
        title="运行详情"
        open={activeRun !== null}
        width={960}
        footer={null}
        onCancel={() => setActiveRun(null)}
      >
        {activeRun ? <WorkflowRunDetail run={activeRun} /> : null}
      </Modal>
    </Space>
  )
}
