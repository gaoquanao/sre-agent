/**
 * Hosted credentials panel: CRUD over `/api/credentials` plus one-click import
 * from local CLI config files. The server stores secrets AES-256-GCM encrypted
 * and only ever returns masked summaries, so this UI never displays plaintext.
 */
import { useState } from 'react'
import {
  Alert,
  App as AntApp,
  AutoComplete,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import { DeleteOutlined, ImportOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { api } from '../api'
import { useAsyncData } from '../hooks'
import { formatTime } from '../utils'
import KvEditor, { rowsToRecord, type KvRow } from './KvEditor'
import type { CredentialImportResult, CredentialInfo, CredentialKind, CredentialPayload, ImportableKernelId } from '../types'

const KIND_META: Record<CredentialKind, { label: string; color: string }> = {
  oauth: { label: 'OAuth 令牌', color: 'geekblue' },
  'api-key': { label: 'API Key', color: 'cyan' },
  'env-json': { label: '环境变量 JSON', color: 'purple' },
}

const IMPORTABLE_KERNELS: Array<{ value: ImportableKernelId; hint: string }> = [
  { value: 'claude-code', hint: '~/.claude/.credentials.json' },
  { value: 'codex', hint: '~/.codex/auth.json' },
  { value: 'qoder', hint: 'Qoder CLI 本地凭证' },
]

const SUGGESTED_REFS = ['claude-code', 'codex', 'qoder']

interface CredentialFormValues {
  ref: string
  kind: CredentialKind
  token?: string
  refreshToken?: string
  expiresAtText?: string
  account?: string
  apiKey?: string
}

export default function CredentialsPanel(): JSX.Element {
  const { message } = AntApp.useApp()
  const credentials = useAsyncData(() => api.credentials(), [])
  const [form] = Form.useForm<CredentialFormValues>()
  const kind = Form.useWatch('kind', form) ?? 'oauth'

  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [envRows, setEnvRows] = useState<KvRow[]>([])

  const [importOpen, setImportOpen] = useState(false)
  const [importKernel, setImportKernel] = useState<ImportableKernelId>('claude-code')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<CredentialImportResult | null>(null)

  const refOptions = Array.from(new Set([...(credentials.data ?? []).map((entry) => entry.ref), ...SUGGESTED_REFS])).map(
    (value) => ({ value }),
  )

  function openDialog(prefill?: { ref: string; kind: CredentialKind }): void {
    form.resetFields()
    setEnvRows([])
    form.setFieldsValue({
      kind: 'oauth',
      ...(prefill ? { ref: prefill.ref, kind: prefill.kind } : {}),
    })
    setDialogOpen(true)
  }

  async function save(): Promise<void> {
    try {
      const values = await form.validateFields()
      const ref = values.ref.trim()
      if (!ref) {
        void message.error('请填写凭证名称（ref）')
        return
      }
      let payload: CredentialPayload
      if (values.kind === 'oauth') {
        let expiresAt: number | undefined
        const text = values.expiresAtText?.trim()
        if (text) {
          expiresAt = Date.parse(text)
          if (Number.isNaN(expiresAt)) {
            void message.error('过期时间格式不正确，请使用 ISO 时间（如 2026-01-01T00:00:00Z）')
            return
          }
        }
        payload = {
          kind: 'oauth',
          token: values.token?.trim() ?? '',
          ...(values.refreshToken?.trim() ? { refreshToken: values.refreshToken.trim() } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(values.account?.trim() ? { account: values.account.trim() } : {}),
        }
      } else if (values.kind === 'api-key') {
        payload = { kind: 'api-key', apiKey: values.apiKey?.trim() ?? '' }
      } else {
        const env = rowsToRecord(envRows)
        if (!env) {
          void message.error('请至少填写一个环境变量')
          return
        }
        payload = { kind: 'env-json', env }
      }
      setSaving(true)
      try {
        await api.putCredential(ref, payload)
        void message.success(`凭证「${ref}」已保存`)
        setDialogOpen(false)
        credentials.reload()
      } catch {
        /* surfaced by the API layer */
      } finally {
        setSaving(false)
      }
    } catch {
      /* form validation failed — antd already showed the field errors */
    }
  }

  async function remove(ref: string): Promise<void> {
    try {
      await api.deleteCredential(ref)
      void message.success(`凭证「${ref}」已删除`)
      credentials.reload()
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function runImport(): Promise<void> {
    setImporting(true)
    setImportResult(null)
    try {
      const result = await api.importCredentials(importKernel)
      setImportResult(result)
      credentials.reload()
    } catch {
      /* surfaced by the API layer */
    } finally {
      setImporting(false)
    }
  }

  const columns: ColumnsType<CredentialInfo> = [
    {
      title: '名称 (ref)',
      dataIndex: 'ref',
      width: 150,
      render: (_v, record) => <span className="mono">{record.ref}</span>,
    },
    {
      title: '类型',
      dataIndex: 'kind',
      width: 130,
      render: (_v, record) => {
        const meta = KIND_META[record.kind] ?? { label: record.kind, color: 'default' }
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    {
      title: '脱敏值',
      dataIndex: 'masked',
      render: (_v, record) => <span className="mono">{record.masked}</span>,
    },
    {
      title: '可刷新',
      dataIndex: 'hasRefresh',
      width: 90,
      render: (_v, record) => (record.hasRefresh ? <Tag color="green">支持</Tag> : <Typography.Text type="secondary">-</Typography.Text>),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 170,
      render: (_v, record) => formatTime(record.updatedAt),
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_v, record) => (
        <Space size={4}>
          <Button size="small" onClick={() => openDialog({ ref: record.ref, kind: record.kind })}>
            更新
          </Button>
          <Popconfirm
            title="删除该凭证？"
            description="删除后对应内核将无法使用该凭证。"
            okText="删除"
            cancelText="取消"
            onConfirm={() => void remove(record.ref)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="安全说明：凭证使用 AES-256-GCM 加密后落盘，只保存在平台数据目录；页面与接口仅返回脱敏摘要，任何明文都不会回显。"
      />
      <Space wrap>
        <Button type="primary" size="small" icon={<SaveOutlined />} onClick={() => openDialog()}>
          添加/更新凭证
        </Button>
        <Button size="small" icon={<ImportOutlined />} onClick={() => { setImportResult(null); setImportOpen(true) }}>
          从本机导入
        </Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={credentials.reload} loading={credentials.loading}>
          刷新
        </Button>
      </Space>
      {credentials.error ? <Alert type="error" showIcon message={`凭证列表加载失败：${credentials.error}`} /> : null}
      <Table<CredentialInfo>
        size="small"
        rowKey="ref"
        loading={credentials.loading && !credentials.data}
        dataSource={credentials.data ?? []}
        columns={columns}
        pagination={false}
        locale={{ emptyText: '暂无托管凭证' }}
      />

      <Modal
        title="添加/更新凭证"
        open={dialogOpen}
        onOk={() => void save()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        onCancel={() => setDialogOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ kind: 'oauth' }}>
          <Form.Item
            name="ref"
            label="凭证名称 (ref)"
            rules={[{ required: true, message: '请选择或填写凭证名称' }, { pattern: /^\S+$/, message: '名称不能包含空白字符' }]}
          >
            <AutoComplete
              options={refOptions}
              placeholder="选择已有名称或直接输入，如 claude-code"
              filterOption={(input, option) => (option?.value as string).includes(input)}
            />
          </Form.Item>
          <Form.Item name="kind" label="类型">
            <Radio.Group
              options={[
                { value: 'oauth', label: KIND_META.oauth.label },
                { value: 'api-key', label: KIND_META['api-key'].label },
                { value: 'env-json', label: KIND_META['env-json'].label },
              ]}
            />
          </Form.Item>

          {kind === 'oauth' ? (
            <>
              <Form.Item
                name="token"
                label="访问令牌 (token)"
                rules={[{ required: true, message: '请输入访问令牌' }]}
              >
                <Input.TextArea rows={3} placeholder="OAuth access token（保存后不可回显）" />
              </Form.Item>
              <Form.Item name="refreshToken" label="刷新令牌 (refreshToken，可选)">
                <Input.Password placeholder="用于自动刷新，可留空" autoComplete="new-password" />
              </Form.Item>
              <Form.Item name="expiresAtText" label="过期时间 (可选)" extra="ISO 时间，如 2026-01-01T00:00:00Z；留空表示未知">
                <Input placeholder="2026-01-01T00:00:00Z" />
              </Form.Item>
              <Form.Item name="account" label="账号 (可选)">
                <Input placeholder="登录账号或邮箱" />
              </Form.Item>
            </>
          ) : null}

          {kind === 'api-key' ? (
            <Form.Item name="apiKey" label="API Key" rules={[{ required: true, message: '请输入 API Key' }]}>
              <Input.Password placeholder="sk-…（保存后不可回显）" autoComplete="new-password" />
            </Form.Item>
          ) : null}

          {kind === 'env-json' ? (
            <Form.Item label="环境变量（键值对）" required>
              <KvEditor rows={envRows} onChange={setEnvRows} keyPlaceholder="变量名" valuePlaceholder="值" addText="添加变量" />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>

      <Modal
        title="从本机导入凭证"
        open={importOpen}
        onOk={() => void runImport()}
        confirmLoading={importing}
        okText="导入"
        cancelText="取消"
        onCancel={() => setImportOpen(false)}
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Form layout="vertical">
            <Form.Item label="选择内核" style={{ marginBottom: 0 }}>
              <Select<ImportableKernelId>
                value={importKernel}
                onChange={setImportKernel}
                options={IMPORTABLE_KERNELS.map((entry) => ({ value: entry.value, label: entry.value }))}
              />
            </Form.Item>
          </Form>
          <Typography.Text type="secondary">
            将从本机 {IMPORTABLE_KERNELS.find((entry) => entry.value === importKernel)?.hint} 读取凭证并加密托管。
          </Typography.Text>
          {importResult ? (
            <Space direction="vertical" size={4}>
              <Space size={4} wrap>
                <Typography.Text>已导入：</Typography.Text>
                {importResult.imported.length === 0 ? (
                  <Typography.Text type="secondary">无</Typography.Text>
                ) : (
                  importResult.imported.map((ref) => (
                    <Tag key={ref} color="green" className="mono">
                      {ref}
                    </Tag>
                  ))
                )}
              </Space>
              <Space size={4} wrap>
                <Typography.Text>未找到：</Typography.Text>
                {importResult.missing.length === 0 ? (
                  <Typography.Text type="secondary">无</Typography.Text>
                ) : (
                  importResult.missing.map((ref) => (
                    <Tag key={ref} className="mono">
                      {ref}
                    </Tag>
                  ))
                )}
              </Space>
            </Space>
          ) : null}
        </Space>
      </Modal>
    </Space>
  )
}
