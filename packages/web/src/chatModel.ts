/**
 * Chat transcript model.
 *
 * The transcript is an ordered list of items built from persisted history
 * (`GET /api/sessions/:id/messages`) and then mutated in place by live kernel
 * events, so streaming text, tool cards and notices all keep their order.
 */
import type { ApprovalRecord, ApprovalStatus, ChatMessage, KernelEvent } from '@sre/protocol'

export interface MessageItem {
  kind: 'message'
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: number
  /** True while deltas are still being appended. */
  streaming: boolean
}

export interface ToolItem {
  kind: 'tool'
  id: string
  callId: string
  name: string
  args: unknown
  status: 'running' | 'ok' | 'fail'
  content?: string
  durationMs?: number
  startedAt: number
}

export interface ReasoningItem {
  kind: 'reasoning'
  id: string
  text: string
  streaming: boolean
}

export interface NoticeItem {
  kind: 'notice'
  id: string
  level: 'info' | 'warn' | 'error'
  text: string
  createdAt: number
}

export interface ApprovalItem {
  kind: 'approval'
  id: string
  approval: ApprovalRecord
  /** Filled once the user (or someone else) decided. */
  decision?: { status: ApprovalStatus; by: string }
}

export type TranscriptItem = MessageItem | ToolItem | ReasoningItem | NoticeItem | ApprovalItem

let seq = 0

function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}-${Date.now().toString(36)}`
}

/** Rebuilds the transcript from persisted history. */
export function fromHistory(messages: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      items.push({
        kind: 'tool',
        id: `h-tool-${message.id}`,
        callId: message.callId ?? `h-call-${message.id}`,
        name: message.toolName ?? 'tool',
        args: undefined,
        status: message.ok === false ? 'fail' : 'ok',
        content: message.text,
        startedAt: message.createdAt,
      })
      continue
    }
    items.push({
      kind: 'message',
      id: `h-msg-${message.id}`,
      role: message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user',
      text: message.text,
      createdAt: message.createdAt,
      streaming: false,
    })
  }
  return items
}

function last(items: TranscriptItem[]): TranscriptItem | undefined {
  return items.length > 0 ? items[items.length - 1] : undefined
}

/** Rough content comparison used to avoid showing the same turn twice. */
function samePrefix(a: string, b: string): boolean {
  const limit = Math.min(40, a.length, b.length)
  if (limit === 0) return false
  return a.slice(0, limit) === b.slice(0, limit)
}

function alreadyPersisted(base: TranscriptItem[], live: TranscriptItem): boolean {
  switch (live.kind) {
    case 'message':
      return base.some(
        (item) =>
          item.kind === 'message' &&
          item.role === live.role &&
          (item.text === live.text || samePrefix(item.text, live.text)),
      )
    case 'tool':
      return base.some((item) => item.kind === 'tool' && item.callId === live.callId)
    case 'approval':
      return base.some((item) => item.kind === 'approval' && item.approval.id === live.approval.id)
    case 'reasoning':
    case 'notice':
      return false
  }
}

/**
 * History can land *after* live events (a slow `GET /messages` racing the
 * socket). Merge instead of replacing, so a stream that started before the
 * history request resolved is not wiped out — only entries the server has
 * already persisted are dropped.
 */
export function mergeHistory(base: TranscriptItem[], live: TranscriptItem[]): TranscriptItem[] {
  return [...base, ...live.filter((item) => !alreadyPersisted(base, item))]
}

/** Marks every open stream (assistant bubble / reasoning block) as finished. */
export function closeStreams(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => {
    if (item.kind === 'message' && item.streaming) return { ...item, streaming: false }
    if (item.kind === 'reasoning' && item.streaming) return { ...item, streaming: false }
    return item
  })
}

export function appendUser(items: TranscriptItem[], text: string): TranscriptItem[] {
  return [
    ...closeStreams(items),
    { kind: 'message', id: nextId('msg'), role: 'user', text, createdAt: Date.now(), streaming: false },
  ]
}

function appendAssistantDelta(items: TranscriptItem[], text: string): TranscriptItem[] {
  const tail = last(items)
  if (tail && tail.kind === 'message' && tail.role === 'assistant' && tail.streaming) {
    return [...items.slice(0, -1), { ...tail, text: tail.text + text }]
  }
  return [
    ...closeStreams(items),
    { kind: 'message', id: nextId('msg'), role: 'assistant', text, createdAt: Date.now(), streaming: true },
  ]
}

function appendReasoningDelta(items: TranscriptItem[], text: string): TranscriptItem[] {
  const tail = last(items)
  if (tail && tail.kind === 'reasoning' && tail.streaming) {
    return [...items.slice(0, -1), { ...tail, text: tail.text + text }]
  }
  return [...closeStreams(items), { kind: 'reasoning', id: nextId('reason'), text, streaming: true }]
}

function finalizeAssistant(items: TranscriptItem[], text: string): TranscriptItem[] {
  const closed = closeStreams(items)
  const tail = last(closed)
  if (tail && tail.kind === 'message' && tail.role === 'assistant') {
    return [...closed.slice(0, -1), { ...tail, text: text || tail.text, streaming: false }]
  }
  return [
    ...closed,
    { kind: 'message', id: nextId('msg'), role: 'assistant', text, createdAt: Date.now(), streaming: false },
  ]
}

function pushNotice(items: TranscriptItem[], level: 'info' | 'warn' | 'error', text: string): TranscriptItem[] {
  return [...items, { kind: 'notice', id: nextId('notice'), level, text, createdAt: Date.now() }]
}

/** Applies one normalized kernel event to the transcript. */
export function applyKernelEvent(items: TranscriptItem[], event: KernelEvent): TranscriptItem[] {
  switch (event.type) {
    case 'assistant_delta':
      return appendAssistantDelta(items, event.text)
    case 'reasoning_delta':
      return appendReasoningDelta(items, event.text)
    case 'assistant_message':
      return finalizeAssistant(items, event.text)
    case 'user_message':
      return items
    case 'tool_call': {
      if (items.some((item) => item.kind === 'tool' && item.callId === event.callId)) return items
      return [
        ...closeStreams(items),
        {
          kind: 'tool',
          id: nextId('tool'),
          callId: event.callId,
          name: event.name,
          args: event.args,
          status: 'running',
          startedAt: Date.now(),
        },
      ]
    }
    case 'tool_result':
      return items.map((item) =>
        item.kind === 'tool' && item.callId === event.callId
          ? {
              ...item,
              status: event.ok ? 'ok' : 'fail',
              content: event.content,
              ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            }
          : item,
      )
    case 'turn_start':
      return items
    case 'turn_end':
      return closeStreams(items)
    case 'agent_status':
      return items
    case 'usage':
      return items
    case 'notice':
      return pushNotice(items, event.level, event.text)
    case 'error':
      return pushNotice(items, 'error', event.message)
    case 'approval_requested':
    case 'approval_resolved':
      // Rendered from the dedicated `approval_requested` / `approval_resolved` WS messages,
      // which carry the full record instead of just the id.
      return items
  }
}

export function upsertApproval(items: TranscriptItem[], approval: ApprovalRecord): TranscriptItem[] {
  const existing = items.find((item) => item.kind === 'approval' && item.approval.id === approval.id)
  if (existing) {
    return items.map((item) =>
      item.kind === 'approval' && item.approval.id === approval.id ? { ...item, approval } : item,
    )
  }
  return [...items, { kind: 'approval', id: `approval-${approval.id}`, approval }]
}

export function resolveApproval(
  items: TranscriptItem[],
  approvalId: string,
  status: ApprovalStatus,
  by: string,
): TranscriptItem[] {
  return items.map((item) =>
    item.kind === 'approval' && item.approval.id === approvalId
      ? { ...item, approval: { ...item.approval, status }, decision: { status, by } }
      : item,
  )
}
