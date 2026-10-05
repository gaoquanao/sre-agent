/** MCP 页：MCP 服务器列表 + 新建/编辑（stdio / http）+ 删除。 */
import { useMemo, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { McpServerSpec, McpTransport } from '@sre/protocol'
import { api } from '../api'
import { useAppState } from '../state'
import { useAsyncData } from '../hooks'
import KvEditor, { recordToRows, rowsToRecord, type KvRow } from '../components/KvEditor'
import JsonBlock from '../components/JsonBlock'
import { isKebabCase, oneLineJson, toKebabCase } from '../utils'

interface McpFormValues {
  name: string
  transport: McpTransport
  enabled: boolean
  description?: string
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  timeoutSec?: number
}

export default function McpPage(): JSX.Element {
  const { message } = AntApp.useApp()
  const { bootstrap } = useAppState()
  const servers = useAsyncData(() => api.mcpServers(), [])
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [env, setEnv] = useState<KvRow[]>([])
  const [headers, setHeaders] = useState<KvRow[]>([])
  const [saving, setSaving] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [form] = Form.useForm<McpFormValues>()
  const transport = Form.useWatch('transport', form) ?? 'stdio'

  const syncHint = useMemo(() => {
    const kernel = bootstrap?.kernels.find((entry) => entry.id === bootstrap.selectedKernel)
    if (!kernel) return 'MCP 服务器会同步到当前内核，是否生效取决于内核能力。'
    switch (kernel.capabilities.mcpSync) {
      case 'files':
        return `MCP 配置会以文件形式同步到内核「${kernel.displayName}」；修改后可能需要重启内核生效。`
      case 'plugin':
        return `MCP 配置通过插件同步到内核「${kernel.displayName}」。`
      default:
        return `当前内核「${kernel.displayName}」不支持 MCP 同步，配置仅保存在平台侧。`
    }
  }, [bootstrap])

  function openEditor(spec?: McpServerSpec): void {
    setEditingName(spec?.name ?? null)
    form.setFieldsValue({
      name: spec?.name ?? '',
      transport: spec?.transport ?? 'stdio',
      enabled: spec?.enabled ?? true,
      description: spec?.description ?? '',
      command: spec?.command ?? '',
      args: spec?.args ?? [],
      cwd: spec?.cwd ?? '',
      url: spec?.url ?? '',
      timeoutSec: spec?.timeoutSec,
    })
    setEnv(recordToRows(spec?.env))
    setHeaders(recordToRows(spec?.headers))
    setEditorOpen(true)
  }

  async function save(): Promise<void> {
    let values: McpFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    const name = values.name.trim()
    const isStdio = values.transport === 'stdio'
    setSaving(true)
    try {
      await api.putMcp(name, {
        transport: values.transport,
        enabled: values.enabled,
        description: values.description?.trim() || undefined,
        command: isStdio ? values.command?.trim() || undefined : undefined,
        args: isStdio ? (values.args ?? []).map((arg) => arg.trim()).filter(Boolean) : undefined,
        cwd: isStdio ? values.cwd?.trim() || undefined : undefined,
        env: isStdio ? rowsToRecord(env) : undefined,
        url: isStdio ? undefined : values.url?.trim() || undefined,
        headers: isStdio ? undefined : rowsToRecord(headers),
        timeoutSec: values.timeoutSec ?? undefined,
      })
      setEditorOpen(false)
      servers.reload()
      void message.success(`MCP 服务器已保存：${name}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setSaving(false)
    }
  }

  async function toggle(spec: McpServerSpec, enabled: boolean): Promise<void> {
    setBusyName(spec.name)
    try {
      const { name, ...payload } = spec
      await api.putMcp(name, { ...payload, enabled })
      servers.reload()
      void message.success(enabled ? `已启用：${name}` : `已停用：${name}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setBusyName(null)
    }
  }

  async function remove(spec: McpServerSpec): Promise<void> {
    try {
      await api.deleteMcp(spec.name)
      servers.reload()
      void message.success(`MCP 服务器已删除：${spec.name}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  const columns: ColumnsType<McpServerSpec> = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 200,
      render: (_v, record) => <span className="mono">{record.name}</span>,
    },
    {
      title: '传输',
      dataIndex: 'transport',
      width: 90,
      render: (_v, record) => (
        <Tag color={record.transport === 'stdio' ? 'geekblue' : 'purple'}>{record.transport}</Tag>
      ),
    },
    {
      title: '连接信息',
      key: 'endpoint',
      render: (_v, record) =>
        record.transport === 'stdio' ? (
          <span className="mono">
            {record.command ?? '-'} {(record.args ?? []).join(' ')}
          </span>
        ) : (
          <span className="mono">{record.url ?? '-'}</span>
        ),
    },
    {
      title: '超时',
      dataIndex: 'timeoutSec',
      width: 90,
      render: (_v, record) => (record.timeoutSec ? `${record.timeoutSec}s` : '默认'),
    },
    {
      title: '描述',
      dataIndex: 'description',
      width: 220,
      render: (_v, record) => record.description || '-',
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (_v, record) => (
        <Switch
          size="small"
          checked={record.enabled}
          loading={busyName === record.name}
          onChange={(checked) => void toggle(record, checked)}
        />
      ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 130,
      fixed: 'right',
      render: (_v, record) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEditor(record)}>
            编辑
          </Button>
          <Popconfirm title="删除该 MCP 服务器？" okText="删除" cancelText="取消" onConfirm={() => void remove(record)}>
            <Button size="small" danger type="text" icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert type="info" showIcon message={syncHint} />
      {servers.error ? <Alert type="error" showIcon message={`MCP 列表加载失败：${servers.error}`} /> : null}

      <Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>
          新建 MCP 服务器
        </Button>
        <Button icon={<ReloadOutlined />} onClick={servers.reload} loading={servers.loading}>
          刷新
        </Button>
      </Space>

      <Table<McpServerSpec>
        size="small"
        rowKey="name"
        loading={servers.loading}
        dataSource={servers.data ?? []}
        columns={columns}
        scroll={{ x: 1100 }}
        pagination={false}
        locale={{ emptyText: '暂无 MCP 服务器' }}
        expandable={{
          expandedRowRender: (record) => (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Typography.Text type="secondary">env</Typography.Text>
              <JsonBlock value={record.env} maxHeight={140} />
              <Typography.Text type="secondary">headers</Typography.Text>
              <JsonBlock value={record.headers} maxHeight={140} />
              <Typography.Text type="secondary" className="mono">
                {oneLineJson({ cwd: record.cwd }, 200)}
              </Typography.Text>
            </Space>
          ),
        }}
      />

      <Modal
        title={editingName ? `编辑 MCP 服务器：${editingName}` : '新建 MCP 服务器'}
        open={editorOpen}
        width={720}
        onCancel={() => setEditorOpen(false)}
        onOk={() => void save()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
      >
        <Form<McpFormValues> form={form} layout="vertical" initialValues={{ transport: 'stdio', enabled: true }}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="name"
                label="名称"
                rules={[
                  { required: true, message: '请输入名称' },
                  {
                    validator: (_rule, value: string) =>
                      !value || isKebabCase(value)
                        ? Promise.resolve()
                        : Promise.reject(new Error('只能使用小写字母、数字和连字符')),
                  },
                ]}
              >
                <Input
                  disabled={editingName !== null}
                  placeholder="filesystem"
                  onChange={(event) => {
                    if (editingName !== null) return
                    if (isKebabCase(event.target.value) || event.target.value === '') return
                    form.setFieldValue('name', toKebabCase(event.target.value))
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="transport" label="传输方式" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: 'stdio', label: 'stdio' },
                    { value: 'http', label: 'http' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="timeoutSec" label="超时（秒）">
                <InputNumber min={1} style={{ width: '100%' }} placeholder="60" />
              </Form.Item>
            </Col>
          </Row>

          {transport === 'stdio' ? (
            <>
              <Form.Item name="command" label="命令" rules={[{ required: true, message: '请输入启动命令' }]}>
                <Input className="mono" placeholder="npx" />
              </Form.Item>
              <Form.Item name="args" label="参数" tooltip="回车添加一个参数">
                <Select mode="tags" tokenSeparators={[' ']} placeholder="-y @modelcontextprotocol/server-filesystem" />
              </Form.Item>
              <Form.Item name="cwd" label="工作目录">
                <Input className="mono" placeholder="/srv/mcp" />
              </Form.Item>
              <Form.Item label="环境变量">
                <KvEditor rows={env} onChange={setEnv} keyPlaceholder="变量名" valuePlaceholder="变量值" />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item
                name="url"
                label="URL"
                rules={[
                  { required: true, message: '请输入 MCP 服务地址' },
                  { type: 'url', message: '请输入合法的 URL' },
                ]}
              >
                <Input className="mono" placeholder="https://mcp.internal/sse" />
              </Form.Item>
              <Form.Item label="请求头">
                <KvEditor rows={headers} onChange={setHeaders} keyPlaceholder="Header" valuePlaceholder="值" />
              </Form.Item>
            </>
          )}

          <Form.Item name="description" label="描述">
            <Input placeholder="可选，说明该 MCP 服务器提供的能力" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
