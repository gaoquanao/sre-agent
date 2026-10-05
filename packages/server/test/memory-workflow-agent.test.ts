import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import type { AgentRun, AgentSpec, AlertEvent, ChatMessage, MemoryItem, MemorySearchHit, WorkflowRun, WorkflowSpec } from '@sre/protocol'
import { App } from '../src/app.ts'
import { resolveConfig } from '../src/config.ts'
import { createHttpServer } from '../src/http.ts'
import { startMockOpenAi } from './mock-openai.ts'
import { getJson, postJson, putJson, waitFor } from './helpers.ts'

const silent = { minLevel: 'error' as const }

async function localServer(handler: (url: string, body: string) => { status: number; body?: string }): Promise<{
  url: string
  requests: { url: string; body: string }[]
  close: () => Promise<void>
}> {
  const requests: { url: string; body: string }[] = []
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      requests.push({ url: request.url ?? '', body })
      const result = handler(request.url ?? '', body)
      response.writeHead(result.status, { 'content-type': 'application/json' })
      response.end(result.body ?? '{"ok":true}')
    })
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.closeAllConnections?.()
        server.close(() => resolvePromise())
      }),
  }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

test('memory: save, list, search ranking and delete', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-mem-'))
  const app = new App(resolveConfig({ home, workspace: home }))

  const fact = app.memory.save({
    kind: 'fact',
    subject: 'nginx',
    text: 'nginx worker 数应等于 CPU 核数，超过会争抢连接池',
    tags: ['nginx', 'capacity'],
    importance: 4,
    source: 'operator',
  })
  app.memory.save({ kind: 'episode', subject: 'checkout-svc', text: '上次 5xx 洪峰是连接池耗尽导致，扩容后恢复', importance: 5, source: 'agent' })
  app.memory.save({ kind: 'preference', subject: 'global', text: '生产变更必须走审批，不接受口头授权', importance: 5, source: 'operator' })

  assert.equal(app.memory.list().length, 3)
  assert.equal(app.memory.list(10, 'fact').length, 1)

  const hits = app.memory.search('nginx worker 连接池')
  assert.equal(hits.length > 0, true)
  assert.equal(hits[0]?.id, fact.id)
  assert.equal(hits[0]?.subject, 'nginx')
  // access bookkeeping drives future ranking
  assert.equal(app.memory.get(fact.id)?.accessCount, 1)

  const kindFiltered = app.memory.search('审批', { kind: 'preference' })
  assert.equal(kindFiltered.length > 0, true)
  assert.equal(kindFiltered.every((hit) => hit.kind === 'preference'), true)

  // recall block is bounded and only appears when something matches
  const block = app.memory.recallBlock('nginx 的连接池要怎么调')
  assert.match(block ?? '', /<memory>/)
  assert.match(block ?? '', /worker 数应等于 CPU 核数/)
  assert.equal(app.memory.recallBlock('x'), undefined)

  app.memory.delete(fact.id)
  assert.equal(app.memory.list().length, 2)
  await app.stop()
})

test('memory bridging: recalled context reaches the model without any tool call', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-mem-bridge-'))
  const mock = await startMockOpenAi({ toolName: '', finalText: 'mock-llm: 已参考记忆回答。' })
  const config = resolveConfig({ home, workspace: home, kernel: 'pi', port: 0 })
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
    app.memory.save({
      kind: 'fact',
      subject: 'api-gateway',
      text: 'api-gateway 的 upstream timeout 阈值是 3s，历史上调大导致过雪崩',
      importance: 5,
      source: 'operator',
    })
    await app.start()
    const session = await postJson<{ id: string }>(`${base}/api/sessions`, { title: '记忆桥接' })
    await postJson(`${base}/api/sessions/${session.id}/prompt`, { text: 'api-gateway 的 upstream timeout 要怎么调？' })

    await waitFor<ChatMessage>(
      async () => {
        const messages = await getJson<ChatMessage[]>(`${base}/api/sessions/${session.id}/messages`)
        return messages.find((message) => message.role === 'assistant')
      },
      { label: 'assistant answer', timeoutMs: 60_000 },
    )

    // The model really received the recalled block: inspect the request it got.
    const firstRequest = mock.requests[0] as { messages?: { role?: string; content?: unknown }[] } | undefined
    const rendered = JSON.stringify(firstRequest?.messages ?? [])
    assert.match(rendered, /<memory>/)
    assert.match(rendered, /upstream timeout 阈值是 3s/)
    // The user's own text is still there, after the block.
    assert.match(rendered, /要怎么调/)
  } finally {
    await server.close()
    await app.stop()
    await mock.close()
  }
})

test('memory tools: agent can search and save through the tool interface', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-mem-tools-'))
  const app = new App(resolveConfig({ home, workspace: home }))
  const ctx = { sessionId: 'sess-1', origin: 'chat' as const }

  const saved = await app.tools.execute(
    'memory_save',
    { kind: 'episode', subject: 'redis', text: 'redis 内存满时先查大 key，本次是 session 未设 TTL', importance: 4, tags: ['redis'] },
    ctx,
  )
  assert.equal(saved.ok, true)
  assert.match(saved.content, /已记住/)

  const searched = await app.tools.execute('memory_search', { query: 'redis 内存满' }, ctx)
  assert.equal(searched.ok, true)
  assert.match(searched.content, /先查大 key/)
  assert.match(searched.content, /\[episode\]/)

  // Recording what a run learned is allowed even unattended.
  const fromSchedule = await app.tools.execute(
    'memory_save',
    { kind: 'fact', subject: 'global', text: '夜间批量任务会占用 40% CPU，属正常基线' },
    { sessionId: 'sched-1', origin: 'schedule' },
  )
  assert.equal(fromSchedule.ok, true)
  await app.stop()
})

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

test('workflow engine: steps, when-conditions, failure handling and approval', { timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-wf-'))
  const webhook = await localServer(() => ({ status: 200 }))
  const app = new App(resolveConfig({ home, workspace: home }))

  const spec: WorkflowSpec = {
    id: 'wf-1',
    name: '测试流程',
    description: '',
    enabled: true,
    updatedAt: Date.now(),
    steps: [
      { id: 'cmd-ok', type: 'command', title: 'echo 成功', command: 'echo step-one-ok', timeoutSec: 10 },
      { id: 'check-status', type: 'check', kind: 'shell', title: '检查退出码', target: 'exit 0', timeoutSec: 10 },
      { id: 'skipped-by-when', type: 'command', title: '不应执行', command: 'echo should-not-run >&2; exit 3', when: { stepId: 'check-status', field: 'exitCode', equals: 7 } },
      { id: 'approval-denied', type: 'approval', title: '需要批准', reason: '测试用审批步骤' },
      { id: 'after-approval', type: 'command', title: '批准后才跑', command: 'echo after-approval-ran', when: { stepId: 'approval-denied', field: 'status', equals: 'approved' } },
      { id: 'notify', type: 'notify', title: '通知', url: `${webhook.url}/hook`, payload: { note: 'done' } },
    ],
  }
  app.saveWorkflow(spec)

  // Run 1: deny the approval -> the run stops and the dependent step is skipped.
  const pendingPromise = app.workflows.run('wf-1', { trigger: 'manual' })
  const approval = await waitFor<{ id: string }>(
    async () => {
      const list = app.approvals.pending()
      return list.find((record) => record.toolName === 'workflow_step')
    },
    { label: 'workflow approval', timeoutMs: 30_000 },
  )
  app.approvals.decide(approval.id, 'denied', 'operator', '测试拒绝')
  const deniedRun: WorkflowRun = await pendingPromise
  assert.equal(deniedRun.status, 'fail')
  assert.match(deniedRun.error ?? '', /审批步骤 approval-denied 未获批准/)

  const byId = new Map(deniedRun.steps.map((step) => [step.stepId, step]))
  assert.equal(byId.get('cmd-ok')?.status, 'ok')
  assert.match(byId.get('cmd-ok')?.output ?? '', /step-one-ok/)
  assert.equal(byId.get('check-status')?.status, 'ok')
  assert.equal(byId.get('skipped-by-when')?.status, 'skipped')
  assert.match(byId.get('skipped-by-when')?.detail ?? '', /条件不满足/)
  assert.equal(byId.get('approval-denied')?.status, 'denied')
  // The dependent step never ran (no approval), and the run stopped before notify.
  assert.equal(byId.has('after-approval'), false)
  assert.equal(byId.has('notify'), false)

  // Run 2: approve -> dependent step runs, notify fires.
  const secondPromise = app.workflows.run('wf-1', { trigger: 'manual' })
  const approval2 = await waitFor<{ id: string }>(
    async () => app.approvals.pending().find((record) => record.toolName === 'workflow_step'),
    { label: 'second workflow approval', timeoutMs: 30_000 },
  )
  app.approvals.decide(approval2.id, 'allowed-once', 'operator', '同意')
  const approvedRun = await secondPromise
  const approvedById = new Map(approvedRun.steps.map((step) => [step.stepId, step]))
  assert.equal(approvedById.get('approval-denied')?.status, 'approved')
  assert.equal(approvedById.get('after-approval')?.status, 'ok')
  assert.match(approvedById.get('after-approval')?.output ?? '', /after-approval-ran/)
  assert.equal(approvedById.get('notify')?.status, 'notified')
  assert.equal(webhook.requests.length, 1)
  assert.match(webhook.requests[0]?.body ?? '', /"note":"done"/)
  assert.equal(approvedRun.status, 'ok')

  // notify failure is surfaced, not swallowed.
  app.saveWorkflow({ ...spec, id: 'wf-notify-bad', steps: [{ id: 'n', type: 'notify', title: '坏 webhook', url: 'http://127.0.0.1:9/nope' }] })
  const badRun = await app.workflows.run('wf-notify-bad', { trigger: 'manual' })
  assert.equal(badRun.status, 'warn')
  assert.equal(badRun.steps[0]?.status, 'notify-failed')

  // command failures stop the run when stopOnFailure is set.
  app.saveWorkflow({
    ...spec,
    id: 'wf-stop',
    steps: [
      { id: 'boom', type: 'command', title: '失败命令', command: 'exit 4', stopOnFailure: true },
      { id: 'never', type: 'command', title: '不该跑', command: 'echo nope' },
    ],
  })
  const stopped = await app.workflows.run('wf-stop', { trigger: 'manual' })
  assert.equal(stopped.status, 'fail')
  assert.equal(stopped.steps.length, 1)
  assert.match(stopped.error ?? '', /步骤 boom 失败/)

  await webhook.close()
  await app.stop()
})

test('workflow_run tool lets an agent execute a fixed procedure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-wf-tool-'))
  const app = new App(resolveConfig({ home, workspace: home }))
  app.saveWorkflow({
    id: 'quick',
    name: '快速检查',
    description: '',
    enabled: true,
    updatedAt: Date.now(),
    steps: [{ id: 'echo', type: 'command', title: '快速检查', command: 'echo quick-check-ok' }],
  })
  const result = await app.tools.execute('workflow_run', { workflowId: 'quick' }, { sessionId: 's1', origin: 'chat' })
  assert.equal(result.ok, true)
  assert.match(result.content, /工作流 quick 执行完成：ok/)
  assert.match(result.content, /quick-check-ok/)
  await app.stop()
})

// ---------------------------------------------------------------------------
// Defined agents
// ---------------------------------------------------------------------------

test('defined agent: workflow-backed run records status and summary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-agent-wf-'))
  const app = new App(resolveConfig({ home, workspace: home }))
  app.saveWorkflow({
    id: 'wf-ok',
    name: '正常流程',
    description: '',
    enabled: true,
    updatedAt: Date.now(),
    steps: [{ id: 'echo', type: 'command', title: '检查', command: 'echo agent-workflow-ok' }],
  })
  app.saveAgent({
    id: 'worker-1',
    name: '流程智能体',
    role: '执行固定流程',
    kind: 'worker',
    workflowId: 'wf-ok',
    allowedTools: [],
    enabled: true,
    updatedAt: Date.now(),
  })

  const run = await app.agents.run('worker-1', { trigger: 'manual' })
  assert.equal(run.status, 'ok')
  assert.equal(typeof run.workflowRunId, 'string')
  const runs = app.agents.listRuns(10, 'worker-1')
  assert.equal(runs.length, 1)
  assert.equal(runs[0]?.status, 'ok')
  await app.stop()
})

test('defined agent: unattended tool scope is enforced and the summary is recorded', { timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-agent-scope-'))
  const mock = await startMockOpenAi({
    toolName: 'sre_shell',
    toolArguments: JSON.stringify({ command: 'echo must-not-run' }),
    finalText: 'mock-llm: 巡检完成，未做变更。',
  })
  const config = resolveConfig({ home, workspace: home, kernel: 'pi', port: 0 })
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

  try {
    await app.start()
    app.saveAgent({
      id: 'triage-1',
      name: '分诊智能体',
      role: '只做只读分诊',
      kind: 'worker',
      allowedTools: ['kb_search', 'memory_search'],
      enabled: true,
      updatedAt: Date.now(),
    })
    const run = await app.agents.run('triage-1', { trigger: 'manual' })
    assert.equal(run.status, 'ok')
    assert.match(run.summary ?? '', /巡检完成/)

    // The agent's session is unattended, so the out-of-scope shell call was denied.
    assert.equal(typeof run.sessionId, 'string')
    const messages = app.store.listMessages(run.sessionId ?? '')
    const toolMessage = messages.find((message) => message.role === 'tool')
    assert.equal(toolMessage?.ok, false)
    assert.match(toolMessage?.text ?? '', /outside the runbook tool scope|runbook scope/)
    // And no human was bothered.
    assert.equal(app.approvals.pending().length, 0)
  } finally {
    await app.stop()
    await mock.close()
  }
})

test('alert-triggered agent: matchers dispatch, escalation posts a payload', { timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-agent-alert-'))
  const escalation = await localServer(() => ({ status: 200 }))
  const config = resolveConfig({ home, workspace: home, kernel: 'pi', port: 0 })
  const app = new App(config)
  app.setHub(undefined)

  try {
    // Failing workflow so the run escalates.
    app.saveWorkflow({
      id: 'wf-fail',
      name: '会失败',
      description: '',
      enabled: true,
      updatedAt: Date.now(),
      steps: [{ id: 'boom', type: 'command', title: '失败', command: 'exit 9', stopOnFailure: true }],
    })
    app.saveAgent({
      id: 'alert-healer',
      name: '自愈智能体',
      role: '处理 HighCPU 类告警',
      kind: 'worker',
      alertMatchers: [{ severity: 'critical', namePattern: 'HighCPU*' }],
      workflowId: 'wf-fail',
      escalation: { notifyUrls: [`${escalation.url}/escalate`] },
      allowedTools: [],
      enabled: true,
      updatedAt: Date.now(),
    })
    app.saveAgent({
      id: 'unrelated',
      name: '无关智能体',
      role: '不匹配',
      kind: 'worker',
      alertMatchers: [{ severity: 'warning', namePattern: 'DiskFull*' }],
      allowedTools: [],
      enabled: true,
      updatedAt: Date.now(),
    })

    const matching: AlertEvent = {
      id: 'a1',
      source: 'test',
      fingerprint: 'fp-1',
      name: 'HighCPU on web-1',
      severity: 'critical',
      labels: {},
      status: 'firing',
      receivedAt: Date.now(),
    }
    assert.deepEqual(app.agents.matchesAlert(matching).map((agent) => agent.id), ['alert-healer'])
    // Trailing-wildcard patterns match, non-matching severity does not.
    assert.deepEqual(app.agents.matchesAlert({ ...matching, severity: 'warning' }), [])

    const dispatched = await app.alerts.ingest({
      source: 'test',
      name: 'HighCPU on web-1',
      severity: 'critical',
      fingerprint: 'fp-1',
    })
    assert.equal(dispatched.triaged, true)
    const runs = app.agents.listRuns(10, 'alert-healer')
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.status, 'fail')
    assert.equal(runs[0]?.trigger, 'alert')
    // Failure escalated to the webhook with the run summary.
    await waitFor(() => escalation.requests.length > 0, { label: 'escalation webhook', timeoutMs: 20_000 })
    assert.match(escalation.requests[0]?.body ?? '', /alert-healer/)
    assert.match(escalation.requests[0]?.body ?? '', /"status":"fail"/)
  } finally {
    await escalation.close()
    await app.stop()
  }
})

test('supervisor agent receives a digest of recent worker runs', { timeout: 240_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-agent-super-'))
  const mock = await startMockOpenAi({ toolName: '', finalText: 'mock-llm: 值守简报已生成。' })
  const config = resolveConfig({ home, workspace: home, kernel: 'pi', port: 0 })
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

  try {
    await app.start()
    app.saveWorkflow({
      id: 'disk-wf',
      name: '磁盘处置',
      description: '',
      enabled: true,
      updatedAt: Date.now(),
      steps: [{ id: 'check', type: 'command', title: '检查磁盘', command: 'echo disk-78-percent' }],
    })
    app.saveAgent({
      id: 'disk-worker',
      name: '磁盘看护',
      role: '检查磁盘水位',
      kind: 'worker',
      workflowId: 'disk-wf',
      allowedTools: [],
      enabled: true,
      updatedAt: Date.now(),
    })
    app.saveAgent({
      id: 'super',
      name: '值守主管',
      role: '协调各智能体',
      kind: 'supervisor',
      allowedTools: ['agent_status', 'memory_search', 'workflow_run'],
      enabled: true,
      updatedAt: Date.now(),
    })

    const workerRun = await app.agents.run('disk-worker', { trigger: 'manual' })
    assert.equal(workerRun.status, 'ok')

    const digest = app.agents.digest()
    assert.match(digest, /磁盘看护/)

    const supervisorRun = await app.agents.run('super', { trigger: 'manual' })
    assert.equal(supervisorRun.status, 'ok')
    assert.match(supervisorRun.summary ?? '', /值守简报/)

    // The supervisor's prompt carried the fleet digest.
    const lastRequest = mock.requests.at(-1) as { messages?: { role?: string; content?: unknown }[] } | undefined
    const rendered = JSON.stringify(lastRequest?.messages ?? [])
    assert.match(rendered, /其他智能体的近期运行/)
    assert.match(rendered, /磁盘看护/)
    assert.match(rendered, /编排要求/)
  } finally {
    await app.stop()
    await mock.close()
  }
})

test('agent_status tool reports the fleet to a supervisor', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-agent-tool-'))
  const app = new App(resolveConfig({ home, workspace: home }))
  app.saveWorkflow({
    id: 'w',
    name: 'w',
    description: '',
    enabled: true,
    updatedAt: Date.now(),
    steps: [{ id: 'c', type: 'command', title: 'c', command: 'echo ok' }],
  })
  app.saveAgent({ id: 'a1', name: '看护一号', role: 'r', kind: 'worker', workflowId: 'w', allowedTools: [], enabled: true, updatedAt: Date.now() })
  await app.agents.run('a1', { trigger: 'manual' })

  const result = await app.tools.execute('agent_status', { limit: 5 }, { sessionId: 's', origin: 'chat' })
  assert.equal(result.ok, true)
  assert.match(result.content, /a1\/看护一号\(worker/)
  assert.match(result.content, /看护一号/)
  assert.match(result.content, /ok/)
  await app.stop()
})

test('agent concurrency guard skips overlapping runs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-agent-conc-'))
  const app = new App(resolveConfig({ home, workspace: home }))
  app.saveWorkflow({
    id: 'slow',
    name: '慢流程',
    description: '',
    enabled: true,
    updatedAt: Date.now(),
    steps: [{ id: 'sleep', type: 'command', title: 'sleep', command: 'sleep 2', timeoutSec: 20 }],
  })
  app.saveAgent({ id: 'slow-agent', name: '慢智能体', role: 'r', kind: 'worker', workflowId: 'slow', allowedTools: [], enabled: true, updatedAt: Date.now() })

  const first = app.agents.run('slow-agent', { trigger: 'manual' })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  const second = await app.agents.run('slow-agent', { trigger: 'manual' })
  assert.equal(second.status, 'warn')
  assert.match(second.summary ?? '', /上一次运行尚未结束/)
  assert.equal((await first).status, 'ok')
  await app.stop()
})

test('agent definitions round-trip through the HTTP API and memory tools are listed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-agent-api-'))
  const app = new App(resolveConfig({ home, workspace: home }))
  const server = await createHttpServer(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`

  try {
    const created = await putJson<AgentSpec>(`${base}/api/agents/disk-watchdog`, {
      name: '磁盘看护',
      role: '看护磁盘',
      kind: 'worker',
      cron: '*/15 * * * *',
      allowedTools: ['sre_shell', 'memory_save'],
      enabled: true,
    })
    assert.equal(created.id, 'disk-watchdog')
    const listed = await getJson<AgentSpec[]>(`${base}/api/agents`)
    assert.equal(listed.some((agent) => agent.id === 'disk-watchdog'), true)

    const memory = await postJson<MemoryItem>(`${base}/api/memory`, {
      kind: 'fact',
      subject: 'api-gateway',
      text: '网关 upstream timeout 阈值 3s',
      importance: 4,
    })
    assert.equal(memory.kind, 'fact')
    const hits = await postJson<MemorySearchHit[]>(`${base}/api/memory/search`, { query: 'upstream timeout' })
    assert.equal(hits.length > 0, true)
    const all = await getJson<(MemoryItem & { text: string })[]>(`${base}/api/memory`)
    assert.equal(all.length, 1)
  } finally {
    await server.close()
    await app.stop()
  }
})
void silent
