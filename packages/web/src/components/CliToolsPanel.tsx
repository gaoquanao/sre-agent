/**
 * CLI tool management panel: lists the external CLI binaries the CLI kernels
 * depend on, and drives `POST /api/clis/:name/install`. Installations can take
 * 1-3 minutes, so the row button keeps a loading state until the server answers.
 */
import { useState } from 'react'
import { Alert, App as AntApp, Button, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { api } from '../api'
import { useAsyncData } from '../hooks'
import type { CliToolInfo } from '../types'

const CLI_SOURCE_META: Record<string, { label: string; color: string }> = {
  path: { label: '本机 PATH', color: 'green' },
  platform: { label: '平台托管', color: 'blue' },
  missing: { label: '未找到', color: 'default' },
}

export default function CliToolsPanel(): JSX.Element {
  const { message, modal } = AntApp.useApp()
  const clis = useAsyncData(() => api.clis(), [])
  const [installing, setInstalling] = useState<string | null>(null)

  async function install(name: string): Promise<void> {
    setInstalling(name)
    try {
      const result = await api.installCli(name)
      clis.reload()
      if (result.ok) {
        void message.success(`CLI「${name}」安装完成`)
      } else {
        void message.error(`CLI「${name}」安装失败，详见安装日志`)
      }
      if (result.log) {
        modal.info({
          title: `安装日志：${name}`,
          width: 760,
          okText: '关闭',
          content: <pre className="sre-json" style={{ maxHeight: 420 }}>{result.log}</pre>,
        })
      }
    } catch {
      /* surfaced by the API layer */
    } finally {
      setInstalling(null)
    }
  }

  const columns: ColumnsType<CliToolInfo> = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 150,
      render: (_v, record) => (
        <Space size={4}>
          <span className="mono">{record.name}</span>
          {record.note ? (
            <Tooltip title={record.note}>
              <Typography.Text type="secondary">*</Typography.Text>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: '命令',
      dataIndex: 'bin',
      width: 120,
      render: (_v, record) => <span className="mono">{record.bin}</span>,
    },
    {
      title: '包名',
      dataIndex: 'pkg',
      width: 220,
      render: (_v, record) => (record.pkg ? <span className="mono">{record.pkg}</span> : <Typography.Text type="secondary">-</Typography.Text>),
    },
    {
      title: '状态',
      dataIndex: 'installed',
      width: 90,
      render: (_v, record) =>
        record.installed ? <Tag color="green">已安装</Tag> : <Tag color="red">未安装</Tag>,
    },
    {
      title: '版本',
      dataIndex: 'version',
      width: 110,
      render: (_v, record) => (record.version ? <span className="mono">{record.version}</span> : <Typography.Text type="secondary">-</Typography.Text>),
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 110,
      render: (_v, record) => {
        if (!record.source) return <Typography.Text type="secondary">-</Typography.Text>
        const meta = CLI_SOURCE_META[record.source] ?? { label: record.source, color: 'default' }
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_v, record) => (
        <Button
          size="small"
          icon={<DownloadOutlined />}
          loading={installing === record.name}
          onClick={() => void install(record.name)}
        >
          {record.installed ? '重装' : '安装'}
        </Button>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="CLI 内核依赖本机命令行工具；安装通过包管理器进行，可能耗时 1-3 分钟，期间请保持本页打开。"
      />
      <Space>
        <Button size="small" icon={<ReloadOutlined />} onClick={clis.reload} loading={clis.loading}>
          刷新
        </Button>
      </Space>
      {clis.error ? <Alert type="error" showIcon message={`CLI 列表加载失败：${clis.error}`} /> : null}
      <Table<CliToolInfo>
        size="small"
        rowKey="name"
        loading={clis.loading && !clis.data}
        dataSource={clis.data ?? []}
        columns={columns}
        pagination={false}
        locale={{ emptyText: '暂无 CLI 工具信息' }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        共 {(clis.data ?? []).length} 个 CLI 工具
      </Typography.Text>
    </Space>
  )
}
