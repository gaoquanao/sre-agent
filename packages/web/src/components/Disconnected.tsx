/** Shown when `GET /api/bootstrap` fails: the platform server is unreachable. */
import { Button, Result, Space, Typography } from 'antd'
import { useAppState } from '../state'

export default function Disconnected({ error }: { error: string }): JSX.Element {
  const { reload, loading } = useAppState()

  return (
    <div className="sre-centered">
      <Result
        status="warning"
        title="未连接到平台服务"
        subTitle={
          <Space direction="vertical" size={4} style={{ maxWidth: 620 }}>
            <Typography.Text type="secondary">错误信息：{error}</Typography.Text>
            <Typography.Text type="secondary">
              前端把 <span className="mono">/api</span>、<span className="mono">/internal</span>、
              <span className="mono">/ws</span> 代理到 <span className="mono">http://127.0.0.1:8787</span>
              ，请确认平台服务已启动（仓库根目录执行 <span className="mono">npm run dev:server</span>）。
            </Typography.Text>
          </Space>
        }
        extra={
          <Space>
            <Button type="primary" loading={loading} onClick={() => void reload()}>
              重试连接
            </Button>
            <Button onClick={() => window.location.reload()}>重新加载页面</Button>
          </Space>
        }
      />
    </div>
  )
}
