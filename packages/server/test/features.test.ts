import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import WebSocket from 'ws'
import type { ApprovalRecord, ChatMessage, ServerMessage, SessionInfo } from '@sre/protocol'
import { openDatabase } from '../src/db.ts'
import { Logger } from '../src/log.ts'
import { Store } from '../src/store.ts'
import { CredentialVault } from '../src/vault.ts'
import { App } from '../src/app.ts'
import { resolveConfig } from '../src/config.ts'
import { createHttpServer } from '../src/http.ts'
import { startMockOpenAi } from './mock-openai.ts'
import { getJson, postJson, waitFor } from './helpers.ts'

const silentLog = new Logger('test', { minLevel: 'error' })

// ---------------------------------------------------------------------------
// Credential vault
// ---------------------------------------------------------------------------

test('credential vault encrypts at rest, masks on read and maps kernel env', () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-vault-'))
  const db = openDatabase(join(home, 'db.sqlite'), silentLog)
  const store = new Store(db)
  const config = resolveConfig({ home })
  const vault = new CredentialVault(store, silentLog, config)

  vault.put('claude-code', { kind: 'oauth', token: 'claude-token-abcdef123456', refreshToken: 'refresh-xyz' })
  vault.put('codex', { kind: 'api-key', apiKey: 'sk-test-9876543210' })
  vault.put('qoder', { kind: 'env-json', env: { QODER_KEY: 'v-secret' } })

  // Secrets survive a round trip and never appear in list output.
  assert.equal(vault.get('claude-code')?.token, 'claude-token-abcdef123456')
  const listed = vault.list()
  assert.equal(listed.length, 3)
  const claude = listed.find((entry) => entry.ref === 'claude-code')
  assert.match(claude?.masked ?? '', /OAuth .*3456/)
  assert.doesNotMatch(JSON.stringify(listed), /abcdef123456/)

  // Ciphertext on disk is not the plaintext.
  const raw = store.getCredential('claude-code')
  assert.equal(raw?.enc.includes(Buffer.from('claude-token-abcdef123456')), false)

  // Kernel env mapping.
  assert.deepEqual(vault.envFor('claude-code'), { CLAUDE_CODE_OAUTH_TOKEN: 'claude-token-abcdef123456' })
  assert.deepEqual(vault.envFor('codex'), { OPENAI_API_KEY: 'sk-test-9876543210' })
  assert.deepEqual(vault.envFor('qoder'), { QODER_KEY: 'v-secret' })
  assert.deepEqual(vault.envFor('pi'), {})

  vault.delete('qoder')
  assert.equal(vault.get('qoder'), undefined)
  db.close()
})

test('credential vault refuses to decrypt with a different secret (fail closed)', () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-vault-key-'))
  const db = openDatabase(join(home, 'db.sqlite'), silentLog)
  const store = new Store(db)
  const config = resolveConfig({ home })

  process.env.SRE_AGENT_SECRET = 'secret-one'
  const vaultA = new CredentialVault(store, silentLog, config)
  vaultA.put('codex', { kind: 'api-key', apiKey: 'sk-live-42' })
  assert.equal(vaultA.get('codex')?.apiKey, 'sk-live-42')

  process.env.SRE_AGENT_SECRET = 'secret-two'
  const vaultB = new CredentialVault(store, silentLog, config)
  assert.equal(vaultB.get('codex'), undefined)
  assert.match(vaultB.list()[0]?.masked ?? '', /无法解密/)
  assert.deepEqual(vaultB.envFor('codex'), {})
  delete process.env.SRE_AGENT_SECRET
  db.close()
})

// ---------------------------------------------------------------------------
// CLI kernel adapters against fixture binaries
// ---------------------------------------------------------------------------

/** Writes fake agent CLIs that speak their kernel's wire format. */
function writeFixtureClis(dir: string): void {
  mkdirSync(dir, { recursive: true })

  const claude = `#!/bin/bash
if [[ "$1" == "--version" ]]; then echo "claude fixture 1.0.0"; exit 0; fi
ARGS="$*"
echo "$ARGS" >> "${dir}/claude-args.log"
RESUME=""
[[ "$ARGS" == *"--resume"* ]] && RESUME=resume
COUNT_FILE="${dir}/claude-count"
COUNT=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo $COUNT > "$COUNT_FILE"
echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"claude-sess-$COUNT\\"}"
echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"claude fixture answer $COUNT ($RESUME)\\"}]}}"
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"claude fixture answer $COUNT ($RESUME)\\"}"
`
  const codex = `#!/bin/bash
if [[ "$1" == "--version" ]]; then echo "codex fixture 1.0.0"; exit 0; fi
ARGS="$*"
echo "$ARGS" >> "${dir}/codex-args.log"
COUNT_FILE="${dir}/codex-count"
COUNT=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo $COUNT > "$COUNT_FILE"
echo "{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"codex-thread-$COUNT\\"}"
echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"codex fixture answer $COUNT\\"}}"
`
  const qoder = `#!/bin/bash
if [[ "$1" == "--version" ]]; then echo "qoder fixture 1.0.0"; exit 0; fi
echo "qoder fixture plain answer"
echo "second line"
`

  for (const [name, script] of [['claude', claude], ['codex', codex], ['qoder', qoder]] as const) {
    const file = join(dir, name)
    writeFileSync(file, script, 'utf8')
    chmodSync(file, 0o755)
  }
}

test('claude-code CLI kernel: spawn, stream-json parsing, resume on next turn', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-cli-claude-'))
  const fixtureDir = join(home, 'fixtures')
  writeFixtureClis(fixtureDir)
  const previousPath = process.env.PATH
  process.env.PATH = `${fixtureDir}:${previousPath}`

  const config = resolveConfig({ home, kernel: 'claude-code', port: 0 })
  const app = new App(config)
  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  config.port = (server.server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${config.port}`

  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/ws`)
  const received: ServerMessage[] = []
  ws.on('message', (data: Buffer) => received.push(JSON.parse(String(data)) as ServerMessage))
  await once(ws, 'open')

  try {
    await app.start()
    const session = await postJson<SessionInfo>(`${base}/api/sessions`, { title: 'claude cli 测试' })
    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '第一轮' })

    const first = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'assistant')
      },
      { label: 'claude fixture answer', timeoutMs: 30_000 },
    )
    assert.match(first.text, /claude fixture answer 1/)

    const kernelSessionId = app.store.getSession(session.id)?.kernelSessionId
    assert.equal(kernelSessionId, 'claude-sess-1')

    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '第二轮' })
    await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'assistant' && message.text.includes('answer 2'))
      },
      { label: 'claude second answer', timeoutMs: 30_000 },
    )
    // The adapter resumed the CLI-side session on the second turn.
    const argsLog = readFileSync(join(fixtureDir, 'claude-args.log'), 'utf8')
    assert.match(argsLog, /--resume claude-sess-1/)
    assert.match(argsLog, /--permission-mode default/)
    // The result event's duplicate text was suppressed (only one assistant message per turn).
    const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
    assert.equal(messages.filter((message) => message.role === 'assistant' && message.text.includes('answer 1')).length, 1)

    // Capability honesty reaches the API.
    const kernels = await getJson<{ id: string; capabilities: { platformApprovalGate?: boolean } }[]>(`${base}/api/kernels`)
    assert.equal(kernels.find((kernel) => kernel.id === 'claude-code')?.capabilities.platformApprovalGate, false)

    const events = received.filter(
      (message): message is Extract<ServerMessage, { type: 'kernel_event' }> => message.type === 'kernel_event',
    )
    assert.equal(events.some((message) => message.envelope.event.type === 'assistant_message'), true)
    assert.equal(events.some((message) => message.envelope.event.type === 'agent_status'), true)
  } finally {
    ws.close()
    process.env.PATH = previousPath
    await server.close()
    await app.stop()
  }
})

test('codex CLI kernel: jsonl parsing, sandbox mapping and native resume', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-cli-codex-'))
  const fixtureDir = join(home, 'fixtures')
  writeFixtureClis(fixtureDir)
  const previousPath = process.env.PATH
  process.env.PATH = `${fixtureDir}:${previousPath}`

  const config = resolveConfig({ home, kernel: 'codex', port: 0 })
  const app = new App(config)
  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  config.port = (server.server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${config.port}`

  try {
    await app.start()
    const session = await postJson<SessionInfo>(`${base}/api/sessions`, { title: 'codex cli 测试' })
    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '第一轮' })
    await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'assistant' && message.text.includes('codex fixture'))
      },
      { label: 'codex fixture answer', timeoutMs: 30_000 },
    )
    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '第二轮' })
    await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'assistant' && message.text.includes('answer 2'))
      },
      { label: 'codex second answer', timeoutMs: 30_000 },
    )

    const argsLog = readFileSync(join(fixtureDir, 'codex-args.log'), 'utf8')
    // First turn: fresh exec with the sandbox mapped from the preset.
    assert.match(argsLog, /exec --json --skip-git-repo-check --sandbox workspace-write/)
    // Second turn: native resume with the thread id captured from turn one.
    assert.match(argsLog, /exec resume codex-thread-1 --json/)
    assert.doesNotMatch(argsLog, /对话历史/)
  } finally {
    process.env.PATH = previousPath
    await server.close()
    await app.stop()
  }
})

test('qoder CLI kernel: plain stdout becomes the answer, health reports experimental', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-cli-qoder-'))
  const fixtureDir = join(home, 'fixtures')
  writeFixtureClis(fixtureDir)
  const previousPath = process.env.PATH
  process.env.PATH = `${fixtureDir}:${previousPath}`

  const config = resolveConfig({ home, kernel: 'qoder', port: 0 })
  const app = new App(config)
  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  config.port = (server.server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${config.port}`

  try {
    await app.start()
    const kernels = await getJson<{ id: string; displayName: string; health: { status: string } }[]>(`${base}/api/kernels`)
    const qoder = kernels.find((kernel) => kernel.id === 'qoder')
    assert.equal(qoder?.displayName.includes('experimental'), true)
    assert.equal(qoder?.health.status, 'ready')

    const session = await postJson<SessionInfo>(`${base}/api/sessions`, { title: 'qoder 测试' })
    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '你好' })
    const answer = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'assistant')
      },
      { label: 'qoder fixture answer', timeoutMs: 30_000 },
    )
    assert.match(answer.text, /qoder fixture plain answer/)
    assert.match(answer.text, /second line/)
  } finally {
    process.env.PATH = previousPath
    await server.close()
    await app.stop()
  }
})

// ---------------------------------------------------------------------------
// ask_user: intent clarification through the approval channel
// ---------------------------------------------------------------------------

test('ask_user blocks the agent until the operator answers, then feeds the answer back', { timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-ask-user-'))
  const mock = await startMockOpenAi({
    toolName: 'ask_user',
    toolArguments: JSON.stringify({
      question: '这次巡检针对哪个环境？',
      choices: ['staging 环境', 'production 环境'],
    }),
    finalText: 'mock-llm: 已按用户选择的环境完成检查。',
  })
  const config = resolveConfig({ home, kernel: 'pi', port: 0 })
  const app = new App(config)
  app.store.upsertProvider({
    id: 'mock',
    name: 'Mock',
    api: 'openai-completions',
    baseUrl: mock.baseUrl,
    apiKey: 'mock-key',
    models: [{ id: 'mock-model' }],
    enabled: true,
  })
  app.store.setSetting('models.default', { provider: 'mock', model: 'mock-model' })
  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  config.port = (server.server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${config.port}`

  try {
    await app.start()
    const session = await postJson<SessionInfo>(`${base}/api/sessions`, { title: '意图确认' })
    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '开始巡检' })

    const approval = await waitFor<ApprovalRecord>(
      async () => {
        const list = await getJson<ApprovalRecord[]>(`${base}/api/approvals?status=pending`)
        return list.find((record) => record.toolName === 'ask_user')
      },
      { label: 'ask_user approval', timeoutMs: 60_000 },
    )
    assert.deepEqual((approval.args as { choices: string[] }).choices, ['staging 环境', 'production 环境'])

    // While the question is open the agent must be blocked.
    const before = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
    assert.equal(before.some((message) => message.role === 'assistant'), false)

    await postJson(`${base}/api/approvals/${approval.id}/decide`, { decision: 'allowed-once', answer: 'staging 环境' })

    const toolMessage = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'tool')
      },
      { label: 'ask_user tool result', timeoutMs: 60_000 },
    )
    assert.equal(toolMessage.ok, true)
    assert.match(toolMessage.text, /用户回答：staging 环境/)

    const answer = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'assistant' && message.text.includes('mock-llm'))
      },
      { label: 'final answer after ask_user', timeoutMs: 60_000 },
    )
    assert.match(answer.text, /已按用户选择的环境完成检查/)
  } finally {
    await server.close()
    await app.stop()
    await mock.close()
  }
})

// ---------------------------------------------------------------------------
// sre_delegate: parent spawns a scoped child session
// ---------------------------------------------------------------------------

test('sre_delegate spawns a child session, depth is capped at one', { timeout: 240_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-delegate-'))
  const mock = await startMockOpenAi({
    toolName: 'sre_delegate',
    toolArguments: JSON.stringify({ objective: '收集 checkout-svc 的 5xx 证据' }),
    finalText: 'mock-llm: 子任务结论已汇总。',
  })
  const config = resolveConfig({ home, kernel: 'pi', port: 0 })
  const app = new App(config)
  app.store.upsertProvider({
    id: 'mock',
    name: 'Mock',
    api: 'openai-completions',
    baseUrl: mock.baseUrl,
    apiKey: 'mock-key',
    models: [{ id: 'mock-model' }],
    enabled: true,
  })
  app.store.setSetting('models.default', { provider: 'mock', model: 'mock-model' })
  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  config.port = (server.server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${config.port}`

  try {
    await app.start()
    const parent = await postJson<SessionInfo>(`${base}/api/sessions`, { title: '父任务' })
    await postJson(`${base}/api/sessions/${parent.id}/prompt`, { text: '分派子任务' })

    // The child session exists and is linked back to the parent.
    const child = await waitFor<SessionInfo>(
      async () => {
        const sessions = await getJson<SessionInfo[]>(`${base}/api/sessions`)
        return sessions.find((entry) => entry.parentSessionId === parent.id)
      },
      { label: 'child session', timeoutMs: 60_000 },
    )
    assert.match(child.title, /子任务/)

    // The child's own delegate attempt is refused (depth cap), so the mock's
    // second turn produces the child's conclusion.
    const childTool = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${child.id}/messages`)
        return messages.find((message) => message.role === 'tool')
      },
      { label: 'child delegate refusal', timeoutMs: 60_000 },
    )
    assert.equal(childTool.ok, false)
    assert.match(childTool.text, /不再嵌套委派|已是子任务/)

    const childAnswer = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${child.id}/messages`)
        return messages.find((message) => message.role === 'assistant' && message.text.includes('mock-llm'))
      },
      { label: 'child conclusion', timeoutMs: 60_000 },
    )
    assert.match(childAnswer.text, /子任务结论已汇总/)

    // The parent's delegate tool result carries the child's conclusion.
    const parentTool = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${parent.id}/messages`)
        return messages.find((message) => message.role === 'tool')
      },
      { label: 'parent delegate result', timeoutMs: 120_000 },
    )
    assert.equal(parentTool.ok, true)
    assert.match(parentTool.text, /子任务结论已汇总/)

    const parentAnswer = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${parent.id}/messages`)
        return messages.find((message) => message.role === 'assistant' && message.text.includes('mock-llm'))
      },
      { label: 'parent conclusion', timeoutMs: 60_000 },
    )
    assert.match(parentAnswer.text, /子任务结论已汇总/)
  } finally {
    await server.close()
    await app.stop()
    await mock.close()
  }
})

test('ask_user and sre_delegate refuse unattended origins without blocking', { timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-unattended-ask-'))
  const mock = await startMockOpenAi({
    toolName: 'ask_user',
    toolArguments: JSON.stringify({ question: '无人环境不该问这个问题' }),
    finalText: 'mock-llm: 已在无人值守下自行决策。',
  })
  const config = resolveConfig({ home, kernel: 'pi', port: 0 })
  const app = new App(config)
  app.store.upsertProvider({
    id: 'mock',
    name: 'Mock',
    api: 'openai-completions',
    baseUrl: mock.baseUrl,
    apiKey: 'mock-key',
    models: [{ id: 'mock-model' }],
    enabled: true,
  })
  app.store.setSetting('models.default', { provider: 'mock', model: 'mock-model' })
  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  config.port = (server.server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${config.port}`

  try {
    await app.start()
    const session = await app.sessions.create({
      title: '无人值守 ask_user',
      origin: 'schedule',
      allowedTools: ['ask_user', 'sre_delegate', 'kb_search'],
    })
    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '开始' })

    const toolMessage = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'tool')
      },
      { label: 'unattended ask_user refusal', timeoutMs: 60_000 },
    )
    assert.equal(toolMessage.ok, false)
    assert.match(toolMessage.text, /无人值守|no operator/)
    assert.equal((await getJson<ApprovalRecord[]>(`${base}/api/approvals?status=pending`)).length, 0)
  } finally {
    await server.close()
    await app.stop()
    await mock.close()
  }
})
