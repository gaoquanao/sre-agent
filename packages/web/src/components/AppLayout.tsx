/** Application shell: left navigation, top bar (kernel / approvals / socket / theme). */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { App as AntApp, Badge, Button, Layout, Menu, Select, Space, Tag, Tooltip, Typography, theme as antdTheme } from 'antd'
import {
  ApiOutlined,
  BulbOutlined,
  DisconnectOutlined,
  MoonOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router-dom'
import type { KernelId } from '@sre/protocol'
import { useAppState } from '../state'
import { useWsStatus } from '../ws'
import { api } from '../api'
import { kernelStatusMeta } from '../utils'
import { NAV_ITEMS } from '../nav'

export default function AppLayout({ children }: { children: ReactNode }): JSX.Element {
  const { bootstrap, reload, selectedKernel, pendingApprovals, themeMode, setThemeMode } = useAppState()
  const { message } = AntApp.useApp()
  const ws = useWsStatus()
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = antdTheme.useToken()
  const [collapsed, setCollapsed] = useState(false)
  const [switching, setSwitching] = useState(false)

  const activeKey = NAV_ITEMS.find((item) => item.path === location.pathname)?.key ?? 'chat'

  const wsMeta =
    ws.state === 'open'
      ? { color: 'green', text: '实时通道已连接' }
      : ws.state === 'connecting'
        ? { color: 'orange', text: '实时通道连接中' }
        : { color: 'red', text: '实时通道已断开' }

  async function handleKernelChange(kernel: KernelId): Promise<void> {
    setSwitching(true)
    try {
      await api.selectKernel(kernel)
      await reload()
      void message.success(`已切换内核：${kernel}`)
    } catch {
      /* the API layer already surfaced the failure */
    } finally {
      setSwitching(false)
    }
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme={themeMode === 'dark' ? 'dark' : 'light'}
        width={196}
      >
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: 8,
            padding: '0 16px',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <ApiOutlined />
          {collapsed ? null : <span>SRE Agent</span>}
        </div>
        <Menu
          mode="inline"
          theme={themeMode === 'dark' ? 'dark' : 'light'}
          selectedKeys={[activeKey]}
          onClick={({ key }) => {
            const item = NAV_ITEMS.find((entry) => entry.key === key)
            if (item) navigate(item.path)
          }}
          items={NAV_ITEMS.map((item) => ({
            key: item.key,
            icon: item.icon,
            label:
              item.key === 'approvals' && pendingApprovals > 0 ? (
                <Space size={6}>
                  <span>{item.label}</span>
                  <Badge count={pendingApprovals} size="small" />
                </Space>
              ) : (
                item.label
              ),
          }))}
        />
      </Layout.Sider>

      <Layout>
        <Layout.Header
          style={{
            height: 56,
            lineHeight: '56px',
            padding: '0 16px',
            background: token.colorBgContainer,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <Space size={8} wrap>
            <Typography.Text strong>{bootstrap?.version ? `SRE Agent 控制台 v${bootstrap.version}` : 'SRE Agent 控制台'}</Typography.Text>
            {selectedKernel ? <Tag color="blue">当前内核 {selectedKernel}</Tag> : null}
          </Space>

          <Space size={8} wrap>
            <Select
              size="small"
              style={{ minWidth: 180 }}
              loading={switching}
              value={selectedKernel ?? undefined}
              placeholder="选择内核"
              onChange={(value) => void handleKernelChange(value as KernelId)}
              options={(bootstrap?.kernels ?? []).map((kernel) => {
                const meta = kernelStatusMeta(kernel.health.status)
                return {
                  value: kernel.id,
                  label: `${kernel.displayName}（${meta.label}）`,
                }
              })}
            />

            <Tooltip title={`${wsMeta.text}${ws.error ? `：${ws.error}` : ''}`}>
              <Tag color={wsMeta.color} icon={ws.state === 'open' ? <ApiOutlined /> : <DisconnectOutlined />}>
                {ws.state === 'open' ? '实时' : ws.state === 'connecting' ? '连接中' : '离线'}
              </Tag>
            </Tooltip>

            <Badge count={pendingApprovals} size="small" offset={[-2, 2]}>
              <Button
                size="small"
                icon={<SafetyCertificateOutlined />}
                onClick={() => navigate('/approvals')}
                type={pendingApprovals > 0 ? 'primary' : 'default'}
                danger={pendingApprovals > 0}
              >
                待审批
              </Button>
            </Badge>

            <Tooltip title="重新拉取平台状态">
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void reload()} />
            </Tooltip>

            <Tooltip title={themeMode === 'dark' ? '切换到浅色主题' : '切换到深色主题'}>
              <Button
                size="small"
                icon={themeMode === 'dark' ? <BulbOutlined /> : <MoonOutlined />}
                onClick={() => setThemeMode(themeMode === 'dark' ? 'light' : 'dark')}
              />
            </Tooltip>
          </Space>
        </Layout.Header>

        <Layout.Content style={{ height: 'calc(100vh - 56px)', overflow: 'auto' }}>
          <div className="sre-page">{children}</div>
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
