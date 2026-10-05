/** 技能页：技能卡片列表 + 新建/编辑（Markdown 正文）+ 启用开关 + 删除。 */
import { useMemo, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Collapse,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { SkillSpec } from '@sre/protocol'
import { api } from '../api'
import { useAppState } from '../state'
import { useAsyncData } from '../hooks'
import { formatTime, isKebabCase, toKebabCase } from '../utils'

interface SkillFormValues {
  name: string
  description: string
  body: string
  enabled: boolean
}

export default function SkillsPage(): JSX.Element {
  const { message } = AntApp.useApp()
  const { bootstrap } = useAppState()
  const skills = useAsyncData(() => api.skills(), [])
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [form] = Form.useForm<SkillFormValues>()

  const syncHint = useMemo(() => {
    const kernel = bootstrap?.kernels.find((entry) => entry.id === bootstrap.selectedKernel)
    if (!kernel) return '技能会同步到当前内核的技能目录。'
    switch (kernel.capabilities.skillSync) {
      case 'files':
        return `技能会以文件形式同步到内核「${kernel.displayName}」的技能目录。`
      case 'plugin':
        return `技能会通过插件方式同步到内核「${kernel.displayName}」。`
      default:
        return `当前内核「${kernel.displayName}」不支持技能同步，技能仅保存在平台侧。`
    }
  }, [bootstrap])

  function openEditor(spec?: SkillSpec): void {
    setEditingName(spec?.name ?? null)
    form.setFieldsValue({
      name: spec?.name ?? '',
      description: spec?.description ?? '',
      body: spec?.body ?? '',
      enabled: spec?.enabled ?? true,
    })
    setEditorOpen(true)
  }

  async function save(): Promise<void> {
    let values: SkillFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    const name = values.name.trim()
    setSaving(true)
    try {
      await api.putSkill(name, {
        description: values.description.trim(),
        body: values.body,
        enabled: values.enabled,
      })
      setEditorOpen(false)
      skills.reload()
      void message.success(`技能已保存：${name}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setSaving(false)
    }
  }

  async function toggle(spec: SkillSpec, enabled: boolean): Promise<void> {
    setBusyName(spec.name)
    try {
      await api.putSkill(spec.name, { description: spec.description, body: spec.body, enabled })
      skills.reload()
      void message.success(enabled ? `已启用技能：${spec.name}` : `已停用技能：${spec.name}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setBusyName(null)
    }
  }

  async function remove(spec: SkillSpec): Promise<void> {
    try {
      await api.deleteSkill(spec.name)
      skills.reload()
      void message.success(`技能已删除：${spec.name}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert type="info" showIcon message={syncHint} />
      {skills.error ? <Alert type="error" showIcon message={`技能列表加载失败：${skills.error}`} /> : null}

      <Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>
          新建技能
        </Button>
        <Button icon={<ReloadOutlined />} onClick={skills.reload} loading={skills.loading}>
          刷新
        </Button>
      </Space>

      {skills.loading && !skills.data ? (
        <div className="sre-centered" style={{ height: 200 }}>
          <Spin />
        </div>
      ) : (skills.data ?? []).length === 0 ? (
        <Empty description="暂无技能，点击「新建技能」创建" />
      ) : (
        <Row gutter={[12, 12]}>
          {(skills.data ?? []).map((spec) => (
            <Col key={spec.name} xs={24} sm={12} lg={8}>
              <Card
                size="small"
                title={<span className="mono">{spec.name}</span>}
                extra={
                  <Space size={4}>
                    <Tag color={spec.source === 'platform' ? 'blue' : spec.source === 'builtin' ? 'gold' : 'default'}>
                      {spec.source === 'platform' ? '平台' : spec.source === 'builtin' ? '内置' : '导入'}
                    </Tag>
                    <Switch
                      size="small"
                      checked={spec.enabled}
                      loading={busyName === spec.name}
                      onChange={(checked) => void toggle(spec, checked)}
                    />
                  </Space>
                }
                actions={[
                  <Button key="edit" type="text" icon={<EditOutlined />} onClick={() => openEditor(spec)}>
                    编辑
                  </Button>,
                  <Popconfirm
                    key="delete"
                    title="删除该技能？"
                    description={spec.source === 'builtin' ? '这是内置技能，删除后需要重新同步才能恢复。' : undefined}
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => void remove(spec)}
                  >
                    <Button type="text" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Typography.Text>{spec.description || '（无描述）'}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    更新于 {formatTime(spec.updatedAt)}
                  </Typography.Text>
                  <Collapse
                    ghost
                    size="small"
                    items={[
                      {
                        key: 'body',
                        label: '查看正文',
                        children: (
                          <pre className="sre-json" style={{ maxHeight: 220 }}>
                            {spec.body || '（正文为空）'}
                          </pre>
                        ),
                      },
                    ]}
                  />
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Modal
        title={editingName ? `编辑技能：${editingName}` : '新建技能'}
        open={editorOpen}
        width={760}
        onCancel={() => setEditorOpen(false)}
        onOk={() => void save()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
      >
        <Form<SkillFormValues> form={form} layout="vertical">
          <Form.Item
            name="name"
            label="技能名称"
            tooltip="kebab-case，同时作为内核技能目录名"
            rules={[
              { required: true, message: '请输入技能名称' },
              {
                validator: (_rule, value: string) =>
                  !value || isKebabCase(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error('只能使用小写字母、数字和连字符，例如 disk-triage')),
              },
            ]}
          >
            <Input
              disabled={editingName !== null}
              placeholder="disk-triage"
              onChange={(event) => {
                if (editingName !== null) return
                if (isKebabCase(event.target.value) || event.target.value === '') return
                form.setFieldValue('name', toKebabCase(event.target.value))
              }}
            />
          </Form.Item>
          <Form.Item name="description" label="描述" rules={[{ required: true, message: '请输入描述' }]}>
            <Input.TextArea rows={3} placeholder="一句话说明该技能适用于什么场景" />
          </Form.Item>
          <Form.Item
            name="body"
            label="正文（Markdown）"
            rules={[{ required: true, message: '请输入技能正文' }]}
          >
            <Input.TextArea rows={14} className="mono" placeholder={'## 适用场景\n- …\n\n## 步骤\n1. …'} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
