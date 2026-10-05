/** 知识库页：文档入库 / 删除 + 检索测试面板。 */
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
  Typography,
} from 'antd'
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { KbDoc, KbHit } from '@sre/protocol'
import { api, apiErrorMessage } from '../api'
import { useAsyncData } from '../hooks'
import { formatTime } from '../utils'

interface DocFormValues {
  title?: string
  source: string
  tags?: string[]
  mime?: string
  text: string
}

const MIME_OPTIONS = [
  { value: 'text/markdown', label: 'text/markdown' },
  { value: 'text/plain', label: 'text/plain' },
  { value: 'application/json', label: 'application/json' },
  { value: 'text/html', label: 'text/html' },
]

const VIA_META: Record<KbHit['via'], { label: string; color: string }> = {
  bm25: { label: 'BM25 关键词', color: 'green' },
  vector: { label: '向量', color: 'blue' },
  hybrid: { label: '混合', color: 'purple' },
}

export default function KnowledgePage(): JSX.Element {
  const { message } = AntApp.useApp()
  const docs = useAsyncData(() => api.kbDocs(), [])

  const [addOpen, setAddOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<DocFormValues>()

  const [query, setQuery] = useState('')
  const [topK, setTopK] = useState<number>(8)
  const [searchTags, setSearchTags] = useState<string[]>([])
  const [hits, setHits] = useState<KbHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  async function addDoc(): Promise<void> {
    let values: DocFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setSaving(true)
    try {
      await api.addKbDoc({
        title: values.title?.trim() || undefined,
        source: values.source.trim(),
        tags: values.tags && values.tags.length > 0 ? values.tags : undefined,
        mime: values.mime || undefined,
        text: values.text,
      })
      setAddOpen(false)
      form.resetFields()
      docs.reload()
      void message.success('文档已入库')
    } catch {
      /* surfaced by the API layer */
    } finally {
      setSaving(false)
    }
  }

  async function deleteDoc(doc: KbDoc): Promise<void> {
    try {
      await api.deleteKbDoc(doc.id)
      docs.reload()
      void message.success(`文档已删除：${doc.title}`)
    } catch {
      /* surfaced by the API layer */
    }
  }

  async function runSearch(): Promise<void> {
    const text = query.trim()
    if (!text) return
    setSearching(true)
    try {
      const result = await api.kbSearch({
        query: text,
        topK,
        ...(searchTags.length > 0 ? { tags: searchTags } : {}),
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

  const columns: ColumnsType<KbDoc> = [
    {
      title: '标题',
      dataIndex: 'title',
      render: (_v, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{record.title}</Typography.Text>
          <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
            {record.source}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 200,
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
    { title: '类型', dataIndex: 'mime', width: 140, render: (_v, record) => <Tag className="mono">{record.mime}</Tag> },
    { title: '分片', dataIndex: 'chunkCount', width: 80, render: (_v, record) => `${record.chunkCount} 段` },
    { title: '入库时间', dataIndex: 'createdAt', width: 170, render: (_v, record) => formatTime(record.createdAt) },
    {
      title: '操作',
      key: 'ops',
      width: 80,
      render: (_v, record) => (
        <Popconfirm title="删除该文档？" okText="删除" cancelText="取消" onConfirm={() => void deleteDoc(record)}>
          <Button size="small" danger type="text" icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {docs.error ? <Alert type="error" showIcon message={`知识库加载失败：${docs.error}`} /> : null}

      <Row gutter={[12, 12]}>
        <Col xs={24} xl={14}>
          <Card
            size="small"
            title="文档"
            extra={
              <Space>
                <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
                  入库文档
                </Button>
                <Button size="small" icon={<ReloadOutlined />} onClick={docs.reload} loading={docs.loading} />
              </Space>
            }
          >
            <Table<KbDoc>
              size="small"
              rowKey="id"
              loading={docs.loading}
              dataSource={docs.data ?? []}
              columns={columns}
              scroll={{ x: 900 }}
              pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }}
              locale={{ emptyText: '知识库为空，先入库一份运维文档' }}
            />
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card size="small" title="检索测试" extra={<Typography.Text type="secondary">POST /api/kb/search</Typography.Text>}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  placeholder="输入问题或关键词"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onPressEnter={() => void runSearch()}
                />
                <Button type="primary" icon={<SearchOutlined />} loading={searching} onClick={() => void runSearch()}>
                  检索
                </Button>
              </Space.Compact>
              <Space size={8} wrap>
                <span>
                  topK{' '}
                  <InputNumber
                    size="small"
                    min={1}
                    max={50}
                    value={topK}
                    onChange={(value) => setTopK(value ?? 8)}
                  />
                </span>
                <Select
                  size="small"
                  mode="tags"
                  allowClear
                  style={{ minWidth: 220 }}
                  placeholder="按标签过滤（可留空）"
                  value={searchTags}
                  onChange={setSearchTags}
                  options={(docs.data ?? [])
                    .flatMap((doc) => doc.tags)
                    .filter((tag, index, array) => array.indexOf(tag) === index)
                    .map((tag) => ({ value: tag, label: tag }))}
                />
              </Space>

              {searchError ? <Alert type="error" showIcon message={`检索失败：${searchError}`} /> : null}

              {hits === null ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入关键词后点击「检索」" />
              ) : hits.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有命中任何分片" />
              ) : (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Typography.Text type="secondary">命中 {hits.length} 条</Typography.Text>
                  <div style={{ maxHeight: 520, overflowY: 'auto' }}>
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      {hits.map((hit) => {
                        const via = VIA_META[hit.via] ?? { label: hit.via, color: 'default' }
                        return (
                          <div className="sre-kb-hit" key={`${hit.docId}-${hit.chunkId}`}>
                            <Space size={6} wrap>
                              <Typography.Text strong>{hit.title}</Typography.Text>
                              <Tag color={via.color}>{via.label}</Tag>
                              <Tag>score {hit.score.toFixed(3)}</Tag>
                              <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
                                {hit.source} · 第 {hit.ord + 1} 段
                              </Typography.Text>
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
                        )
                      })}
                    </Space>
                  </div>
                </Space>
              )}
            </Space>
          </Card>
        </Col>
      </Row>

      <Modal
        title="入库文档"
        open={addOpen}
        width={760}
        onCancel={() => setAddOpen(false)}
        onOk={() => void addDoc()}
        okText="入库"
        cancelText="取消"
        confirmLoading={saving}
      >
        <Form<DocFormValues> form={form} layout="vertical" initialValues={{ mime: 'text/markdown' }}>
          <Form.Item name="title" label="标题">
            <Input placeholder="留空则由服务端从正文推断" />
          </Form.Item>
          <Form.Item name="source" label="来源" rules={[{ required: true, message: '请填写来源' }]}>
            <Input className="mono" placeholder="runbook/disk-pressure.md 或 https://…" />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="磁盘, mysql, 应急" />
          </Form.Item>
          <Form.Item name="mime" label="MIME">
            <Select allowClear options={MIME_OPTIONS} />
          </Form.Item>
          <Form.Item name="text" label="正文" rules={[{ required: true, message: '请粘贴或输入文档正文' }]}>
            <Input.TextArea rows={12} placeholder="支持 Markdown / 纯文本" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
