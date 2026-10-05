/** 权限页：预设三选一 + 规则表 + 审计日志。 */
import { useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
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
import type { AuditEntry, PermissionEffect, PermissionPreset, PermissionRule, RiskLevel, ToolOrigin } from '@sre/protocol'
import { api } from '../api'
import { useAppState } from '../state'
import { useAsyncData } from '../hooks'
import { EffectTag, RiskTag } from '../components/StatusTags'
import JsonBlock from '../components/JsonBlock'
import { PERMISSION_PRESET_META, formatTime, isKebabCase, originLabel, presetMeta, randomId } from '../utils'

interface RuleFormValues {
  id: string
  priority: number
  tool?: string
  risk?: RiskLevel
  origins?: ToolOrigin[]
  effect: PermissionEffect
  enabled: boolean
  description?: string
}

const PRESETS: PermissionPreset[] = ['read-only', 'workspace-write', 'full-access']
const ORIGIN_OPTIONS: ToolOrigin[] = ['chat', 'schedule', 'alert', 'api']

export default function PermissionsPage(): JSX.Element {
  const { message, modal } = AntApp.useApp()
  const { reload: reloadBootstrap } = useAppState()
  const permissions = useAsyncData(() => api.permissions(), [])
  const audit = useAsyncData(() => api.audit(200), [])
  const [busyPreset, setBusyPreset] = useState<PermissionPreset | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<RuleFormValues>()

  const preset = permissions.data?.preset ?? null

  async function applyPreset(next: PermissionPreset): Promise<void> {
    if (next === preset) return
    setBusyPreset(next)
    try {
      await api.setPermissionPreset(next)
      permissions.reload()
      void reloadBootstrap()
      void message.success(`权限预设已切换为：${presetMeta(next).label}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setBusyPreset(null)
    }
  }

  function choosePreset(next: PermissionPreset): void {
    if (next === preset) return
    if (next === 'full-access') {
      modal.confirm({
        title: '切换到完全访问（full-access）？',
        content:
          '该预设下除显式 deny 规则外，所有工具调用都会直接放行，不再弹出人工审批。请确认这是受控环境中的预期行为。',
        okText: '我已确认，切换',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => applyPreset(next),
      })
      return
    }
    void applyPreset(next)
  }

  function openEditor(rule?: PermissionRule): void {
    setEditingId(rule?.id ?? null)
    form.setFieldsValue({
      id: rule?.id ?? randomId('rule'),
      priority: rule?.priority ?? 100,
      tool: rule?.tool ?? '',
      risk: rule?.risk,
      origins: rule?.origins ?? [],
      effect: rule?.effect ?? 'ask',
      enabled: rule?.enabled ?? true,
      description: rule?.description ?? '',
    })
    setEditorOpen(true)
  }

  async function saveRule(): Promise<void> {
    let values: RuleFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    const id = values.id.trim()
    const rule: PermissionRule = {
      id,
      priority: values.priority,
      enabled: values.enabled,
      tool: values.tool?.trim() || undefined,
      risk: values.risk,
      origins: values.origins && values.origins.length > 0 ? values.origins : undefined,
      effect: values.effect,
      description: values.description?.trim() || undefined,
    }
    setSaving(true)
    try {
      await api.putPermissionRule(id, rule)
      setEditorOpen(false)
      permissions.reload()
      void message.success(`权限规则已保存：${id}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setSaving(false)
    }
  }

  async function toggleRule(rule: PermissionRule, enabled: boolean): Promise<void> {
    try {
      await api.putPermissionRule(rule.id, { ...rule, enabled })
      permissions.reload()
      void message.success(enabled ? `已启用规则：${rule.id}` : `已停用规则：${rule.id}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function deleteRule(rule: PermissionRule): Promise<void> {
    try {
      await api.deletePermissionRule(rule.id)
      permissions.reload()
      void message.success(`权限规则已删除：${rule.id}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  const ruleColumns: ColumnsType<PermissionRule> = [
    {
      title: '规则 ID',
      dataIndex: 'id',
      width: 170,
      render: (_v, record) => <span className="mono">{record.id}</span>,
    },
    {
      title: '优先级',
      dataIndex: 'priority',
      width: 90,
      sorter: (a, b) => a.priority - b.priority,
      render: (_v, record) => <Tag color="geekblue">{record.priority}</Tag>,
    },
    {
      title: '工具 glob',
      dataIndex: 'tool',
      width: 200,
      render: (_v, record) =>
        record.tool ? <span className="mono">{record.tool}</span> : <Typography.Text type="secondary">全部工具</Typography.Text>,
    },
    {
      title: '风险',
      dataIndex: 'risk',
      width: 100,
      render: (_v, record) => (record.risk ? <RiskTag risk={record.risk} /> : <Typography.Text type="secondary">不限</Typography.Text>),
    },
    {
      title: '来源',
      dataIndex: 'origins',
      width: 180,
      render: (_v, record) =>
        record.origins && record.origins.length > 0 ? (
          <Space size={4} wrap>
            {record.origins.map((origin) => (
              <Tag key={origin}>{originLabel(origin)}</Tag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">全部来源</Typography.Text>
        ),
    },
    {
      title: '效果',
      dataIndex: 'effect',
      width: 90,
      render: (_v, record) => <EffectTag effect={record.effect} />,
    },
    {
      title: '说明',
      dataIndex: 'description',
      render: (_v, record) => record.description || '-',
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (_v, record) => (
        <Switch size="small" checked={record.enabled} onChange={(checked) => void toggleRule(record, checked)} />
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
          <Popconfirm title="删除该规则？" okText="删除" cancelText="取消" onConfirm={() => void deleteRule(record)}>
            <Button size="small" danger type="text" icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const auditColumns: ColumnsType<AuditEntry> = [
    { title: '时间', dataIndex: 'ts', width: 170, render: (_v, record) => formatTime(record.ts) },
    { title: 'actor', dataIndex: 'actor', width: 120 },
    { title: 'action', dataIndex: 'action', width: 180, render: (_v, record) => <span className="mono">{record.action}</span> },
    { title: 'subject', dataIndex: 'subject', width: 220, render: (_v, record) => <span className="mono">{record.subject}</span> },
    {
      title: 'detail',
      dataIndex: 'detail',
      render: (_v, record) => (
        <Typography.Text type="secondary" className="sre-clamped">
          {record.detail === undefined ? '-' : JSON.stringify(record.detail)}
        </Typography.Text>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {permissions.error ? <Alert type="error" showIcon message={`权限配置加载失败：${permissions.error}`} /> : null}

      <Card
        size="small"
        title="权限预设"
        extra={
          <Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={permissions.reload} loading={permissions.loading}>
              刷新
            </Button>
          </Space>
        }
      >
        <Row gutter={[12, 12]}>
          {PRESETS.map((item) => {
            const meta = PERMISSION_PRESET_META[item]
            const active = preset === item
            return (
              <Col key={item} xs={24} md={8}>
                <div
                  className={`sre-pick-card ${active ? 'sre-pick-card-active' : ''}`}
                  onClick={() => choosePreset(item)}
                  role="button"
                  aria-pressed={active}
                >
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Space size={6}>
                      <Tag color={meta.color}>{meta.label}</Tag>
                      {active ? <Tag color="green">当前</Tag> : null}
                      {busyPreset === item ? <Typography.Text type="secondary">切换中…</Typography.Text> : null}
                    </Space>
                    <Typography.Text type="secondary">{meta.description}</Typography.Text>
                  </Space>
                </div>
              </Col>
            )
          })}
        </Row>
      </Card>

      <Card
        size="small"
        title="权限规则"
        extra={
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>
            新增规则
          </Button>
        }
      >
        <Table<PermissionRule>
          size="small"
          rowKey="id"
          loading={permissions.loading}
          dataSource={permissions.data?.rules ?? []}
          columns={ruleColumns}
          scroll={{ x: 1200 }}
          pagination={false}
          locale={{ emptyText: '暂无规则，预设将决定所有工具调用' }}
        />
      </Card>

      <Card
        size="small"
        title="审计日志"
        extra={
          <Space>
            <Typography.Text type="secondary">最近 200 条</Typography.Text>
            <Button size="small" icon={<ReloadOutlined />} onClick={audit.reload} loading={audit.loading}>
              刷新
            </Button>
          </Space>
        }
      >
        {audit.error ? <Alert type="error" showIcon message={`审计日志加载失败：${audit.error}`} style={{ marginBottom: 8 }} /> : null}
        <Table<AuditEntry>
          size="small"
          rowKey="id"
          loading={audit.loading}
          dataSource={audit.data ?? []}
          columns={auditColumns}
          scroll={{ x: 1000 }}
          pagination={{ pageSize: 20, size: 'small', showSizeChanger: false }}
          expandable={{ expandedRowRender: (record) => <JsonBlock value={record.detail} maxHeight={220} /> }}
          locale={{ emptyText: '暂无审计记录' }}
        />
      </Card>

      <Modal
        title={editingId ? `编辑权限规则：${editingId}` : '新增权限规则'}
        open={editorOpen}
        onCancel={() => setEditorOpen(false)}
        onOk={() => void saveRule()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
      >
        <Form<RuleFormValues> form={form} layout="vertical">
          <Form.Item
            name="id"
            label="规则 ID"
            rules={[
              { required: true, message: '请输入规则 ID' },
              {
                validator: (_rule, value: string) =>
                  !value || isKebabCase(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error('只能使用小写字母、数字和连字符')),
              },
            ]}
          >
            <Input disabled={editingId !== null} placeholder="high-risk-shell" />
          </Form.Item>
          <Form.Item
            name="priority"
            label="优先级"
            tooltip="数字越小越先匹配"
            rules={[{ required: true, message: '请输入优先级' }]}
          >
            <InputNumber min={0} max={9999} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="tool" label="工具 glob" tooltip="支持 * 通配，例如 shell_exec 或 mcp__*">
            <Input className="mono" placeholder="shell_exec" />
          </Form.Item>
          <Form.Item name="risk" label="风险等级">
            <Select
              allowClear
              placeholder="不限"
              options={[
                { value: 'low', label: '低风险' },
                { value: 'medium', label: '中风险' },
                { value: 'high', label: '高风险' },
              ]}
            />
          </Form.Item>
          <Form.Item name="origins" label="来源" tooltip="留空表示对所有来源生效">
            <Select
              mode="multiple"
              allowClear
              placeholder="全部来源"
              options={ORIGIN_OPTIONS.map((origin) => ({ value: origin, label: originLabel(origin) }))}
            />
          </Form.Item>
          <Form.Item name="effect" label="效果" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'allow', label: 'allow（直接放行）' },
                { value: 'ask', label: 'ask（转人工审批）' },
                { value: 'deny', label: 'deny（直接拒绝）' },
              ]}
            />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={2} placeholder="这条规则的用途" />
          </Form.Item>
        </Form>
      </Modal>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        匹配顺序：按优先级升序取第一条命中的规则；没有命中任何规则时由预设兜底
        {preset ? `（当前预设：${presetMeta(preset).label}）` : ''}。
      </Typography.Text>
    </Space>
  )
}
