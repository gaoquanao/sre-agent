import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { KbDoc, KbHit, KbSearchOptions } from '@sre/protocol'
import { Logger } from './log.ts'

export interface Embedder {
  model: string
  embed(texts: string[]): Promise<Float32Array[]>
}

export interface IngestInput {
  title?: string
  source: string
  tags?: string[]
  mime?: string
  text: string
}

const CHUNK_TARGET = 900
const CHUNK_OVERLAP = 120
const MIN_FTS_TERM = 3

/**
 * Knowledge base for runbooks, postmortems and service docs.
 *
 * Retrieval is hybrid: FTS5 (trigram tokenizer, so Chinese text and substring
 * matches work) is always available; embeddings are used when an embedder is
 * configured and vectors were stored at ingest time.
 */
export class KnowledgeBase {
  private readonly db: DatabaseSync
  private readonly log: Logger
  private embedder: Embedder | undefined

  constructor(db: DatabaseSync, log: Logger, embedder?: Embedder) {
    this.db = db
    this.log = log
    this.embedder = embedder
  }

  setEmbedder(embedder: Embedder | undefined): void {
    this.embedder = embedder
  }

  ingest(input: IngestInput): KbDoc {
    const text = normalize(input.text)
    const hash = createHash('sha256').update(`${input.source}\n${text}`).digest('hex')
    const existing = this.db.prepare('SELECT * FROM kb_docs WHERE hash = ?').get(hash) as
      | Record<string, unknown>
      | undefined
    if (existing !== undefined) return mapDoc(existing)

    const id = randomUUID()
    const now = Date.now()
    const title = input.title ?? firstLine(text) ?? input.source
    const tags = input.tags ?? []
    const mime = input.mime ?? guessMime(input.source)
    const chunks = chunkText(text)

    this.db
      .prepare(
        'INSERT INTO kb_docs(id, title, source, tags, mime, hash, chunk_count, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, title, input.source, JSON.stringify(tags), mime, hash, chunks.length, now)

    const insertChunk = this.db.prepare('INSERT INTO kb_chunks(doc_id, ord, text) VALUES(?, ?, ?)')
    for (const [ord, chunk] of chunks.entries()) insertChunk.run(id, ord, chunk)

    this.db
      .prepare('UPDATE kb_docs SET chunk_count = ? WHERE id = ?')
      .run(chunks.length, id)

    // Embedding is best-effort: a provider outage must not lose the document.
    if (this.embedder !== undefined) {
      void this.embedDocument(id, chunks).catch((error) => {
        this.log.warn(`embedding failed for ${input.source}: ${String(error)}`)
      })
    }
    this.log.info(`kb ingest: ${input.source} (${chunks.length} chunks)`)
    return {
      id,
      title,
      source: input.source,
      tags,
      mime,
      hash,
      chunkCount: chunks.length,
      createdAt: now,
    }
  }

  private async embedDocument(docId: string, chunks: string[]): Promise<void> {
    const embedder = this.embedder
    if (embedder === undefined) return
    const vectors = await embedder.embed(chunks)
    const update = this.db.prepare('UPDATE kb_chunks SET embedding = ?, embedding_model = ? WHERE doc_id = ? AND ord = ?')
    for (const [ord, vector] of vectors.entries()) {
      update.run(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), embedder.model, docId, ord)
    }
  }

  listDocs(): KbDoc[] {
    const rows = this.db.prepare('SELECT * FROM kb_docs ORDER BY created_at DESC').all() as Record<string, unknown>[]
    return rows.map(mapDoc)
  }

  deleteDoc(id: string): void {
    this.db.prepare('DELETE FROM kb_docs WHERE id = ?').run(id)
  }

  hasFts(): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kb_fts'")
      .get() as { name: string } | undefined
    return row !== undefined
  }

  async search(query: string, options: KbSearchOptions = {}): Promise<KbHit[]> {
    const topK = Math.max(1, Math.min(options.topK ?? 5, 50))
    const bm25Hits = this.searchBm25(query, options, topK * 3)
    const vectorHits = await this.searchVector(query, options, topK * 3)
    return mergeHits(bm25Hits, vectorHits, topK)
  }

  private searchBm25(query: string, options: KbSearchOptions, limit: number): KbHit[] {
    const terms = tokenize(query)
    const rows: Record<string, unknown>[] = []
    if (this.hasFts()) {
      const ftsQuery = buildFtsQuery(terms)
      if (ftsQuery !== undefined) {
        try {
          rows.push(
            ...(this.db
              .prepare(
                `SELECT c.id AS chunk_id, c.doc_id, c.ord, c.text, bm25(kb_fts) AS score
                 FROM kb_fts JOIN kb_chunks c ON c.id = kb_fts.rowid
                 WHERE kb_fts MATCH ? LIMIT ?`,
              )
              .all(ftsQuery, limit * 4) as Record<string, unknown>[]),
          )
        } catch (error) {
          this.log.warn(`fts query failed, using LIKE: ${String(error)}`)
        }
      }
    }
    if (rows.length === 0 && terms.length > 0) {
      // LIKE fallback for short queries (trigram needs >= 3 chars) or missing FTS5.
      const like = `%${terms[0] ?? query}%`
      rows.push(
        ...(this.db
          .prepare('SELECT id AS chunk_id, doc_id, ord, text FROM kb_chunks WHERE text LIKE ? LIMIT ?')
          .all(like, limit * 4) as Record<string, unknown>[]),
      )
    }

    const hits: KbHit[] = []
    for (const row of rows) {
      const docId = String(row.doc_id)
      if (options.docId !== undefined && docId !== options.docId) continue
      const doc = this.getDoc(docId)
      if (doc === undefined) continue
      if (options.tags !== undefined && options.tags.length > 0) {
        if (!options.tags.some((tag) => doc.tags.includes(tag))) continue
      }
      const bm25 = row.score === undefined ? 0 : Number(row.score)
      // bm25() returns a negative value where more negative = better.
      const score = row.score === undefined ? 0.5 : 1 / (1 + Math.exp(bm25 / 2))
      hits.push({
        docId,
        title: doc.title,
        source: doc.source,
        tags: doc.tags,
        chunkId: Number(row.chunk_id),
        ord: Number(row.ord),
        text: String(row.text),
        score,
        via: 'bm25',
      })
      if (hits.length >= limit) break
    }
    return hits
  }

  private async searchVector(query: string, options: KbSearchOptions, limit: number): Promise<KbHit[]> {
    const embedder = this.embedder
    if (embedder === undefined) return []
    const [queryVector] = await embedder.embed([query])
    if (queryVector === undefined) return []

    const rows = this.db
      .prepare('SELECT id AS chunk_id, doc_id, ord, text, embedding, embedding_model FROM kb_chunks WHERE embedding IS NOT NULL LIMIT 4000')
      .all() as Record<string, unknown>[]

    const scored: { hit: KbHit; score: number }[] = []
    for (const row of rows) {
      if (options.docId !== undefined && String(row.doc_id) !== options.docId) continue
      const raw = row.embedding
      if (!(raw instanceof Uint8Array)) continue
      const vector = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
      if (vector.length !== queryVector.length) continue
      const doc = this.getDoc(String(row.doc_id))
      if (doc === undefined) continue
      if (options.tags !== undefined && options.tags.length > 0) {
        if (!options.tags.some((tag) => doc.tags.includes(tag))) continue
      }
      scored.push({
        hit: {
          docId: String(row.doc_id),
          title: doc.title,
          source: doc.source,
          tags: doc.tags,
          chunkId: Number(row.chunk_id),
          ord: Number(row.ord),
          text: String(row.text),
          score: 0,
          via: 'vector',
        },
        score: cosine(queryVector, vector),
      })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((entry) => ({ ...entry.hit, score: entry.score }))
  }

  private getDoc(id: string): KbDoc | undefined {
    const row = this.db.prepare('SELECT * FROM kb_docs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? undefined : mapDoc(row)
  }
}

export function chunkText(text: string, target = CHUNK_TARGET, overlap = CHUNK_OVERLAP): string[] {
  const normalized = normalize(text)
  if (normalized.length === 0) return []
  const paragraphs = normalized.split(/\n{2,}/)
  const chunks: string[] = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (current.length > 0 && current.length + paragraph.length + 2 > target) {
      chunks.push(current)
      const tail = current.slice(Math.max(0, current.length - overlap))
      current = `${tail}\n\n${paragraph}`
      while (current.length > target * 2) {
        chunks.push(current.slice(0, target * 2))
        current = current.slice(target * 2 - overlap)
      }
    } else {
      current = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`
    }
  }
  if (current.trim().length > 0) chunks.push(current)
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0)
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

function firstLine(text: string): string | undefined {
  const line = text.split('\n').find((entry) => entry.trim().length > 0)
  if (line === undefined) return undefined
  return line.replace(/^#+\s*/, '').trim().slice(0, 120)
}

function guessMime(source: string): string {
  if (source.endsWith('.md')) return 'text/markdown'
  if (source.endsWith('.json')) return 'application/json'
  if (source.endsWith('.yaml') || source.endsWith('.yml')) return 'application/yaml'
  return 'text/plain'
}

function tokenize(query: string): string[] {
  return query
    .split(/[\s,，。；;、]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
}

function buildFtsQuery(terms: string[]): string | undefined {
  const usable = terms.filter((term) => term.length >= MIN_FTS_TERM)
  if (usable.length === 0) return undefined
  return usable.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}

function mergeHits(bm25: KbHit[], vector: KbHit[], topK: number): KbHit[] {
  const byChunk = new Map<number, KbHit>()
  for (const hit of bm25) byChunk.set(hit.chunkId, hit)
  for (const hit of vector) {
    const existing = byChunk.get(hit.chunkId)
    if (existing === undefined) {
      byChunk.set(hit.chunkId, hit)
    } else {
      existing.score = Math.max(existing.score, hit.score)
      existing.via = 'hybrid'
    }
  }
  return [...byChunk.values()].sort((a, b) => b.score - a.score).slice(0, topK)
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function mapDoc(row: Record<string, unknown>): KbDoc {
  return {
    id: String(row.id),
    title: String(row.title),
    source: String(row.source),
    tags: parseTags(row.tags),
    mime: String(row.mime),
    hash: String(row.hash),
    chunkCount: Number(row.chunk_count),
    createdAt: Number(row.created_at),
  }
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.map((tag) => String(tag)) : []
  } catch {
    return []
  }
}
