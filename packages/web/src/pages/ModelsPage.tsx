/** 模型页：Provider 列表 + 编辑（api/baseUrl/密钥/模型表）+ 标记默认模型。 */
import { useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, StarFilled } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { ProviderApi, ProviderSpec } from '@sre/protocol'
import { api } from '../api'
import { useAppState } from '../state'
import { useAsyncData } from '../hooks'
import { isKebabCase, readLocalDefaultModel, toKebabCase, writeLocalDefaultModel } from '../utils'

interface ProviderFormValues {
  id: string
  name: string
  api: ProviderApi
  baseUrl: string
  keyMode: 'env' | 'inline'
  apiKeyEnv?: string
  apiKey?: string
  enabled: boolean
}

interface ModelRow {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  reasoning: boolean
}

const API_OPTIONS: Array<{ value: ProviderApi; label: string }> = [
  { value: 'openai-completions', label: 'openai-completions（/chat/completions）' },
  { value: 'openai-responses', label: 'openai-responses（/responses）' },
  { value: 'anthropic-messages', label: 'anthropic-messages（/v1/messages）' },
]

export default function ModelsPage(): JSX.Element {
  const { message } = AntApp.useApp()
  const { bootstrap, reload: reloadBootstrap } = useAppState()
  const providers = useAsyncData(() => api.providers(), [])
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [models, setModels] = useState<ModelRow[]>([])
  const [saving, setSaving] = useState(false)
  const [localDefault, setLocalDefault] = useState(() => readLocalDefaultModel())
  const [form] = Form.useForm<ProviderFormValues>()
  const keyMode = Form.useWatch('keyMode', form) ?? 'env'

  const platformDefault = bootstrap?.defaultModel ?? null

  const modelColumns: ColumnsType<ModelRow> = [
    {
      title: '模型 ID',
      dataIndex: 'id',
      width: 220,
      render: (_v, _record, index) => (
        <Input
          size="small"
          className="mono"
          value={models[index]?.id ?? ''}
          placeholder="deepseek-chat"
          onChange={(event) =>
            setModels((prev) => prev.map((row, i) => (i === index ? { ...row, id: event.target.value } : row)))
          }
        />
      ),
    },
    {
      title: '显示名',
      dataIndex: 'name',
      width: 180,
      render: (_v, _record, index) => (
        <Input
          size="small"
          value={models[index]?.name ?? ''}
          onChange={(event) =>
            setModels((prev) => prev.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)))
          }
        />
      ),
    },
    {
      title: '上下文窗口',
      dataIndex: 'contextWindow',
      width: 130,
      render: (_v, _record, index) => (
        <InputNumber
          size="small"
          min={0}
          style={{ width: '100%' }}
          value={models[index]?.contextWindow}
          onChange={(value) =>
            setModels((prev) =>
              prev.map((row, i) => (i === index ? { ...row, contextWindow: value ?? undefined } : row)),
            )
          }
        />
      ),
    },
    {
      title: '最大输出',
      dataIndex: 'maxTokens',
      width: 120,
      render: (_v, _record, index) => (
        <InputNumber
          size="small"
          min={0}
          style={{ width: '100%' }}
          value={models[index]?.maxTokens}
          onChange={(value) =>
            setModels((prev) => prev.map((row, i) => (i === index ? { ...row, maxTokens: value ?? undefined } : row)))
          }
        />
      ),
    },
    {
      title: '推理模型',
      dataIndex: 'reasoning',
      width: 90,
      render: (_v, _record, index) => (
        <Switch
          size="small"
          checked={models[index]?.reasoning ?? false}
          onChange={(checked) =>
            setModels((prev) => prev.map((row, i) => (i === index ? { ...row, reasoning: checked } : row)))
          }
        />
      ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 70,
      render: (_v, _record, index) => (
        <Button
          size="small"
          type="text"
          danger
          icon={<DeleteOutlined />}
          onClick={() => setModels((prev) => prev.filter((_, i) => i !== index))}
        />
      ),
    },
  ]

  function openEditor(spec?: ProviderSpec): void {
    setEditingId(spec?.id ?? null)
    form.setFieldsValue({
      id: spec?.id ?? '',
      name: spec?.name ?? '',
      api: spec?.api ?? 'openai-completions',
      baseUrl: spec?.baseUrl ?? '',
      keyMode: spec?.apiKey ? 'inline' : 'env',
      apiKeyEnv: spec?.apiKeyEnv ?? '',
      apiKey: spec?.apiKey ?? '',
      enabled: spec?.enabled ?? true,
    })
    setModels(
      (spec?.models ?? []).map((model) => ({
        id: model.id,
        name: model.name ?? '',
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning ?? false,
      })),
    )
    setEditorOpen(true)
  }

  async function save(): Promise<void> {
    let values: ProviderFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    const id = values.id.trim()
    const payload: ProviderSpec = {
      id,
      name: values.name.trim(),
      api: values.api,
      baseUrl: values.baseUrl.trim(),
      enabled: values.enabled,
      models: models
        .filter((row) => row.id.trim())
        .map((row) => ({
          id: row.id.trim(),
          name: row.name.trim() || undefined,
          contextWindow: row.contextWindow,
          maxTokens: row.maxTokens,
          reasoning: row.reasoning,
        })),
      apiKeyEnv: values.keyMode === 'env' ? values.apiKeyEnv?.trim() || undefined : undefined,
      apiKey: values.keyMode === 'inline' ? values.apiKey?.trim() || undefined : undefined,
    }
    setSaving(true)
    try {
      await api.putProvider(id, payload)
      setEditorOpen(false)
      providers.reload()
      void reloadBootstrap()
      void message.success(`Provider 已保存：${payload.name}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setSaving(false)
    }
  }

  async function toggle(spec: ProviderSpec, enabled: boolean): Promise<void> {
    try {
      await api.putProvider(spec.id, { ...spec, enabled })
      providers.reload()
      void message.success(enabled ? `已启用：${spec.name}` : `已停用：${spec.name}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function remove(spec: ProviderSpec): Promise<void> {
    try {
      await api.deleteProvider(spec.id)
      providers.reload()
      void reloadBootstrap()
      void message.success(`Provider 已删除：${spec.name}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  function setDefault(providerId: string, modelId: string): void {
    writeLocalDefaultModel({ provider: providerId, model: modelId })
    const next = readLocalDefaultModel()
    setLocalDefault(next)
    void message.success(`新建会话将默认使用 ${providerId} / ${modelId}（仅保存在本机浏览器）`)
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={
          <Space direction="vertical" size={2}>
            <span>
              平台默认模型（来自 <span className="mono">GET /api/bootstrap</span>）：
              {platformDefault ? `${platformDefault.provider} / ${platformDefault.model}` : '未设置'}
            </span>
            <span>
              「设为默认」只写入本机浏览器（localStorage），用于新建会话时预选模型；平台级默认由服务端配置决定。
            </span>
          </Space>
        }
      />
      {providers.error ? <Alert type="error" showIcon message={`Provider 列表加载失败：${providers.error}`} /> : null}

      <Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>
          新建 Provider
        </Button>
        <Button icon={<ReloadOutlined />} onClick={providers.reload} loading={providers.loading}>
          刷新
        </Button>
      </Space>

      <Row gutter={[12, 12]}>
        {(providers.data ?? []).map((spec) => (
          <Col key={spec.id} xs={24} xl={12}>
            <Card
              size="small"
              title={
                <Space size={6}>
                  <span>{spec.name}</span>
                  <Tag className="mono">{spec.id}</Tag>
                  <Tag color="geekblue">{spec.api}</Tag>
                </Space>
              }
              extra={
                <Space size={4}>
                  <Switch size="small" checked={spec.enabled} onChange={(checked) => void toggle(spec, checked)} />
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEditor(spec)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除该 Provider？"
                    description="引用该 Provider 的会话与巡检手册的模型设置将失效。"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => void remove(spec)}
                  >
                    <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              }
            >
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Descriptions size="small" column={1} items={[
                  { key: 'baseUrl', label: 'baseUrl', children: <span className="mono">{spec.baseUrl}</span> },
                  {
                    key: 'key',
                    label: '密钥',
                    children: spec.apiKeyEnv ? (
                      <Tag color="green">环境变量 {spec.apiKeyEnv}</Tag>
                    ) : spec.apiKey ? (
                      <Tooltip title="密钥以明文存储在平台侧（v1 不加密），请谨慎使用">
                        <Tag color="orange">内联密钥 ****{spec.apiKey.slice(-4)}</Tag>
                      </Tooltip>
                    ) : (
                      <Tag color="red">未配置</Tag>
                    ),
                  },
                  { key: 'models', label: '模型数', children: `${spec.models.length} 个` },
                ]} />
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {spec.models.length === 0 ? (
                    <Typography.Text type="secondary">未配置模型</Typography.Text>
                  ) : (
                    spec.models.map((model) => {
                      const isPlatformDefault =
                        platformDefault?.provider === spec.id && platformDefault.model === model.id
                      const isLocalDefault = localDefault?.provider === spec.id && localDefault.model === model.id
                      return (
                        <Space key={model.id} size={6} wrap>
                          <span className="mono">{model.id}</span>
                          {model.name ? <Typography.Text type="secondary">{model.name}</Typography.Text> : null}
                          {isPlatformDefault ? <Tag color="gold">平台默认</Tag> : null}
                          {isLocalDefault ? <Tag color="blue">本机默认</Tag> : null}
                          <Button
                            size="small"
                            type="text"
                            icon={<StarFilled />}
                            onClick={() => setDefault(spec.id, model.id)}
                          >
                            设为默认
                          </Button>
                        </Space>
                      )
                    })
                  )}
                </Space>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
      {(providers.data ?? []).length === 0 && !providers.loading ? (
        <Alert type="warning" showIcon message="尚无 Provider 配置，请先新建一个 Provider 再开始对话。" />
      ) : null}

      <Modal
        title={editingId ? `编辑 Provider：${editingId}` : '新建 Provider'}
        open={editorOpen}
        width={880}
        onCancel={() => setEditorOpen(false)}
        onOk={() => void save()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
      >
        <Form<ProviderFormValues> form={form} layout="vertical" initialValues={{ api: 'openai-completions', keyMode: 'env', enabled: true }}>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item
                name="id"
                label="ID"
                rules={[
                  { required: true, message: '请输入 ID' },
                  {
                    validator: (_rule, value: string) =>
                      !value || isKebabCase(value)
                        ? Promise.resolve()
                        : Promise.reject(new Error('只能使用小写字母、数字和连字符')),
                  },
                ]}
              >
                <Input
                  disabled={editingId !== null}
                  placeholder="deepseek"
                  onChange={(event) => {
                    if (editingId !== null) return
                    if (isKebabCase(event.target.value) || event.target.value === '') return
                    form.setFieldValue('id', toKebabCase(event.target.value))
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="name" label="显示名" rules={[{ required: true, message: '请输入显示名' }]}>
                <Input placeholder="DeepSeek" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="api" label="API 协议" rules={[{ required: true }]}>
                <Select options={API_OPTIONS} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="baseUrl"
            label="Base URL"
            rules={[
              { required: true, message: '请输入 Base URL' },
              { type: 'url', message: '请输入合法的 URL' },
            ]}
          >
            <Input className="mono" placeholder="https://api.deepseek.com/v1" />
          </Form.Item>
          <Form.Item name="keyMode" label="密钥来源">
            <Radio.Group
              options={[
                { value: 'env', label: '环境变量名' },
                { value: 'inline', label: '直接填写密钥' },
              ]}
              optionType="button"
            />
          </Form.Item>
          {keyMode === 'env' ? (
            <Form.Item name="apiKeyEnv" label="环境变量名" tooltip="例如 DEEPSEEK_API_KEY">
              <Input className="mono" placeholder="DEEPSEEK_API_KEY" />
            </Form.Item>
          ) : (
            <>
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="内联密钥会随 Provider 配置保存在平台侧，v1 不做静态加密，请仅在受控环境使用。"
              />
              <Form.Item name="apiKey" label="API Key">
                <Input.Password className="mono" placeholder="sk-…" />
              </Form.Item>
            </>
          )}
          <Form.Item label="模型列表">
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Table<ModelRow>
                size="small"
                rowKey={(row, index) => `${row.id}-${index ?? 0}`}
                dataSource={models}
                columns={modelColumns}
                pagination={false}
                scroll={{ x: 800 }}
                locale={{ emptyText: '暂无模型' }}
              />
              <Button
                icon={<PlusOutlined />}
                onClick={() => setModels((prev) => [...prev, { id: '', name: '', reasoning: false }])}
              >
                添加模型
              </Button>
            </Space>
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
