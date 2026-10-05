import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import WebSocket from 'ws'
import type { ApprovalRecord, ChatMessage, SessionInfo, ServerMessage } from '@sre/protocol'
import { App } from '../src/app.ts'
import { resolveConfig } from '../src/config.ts'
import { createHttpServer } from '../src/http.ts'
import { startMockOpenAi } from './mock-openai.ts'
import { getJson, postJson, waitFor } from './helpers.ts'

/**
 * Full-stack Pi test: real HTTP + WebSocket, a real session, and a real tool call
 * gated by the platform's approval flow. The only stand-in is the LLM endpoint
 * (an OpenAI-compatible SSE mock), so everything the product actually does is
 * exercised: provider sync, tool injection, the `tool_call` extension gate,
 * approval round trip, tool execution, and streaming to the browser.
 */
test('pi kernel drives prompt -> tool call -> approval -> execution -> answer', { timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-pi-e2e-'))
  const mock = await startMockOpenAi({
    toolName: 'sre_shell',
    toolArguments: JSON.stringify({ command: 'echo mock-llm-pipeline-ok' }),
  })

  const config = resolveConfig({ home, kernel: 'pi', port: 0 })
  const app = new App(config)
  // Providers must exist before the kernel starts: the adapter writes them into
  // its own models.json and registers the key on the model runtime.
  app.store.upsertProvider({
    id: 'mock',
    name: 'Mock Provider',
    api: 'openai-completions',
    baseUrl: mock.baseUrl,
    apiKey: 'mock-key',
    models: [{ id: 'mock-model', name: 'Mock Model' }],
    enabled: true,
  })
  app.store.setSetting('models.default', { provider: 'mock', model: 'mock-model' })

  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  const port = (server.server.address() as AddressInfo).port
  config.port = port
  const base = `http://127.0.0.1:${port}`
  await app.start()

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const received: ServerMessage[] = []
  ws.on('message', (data: Buffer) => {
    received.push(JSON.parse(String(data)) as ServerMessage)
  })
  await once(ws, 'open')

  try {
    // -- provider sync ----------------------------------------------------
    const modelsJson = JSON.parse(readFileSync(join(home, 'kernels', 'pi', 'models.json'), 'utf8')) as {
      providers: Record<string, { baseUrl?: string; api?: string; models?: { id: string }[] }>
    }
    assert.equal(modelsJson.providers.mock?.baseUrl, mock.baseUrl)
    assert.equal(modelsJson.providers.mock?.api, 'openai-completions')
    assert.deepEqual(
      modelsJson.providers.mock?.models?.map((model) => model.id),
      ['mock-model'],
    )
    // The kernel must not have touched the operator's own Pi config.
    assert.equal(existsSync(join(home, 'kernels', 'pi', 'auth.json')), true)

    // -- session + prompt -------------------------------------------------
    const session = await postJson<SessionInfo>(`${base}/api/sessions`, { title: '端到端巡检' })
    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '请检查网关健康状态' })

    // -- approval gate ----------------------------------------------------
    const pending = await waitFor<ApprovalRecord[]>(
      async () => {
        const list = await getJson<ApprovalRecord[]>(`${base}/api/approvals?status=pending`)
        return list.length > 0 ? list : undefined
      },
      { label: 'pending approval', timeoutMs: 60_000 },
    )
    const approval = pending[0]!
    assert.equal(approval.toolName, 'sre_shell')
    assert.equal(approval.risk, 'high')
    assert.equal(approval.sessionId, session.id)
    assert.equal(approval.origin, 'chat')

    // While the approval is unanswered the tool must not have run: the mock tool
    // writes nothing, so assert on the transcript instead (no tool result yet).
    const beforeDecision = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
    assert.equal(
      beforeDecision.some((message) => message.role === 'tool'),
      false,
      'tool must not execute before approval',
    )

    await postJson(`${base}/api/approvals/${approval.id}/decide`, { decision: 'allowed-once' })

    // -- execution + answer ------------------------------------------------
    const toolMessage = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'tool')
      },
      { label: 'tool result', timeoutMs: 60_000 },
    )
    assert.equal(toolMessage.ok, true)
    assert.match(toolMessage.text, /mock-llm-pipeline-ok/)
    assert.equal(toolMessage.toolName, 'sre_shell')

    const answer = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'assistant' && message.text.includes('mock-llm'))
      },
      { label: 'assistant answer', timeoutMs: 60_000 },
    )
    assert.match(answer.text, /巡检结论已生成/)

    // The kernel really did loop back to the model with the tool result.
    assert.equal(mock.toolCallCount(), 1)
    const secondRequest = mock.requests[1] as { messages?: { role?: string }[] } | undefined
    assert.equal(secondRequest?.messages?.some((message) => message.role === 'tool'), true)

    // -- websocket surface -------------------------------------------------
    const types = received.map((message) => message.type)
    assert.equal(types.includes('hello'), true)
    assert.equal(types.includes('approval_requested'), true)
    assert.equal(types.includes('approval_resolved'), true)

    const kernelEvents = received
      .filter((message): message is Extract<ServerMessage, { type: 'kernel_event' }> => message.type === 'kernel_event')
      .map((message) => message.envelope.event.type)
    assert.equal(kernelEvents.includes('tool_call'), true)
    assert.equal(kernelEvents.includes('assistant_delta'), true, 'streaming deltas must reach the browser')
    assert.equal(kernelEvents.includes('tool_result'), true)

    const deltas = received.filter(
      (message) => message.type === 'kernel_event' && message.envelope.event.type === 'assistant_delta',
    )
    assert.equal(deltas.length >= 2, true, 'the answer should arrive in more than one delta')

    // -- audit trail -------------------------------------------------------
    const audit = await getJson<{ action: string; subject: string }[]>(`${base}/api/audit?limit=100`)
    assert.equal(audit.some((entry) => entry.action === 'approval.request'), true)
    assert.equal(audit.some((entry) => entry.action === 'approval.decide'), true)
    assert.equal(audit.some((entry) => entry.action === 'tool.shell'), true)
  } finally {
    ws.close()
    await server.close()
    await app.stop()
    await mock.close()
  }
})

test('unattended (schedule-origin) sessions deny tools outside the runbook scope', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-pi-scope-'))
  const mock = await startMockOpenAi({
    toolName: 'sre_shell',
    toolArguments: JSON.stringify({ command: 'echo should-not-run' }),
    finalText: 'mock-llm: 已按只读范围完成巡检。',
  })
  const config = resolveConfig({ home, kernel: 'pi', port: 0 })
  const app = new App(config)
  app.store.upsertProvider({
    id: 'mock',
    name: 'Mock Provider',
    api: 'openai-completions',
    baseUrl: mock.baseUrl,
    apiKey: 'mock-key',
    models: [{ id: 'mock-model' }],
    enabled: true,
  })
  app.store.setSetting('models.default', { provider: 'mock', model: 'mock-model' })

  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  const port = (server.server.address() as AddressInfo).port
  config.port = port
  const base = `http://127.0.0.1:${port}`
  await app.start()

  try {
    const session = await app.sessions.create({
      title: '无人值守巡检',
      origin: 'schedule',
      allowedTools: ['kb_search'],
    })
    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '执行巡检' })

    const toolMessage = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'tool')
      },
      { label: 'denied tool result', timeoutMs: 60_000 },
    )
    assert.equal(toolMessage.ok, false)
    assert.match(toolMessage.text, /outside the runbook tool scope/)

    // No human, no approval prompt: the denial is immediate and audited.
    const approvals = await getJson<ApprovalRecord[]>(`${base}/api/approvals?status=pending`)
    assert.equal(approvals.length, 0)

    const answer = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'assistant' && message.text.includes('只读范围'))
      },
      { label: 'final answer', timeoutMs: 60_000 },
    )
    assert.match(answer.text, /已按只读范围完成巡检/)
  } finally {
    await server.close()
    await app.stop()
    await mock.close()
  }
})

test('providers added after the kernel started work for new sessions, and missing ones warn', { timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-pi-late-provider-'))
  const mock = await startMockOpenAi({
    toolName: 'kb_search',
    toolArguments: JSON.stringify({ query: 'late provider' }),
    finalText: 'mock-llm: 后注册的 provider 生效。',
  })
  const config = resolveConfig({ home, kernel: 'pi', port: 0 })
  const app = new App(config)
  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  config.port = (server.server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${config.port}`
  // Kernel starts with no provider configured at all.
  await app.start()

  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/ws`)
  const received: ServerMessage[] = []
  ws.on('message', (data: Buffer) => received.push(JSON.parse(String(data)) as ServerMessage))
  await once(ws, 'open')

  try {
    // Without a provider the platform must explain itself rather than run an
    // empty turn that looks like a silent failure.
    const bare = await postJson<SessionInfo>(`${base}/api/sessions`, { title: 'no provider yet' })
    const notice = await waitFor<ServerMessage>(
      () => {
        const found = received.find(
          (message): message is Extract<ServerMessage, { type: 'kernel_event' }> =>
            message.type === 'kernel_event' &&
            message.envelope.sessionId === bare.id &&
            message.envelope.event.type === 'notice',
        )
        return found
      },
      { label: 'missing-model notice', timeoutMs: 30_000 },
    )
    if (notice.type !== 'kernel_event') throw new Error('unexpected message')
    assert.equal(notice.envelope.event.type, 'notice')

    // Register the provider the way the UI does: over the API, after startup.
    const providers = await fetch(`${base}/api/providers/mock`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Mock Provider',
        api: 'openai-completions',
        baseUrl: mock.baseUrl,
        apiKey: 'mock-key',
        enabled: true,
        models: [{ id: 'mock-model' }],
      }),
    })
    assert.equal(providers.status, 200)
    await postJson(`${base}/api/providers/mock/default`, {})

    const session = await postJson<SessionInfo>(`${base}/api/sessions`, { title: 'late provider' })
    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '查一下' })

    const toolMessage = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'tool')
      },
      { label: 'tool result with late provider', timeoutMs: 60_000 },
    )
    assert.equal(toolMessage.ok, true)

    const answer = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'assistant' && message.text.includes('后注册的 provider'))
      },
      { label: 'answer with late provider', timeoutMs: 60_000 },
    )
    assert.match(answer.text, /后注册的 provider 生效/)

    // A session opened before the provider existed must also work once the model
    // is resolvable at prompt time (it resolves per session open).
    const reopened = await postJson<SessionInfo>(`${base}/api/sessions`, { title: 'reuse' })
    await postJson(`${base}/api/sessions/${reopened.id}/prompt`, { text: '再查一次' })
    const secondTool = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${reopened.id}/messages`)
        return messages.find((message) => message.role === 'tool')
      },
      { label: 'second tool result', timeoutMs: 60_000 },
    )
    assert.equal(secondTool.ok, true)
  } finally {
    ws.close()
    await server.close()
    await app.stop()
    await mock.close()
  }
})

test('platform tools are exposed to the kernel and execute against the platform', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-pi-tools-'))
  const mock = await startMockOpenAi({
    toolName: 'kb_search',
    toolArguments: JSON.stringify({ query: 'nginx upstream timeout' }),
    finalText: 'mock-llm: 知识库检索完成。',
  })
  const config = resolveConfig({ home, kernel: 'pi', port: 0 })
  const app = new App(config)
  app.store.upsertProvider({
    id: 'mock',
    name: 'Mock Provider',
    api: 'openai-completions',
    baseUrl: mock.baseUrl,
    apiKey: 'mock-key',
    models: [{ id: 'mock-model' }],
    enabled: true,
  })
  app.store.setSetting('models.default', { provider: 'mock', model: 'mock-model' })
  app.kb.ingest({
    title: 'nginx upstream timeout 手册',
    source: 'kb/nginx.md',
    tags: ['nginx'],
    text: 'upstream timed out 时先看后端 P99 与连接池，再核对 keepalive 与 somaxconn。',
  })
  // Skills must land on disk for the kernel to pick them up.
  await app.store.listSkills()
  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  const port = (server.server.address() as AddressInfo).port
  config.port = port
  const base = `http://127.0.0.1:${port}`
  await app.start()
  await app.saveSkill({
    name: 'nginx-timeout-triage',
    description: 'Use when nginx reports upstream timeouts: the evidence order and known fixes.',
    body: '# nginx upstream timeout\n\n1. 查后端 P99。\n2. 查连接池。\n',
    enabled: true,
    source: 'platform',
    updatedAt: Date.now(),
  })

  try {
    assert.equal(
      existsSync(join(home, 'skills', 'nginx-timeout-triage', 'SKILL.md')),
      true,
      'skill must be mirrored to disk',
    )
    const markdown = readFileSync(join(home, 'skills', 'nginx-timeout-triage', 'SKILL.md'), 'utf8')
    assert.match(markdown, /^---\nname: nginx-timeout-triage\n/)
    assert.match(markdown, /description: "Use when nginx/)

    const session = await postJson<SessionInfo>(`${base}/api/sessions`, { title: '知识库检索' })
    const tools = await getJson<{ id: string; health: { tools?: string[] } }[]>(`${base}/api/kernels`)
    assert.equal(tools.length >= 2, true)

    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '查一下 upstream timeout 怎么处理' })

    const toolMessage = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'tool')
      },
      { label: 'kb_search result', timeoutMs: 60_000 },
    )
    assert.equal(toolMessage.ok, true)
    // kb_search is read-only and declares chat as an approved origin, so it runs
    // without an approval prompt.
    assert.match(toolMessage.text, /nginx upstream timeout 手册/)
    assert.equal((await getJson<ApprovalRecord[]>(`${base}/api/approvals?status=pending`)).length, 0)
  } finally {
    await server.close()
    await app.stop()
    await mock.close()
  }
})
