/** Pretty-printed JSON / text block used for tool arguments and audit details. */
import { Button, Space, Typography } from 'antd'
import { CheckOutlined, CopyOutlined } from '@ant-design/icons'
import { useState } from 'react'
import { copyText, prettyJson } from '../utils'

interface Props {
  value: unknown
  maxHeight?: number
  /** Hide the copy button for tiny inline values. */
  copyable?: boolean
  emptyText?: string
}

export default function JsonBlock({ value, maxHeight = 240, copyable = true, emptyText = '（无内容）' }: Props): JSX.Element {
  const [copied, setCopied] = useState(false)
  const text = prettyJson(value)
  const isEmpty = value === undefined || value === null || text === ''

  if (isEmpty) return <Typography.Text type="secondary">{emptyText}</Typography.Text>

  return (
    <div>
      <Space size={4} style={{ marginBottom: 4 }}>
        {copyable ? (
          <Button
            size="small"
            type="text"
            icon={copied ? <CheckOutlined /> : <CopyOutlined />}
            onClick={() => {
              void copyText(text).then((ok) => {
                if (ok) {
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1500)
                }
              })
            }}
          >
            {copied ? '已复制' : '复制'}
          </Button>
        ) : null}
      </Space>
      <pre className="sre-json" style={{ maxHeight }}>
        {text}
      </pre>
    </div>
  )
}
