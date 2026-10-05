/** 内核页：内核卡片（能力矩阵 / 健康状态 / 启停切换）+ CLI 工具 / 凭证托管 + 平台日志流。 */
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Modal,
  Row,
  Segmented,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  CheckCircleOutlined,
  CloudSyncOutlined,
  PoweroffOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { KernelCapabilities, KernelId, KernelInfo, SyncReport } from '@sre/protocol'
import { api } from '../api'
import { useAppState } from '../state'
import { useAsyncData } from '../hooks'
import { useWsEvent } from '../ws'
import { KernelStatusTag } from '../components/StatusTags'
import CliToolsPanel from '../components/CliToolsPanel'
import CredentialsPanel from '../components/CredentialsPanel'
import { LOG_LEVEL_COLOR, formatTime, formatTimeShort } from '../utils'
import type { PlatformLog } from '../types'

const PLATFORM_GATE_WARNING = '平台审批门不可用：工具在 CLI 进程内执行，仅能通过 CLI 自身权限参数约束'

const CAPABILITY_LABELS: Array<{ key: keyof KernelCapabilities; label: string; hint: string }> = [
  { key: 'inProcess', label: '进程内运行', hint: '内核运行在平台进程内，还是作为被管理的子进程' },
  { key: 'nativeApproval', label: '原生审批', hint: '内核自带审批服务，可以阻塞工具调用等待人工决定' },
  { key: 'toolRegistration', label: '运行时注册工具', hint: '平台可以在运行时向内核注册工具' },
  { key: 'skillSync', label: '技能同步', hint: '技能通过 files / plugin 方式同步到内核' },
  { key: 'mcpSync', label: 'MCP 同步', hint: 'MCP 配置通过 files / plugin 方式同步到内核' },
  { key: 'modelSwitch', label: '模型切换', hint: 'runtime 可中途换模型；session-recreate 需要重建会话' },
  { key: 'tokenStreaming', label: 'Token 流式', hint: '是否提供 token 级增量输出' },
  { key: 'sessionResume', label: '会话恢复', hint: '内核持久化会话，平台可列出并恢复' },
]

function capabilityValue(capabilities: KernelCapabilities, key: keyof KernelCapabilities): JSX.Element {
  const value = capabilities[key]
  if (typeof value === 'boolean') {
    return value ? <Tag color="green">支持</Tag> : <Tag>不支持</Tag>
  }
  if (value === 'none') return <Tag>不支持</Tag>
  return <Tag color="blue">{String(value)}</Tag>
}

export default function KernelsPage(): JSX.Element {
  const { message } = AntApp.useApp()
  const { selectedKernel, reload: reloadBootstrap } = useAppState()
  const kernels = useAsyncData(() => api.kernels(), [])
  const logs = useAsyncData(() => api.logs(100), [])

  const [entries, setEntries] = useState<PlatformLog[]>([])
  const [levelFilter, setLevelFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [resyncing, setResyncing] = useState(false)
  const [reports, setReports] = useState<SyncReport[] | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (logs.data) setEntries(logs.data)
  }, [logs.data])

  useWsEvent('log', (msg) => {
    setEntries((prev) => [
      ...prev.slice(-499),
      { ts: Date.now(), level: msg.level, scope: msg.scope, text: msg.text },
    ])
  })

  useWsEvent('kernel_status', (msg) => {
    kernels.setData((prev) =>
      (prev ?? []).map((kernel) => (kernel.id === msg.kernel ? { ...kernel, health: msg.health } : kernel)),
    )
  })

  useEffect(() => {
    const element = logRef.current
    if (!element || !autoScroll) return
    element.scrollTop = element.scrollHeight
  }, [entries, autoScroll])

  async function startKernel(id: KernelId): Promise<void> {
    setBusy(id)
    try {
      await api.startKernel(id)
      kernels.reload()
      void reloadBootstrap()
      void message.success(`已请求启动内核：${id}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setBusy(null)
    }
  }

  async function stopKernel(id: KernelId): Promise<void> {
    setBusy(id)
    try {
      await api.stopKernel(id)
      kernels.reload()
      void reloadBootstrap()
      void message.success(`已请求停止内核：${id}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setBusy(null)
    }
  }

  async function selectKernel(id: KernelId): Promise<void> {
    setBusy(id)
    try {
      await api.selectKernel(id)
      kernels.reload()
      await reloadBootstrap()
      void message.success(`已切换首选内核：${id}`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setBusy(null)
    }
  }

  async function resync(): Promise<void> {
    setResyncing(true)
    try {
      const result = await api.resyncKernels()
      setReports(result)
      kernels.reload()
      const ok = result.filter((report) => report.ok).length
      void message.success(`同步完成：${ok}/${result.length} 项成功`)
    } catch {
      /* surfaced by the API layer */
    } finally {
      setResyncing(false)
    }
  }

  const visibleLogs = levelFilter === 'all' ? entries : entries.filter((entry) => entry.level === levelFilter)

  const reportColumns: ColumnsType<SyncReport> = [
    {
      title: '目标',
      dataIndex: 'target',
      width: 200,
      render: (_v, record) => <span className="mono">{record.target}</span>,
    },
    {
      title: '结果',
      dataIndex: 'ok',
      width: 100,
      render: (_v, record) => (record.ok ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>),
    },
    {
      title: '写入',
      dataIndex: 'written',
      render: (_v, record) => (
        <Space size={4} wrap>
          {(record.written ?? []).map((item) => (
            <Tag key={item} className="mono">
              {item}
            </Tag>
          ))}
          {(record.written ?? []).length === 0 ? <Typography.Text type="secondary">-</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: '移除',
      dataIndex: 'removed',
      render: (_v, record) => (
        <Space size={4} wrap>
          {(record.removed ?? []).map((item) => (
            <Tag key={item} className="mono">
              {item}
            </Tag>
          ))}
          {(record.removed ?? []).length === 0 ? <Typography.Text type="secondary">-</Typography.Text> : null}
        </Space>
      ),
    },
    { title: '消息', dataIndex: 'message', render: (_v, record) => record.message ?? '-' },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {kernels.error ? <Alert type="error" showIcon message={`内核列表加载失败：${kernels.error}`} /> : null}

      <Space>
        <Button icon={<ReloadOutlined />} onClick={kernels.reload} loading={kernels.loading}>
          刷新内核状态
        </Button>
        <Button icon={<CloudSyncOutlined />} loading={resyncing} onClick={() => void resync()}>
          重新同步技能/MCP
        </Button>
      </Space>

      <Row gutter={[12, 12]}>
        {(kernels.data ?? []).map((kernel: KernelInfo) => {
          const selected = kernel.id === selectedKernel
          const running = kernel.health.status === 'ready' || kernel.health.status === 'degraded' || kernel.health.status === 'starting'
          return (
            <Col key={kernel.id} xs={24} xl={12}>
              <Card
                size="small"
                title={
                  <Space size={6} wrap>
                    <span>{kernel.displayName}</span>
                    <Tag className="mono">{kernel.id}</Tag>
                    <KernelStatusTag status={kernel.health.status} detail={kernel.health.detail} />
                    {selected ? <Tag color="blue">当前内核</Tag> : null}
                    {kernel.capabilities.platformApprovalGate === false ? (
                      <Tooltip title={PLATFORM_GATE_WARNING}>
                        <Tag color="warning" icon={<WarningOutlined />}>
                          平台审批门不可用
                        </Tag>
                      </Tooltip>
                    ) : null}
                  </Space>
                }
                extra={<Typography.Text type="secondary">{kernel.version ? `v${kernel.version}` : ''}</Typography.Text>}
              >
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  <Descriptions
                    size="small"
                    column={2}
                    items={[
                      {
                        key: 'detail',
                        label: '健康详情',
                        children: kernel.health.detail ?? '-',
                      },
                      {
                        key: 'sessions',
                        label: '内核会话数',
                        children:
                          kernel.health.sessions === undefined ? '-' : `${kernel.health.sessions} 个`,
                      },
                      {
                        key: 'since',
                        label: '状态起始',
                        children: kernel.health.since ? formatTime(kernel.health.since) : '-',
                      },
                      {
                        key: 'tools',
                        label: '已暴露工具',
                        children:
                          kernel.health.tools && kernel.health.tools.length > 0 ? (
                            <Tooltip
                              title={
                                <Space size={4} wrap>
                                  {kernel.health.tools.map((tool) => (
                                    <span key={tool} className="mono">
                                      {tool}
                                    </span>
                                  ))}
                                </Space>
                              }
                            >
                              <span>{kernel.health.tools.length} 个</span>
                            </Tooltip>
                          ) : (
                            '未知'
                          ),
                      },
                    ]}
                  />

                  <div>
                    <Typography.Text type="secondary">能力矩阵</Typography.Text>
                    <Descriptions
                      size="small"
                      column={2}
                      style={{ marginTop: 6 }}
                      items={CAPABILITY_LABELS.map((item) => ({
                        key: item.key,
                        label: (
                          <Tooltip title={item.hint}>
                            <span style={{ borderBottom: '1px dotted currentColor' }}>{item.label}</span>
                          </Tooltip>
                        ),
                        children: capabilityValue(kernel.capabilities, item.key),
                      }))}
                    />
                  </div>

                  <Space wrap>
                    <Button
                      size="small"
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      disabled={running}
                      loading={busy === kernel.id}
                      onClick={() => void startKernel(kernel.id)}
                    >
                      启动
                    </Button>
                    <Button
                      size="small"
                      danger
                      icon={<PoweroffOutlined />}
                      disabled={!running}
                      loading={busy === kernel.id}
                      onClick={() => void stopKernel(kernel.id)}
                    >
                      停止
                    </Button>
                    <Button
                      size="small"
                      icon={<CheckCircleOutlined />}
                      disabled={selected}
                      loading={busy === kernel.id}
                      onClick={() => void selectKernel(kernel.id)}
                    >
                      {selected ? '已是当前内核' : '切换为当前内核'}
                    </Button>
                  </Space>
                </Space>
              </Card>
            </Col>
          )
        })}
      </Row>

      <Card size="small" title="CLI 与凭证">
        <Tabs
          size="small"
          items={[
            { key: 'clis', label: 'CLI 工具管理', children: <CliToolsPanel /> },
            { key: 'credentials', label: '凭证托管', children: <CredentialsPanel /> },
          ]}
        />
      </Card>

      <Card
        size="small"
        title="平台日志"
        extra={
          <Space size={8} wrap>
            <Segmented
              size="small"
              value={levelFilter}
              onChange={(value) => setLevelFilter(value as typeof levelFilter)}
              options={[
                { label: '全部', value: 'all' },
                { label: 'info', value: 'info' },
                { label: 'warn', value: 'warn' },
                { label: 'error', value: 'error' },
              ]}
            />
            <Tooltip title="自动滚动到底部">
              <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
            </Tooltip>
            <Button size="small" icon={<ReloadOutlined />} onClick={logs.reload} loading={logs.loading}>
              重新拉取
            </Button>
            <Button size="small" onClick={() => setEntries([])}>
              清空
            </Button>
          </Space>
        }
      >
        {logs.error ? <Alert type="error" showIcon message={`日志加载失败：${logs.error}`} style={{ marginBottom: 8 }} /> : null}
        <div className="sre-log" ref={logRef}>
          {visibleLogs.length === 0 ? (
            <Typography.Text type="secondary">暂无日志</Typography.Text>
          ) : (
            visibleLogs.map((entry, index) => (
              <div className="sre-log-line" key={`${entry.ts}-${index}`}>
                <span className="sre-log-ts">{formatTimeShort(entry.ts)}</span>
                <span className="sre-log-scope">[{entry.scope}]</span>
                <span style={{ color: LOG_LEVEL_COLOR[entry.level] ?? 'inherit' }}>
                  {entry.level.toUpperCase()} {entry.text}
                </span>
              </div>
            ))
          )}
        </div>
      </Card>

      <Modal
        title="同步报告"
        open={reports !== null}
        width={820}
        footer={null}
        onCancel={() => setReports(null)}
      >
        <Table<SyncReport>
          size="small"
          rowKey={(record) => record.target}
          dataSource={reports ?? []}
          columns={reportColumns}
          pagination={false}
          locale={{ emptyText: '没有同步结果' }}
        />
      </Modal>
    </Space>
  )
}
