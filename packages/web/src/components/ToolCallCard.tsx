/** Tool invocation card: name, status, arguments and (collapsible) result. */
import { useEffect, useState } from 'react'
import { Card, Collapse, Space, Tag, Tooltip, Typography } from 'antd'
import { ToolOutlined } from '@ant-design/icons'
import { formatDuration, oneLineJson, truncate } from '../utils'
import JsonBlock from './JsonBlock'
import type { ToolItem } from '../chatModel'

export default function ToolCallCard({ item }: { item: ToolItem }): JSX.Element {
  const [openKeys, setOpenKeys] = useState<string[]>(['args'])

  // A failed call is the interesting one — open its output without being asked.
  useEffect(() => {
    if (item.status !== 'fail') return
    setOpenKeys((keys) => (keys.includes('result') ? keys : [...keys, 'result']))
  }, [item.status])

  const meta =
    item.status === 'running'
      ? { color: 'processing', label: '执行中' }
      : item.status === 'ok'
        ? { color: 'green', label: '成功' }
        : { color: 'red', label: '失败' }

  const hasResult = typeof item.content === 'string' && item.content.length > 0
  const resultPreview = hasResult ? oneLineJson(item.content, 70) : ''

  return (
    <Card
      size="small"
      style={{ maxWidth: 820, alignSelf: 'flex-start', width: '100%' }}
      styles={{ body: { padding: 8 } }}
      title={
        <Space size={6} wrap>
          <ToolOutlined />
          <span className="mono">{item.name}</span>
          <Tag color={meta.color}>{meta.label}</Tag>
          {item.durationMs !== undefined ? (
            <Typography.Text type="secondary">{formatDuration(item.durationMs)}</Typography.Text>
          ) : null}
          {item.args !== undefined ? (
            <Tooltip title={oneLineJson(item.args, 400)}>
              <Typography.Text type="secondary" className="mono">
                {oneLineJson(item.args, 80)}
              </Typography.Text>
            </Tooltip>
          ) : null}
        </Space>
      }
    >
      <Collapse
        ghost
        size="small"
        activeKey={openKeys}
        onChange={(keys) => setOpenKeys(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
        items={[
          {
            key: 'args',
            label: '参数',
            children: <JsonBlock value={item.args} maxHeight={200} emptyText="（无参数）" />,
          },
          ...(hasResult
            ? [
                {
                  key: 'result',
                  label: (
                    <Space size={6}>
                      <span>{item.status === 'fail' ? '结果（失败）' : '结果'}</span>
                      <Typography.Text type="secondary" className="mono">
                        {truncate(resultPreview, 70)}
                      </Typography.Text>
                    </Space>
                  ),
                  children: <pre className="sre-json" style={{ maxHeight: 280 }}>{item.content}</pre>,
                },
              ]
            : []),
        ]}
      />
    </Card>
  )
}
