/**
 * Application-level state: platform bootstrap, pending approval counter, theme
 * mode, and the WebSocket driven notifications (approval requests / alerts).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { App as AntApp, Button, Space, Tag } from 'antd'
import { useNavigate } from 'react-router-dom'
import type { BootstrapPayload, KernelId } from '@sre/protocol'
import { api, apiErrorMessage } from './api'
import { useWsEvent } from './ws'
import { originLabel, riskMeta } from './utils'
import type { ThemeMode } from './types'

interface AppStateValue {
  /** Latest bootstrap payload, or null while the platform is unreachable. */
  bootstrap: BootstrapPayload | null
  loading: boolean
  /** Set when `GET /api/bootstrap` failed — the shell then shows the offline screen. */
  fatalError: string | null
  reload: () => Promise<void>
  selectedKernel: KernelId | null
  pendingApprovals: number
  refreshPendingApprovals: () => Promise<void>
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => void
}

const AppStateContext = createContext<AppStateValue | null>(null)

interface AppStateProviderProps {
  children: ReactNode
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => void
}

export function AppStateProvider({ children, themeMode, setThemeMode }: AppStateProviderProps): JSX.Element {
  const { message, notification } = AntApp.useApp()
  const navigate = useNavigate()

  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [pendingApprovals, setPendingApprovals] = useState(0)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const payload = await api.bootstrap()
      setBootstrap(payload)
      setPendingApprovals(payload.pendingApprovals ?? 0)
      setFatalError(null)
    } catch (err) {
      setFatalError(apiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const refreshPendingApprovals = useCallback(async () => {
    try {
      const pending = await api.approvals('pending')
      setPendingApprovals(pending.length)
    } catch {
      /* the badge is best-effort; a failure must not disturb the page */
    }
  }, [])

  // Keep the badge honest even when the socket is down.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshPendingApprovals()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [refreshPendingApprovals])

  useWsEvent('approval_requested', (msg) => {
    setPendingApprovals((count) => count + 1)
    const approval = msg.approval
    const risk = riskMeta(approval.risk)
    notification.warning({
      key: `approval-${approval.id}`,
      message: '收到工具审批请求',
      description: (
        <Space direction="vertical" size={2}>
          <span>
            工具 <Tag color="geekblue">{approval.toolName}</Tag> 等待决定
          </span>
          <span>
            风险 <Tag color={risk.color}>{risk.label}</Tag> 来源 {originLabel(approval.origin)} 会话{' '}
            <span className="mono">{approval.sessionId.slice(0, 8)}</span>
          </span>
        </Space>
      ),
      duration: 0,
      btn: (
        <Button
          size="small"
          type="primary"
          onClick={() => {
            notification.destroy(`approval-${approval.id}`)
            navigate(`/approvals?focus=${encodeURIComponent(approval.id)}`)
          }}
        >
          去处理
        </Button>
      ),
    })
    void message.info(`新的审批请求：${approval.toolName}`)
    void refreshPendingApprovals()
  })

  useWsEvent('approval_resolved', () => {
    void refreshPendingApprovals()
  })

  useWsEvent('alert_received', (msg) => {
    notification.error({
      key: `alert-${msg.alert.id}`,
      message: `收到告警：${msg.alert.name}`,
      description: `${msg.alert.severity} · ${msg.alert.target ?? '未指定目标'} · ${msg.alert.summary ?? ''}`,
      btn: (
        <Button size="small" onClick={() => navigate('/alerts')}>
          查看告警
        </Button>
      ),
    })
  })

  const value = useMemo<AppStateValue>(
    () => ({
      bootstrap,
      loading,
      fatalError,
      reload,
      selectedKernel: bootstrap?.selectedKernel ?? null,
      pendingApprovals,
      refreshPendingApprovals,
      themeMode,
      setThemeMode,
    }),
    [bootstrap, loading, fatalError, reload, pendingApprovals, refreshPendingApprovals, themeMode, setThemeMode],
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext)
  if (!value) throw new Error('useAppState must be used inside <AppStateProvider>')
  return value
}
