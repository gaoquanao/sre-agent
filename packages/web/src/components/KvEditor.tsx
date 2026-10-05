/**
 * Controlled key/value list editor (MCP env / headers, alert labels).
 *
 * The parent owns the row array so partially typed rows (empty key) survive
 * until submit; `rowsToRecord` drops them at the boundary.
 */
import { Button, Input, Space } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

export interface KvRow {
  key: string
  value: string
}

export function recordToRows(record: Record<string, string> | undefined): KvRow[] {
  if (!record) return []
  return Object.entries(record).map(([key, value]) => ({ key, value }))
}

export function rowsToRecord(rows: KvRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    out[key] = row.value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

interface Props {
  rows: KvRow[]
  onChange: (rows: KvRow[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  addText?: string
}

export default function KvEditor({
  rows,
  onChange,
  keyPlaceholder = '名称',
  valuePlaceholder = '值',
  addText = '添加一项',
}: Props): JSX.Element {
  const update = (index: number, patch: Partial<KvRow>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  return (
    <div>
      {rows.map((row, index) => (
        <div className="sre-kv-row" key={index}>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              style={{ width: '40%' }}
              placeholder={keyPlaceholder}
              value={row.key}
              onChange={(event) => update(index, { key: event.target.value })}
            />
            <Input
              placeholder={valuePlaceholder}
              value={row.value}
              onChange={(event) => update(index, { value: event.target.value })}
            />
            <Button
              icon={<DeleteOutlined />}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
              aria-label="删除该行"
            />
          </Space.Compact>
        </div>
      ))}
      <Button size="small" icon={<PlusOutlined />} onClick={() => onChange([...rows, { key: '', value: '' }])}>
        {addText}
      </Button>
    </div>
  )
}
