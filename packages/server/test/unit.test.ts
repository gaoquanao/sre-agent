import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { jsonSchemaToDshParameters, jsonSchemaToDshValue } from '@sre/protocol'
import type { PermissionRule } from '@sre/protocol'
import { openDatabase } from '../src/db.ts'
import { KnowledgeBase, chunkText, cosine } from '../src/knowledge.ts'
import { Logger } from '../src/log.ts'
import { PermissionEngine, matchGlob, riskOf } from '../src/permission.ts'
import { Store } from '../src/store.ts'
import { jsonSchemaToTypeBox } from '../src/kernels/pi-schema.ts'

const silentLog = new Logger('test', { minLevel: 'error' })

test('JSON Schema -> dsh parameter DSL keeps requiredness per property', () => {
  const params = jsonSchemaToDshParameters({
    type: 'object',
    properties: {
      target: { type: 'string', description: 'service to check' },
      window: { type: 'string', enum: ['5m', '15m', '1h'], default: '15m' },
      limit: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      choice: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['target'],
    additionalProperties: false,
  })

  assert.equal((params.target as { required?: true }).required, true)
  assert.equal((params.window as { required?: true }).required, undefined)
  assert.deepEqual((params.window as { enum?: unknown }).enum, ['5m', '15m', '1h'])
  assert.equal((params.tags as { type?: string }).type, 'array')
  assert.deepEqual((params.tags as { items?: unknown }).items, { type: 'string' })
  // dsh requires an explicit boolean; a schema-valued map degrades to an open object.
  assert.equal((params.headers as { additionalProperties?: boolean }).additionalProperties, true)
  assert.deepEqual((params.choice as { oneOf?: unknown }).oneOf, [{ type: 'string' }, { type: 'null' }])
})

test('JSON Schema -> dsh value degrades unknown shapes to json', () => {
  assert.deepEqual(jsonSchemaToDshValue(undefined), { type: 'json' })
  assert.deepEqual(jsonSchemaToDshValue({ type: 'object' }), {
    type: 'object',
    additionalProperties: true,
  })
})

test('JSON Schema -> TypeBox produces a usable schema', () => {
  const schema = jsonSchemaToTypeBox({
    type: 'object',
    properties: {
      url: { type: 'string', description: 'target' },
      timeoutSec: { type: 'number', default: 10 },
      method: { type: 'string', enum: ['GET', 'POST'] },
    },
    required: ['url'],
    additionalProperties: false,
  }) as Record<string, unknown>
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['url'])
  const properties = schema.properties as Record<string, Record<string, unknown>>
  assert.equal(properties.url?.type, 'string')
  assert.equal(properties.method?.enum !== undefined || Array.isArray(properties.method?.anyOf), true)
})

test('tool risk derives from annotations first, names second', () => {
  assert.equal(riskOf('anything', { readOnlyHint: true }), 'low')
  assert.equal(riskOf('anything', { destructiveHint: true }), 'high')
  assert.equal(riskOf('sre_shell'), 'medium')
  assert.equal(riskOf('read_file'), 'low')
  assert.equal(riskOf('delete_pod'), 'high')
})

test('permission presets gate by risk', () => {
  const readOnly = new PermissionEngine('read-only', [])
  assert.equal(readOnly.evaluate({ toolName: 'kb_search', origin: 'chat', sessionId: 's' }).effect, 'allow')
  assert.equal(
    readOnly.evaluate({ toolName: 'sre_shell', annotations: { destructiveHint: true }, origin: 'chat', sessionId: 's' })
      .effect,
    'deny',
  )

  const workspaceWrite = new PermissionEngine('workspace-write', [])
  assert.equal(
    workspaceWrite.evaluate({ toolName: 'sre_shell', annotations: { destructiveHint: true }, origin: 'chat', sessionId: 's' })
      .effect,
    'ask',
  )

  const full = new PermissionEngine('full-access', [])
  assert.equal(
    full.evaluate({ toolName: 'sre_shell', annotations: { destructiveHint: true }, origin: 'chat', sessionId: 's' }).effect,
    'allow',
  )
})

test('unattended origins never ask: they deny instead of hanging', () => {
  const engine = new PermissionEngine('workspace-write', [])
  const decision = engine.evaluate({
    toolName: 'sre_shell',
    annotations: { destructiveHint: true },
    origin: 'schedule',
    sessionId: 's',
  })
  assert.equal(decision.effect, 'deny')
  assert.equal(decision.by, 'unattended-default')
})

test('runbook scope allowlists win over the preset, and deny everything else', () => {
  const engine = new PermissionEngine('full-access', [])
  const allowed = engine.evaluate({
    toolName: 'sre_http_probe',
    origin: 'schedule',
    sessionId: 's',
    allowedTools: ['sre_http_probe'],
  })
  assert.equal(allowed.effect, 'allow')
  assert.equal(allowed.by, 'runbook-allowlist')

  const denied = engine.evaluate({
    toolName: 'sre_shell',
    origin: 'schedule',
    sessionId: 's',
    allowedTools: ['sre_http_probe'],
  })
  assert.equal(denied.effect, 'deny')
  assert.match(denied.reason, /outside the runbook tool scope/)
})

test('rules are evaluated by priority and can narrow a permissive preset', () => {
  const rules: PermissionRule[] = [
    { id: 'block-kubectl-delete', priority: 10, enabled: true, tool: '*delete*', effect: 'deny' },
    { id: 'ask-scale', priority: 20, enabled: true, tool: 'kubectl_scale', effect: 'ask' },
  ]
  const engine = new PermissionEngine('full-access', rules)
  assert.equal(engine.evaluate({ toolName: 'kubectl_delete_pod', origin: 'chat', sessionId: 's' }).effect, 'deny')
  assert.equal(engine.evaluate({ toolName: 'kubectl_scale', origin: 'chat', sessionId: 's' }).effect, 'ask')
  assert.equal(engine.evaluate({ toolName: 'kb_search', origin: 'chat', sessionId: 's' }).effect, 'allow')

  const disabled = new PermissionEngine('full-access', [{ ...rules[0]!, enabled: false }])
  assert.equal(disabled.evaluate({ toolName: 'kubectl_delete_pod', origin: 'chat', sessionId: 's' }).effect, 'allow')
})

test('glob matching is anchored and case-insensitive', () => {
  assert.equal(matchGlob('mcp__*__*', 'mcp__grafana__query'), true)
  assert.equal(matchGlob('sre_shell', 'sre_shell'), true)
  assert.equal(matchGlob('sre_shell', 'sre_shell_extra'), false)
  assert.equal(matchGlob('*delete*', 'K8s_DeletePod'), true)
})

test('knowledge base ingests, chunks and retrieves by keyword', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-kb-'))
  const db = openDatabase(join(home, 'kb.db'), silentLog)
  const kb = new KnowledgeBase(db, silentLog)

  const single = chunkText('a'.repeat(200) + '\n\n' + 'b'.repeat(200))
  assert.equal(single.length, 1)
  const split = chunkText('a'.repeat(600) + '\n\n' + 'b'.repeat(600) + '\n\n' + 'c'.repeat(600))
  assert.equal(split.length >= 2, true)
  assert.equal(split.every((chunk) => chunk.length > 0), true)

  const doc = kb.ingest({
    title: 'nginx upstream timeout 处置手册',
    source: 'runbooks/nginx-timeout.md',
    tags: ['nginx', 'timeout'],
    text: '当 nginx 出现 upstream timed out 时，先检查后端 P99 延迟与连接池耗尽情况，再确认 keepalive 配置与内核参数 somaxconn。',
  })
  assert.equal(doc.chunkCount > 0, true)

  const hits = await kb.search('upstream timed out', { topK: 3 })
  assert.equal(hits.length > 0, true)
  assert.equal(hits[0]?.docId, doc.id)
  assert.match(hits[0]?.text ?? '', /upstream timed out/)

  const tagged = await kb.search('连接池', { topK: 3, tags: ['nginx'] })
  assert.equal(tagged.length > 0, true)
  const untagged = await kb.search('连接池', { topK: 3, tags: ['not-a-tag'] })
  assert.equal(untagged.length, 0)

  // Duplicate content must not be ingested twice.
  const again = kb.ingest({ source: 'runbooks/nginx-timeout.md', text: '当 nginx 出现 upstream timed out 时，先检查后端 P99 延迟与连接池耗尽情况，再确认 keepalive 配置与内核参数 somaxconn。' })
  assert.equal(again.id, doc.id)

  db.close()
})

test('cosine similarity behaves on padded and identical vectors', () => {
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])), 1)
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([0, 1])), 0)
  assert.equal(cosine(new Float32Array([0, 0]), new Float32Array([1, 0])), 0)
})

test('store round-trips sessions, approvals and audit entries', () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-store-'))
  const db = openDatabase(join(home, 'store.db'), silentLog)
  const store = new Store(db)

  store.insertSession(
    {
      id: 's1',
      kernel: 'pi',
      title: '巡检',
      cwd: '/tmp',
      origin: 'chat',
      status: 'active',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 0,
    },
    ['kb_search'],
  )
  assert.deepEqual(store.getSessionAllowedTools('s1'), ['kb_search'])

  store.insertApproval({
    id: 'a1',
    sessionId: 's1',
    kernel: 'pi',
    toolName: 'sre_shell',
    args: { command: 'ls' },
    risk: 'high',
    reason: 'test',
    origin: 'chat',
    status: 'pending',
    requestedAt: 1,
    expiresAt: 2,
  })
  assert.equal(store.expireApprovals(3).length, 1)
  assert.equal(store.getApproval('a1')?.status, 'expired')

  store.audit({ actor: 'operator', action: 'test', subject: 's1', detail: { ok: true } })
  assert.equal(store.listAudit(10)[0]?.action, 'test')

  store.appendMessage({ sessionId: 's1', role: 'user', text: 'hello', createdAt: 5 })
  assert.equal(store.listMessages('s1').length, 1)

  db.close()
})
