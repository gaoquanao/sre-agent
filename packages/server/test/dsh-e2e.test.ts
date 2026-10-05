import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import type { ApprovalRecord, ChatMessage, SessionInfo } from '@sre/protocol'
import { App } from '../src/app.ts'
import { resolveConfig } from '../src/config.ts'
import { createHttpServer } from '../src/http.ts'
import { getJson, postJson, waitFor } from './helpers.ts'

/**
 * Full-stack DeepSeek Harness test.
 *
 * The kernel runs as a real `dsh --profile sre-agent` subprocess with a
 * platform-generated profile that mounts our bridge plugin. The LLM is a
 * deterministic in-process adapter shipped with that plugin, so the whole chain
 * is exercised offline: profile generation -> plugin install -> stdio JSON-RPC
 * -> tool call -> `tools/pre-execute` gate -> HTTP callback into the platform ->
 * human approval -> tool execution on the platform -> tool result -> answer.
 */
test('dsh kernel: generated profile, bridge plugin, approval round trip', { timeout: 300_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-dsh-e2e-'))
  const config = resolveConfig({
    home,
    kernel: 'dsh',
    port: 0,
    mockLlm: true,
    mockLlmTool: 'sre_shell',
    mockLlmToolArguments: JSON.stringify({ command: 'echo dsh-bridge-ok' }),
    mockLlmFinalText: 'mock-llm: dsh 链路闭环。',
  })

  const app = new App(config)
  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  const port = (server.server.address() as AddressInfo).port
  // The bridge plugin needs the real port; the kernel starts after this.
  config.port = port
  const base = `http://127.0.0.1:${port}`

  try {
    await app.start()

    // -- generated profile ------------------------------------------------
    const profile = join(home, 'kernels', 'dsh', 'profiles', 'sre-agent')
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    assert.equal(manifest.dependencies['sre-agent-dsh-bridge']?.startsWith('file:'), true)
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'])
    assert.equal(
      existsSync(join(profile, 'node_modules', 'sre-agent-dsh-bridge', 'index.js')),
      true,
      'bridge plugin must be installed into the profile',
    )

    const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /- id: session-persistence-jsonl\n  config:\n    root: /)
    assert.match(patch, /compression: none/)
    assert.match(patch, /customSkillDirs: \[/)
    assert.match(patch, /- insert:\n    - id: sre-agent-bridge\n      name: sre-agent-dsh-bridge/)
    assert.match(patch, /- id: sre-agent-mock-llm/)
    assert.match(patch, new RegExp(`platformBase: http://127.0.0.1:${port}`))

    const kernels = await getJson<{ id: string; health: { status: string; detail?: string } }[]>(`${base}/api/kernels`)
    const dsh = kernels.find((kernel) => kernel.id === 'dsh')
    assert.equal(dsh?.health.status, 'ready', `dsh health: ${JSON.stringify(dsh?.health)}`)

    // -- session + prompt -------------------------------------------------
    const session = await postJson<SessionInfo>(`${base}/api/sessions`, { title: 'dsh 端到端' })
    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '请执行一次巡检' })

    const pending = await waitFor<ApprovalRecord[]>(
      async () => {
        const list = await getJson<ApprovalRecord[]>(`${base}/api/approvals?status=pending`)
        return list.length > 0 ? list : undefined
      },
      { label: 'pending approval from dsh', timeoutMs: 90_000 },
    )
    const approval = pending[0]!
    assert.equal(approval.toolName, 'sre_shell')
    assert.equal(approval.kernel, 'dsh')
    assert.equal(approval.sessionId, session.id)

    // The plugin holds the turn until the platform answers; nothing may have run.
    const before = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
    assert.equal(before.some((message) => message.role === 'tool'), false)

    await postJson(`${base}/api/approvals/${approval.id}/decide`, { decision: 'allowed-once' })

    const toolMessage = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'tool')
      },
      { label: 'dsh tool result', timeoutMs: 90_000 },
    )
    assert.equal(toolMessage.ok, true)
    assert.match(toolMessage.text, /dsh-bridge-ok/)

    const answer = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'assistant' && message.text.includes('dsh 链路闭环'))
      },
      { label: 'dsh assistant answer', timeoutMs: 90_000 },
    )
    assert.match(answer.text, /dsh 链路闭环/)

    // -- session history is readable by the platform ----------------------
    const kernelSessions = await app.registry.adapter('dsh').listKernelSessions?.()
    assert.equal((kernelSessions?.length ?? 0) >= 1, true)
    const sessionFile = join(home, 'kernels', 'dsh', 'sessions')
    assert.equal(existsSync(sessionFile), true)
  } finally {
    await server.close()
    await app.stop()
  }
})

test('dsh denies an unattended tool outside the runbook scope without prompting', { timeout: 300_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-dsh-scope-'))
  const config = resolveConfig({
    home,
    kernel: 'dsh',
    port: 0,
    mockLlm: true,
    mockLlmTool: 'sre_shell',
    mockLlmToolArguments: JSON.stringify({ command: 'echo must-not-run' }),
    mockLlmFinalText: 'mock-llm: 无人值守巡检结束。',
  })
  const app = new App(config)
  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  config.port = (server.server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${config.port}`

  try {
    await app.start()
    const session = await app.sessions.create({
      title: 'dsh 无人值守',
      origin: 'schedule',
      allowedTools: ['kb_search'],
    })
    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: '执行巡检' })

    const toolMessage = await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'tool')
      },
      { label: 'dsh denial', timeoutMs: 90_000 },
    )
    assert.equal(toolMessage.ok, false)
    // The denial reason is produced by the platform and surfaced by the plugin.
    assert.match(toolMessage.text, /outside the runbook tool scope|runbook scope/)
    assert.equal((await getJson<ApprovalRecord[]>(`${base}/api/approvals?status=pending`)).length, 0)
  } finally {
    await server.close()
    await app.stop()
  }
})
