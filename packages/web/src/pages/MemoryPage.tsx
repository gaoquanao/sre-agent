/** 记忆页：记忆列表 / 新增 / 删除 + 检索测试面板。 */
import { useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { MemoryItem, MemoryKind, MemorySearchHit } from '@sre/protocol'
import { api, apiErrorMessage } from '../api'
import { useAsyncData } from '../hooks'
import { formatTime } from '../utils'

interface MemoryFormValues {
  kind: MemoryKind
  subject: string
  text: string
  tags?: string[]
  importance?: number
}

const KIND_META: Record<MemoryKind, { label: string; color: string }> = {
  fact: { label: '事实 fact', color: 'blue' },
  episode: { label: '事件 episode', color: 'orange' },
  preference: { label: '偏好 preference', color: 'purple' },
}

const KIND_OPTIONS = (Object.keys(KIND_META) as MemoryKind[]).map((kind) => ({
  value: kind,
  label: KIND_META[kind].label,
}))

const SOURCE_LABEL: Record<MemoryItem['source'], string> = {
  agent: 'agent 写入',
  operator: '操作者',
  system: '系统',
}

function KindTag({ kind }: { kind: MemoryKind }): JSX.Element {
  const meta = KIND_META[kind] ?? { label: kind, color: 'default' }
  return <Tag color={meta.color}>{meta.label}</Tag>
}

export default function MemoryPage(): JSX.Element {
  const { message } = AntApp.useApp()
  const memories = useAsyncData(() => api.memory(200), [])

  const [addOpen, setAddOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<MemoryFormValues>()

  const [query, setQuery] = useState('')
  const [searchKind, setSearchKind] = useState<MemoryKind | undefined>(undefined)
  const [topK, setTopK] = useState<number>(5)
  const [hits, setHits] = useState<MemorySearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  async function addMemory(): Promise<void> {
    let values: MemoryFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setSaving(true)
    try {
      await api.addMemory({
        kind: values.kind,
        subject: values.subject.trim(),
        text: values.text,
        tags: values.tags && values.tags.length > 0 ? values.tags : undefined,
        importance: values.importance ?? 3,
      })
      setAddOpen(false)
      form.resetFields()
      memories.reload()
      void message.success('记忆已保存')
    } catch {
      /* surfaced by the API layer */
    } finally {
      setSaving(false)
    }
  }

  async function deleteMemory(item: MemoryItem): Promise<void> {
    try {
      await api.deleteMemory(item.id)
      memories.reload()
      void message.success('记忆已删除')
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function runSearch(): Promise<void> {
    const text = query.trim()
    if (!text) return
    setSearching(true)
    try {
      const result = await api.searchMemory({
        query: text,
        ...(searchKind ? { kind: searchKind } : {}),
        topK,
      })
      setHits(result)
      setSearchError(null)
    } catch (err) {
      setSearchError(apiErrorMessage(err))
      setHits([])
    } finally {
      setSearching(false)
    }
  }

  const columns: ColumnsType<MemoryItem> = [
    {
      title: '类型',
      dataIndex: 'kind',
      width: 120,
      render: (_v, record) => <KindTag kind={record.kind} />,
    },
    {
      title: '主体',
      dataIndex: 'subject',
      width: 160,
      render: (_v, record) => <span className="mono">{record.subject}</span>,
    },
    {
      title: '内容',
      dataIndex: 'text',
      render: (_v, record) => (
        <Tooltip title={record.text} placement="topLeft">
          <Typography.Text style={{ maxWidth: 420 }} ellipsis>
            {record.text}
          </Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 160,
      render: (_v, record) =>
        record.tags.length > 0 ? (
          <Space size={4} wrap>
            {record.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </Space>
        ) : (
          '-'
        ),
    },
    {
      title: '重要度',
      dataIndex: 'importance',
      width: 80,
      render: (_v, record) => <Tag color={record.importance >= 4 ? 'red' : 'default'}>{record.importance}</Tag>,
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 120,
      render: (_v, record) => (
        <Space size={4} direction="vertical">
          <Tag>{SOURCE_LABEL[record.source] ?? record.source}</Tag>
          {record.sourceSessionId ? (
            <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
              {record.sourceSessionId.slice(0, 12)}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '写入时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (_v, record) => (
        <Tooltip title={`最近访问 ${formatTime(record.lastAccessedAt)}，访问 ${record.accessCount} 次`}>
          <span>{formatTime(record.createdAt)}</span>
        </Tooltip>
      ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 70,
      render: (_v, record) => (
        <Popconfirm title="删除该条记忆？" okText="删除" cancelText="取消" onConfirm={() => void deleteMemory(record)}>
          <Button size="small" danger type="text" icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {memories.error ? <Alert type="error" showIcon message={`记忆列表加载失败：${memories.error}`} /> : null}

      <Alert
        type="info"
        showIcon
        message="记忆会自动注入 agent 会话上下文（自动召回最多 3 条）；agent 也可通过 memory_search / memory_save 工具读写"
      />

      <Row gutter={[12, 12]}>
        <Col xs={24} xl={15}>
          <Card
            size="small"
            title="记忆列表"
            extra={
              <Space>
                <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
                  新增记忆
                </Button>
                <Button size="small" icon={<ReloadOutlined />} onClick={memories.reload} loading={memories.loading} />
              </Space>
            }
          >
            <Table<MemoryItem>
              size="small"
              rowKey="id"
              loading={memories.loading}
              dataSource={memories.data ?? []}
              columns={columns}
              scroll={{ x: 1000 }}
              pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }}
              locale={{ emptyText: '暂无记忆，agent 运行或手动新增后会出现在这里' }}
            />
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <Card size="small" title="检索测试" extra={<Typography.Text type="secondary">POST /api/memory/search</Typography.Text>}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  placeholder="输入要召回的问题或关键词"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onPressEnter={() => void runSearch()}
                />
                <Button type="primary" icon={<SearchOutlined />} loading={searching} onClick={() => void runSearch()}>
                  检索
                </Button>
              </Space.Compact>
              <Space size={8} wrap>
                <Select
                  size="small"
                  allowClear
                  style={{ minWidth: 160 }}
                  placeholder="按类型过滤（可留空）"
                  value={searchKind}
                  onChange={setSearchKind}
                  options={KIND_OPTIONS}
                />
                <span>
                  topK{' '}
                  <InputNumber size="small" min={1} max={20} value={topK} onChange={(value) => setTopK(value ?? 5)} />
                </span>
              </Space>

              {searchError ? <Alert type="error" showIcon message={`检索失败：${searchError}`} /> : null}

              {hits === null ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入关键词后点击「检索」" />
              ) : hits.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有命中任何记忆" />
              ) : (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Typography.Text type="secondary">命中 {hits.length} 条</Typography.Text>
                  <div style={{ maxHeight: 520, overflowY: 'auto' }}>
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      {hits.map((hit) => (
                        <div className="sre-kb-hit" key={hit.id}>
                          <Space size={6} wrap>
                            <KindTag kind={hit.kind} />
                            <span className="mono">{hit.subject}</span>
                            <Tag color="geekblue">score {hit.score.toFixed(3)}</Tag>
                            <Typography.Text type="secondary">重要度 {hit.importance}</Typography.Text>
                          </Space>
                          <pre className="sre-pre" style={{ marginTop: 6, fontSize: 12 }}>
                            {hit.text}
                          </pre>
                          {hit.tags.length > 0 ? (
                            <Space size={4} wrap style={{ marginTop: 4 }}>
                              {hit.tags.map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                              ))}
                            </Space>
                          ) : null}
                        </div>
                      ))}
                    </Space>
                  </div>
                </Space>
              )}
            </Space>
          </Card>
        </Col>
      </Row>

      <Modal
        title="新增记忆"
        open={addOpen}
        width={640}
        onCancel={() => setAddOpen(false)}
        onOk={() => void addMemory()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
      >
        <Form<MemoryFormValues> form={form} layout="vertical" initialValues={{ kind: 'fact', importance: 3 }}>
          <Form.Item name="kind" label="类型" rules={[{ required: true, message: '请选择类型' }]}>
            <Select options={KIND_OPTIONS} />
          </Form.Item>
          <Form.Item name="subject" label="主体" tooltip="这条记忆是关于谁的：服务名、global、事件 ID…">
            <Input className="mono" placeholder="prod-api / global / INC-2024-001" />
          </Form.Item>
          <Form.Item name="text" label="内容" rules={[{ required: true, message: '请输入记忆内容' }]}>
            <Input.TextArea rows={4} placeholder="prod-api 的数据库连接池上限为 200，压测时不要超过" />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="mysql, 容量, 应急" />
          </Form.Item>
          <Form.Item name="importance" label="重要度" tooltip="1-5，越高越不容易被清理">
            <InputNumber min={1} max={5} style={{ width: 120 }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
