import { randomUUID } from 'node:crypto'
import type { MemoryItem, MemoryKind, MemorySearchHit } from '@sre/protocol'
import type { Logger } from './log.ts'
import type { Store } from './store.ts'

export interface MemoryWriteInput {
  kind: MemoryKind
  subject: string
  text: string
  tags?: string[]
  importance?: number
  source?: MemoryItem['source']
  sourceSessionId?: string
}

export interface RecallOptions {
  /** Max items injected into a prompt. */
  maxItems?: number
  /** Hard character budget for the rendered block. */
  maxChars?: number
}

const DEFAULT_KIND_WEIGHT: Record<MemoryKind, number> = { preference: 1.15, fact: 1.0, episode: 0.9 }
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_MEMORIES = 2000

/**
 * Platform-level memory.
 *
 * Memory belongs to the platform, not to a kernel: a fact learned in a Pi
 * session is available to a dsh session, a CLI kernel, or an unattended agent
 * run. Two bridging paths make that real:
 *
 * 1. tools (`memory_search` / `memory_save`) for explicit read/write;
 * 2. automatic recall — the prompt transformer below injects a small, bounded
 *    block of relevant memories before each turn, so the model does not have to
 *    know it should ask.
 *
 * Scores combine text relevance with importance, kind and recency, and recall
 * always records what it surfaced so the UI can show why something was injected.
 */
export class MemoryService {
  private readonly store: Store
  private readonly log: Logger

  constructor(store: Store, log: Logger) {
    this.store = store
    this.log = log
  }

  save(input: MemoryWriteInput): MemoryItem {
    const text = input.text.trim()
    if (text.length === 0) throw new Error('memory text must not be empty')
    const subject = input.subject.trim().length === 0 ? 'global' : input.subject.trim()
    const item: MemoryItem = {
      id: randomUUID(),
      kind: input.kind,
      subject,
      text,
      tags: dedupe(input.tags ?? []),
      importance: clampImportance(input.importance),
      source: input.source ?? 'agent',
      ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
    }
    this.store.insertMemory(item)
    this.store.audit({
      actor: item.source === 'agent' ? (input.sourceSessionId ?? 'agent') : item.source,
      action: 'memory.save',
      subject: `${item.kind}:${subject}`,
      detail: { importance: item.importance, tags: item.tags },
    })
    this.log.info(`memory saved: [${item.kind}] ${subject} — ${text.slice(0, 80)}`)
    this.pruneIfNeeded()
    return item
  }

  list(limit = 200, kind?: MemoryKind): MemoryItem[] {
    return this.store.listMemory(limit, kind)
  }

  get(id: string): MemoryItem | undefined {
    return this.store.getMemory(id)
  }

  delete(id: string): void {
    this.store.deleteMemory(id)
    this.store.audit({ actor: 'operator', action: 'memory.delete', subject: id })
  }

  search(query: string, options: { kind?: MemoryKind; topK?: number } = {}): MemorySearchHit[] {
    const topK = Math.max(1, Math.min(options.topK ?? 8, 50))
    const candidates = this.store.searchMemoryRows(query, topK * 4)
    const scored = candidates
      .filter((entry) => options.kind === undefined || entry.item.kind === options.kind)
      .map((entry) => ({ ...entry.item, score: this.finalScore(entry.item, entry.score) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
    this.store.touchMemory(scored.map((hit) => hit.id))
    return scored
  }

  /**
   * Prompt transformer: returns a bounded context block for the given text, or
   * undefined when nothing relevant is known (so we never inject boilerplate).
   */
  recallBlock(text: string, options: RecallOptions = {}): string | undefined {
    const maxItems = options.maxItems ?? 3
    const maxChars = options.maxChars ?? 700
    const query = text.trim()
    if (query.length < 4) return undefined
    const hits = this.search(query, { topK: maxItems })
    if (hits.length === 0) return undefined

    const lines: string[] = []
    let used = 0
    for (const hit of hits) {
      const line = `- [${hit.kind}] ${hit.subject}: ${hit.text.replace(/\s+/g, ' ').slice(0, 240)}`
      if (used + line.length > maxChars) break
      lines.push(line)
      used += line.length
    }
    if (lines.length === 0) return undefined
    this.log.debug(`memory recall: injected ${lines.length} item(s) for a ${query.length}-char prompt`)
    return ['<memory>', '以下是平台记忆库中与该请求相关的已知信息（可能过时，必要时用 memory_search 核对）：', ...lines, '</memory>'].join('\n')
  }

  stats(): { total: number; byKind: Record<MemoryKind, number> } {
    const items = this.store.listMemory(MAX_MEMORIES)
    const byKind: Record<MemoryKind, number> = { fact: 0, episode: 0, preference: 0 }
    for (const item of items) byKind[item.kind] += 1
    return { total: items.length, byKind }
  }

  private finalScore(item: MemoryItem, relevance: number): number {
    const ageDays = (Date.now() - item.createdAt) / HALF_LIFE_MS
    const recency = Math.pow(0.5, ageDays)
    const usage = Math.min(0.15, item.accessCount * 0.02)
    return Number(
      (relevance * DEFAULT_KIND_WEIGHT[item.kind] * (0.6 + item.importance / 12) + recency * 0.25 + usage).toFixed(4),
    )
  }

  /** Keep the store bounded: drop the weakest entries beyond the cap. */
  private pruneIfNeeded(): void {
    const total = this.store.countMemory()
    if (total <= MAX_MEMORIES) return
    const excess = total - MAX_MEMORIES
    for (const item of this.store.weakMemories(Math.min(excess, 50))) {
      this.store.deleteMemory(item.id)
      this.log.debug(`memory pruned: [${item.kind}] ${item.subject} (${item.id})`)
    }
  }
}

function clampImportance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 3
  return Math.max(1, Math.min(5, Math.round(value)))
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].slice(0, 12)
}
