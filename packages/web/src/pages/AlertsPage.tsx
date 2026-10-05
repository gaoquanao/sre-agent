/** 告警页：告警列表、自动分诊，以及自测用的模拟上报表单。 */
import { useState } from 'react'
import {
  Alert as AntAlert,
  App as AntApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { ExperimentOutlined, PlusOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { Link, useNavigate } from 'react-router-dom'
import type { AlertEvent, AlertSeverity } from '@sre/protocol'
import { api } from '../api'
import { useAsyncData } from '../hooks'
import { useWsEvent } from '../ws'
import { SeverityTag } from '../components/StatusTags'
import KvEditor, { rowsToRecord, type KvRow } from '../components/KvEditor'
import JsonBlock from '../components/JsonBlock'
import { formatTime } from '../utils'

interface SimulatorValues {
  name: string
  severity: AlertSeverity
  target?: string
  summary?: string
  source?: string
  fingerprint?: string
}

export default function AlertsPage(): JSX.Element {
  const { message, notification } = AntApp.useApp()
  const navigate = useNavigate()
  const [triaging, setTriaging] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [labels, setLabels] = useState<KvRow[]>([])
  const [form] = Form.useForm<SimulatorValues>()

  const alerts = useAsyncData(() => api.alerts(100), [])

  useWsEvent('alert_received', (msg) => {
    alerts.setData((prev) => {
      const list = prev ?? []
      if (list.some((entry) => entry.id === msg.alert.id)) return list
      return [msg.alert, ...list]
    })
  })

  async function triage(alert: AlertEvent): Promise<void> {
    setTriaging(alert.id)
    try {
      const result = await api.triageAlert(alert.id)
      notification.success({
        key: `triage-${alert.id}`,
        message: '已创建分诊会话',
        description: `告警「${alert.name}」的分诊会话：${result.sessionId}`,
        btn: (
          <Button size="small" type="primary" onClick={() => navigate(`/?session=${encodeURIComponent(result.sessionId)}`)}>
            打开会话
          </Button>
        ),
      })
      alerts.reload()
    } catch {
      /* surfaced by the API layer */
    } finally {
      setTriaging(null)
    }
  }

  async function submitSimulated(): Promise<void> {
    let values: SimulatorValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setSubmitting(true)
    try {
      const result = await api.createAlert({
        name: values.name.trim(),
        severity: values.severity,
        target: values.target?.trim() || undefined,
        summary: values.summary?.trim() || undefined,
        source: values.source?.trim() || undefined,
        fingerprint: values.fingerprint?.trim() || undefined,
        labels: rowsToRecord(labels),
      })
      void message.success(
        `已上报告警 ${result.alert.id}${result.sessionId ? `，自动关联会话 ${result.sessionId}` : ''}`,
      )
      form.resetFields()
      setLabels([])
      alerts.reload()
    } catch {
      /* surfaced by the API layer */
    } finally {
      setSubmitting(false)
    }
  }

  const columns: ColumnsType<AlertEvent> = [
    { title: '级别', dataIndex: 'severity', width: 90, render: (_v, record) => <SeverityTag severity={record.severity} /> },
    {
      title: '名称',
      dataIndex: 'name',
      width: 220,
      render: (_v, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
            {record.fingerprint}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '目标',
      dataIndex: 'target',
      width: 180,
      render: (_v, record) => (record.target ? <span className="mono">{record.target}</span> : '-'),
    },
    {
      title: '摘要',
      dataIndex: 'summary',
      render: (_v, record) => (
        <Tooltip title={record.summary}>
          <Typography.Text type="secondary">{record.summary ?? '-'}</Typography.Text>
        </Tooltip>
      ),
    },
    { title: '来源', dataIndex: 'source', width: 140, render: (_v, record) => <Tag>{record.source}</Tag> },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (_v, record) =>
        record.status === 'firing' ? <Tag color="red">触发中</Tag> : <Tag color="green">已恢复</Tag>,
    },
    {
      title: '关联会话',
      dataIndex: 'sessionId',
      width: 120,
      render: (_v, record) =>
        record.sessionId ? (
          <Link to={`/?session=${encodeURIComponent(record.sessionId)}`} className="mono">
            {record.sessionId.slice(0, 8)}
          </Link>
        ) : (
          <Typography.Text type="secondary">未分诊</Typography.Text>
        ),
    },
    { title: '接收时间', dataIndex: 'receivedAt', width: 170, render: (_v, record) => formatTime(record.receivedAt) },
    {
      title: '操作',
      key: 'ops',
      width: 150,
      fixed: 'right',
      render: (_v, record) => (
        <Space size={4}>
          <Button
            size="small"
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={triaging === record.id}
            onClick={() => void triage(record)}
          >
            自动分诊
          </Button>
          {record.sessionId ? (
            <Button size="small" onClick={() => navigate(`/?session=${encodeURIComponent(record.sessionId ?? '')}`)}>
              打开
            </Button>
          ) : null}
        </Space>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {alerts.error ? <AntAlert type="error" showIcon message={`告警列表加载失败：${alerts.error}`} /> : null}

      <Card
        size="small"
        title="模拟上报（自测用）"
        extra={
          <Typography.Text type="secondary">
            调用 <span className="mono">POST /api/alerts</span>，可用于验证告警链路与自动分诊
          </Typography.Text>
        }
      >
        <Form<SimulatorValues>
          form={form}
          layout="vertical"
          initialValues={{ severity: 'warning', source: 'manual-test' }}
        >
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="name" label="告警名称" rules={[{ required: true, message: '请输入告警名称' }]}>
                <Input placeholder="HighCPUUsage" />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="severity" label="级别" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: 'critical', label: '严重 critical' },
                    { value: 'warning', label: '警告 warning' },
                    { value: 'info', label: '提示 info' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="target" label="目标">
                <Input placeholder="prod-api-01 / 10.0.0.12" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="source" label="来源">
                <Input placeholder="manual-test / alertmanager" />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="summary" label="摘要">
                <Input placeholder="CPU 使用率持续高于 90%（5 分钟）" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="fingerprint" label="指纹（去重键）">
                <Input placeholder="留空由服务端生成" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item label="标签">
                <KvEditor rows={labels} onChange={setLabels} keyPlaceholder="标签名" valuePlaceholder="标签值" />
              </Form.Item>
            </Col>
          </Row>
          <Space>
            <Button type="primary" icon={<PlusOutlined />} loading={submitting} onClick={() => void submitSimulated()}>
              上报告警
            </Button>
            <Button
              onClick={() => {
                form.resetFields()
                setLabels([])
              }}
            >
              重置表单
            </Button>
          </Space>
        </Form>
      </Card>

      <Space>
        <Button icon={<ReloadOutlined />} onClick={alerts.reload} loading={alerts.loading}>
          刷新
        </Button>
        <Button
          icon={<ExperimentOutlined />}
          onClick={() => {
            form.setFieldValue('name', `TestAlert-${Math.random().toString(36).slice(2, 6)}`)
            void message.info('已填充随机告警名，可直接上报')
          }}
        >
          随机填充
        </Button>
      </Space>

      <Table<AlertEvent>
        size="small"
        rowKey="id"
        loading={alerts.loading}
        dataSource={alerts.data ?? []}
        columns={columns}
        scroll={{ x: 1400 }}
        pagination={{ pageSize: 20, size: 'small', showSizeChanger: false }}
        locale={{ emptyText: '暂无告警' }}
        expandable={{
          expandedRowRender: (record) => <JsonBlock value={{ labels: record.labels, raw: record.raw }} maxHeight={200} />,
        }}
      />
    </Space>
  )
}
