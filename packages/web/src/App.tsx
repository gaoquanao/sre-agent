/** Application root: theme, antd context, router, layout and routes. */
import { useEffect, useState } from 'react'
import { App as AntApp, ConfigProvider, Empty, Spin, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppStateProvider, useAppState } from './state'
import { setApiErrorSink } from './api'
import { wsClient } from './ws'
import AppLayout from './components/AppLayout'
import Disconnected from './components/Disconnected'
import { NAV_ITEMS } from './nav'
import type { ThemeMode } from './types'

const THEME_KEY = 'sre-agent.theme'

function readTheme(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_KEY)
  return stored === 'light' || stored === 'dark' ? stored : 'dark'
}

/** Routes antd `message` from the API layer into the current theme context. */
function ApiErrorBridge(): null {
  const { message } = AntApp.useApp()
  useEffect(() => {
    setApiErrorSink((text) => {
      void message.error(text)
    })
  }, [message])
  return null
}

function Shell(): JSX.Element {
  const { loading, fatalError, bootstrap } = useAppState()

  if (!bootstrap && loading) {
    return (
      <div className="sre-centered">
        <Spin size="large" tip="正在连接平台服务…">
          <div style={{ width: 240, height: 60 }} />
        </Spin>
      </div>
    )
  }

  if (!bootstrap && fatalError) {
    return <Disconnected error={fatalError} />
  }

  return (
    <AppLayout>
      <Routes>
        {NAV_ITEMS.map((item) => (
          <Route key={item.key} path={item.path} element={item.element} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  )
}

export default function App(): JSX.Element {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readTheme())

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode
    window.localStorage.setItem(THEME_KEY, themeMode)
  }, [themeMode])

  useEffect(() => {
    wsClient.start()
  }, [])

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: themeMode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { borderRadius: 6, fontSize: 13 },
      }}
      componentSize="middle"
      // antd's default empty artwork ships English "No data" text; keep the UI Chinese.
      renderEmpty={() => <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />}
    >
      <AntApp>
        <ApiErrorBridge />
        <BrowserRouter>
          <AppStateProvider themeMode={themeMode} setThemeMode={setThemeMode}>
            <Shell />
          </AppStateProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  )
}
