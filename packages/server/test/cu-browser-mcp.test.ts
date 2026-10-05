import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import { App } from '../src/app.ts'
import { resolveConfig } from '../src/config.ts'
import { MacComputerDriver } from '../src/computer.ts'
import { PlaywrightBrowserDriver } from '../src/browser.ts'
import { getJson, postJson, waitFor } from './helpers.ts'

const silent = { silent: true }

// ---------------------------------------------------------------------------
// Computer driver: command construction (mocked exec, never touches the UI)
// ---------------------------------------------------------------------------

test('mac computer driver builds the right automation commands', async () => {
  const calls: { file: string; args: string[] }[] = []
  const driver = new MacComputerDriver(async (file, args) => {
    calls.push({ file, args })
    if (args.join(' ').includes('get name of first process whose frontmost is true')) return 'Finder\n'
    return ''
  })

  await driver.click(120, 240)
  await driver.click(10, 20, { button: 'right' })
  await driver.click(30, 40, { double: true })
  await driver.type('hello 世界')
  await driver.key('enter')
  await driver.scroll(0, 120)
  const app = await driver.frontmostApp()
  assert.equal(app, 'Finder')

  const scripts = calls.filter((call) => call.file === '/usr/bin/osascript').map((call) => call.args.join(' '))
  assert.equal(scripts.length, 7)
  // JXA click posts mouse-down/up events at the coordinates.
  assert.match(scripts[0]!, /CoreGraphics/)
  assert.match(scripts[0]!, /kCGEventLeftMouseDown/)
  assert.match(scripts[0]!, /\{"x":120,"y":240\}/)
  assert.match(scripts[1]!, /kCGEventRightMouseDown/)
  assert.match(scripts[2]!, /kCGEventLeftMouseDown/) // double click = two pairs
  // typing goes through System Events keystroke (unicode-safe)
  assert.match(scripts[3]!, /keystroke "hello 世界"/)
  // named keys map to System Events key codes
  assert.match(scripts[4]!, /key code 36/)
  assert.match(scripts[0]!, /kCGHIDEventTap/)
})

test('mac computer driver screenshot round-trips a png file', async () => {
  // 1x1 transparent png
  const fakePng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )
  const dir = mkdtempSync(join(tmpdir(), 'sre-shot-'))
  let capturedPath: string | undefined
  const driver = new MacComputerDriver(async (file, args) => {
    assert.equal(file, '/usr/sbin/screencapture')
    capturedPath = args[3]
    const { writeFileSync } = await import('node:fs')
    writeFileSync(capturedPath!, fakePng)
    return ''
  })
  const shot = await driver.screenshot()
  assert.equal(shot.png.equals(fakePng), true)
  assert.match(capturedPath ?? '', /sre-screen-.*\.png$/)
  void dir
})

// ---------------------------------------------------------------------------
// Browser driver: real Chrome on this machine
// ---------------------------------------------------------------------------

test('browser driver drives real Chrome against a local site', { timeout: 120_000 }, async () => {
  const pageHtml = `<!doctype html><html><head><title>SRE Demo</title></head>
<body><h1>Service health</h1><p>All systems nominal. Error budget 92% remaining.</p>
<a href="/metrics">Metrics</a><a href="/alerts">Alerts</a>
<input id="filter" placeholder="filter services"/></body></html>`

  const server: Server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(request.url === '/health' ? 'ok' : pageHtml)
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const port = (server.address() as AddressInfo).port

  const driver = new PlaywrightBrowserDriver()
  const state = await driver.provisioned()
  if (!state.ok) {
    server.close()
    // Environment without playwright-core/Chrome: the degradation path is the
    // contract under test.
    assert.match(state.detail, /未就绪/)
    return
  }

  try {
    const sessionId = 'browser-test-session'
    const info = await driver.navigate(sessionId, `http://127.0.0.1:${port}/status`)
    assert.equal(info.title, 'SRE Demo')
    assert.match(info.textExcerpt, /All systems nominal/)
    assert.equal(info.links.some((link) => link.includes('/metrics')), true)

    const shot = await driver.screenshot(sessionId)
    // PNG magic bytes.
    assert.deepEqual([...shot.png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47])
    assert.match(shot.url, /127\.0\.0\.1/)

    await driver.fill(sessionId, '#filter', 'checkout')
    const evaluated = await driver.evaluate(sessionId, "document.getElementById('filter').value")
    assert.equal(evaluated, 'checkout')

    await driver.click(sessionId, 'a[href="/metrics"]')
    await driver.close(sessionId)
  } finally {
    await driver.closeAll()
    server.closeAllConnections?.()
    server.close()
  }
})

// ---------------------------------------------------------------------------
// MCP stdio bridge: platform tools for MCP-capable kernels, through the gate
// ---------------------------------------------------------------------------

async function rpc(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`rpc timeout: ${message.method}`)), 20_000)
    const onLine = (raw: Buffer | string): void => {
      const line = String(raw).trim()
      if (line.length === 0) return
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (parsed.id === message.id) {
        clearTimeout(timer)
        child.stdout.off('data', onLine)
        resolvePromise(parsed)
      }
    }
    child.stdout.on('data', onLine)
    child.stdin.write(`${JSON.stringify(message)}\n`)
  })
}

test('MCP stdio bridge: initialize, list platform tools, call through the approval gate', { timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-mcp-'))
  const config = resolveConfig({ home, kernel: 'pi', port: 0 })
  const app = new App(config)
  const server = await createHttpServer2(app)
  await server.listen({ host: '127.0.0.1', port: 0 })
  config.port = (server.server.address() as AddressInfo).port

  // Build the bridge first so its script exists on disk.
  const { execFileSync } = await import('node:child_process')
  execFileSync('npx', ['tsc', '-p', 'packages/server/tsconfig.json'], { cwd: process.cwd(), stdio: 'pipe' })
  const bridge = join(process.cwd(), 'packages', 'server', 'dist', 'mcp-stdio.js')

  const child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      SRE_AGENT_URL: `http://127.0.0.1:${config.port}`,
      SRE_AGENT_HOME: home,
      SRE_AGENT_INTERNAL_TOKEN: config.internalToken,
      SRE_AGENT_SESSION_ID: 'mcp-test-session',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
  child.stderr.on('data', () => undefined)

  try {
    await app.start()
    app.registerSessionRuntime({ sessionId: 'mcp-test-session', origin: 'chat' })

    const init = await rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const initResult = init.result as { serverInfo?: { name?: string }; protocolVersion?: string }
    assert.equal(initResult?.serverInfo?.name, 'sre-agent-platform')

    const listed = await rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const tools = (listed.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)
    assert.equal(tools.includes('kb_search'), true)
    assert.equal(tools.includes('browser_navigate'), true)
    assert.equal(tools.includes('computer_click'), true)
    assert.equal(tools.includes('sre_delegate'), true)
    assert.equal(tools.includes('ask_user'), true)

    // A read-only tool call executes immediately.
    app.kb.ingest({ title: 'redis 手册', source: 'kb/redis.md', text: 'redis 内存满时优先查大 key 与 maxmemory 策略。' })
    const call = await rpc(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'kb_search', arguments: { query: 'redis 内存满' } },
    })
    const callResult = call.result as { content: { type: string; text: string }[]; isError?: boolean }
    assert.equal(callResult.isError, false)
    assert.match(callResult.content.at(-1)?.text ?? '', /redis 手册/)

    // A destructive tool call blocks in the approval gate until answered.
    const shellCall = rpc(child, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'sre_shell', arguments: { command: 'echo via-mcp' } },
    })
    const approval = await waitFor<Record<string, unknown>>(
      async () => {
        const list = await getJson<Record<string, unknown>[]>(`http://127.0.0.1:${config.port}/api/approvals?status=pending`)
        return list.find((record) => (record as { toolName: string }).toolName === 'sre_shell')
      },
      { label: 'mcp-gated approval', timeoutMs: 30_000 },
    )
    await postJson(`http://127.0.0.1:${config.port}/api/approvals/${String(approval.id)}/decide`, {
      decision: 'allowed-once',
    })
    const shellResult = (await shellCall).result as { content: { type: string; text: string }[]; isError?: boolean }
    assert.equal(shellResult.isError, false)
    assert.match(shellResult.content.at(-1)?.text ?? '', /via-mcp/)
  } finally {
    child.kill('SIGTERM')
    await server.close()
    await app.stop()
  }
})

// keep the import used; createHttpServer imported lazily to mirror other suites
async function createHttpServer2(app: App): Promise<ReturnType<typeof import('../src/http.ts')['createHttpServer']>> {
  const mod = await import('../src/http.ts')
  return mod.createHttpServer(app)
}

// Claude profile must reference the MCP config when one is prepared for the turn.
test('claude-code profile passes --mcp-config so platform tools reach the CLI', async () => {
  const { claudeCodeProfile } = await import('../src/kernels/cli.ts')
  const plan = claudeCodeProfile.buildTurn('hello', {
    workspace: '/tmp',
    permission: 'workspace-write',
    transcript: [],
    mcpConfigPath: '/tmp/mcp-config.json',
  })
  const args = plan.args.join(' ')
  assert.match(args, /--mcp-config \/tmp\/mcp-config\.json/)
  assert.match(args, /--strict-mcp-config/)
  assert.match(args, /--allowedTools mcp__sre-platform/)
})
void silent
