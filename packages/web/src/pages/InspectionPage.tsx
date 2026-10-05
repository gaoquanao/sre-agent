/** 巡检页：Runbook 编辑/执行、执行历史、定时任务。 */
import { useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
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
import { DeleteOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { Link } from 'react-router-dom'
import type { CheckFinding, RunbookCheck, RunbookSpec, RunRecord, ScheduleSpec } from '@sre/protocol'
import { api } from '../api'
import { useAsyncData } from '../hooks'
import { useWsEvent } from '../ws'
import { CheckKindTag, FindingStatusTag, RunStatusTag } from '../components/StatusTags'
import { formatDuration, formatTime, isKebabCase, randomId, toKebabCase } from '../utils'

interface RunbookFormValues {
  id: string
  name: string
  description?: string
  prompt?: string
  allowedTools?: string[]
  notify?: string[]
  enabled: boolean
}

interface ScheduleFormValues {
  id: string
  runbookId: string
  cron: string
  timezone?: string
  enabled: boolean
}

const findingColumns: ColumnsType<CheckFinding> = [
  { title: '状态', dataIndex: 'status', width: 80, render: (_v, record) => <FindingStatusTag status={record.status} /> },
  { title: '标题', dataIndex: 'title', width: 220 },
  {
    title: '类型',
    dataIndex: 'kind',
    width: 80,
    render: (_v, record) => <CheckKindTag kind={record.kind} />,
  },
  { title: '目标', dataIndex: 'target', render: (_v, record) => <span className="mono">{record.target}</span> },
  {
    title: '耗时',
    dataIndex: 'durationMs',
    width: 90,
    render: (_v, record) => formatDuration(record.durationMs),
  },
  {
    title: '说明',
    dataIndex: 'detail',
    render: (_v, record) => (
      <Tooltip title={record.detail}>
        <Typography.Text type="secondary">{record.detail}</Typography.Text>
      </Tooltip>
    ),
  },
]

function RunDetail({ run }: { run: RunRecord }): JSX.Element {
  const finishedAt = run.finishedAt ?? Date.now()
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={8} wrap>
        <RunStatusTag status={run.status} />
        {run.runbookName ? <Tag>{run.runbookName}</Tag> : <Tag>{run.runbookId}</Tag>}
        <Typography.Text type="secondary">开始 {formatTime(run.startedAt)}</Typography.Text>
        <Typography.Text type="secondary">耗时 {formatDuration(finishedAt - run.startedAt)}</Typography.Text>
        {run.sessionId ? (
          <Link to={`/?session=${encodeURIComponent(run.sessionId)}`}>查看巡检会话</Link>
        ) : null}
        <Typography.Text type="secondary" className="mono">
          {run.id}
        </Typography.Text>
      </Space>
      {run.error ? <Alert type="error" showIcon message={run.error} /> : null}
      <Table<CheckFinding>
        size="small"
        rowKey={(record) => record.checkId}
        dataSource={run.findings}
        columns={findingColumns}
        pagination={false}
        expandable={{
          expandedRowRender: (record) => (
            <pre className="sre-json" style={{ maxHeight: 240 }}>
              {record.output ?? record.detail}
            </pre>
          ),
        }}
      />
      {run.report ? (
        <Card size="small" title="巡检报告">
          <pre className="sre-pre">{run.report}</pre>
        </Card>
      ) : null}
    </Space>
  )
}

export default function InspectionPage(): JSX.Element {
  const { message } = AntApp.useApp()
  const [tab, setTab] = useState('runbooks')

  const runbooks = useAsyncData(() => api.runbooks(), [])
  const runs = useAsyncData(() => api.runs(50), [])
  const schedules = useAsyncData(() => api.schedules(), [])

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [checks, setChecks] = useState<RunbookCheck[]>([])
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<RunbookFormValues>()

  const [runningId, setRunningId] = useState<string | null>(null)
  const [activeRun, setActiveRun] = useState<RunRecord | null>(null)

  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleEditing, setScheduleEditing] = useState<string | null>(null)
  const [scheduleForm] = Form.useForm<ScheduleFormValues>()

  // --- runbooks -------------------------------------------------------------

  function openEditor(spec?: RunbookSpec): void {
    setEditingId(spec?.id ?? null)
    form.setFieldsValue({
      id: spec?.id ?? '',
      name: spec?.name ?? '',
      description: spec?.description ?? '',
      prompt: spec?.prompt ?? '',
      allowedTools: spec?.allowedTools ?? [],
      notify: spec?.notify ?? [],
      enabled: spec?.enabled ?? true,
    })
    setChecks(spec ? spec.checks.map((check) => ({ ...check })) : [])
    setEditorOpen(true)
  }

  async function saveRunbook(): Promise<void> {
    let values: RunbookFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    const id = values.id.trim()
    const spec: RunbookSpec = {
      id,
      name: values.name.trim(),
      description: values.description?.trim() ?? '',
      prompt: values.prompt ?? '',
      checks: checks.map((check) => ({
        ...check,
        id: check.id.trim() || randomId('check'),
        title: check.title.trim() || check.id,
        target: check.target.trim(),
      })),
      allowedTools: (values.allowedTools ?? []).map((tool) => tool.trim()).filter(Boolean),
      notify: (values.notify ?? []).map((url) => url.trim()).filter(Boolean),
      enabled: values.enabled,
      updatedAt: Date.now(),
    }
    setSaving(true)
    try {
      await api.putRunbook(id, spec)
      setEditorOpen(false)
      runbooks.reload()
      void message.success(`巡检手册已保存：${spec.name}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setSaving(false)
    }
  }

  async function deleteRunbook(spec: RunbookSpec): Promise<void> {
    try {
      await api.deleteRunbook(spec.id)
      runbooks.reload()
      void message.success(`已删除巡检手册：${spec.name}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function runNow(spec: RunbookSpec): Promise<void> {
    setRunningId(spec.id)
    try {
      const record = await api.runRunbook(spec.id)
      setActiveRun(record)
      runs.reload()
      setTab('runs')
      void message.success(`已触发巡检：${spec.name}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setRunningId(null)
    }
  }

  function updateCheck(index: number, patch: Partial<RunbookCheck>): void {
    setChecks((prev) => prev.map((check, i) => (i === index ? { ...check, ...patch } : check)))
  }

  const checkColumns: ColumnsType<RunbookCheck> = [
    {
      title: '类型',
      dataIndex: 'kind',
      width: 110,
      render: (_v, _record, index) => (
        <Select
          size="small"
          value={checks[index]?.kind ?? 'http'}
          style={{ width: '100%' }}
          onChange={(value) => updateCheck(index, { kind: value })}
          options={[
            { value: 'http', label: 'HTTP' },
            { value: 'shell', label: 'Shell' },
            { value: 'tcp', label: 'TCP' },
          ]}
        />
      ),
    },
    {
      title: '标题',
      dataIndex: 'title',
      width: 180,
      render: (_v, _record, index) => (
        <Input
          size="small"
          value={checks[index]?.title ?? ''}
          placeholder="用于报告的检查项名称"
          onChange={(event) => updateCheck(index, { title: event.target.value })}
        />
      ),
    },
    {
      title: '目标',
      dataIndex: 'target',
      width: 220,
      render: (_v, _record, index) => (
        <Input
          size="small"
          className="mono"
          value={checks[index]?.target ?? ''}
          placeholder={checks[index]?.kind === 'http' ? 'https://…' : checks[index]?.kind === 'tcp' ? 'host:port' : '命令'}
          onChange={(event) => updateCheck(index, { target: event.target.value })}
        />
      ),
    },
    {
      title: '方法',
      dataIndex: 'method',
      width: 100,
      render: (_v, _record, index) =>
        checks[index]?.kind === 'http' ? (
          <Select
            size="small"
            allowClear
            value={checks[index]?.method}
            style={{ width: '100%' }}
            onChange={(value) => updateCheck(index, { method: value })}
            options={[
              { value: 'GET', label: 'GET' },
              { value: 'POST', label: 'POST' },
              { value: 'HEAD', label: 'HEAD' },
            ]}
          />
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: '期望状态码',
      dataIndex: 'expectStatus',
      width: 120,
      render: (_v, _record, index) =>
        checks[index]?.kind === 'http' ? (
          <InputNumber
            size="small"
            value={checks[index]?.expectStatus}
            placeholder="200"
            onChange={(value) => updateCheck(index, { expectStatus: value ?? undefined })}
          />
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: '超时(s)',
      dataIndex: 'timeoutSec',
      width: 100,
      render: (_v, _record, index) => (
        <InputNumber
          size="small"
          min={1}
          value={checks[index]?.timeoutSec}
          onChange={(value) => updateCheck(index, { timeoutSec: value ?? undefined })}
        />
      ),
    },
    {
      title: '关键',
      dataIndex: 'critical',
      width: 70,
      render: (_v, _record, index) => (
        <Switch
          size="small"
          checked={checks[index]?.critical ?? true}
          onChange={(value) => updateCheck(index, { critical: value })}
        />
      ),
    },
    {
      title: '必须包含',
      dataIndex: 'expectContains',
      width: 150,
      render: (_v, _record, index) => (
        <Input
          size="small"
          value={checks[index]?.expectContains ?? ''}
          onChange={(event) => updateCheck(index, { expectContains: event.target.value })}
        />
      ),
    },
    {
      title: '禁止包含',
      dataIndex: 'expectNotContains',
      width: 150,
      render: (_v, _record, index) => (
        <Input
          size="small"
          value={checks[index]?.expectNotContains ?? ''}
          onChange={(event) => updateCheck(index, { expectNotContains: event.target.value })}
        />
      ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 70,
      fixed: 'right',
      render: (_v, _record, index) => (
        <Button
          size="small"
          type="text"
          danger
          icon={<DeleteOutlined />}
          onClick={() => setChecks((prev) => prev.filter((_, i) => i !== index))}
        />
      ),
    },
  ]

  // --- schedules ------------------------------------------------------------

  function openSchedule(spec?: ScheduleSpec): void {
    setScheduleEditing(spec?.id ?? null)
    scheduleForm.setFieldsValue({
      id: spec?.id ?? '',
      runbookId: spec?.runbookId ?? (runbooks.data?.[0]?.id ?? ''),
      cron: spec?.cron ?? '*/15 * * * *',
      timezone: spec?.timezone ?? 'Asia/Shanghai',
      enabled: spec?.enabled ?? true,
    })
    setScheduleOpen(true)
  }

  async function saveSchedule(): Promise<void> {
    let values: ScheduleFormValues
    try {
      values = await scheduleForm.validateFields()
    } catch {
      return
    }
    const spec: ScheduleSpec = {
      id: values.id.trim(),
      runbookId: values.runbookId,
      cron: values.cron.trim(),
      timezone: values.timezone?.trim() || undefined,
      enabled: values.enabled,
    }
    try {
      await api.putSchedule(spec.id, spec)
      setScheduleOpen(false)
      schedules.reload()
      void message.success(`定时任务已保存：${spec.id}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function toggleSchedule(spec: ScheduleSpec, enabled: boolean): Promise<void> {
    try {
      await api.putSchedule(spec.id, { ...spec, enabled })
      schedules.reload()
      void message.success(enabled ? '定时任务已启用' : '定时任务已停用')
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function deleteSchedule(spec: ScheduleSpec): Promise<void> {
    try {
      await api.deleteSchedule(spec.id)
      schedules.reload()
      void message.success('定时任务已删除')
    } catch {
      /* surfaced by the API layer */
    }
  }

  useWsEvent('run_updated', (msg) => {
    runs.setData((prev) => {
      const list = prev ?? []
      const index = list.findIndex((entry) => entry.id === msg.run.id)
      if (index < 0) return [msg.run, ...list]
      return list.map((entry) => (entry.id === msg.run.id ? msg.run : entry))
    })
    setActiveRun((prev) => (prev && prev.id === msg.run.id ? msg.run : prev))
  })

  useWsEvent('schedule_fired', (msg) => {
    void message.info(`定时任务已触发：${msg.scheduleId}`)
    runs.reload()
    schedules.reload()
  })

  // --- render ---------------------------------------------------------------

  const runbookColumns: ColumnsType<RunbookSpec> = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 200,
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
    { title: '检查项', dataIndex: 'checks', width: 90, render: (_v, record) => `${record.checks.length} 项` },
    {
      title: '允许工具',
      dataIndex: 'allowedTools',
      width: 220,
      render: (_v, record) =>
        record.allowedTools.length === 0 ? (
          <Typography.Text type="secondary">未限制</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {record.allowedTools.slice(0, 4).map((tool) => (
              <Tag key={tool} className="mono">
                {tool}
              </Tag>
            ))}
            {record.allowedTools.length > 4 ? <Tag>+{record.allowedTools.length - 4}</Tag> : null}
          </Space>
        ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (_v, record) => (record.enabled ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 160,
      render: (_v, record) => formatTime(record.updatedAt),
    },
    {
      title: '操作',
      key: 'ops',
      width: 210,
      fixed: 'right',
      render: (_v, record) => (
        <Space size={4}>
          <Button
            size="small"
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={runningId === record.id}
            onClick={() => void runNow(record)}
          >
            立即执行
          </Button>
          <Button size="small" onClick={() => openEditor(record)}>
            编辑
          </Button>
          <Popconfirm title="删除该巡检手册？" okText="删除" cancelText="取消" onConfirm={() => void deleteRunbook(record)}>
            <Button size="small" danger type="text" icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const runColumns: ColumnsType<RunRecord> = [
    { title: '状态', dataIndex: 'status', width: 90, render: (_v, record) => <RunStatusTag status={record.status} /> },
    {
      title: '手册',
      dataIndex: 'runbookName',
      width: 200,
      render: (_v, record) => record.runbookName ?? record.runbookId,
    },
    { title: '开始时间', dataIndex: 'startedAt', width: 170, render: (_v, record) => formatTime(record.startedAt) },
    {
      title: '耗时',
      dataIndex: 'finishedAt',
      width: 100,
      render: (_v, record) => formatDuration((record.finishedAt ?? Date.now()) - record.startedAt),
    },
    {
      title: '检查结果',
      dataIndex: 'findings',
      width: 200,
      render: (_v, record) => {
        const ok = record.findings.filter((finding) => finding.status === 'ok').length
        const bad = record.findings.filter((finding) => finding.status === 'fail' || finding.status === 'error').length
        return (
          <Space size={4}>
            <Tag color="green">通过 {ok}</Tag>
            {bad > 0 ? <Tag color="red">异常 {bad}</Tag> : null}
            <Typography.Text type="secondary">共 {record.findings.length}</Typography.Text>
          </Space>
        )
      },
    },
    {
      title: '会话',
      dataIndex: 'sessionId',
      width: 120,
      render: (_v, record) =>
        record.sessionId ? (
          <Link to={`/?session=${encodeURIComponent(record.sessionId)}`} className="mono">
            {record.sessionId.slice(0, 8)}
          </Link>
        ) : (
          '-'
        ),
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

  const scheduleColumns: ColumnsType<ScheduleSpec> = [
    {
      title: '任务 ID',
      dataIndex: 'id',
      width: 180,
      render: (_v, record) => <span className="mono">{record.id}</span>,
    },
    {
      title: '巡检手册',
      dataIndex: 'runbookId',
      width: 200,
      render: (_v, record) => {
        const spec = runbooks.data?.find((entry) => entry.id === record.runbookId)
        return spec ? spec.name : <span className="mono">{record.runbookId}</span>
      },
    },
    { title: 'cron', dataIndex: 'cron', width: 150, render: (_v, record) => <span className="mono">{record.cron}</span> },
    { title: '时区', dataIndex: 'timezone', width: 140, render: (_v, record) => record.timezone ?? '本地时区' },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (_v, record) => (
        <Switch size="small" checked={record.enabled} onChange={(checked) => void toggleSchedule(record, checked)} />
      ),
    },
    { title: '上次执行', dataIndex: 'lastRunAt', width: 170, render: (_v, record) => formatTime(record.lastRunAt) },
    { title: '下次执行', dataIndex: 'nextRunAt', width: 170, render: (_v, record) => formatTime(record.nextRunAt) },
    {
      title: '操作',
      key: 'ops',
      width: 140,
      render: (_v, record) => (
        <Space size={4}>
          <Button size="small" onClick={() => openSchedule(record)}>
            编辑
          </Button>
          <Popconfirm title="删除该定时任务？" okText="删除" cancelText="取消" onConfirm={() => void deleteSchedule(record)}>
            <Button size="small" danger type="text" icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {runbooks.error ? <Alert type="error" showIcon message={`巡检手册加载失败：${runbooks.error}`} /> : null}

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'runbooks',
            label: '巡检手册',
            children: (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Space>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>
                    新建巡检手册
                  </Button>
                  <Button icon={<ReloadOutlined />} onClick={runbooks.reload} loading={runbooks.loading}>
                    刷新
                  </Button>
                </Space>
                <Table<RunbookSpec>
                  size="small"
                  rowKey="id"
                  loading={runbooks.loading}
                  dataSource={runbooks.data ?? []}
                  columns={runbookColumns}
                  scroll={{ x: 1200 }}
                  pagination={false}
                  locale={{ emptyText: '暂无巡检手册，点击「新建巡检手册」创建' }}
                />
              </Space>
            ),
          },
          {
            key: 'runs',
            label: '执行历史',
            children: (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Space>
                  <Button icon={<ReloadOutlined />} onClick={runs.reload} loading={runs.loading}>
                    刷新
                  </Button>
                  <Typography.Text type="secondary">最近 50 条执行记录</Typography.Text>
                </Space>
                <Table<RunRecord>
                  size="small"
                  rowKey="id"
                  loading={runs.loading}
                  dataSource={runs.data ?? []}
                  columns={runColumns}
                  scroll={{ x: 1100 }}
                  pagination={false}
                  locale={{ emptyText: '暂无执行记录' }}
                />
              </Space>
            ),
          },
          {
            key: 'schedules',
            label: '定时任务',
            children: (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Space>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => openSchedule()}>
                    新建定时任务
                  </Button>
                  <Button icon={<ReloadOutlined />} onClick={schedules.reload} loading={schedules.loading}>
                    刷新
                  </Button>
                </Space>
                <Table<ScheduleSpec>
                  size="small"
                  rowKey="id"
                  loading={schedules.loading}
                  dataSource={schedules.data ?? []}
                  columns={scheduleColumns}
                  scroll={{ x: 1100 }}
                  pagination={false}
                  locale={{ emptyText: '暂无定时任务' }}
                />
              </Space>
            ),
          },
        ]}
      />

      <Drawer
        title={editingId ? `编辑巡检手册：${editingId}` : '新建巡检手册'}
        width={980}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setEditorOpen(false)}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => void saveRunbook()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form<RunbookFormValues> form={form} layout="vertical">
          <Form.Item
            name="id"
            label="手册 ID"
            tooltip="kebab-case，作为存储与调用的唯一标识"
            rules={[
              { required: true, message: '请输入手册 ID' },
              {
                validator: (_rule, value: string) =>
                  !value || isKebabCase(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error('只能使用小写字母、数字和连字符，例如 disk-pressure')),
              },
            ]}
          >
            <Input
              disabled={editingId !== null}
              placeholder="disk-pressure"
              onChange={(event) => {
                if (editingId !== null) return
                const next = toKebabCase(event.target.value)
                const name = form.getFieldValue('name') as string | undefined
                if (!name) form.setFieldValue('name', next)
              }}
            />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="磁盘压力巡检" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input placeholder="一句话说明这份巡检做什么" />
          </Form.Item>
          <Form.Item name="prompt" label="Prompt（交给模型的排查指令）">
            <Input.TextArea rows={5} placeholder="请检查以下检查项的失败原因，并给出根因分析与处置建议…" />
          </Form.Item>
          <Form.Item label="检查项">
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Table<RunbookCheck>
                size="small"
                rowKey={(record) => record.id}
                dataSource={checks}
                columns={checkColumns}
                pagination={false}
                scroll={{ x: 1500 }}
                locale={{ emptyText: '暂无检查项' }}
              />
              <Button
                icon={<PlusOutlined />}
                onClick={() =>
                  setChecks((prev) => [
                    ...prev,
                    {
                      id: randomId('check'),
                      kind: 'http',
                      title: '',
                      target: '',
                      timeoutSec: 10,
                      critical: true,
                    },
                  ])
                }
              >
                添加检查项
              </Button>
            </Space>
          </Form.Item>
          <Form.Item name="allowedTools" label="允许的工具（无人值守时可用）" tooltip="留空表示不额外限制；其他工具一律拒绝">
            <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="输入工具名后回车" />
          </Form.Item>
          <Form.Item name="notify" label="通知 Webhook">
            <Select mode="tags" tokenSeparators={[',']} placeholder="https://…（回车添加）" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>

      <Modal
        title="执行详情"
        open={activeRun !== null}
        width={960}
        footer={null}
        onCancel={() => setActiveRun(null)}

      >
        {activeRun ? <RunDetail run={activeRun} /> : null}
      </Modal>

      <Modal
        title={scheduleEditing ? `编辑定时任务：${scheduleEditing}` : '新建定时任务'}
        open={scheduleOpen}
        onCancel={() => setScheduleOpen(false)}
        onOk={() => void saveSchedule()}
        okText="保存"
        cancelText="取消"

      >
        <Form<ScheduleFormValues> form={scheduleForm} layout="vertical">
          <Form.Item
            name="id"
            label="任务 ID"
            rules={[
              { required: true, message: '请输入任务 ID' },
              {
                validator: (_rule, value: string) =>
                  !value || isKebabCase(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error('只能使用小写字母、数字和连字符')),
              },
            ]}
          >
            <Input disabled={scheduleEditing !== null} placeholder="disk-pressure-every-15m" />
          </Form.Item>
          <Form.Item name="runbookId" label="巡检手册" rules={[{ required: true, message: '请选择巡检手册' }]}>
            <Select
              placeholder="选择巡检手册"
              options={(runbooks.data ?? []).map((spec) => ({ value: spec.id, label: `${spec.name}（${spec.id}）` }))}
            />
          </Form.Item>
          <Form.Item
            name="cron"
            label="cron 表达式"
            tooltip="标准 5 段 cron：分 时 日 月 周"
            rules={[{ required: true, message: '请输入 cron 表达式' }]}
          >
            <Input className="mono" placeholder="*/15 * * * *" />
          </Form.Item>
          <Form.Item name="timezone" label="时区" tooltip="留空使用服务端本地时区">
            <Input placeholder="Asia/Shanghai" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
