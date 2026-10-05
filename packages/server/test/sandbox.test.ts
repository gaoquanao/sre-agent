import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { openDatabase } from '../src/db.ts'
import { KnowledgeBase } from '../src/knowledge.ts'
import { Logger } from '../src/log.ts'
import { Store } from '../src/store.ts'
import { createPlatformTools } from '../src/tools.ts'
import { createSandboxProvider } from '../src/sandbox/index.ts'
import { LocalSandboxProvider } from '../src/sandbox/local.ts'
import { E2BSandboxProvider, e2bSdkFactoryOf, type E2BSandboxLike } from '../src/sandbox/e2b.ts'
import { OpenSandboxProvider, osbSdkFactoryOf, type OSBSandboxLike } from '../src/sandbox/opensandbox.ts'
import { PlaywrightBrowserDriver, type LoadedPlaywright } from '../src/browser.ts'

const silentLog = new Logger('test', { minLevel: 'error' })

// -- local ------------------------------------------------------------------

test('local provider executes on the host and does file IO', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-sb-local-'))
  const config = resolveConfig({ home, workspace: home })
  const provider = new LocalSandboxProvider(config)

  const handle = await provider.get('s1')
  const result = await handle.exec('echo local-ok && echo err-line >&2')
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /local-ok/)
  assert.match(result.stderr, /err-line/)

  const file = join(home, 'sandbox-file.txt')
  await handle.writeFile(file, 'hello sandbox')
  assert.equal(await handle.readFile(file), 'hello sandbox')

  assert.equal(await handle.cdpEndpoint(), undefined)
  assert.deepEqual(await provider.sweep(Date.now()), [])
  assert.deepEqual(provider.summaries(), [])
})

// -- e2b backend (fake SDK) --------------------------------------------------

function fakeE2BSandbox(id: string, trace: string[]): E2BSandboxLike {
  return {
    sandboxId: id,
    commands: {
      run: async (cmd, opts) => {
        trace.push(`e2b-exec:${id}:${cmd}:${JSON.stringify(opts ?? {})}`)
        return { exitCode: 0, stdout: `ran ${cmd}`, stderr: '' }
      },
    },
    files: {
      read: async (path) => `content-of-${path}`,
      write: async (path) => {
        trace.push(`e2b-write:${id}:${path}`)
      },
    },
    getHost: (port) => `https://${id}-${port}.e2b.example`,
    setTimeout: async () => {
      trace.push(`e2b-renew:${id}`)
    },
    kill: async () => {
      trace.push(`e2b-kill:${id}`)
    },
  }
}

test('e2b provider: lazy per-session handles, exec mapping, sweep and releaseAll', async () => {
  const trace: string[] = []
  const provider = new E2BSandboxProvider(
    { template: 'sre-code', cdpPort: 9222, sdkFactory: e2bSdkFactoryOf([fakeE2BSandbox('sbx-1', trace), fakeE2BSandbox('sbx-2', trace)]) },
    60_000,
    silentLog,
  )

  const handleA = await provider.get('session-a')
  assert.equal(handleA.sandboxId, 'sbx-1')
  // Same session reuses the handle; no second create.
  assert.equal((await provider.get('session-a')).sandboxId, 'sbx-1')

  const result = await handleA.exec('uname -a', { cwd: '/workspace', timeoutMs: 5_000 })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'ran uname -a')
  assert.match(trace[0] ?? '', /e2b-exec:sbx-1:uname -a/)

  // CDP endpoint for browser-type images.
  assert.equal(await handleA.cdpEndpoint(), 'https://sbx-1-9222.e2b.example')

  // Idle reaping uses lastUsedAt vs the TTL.
  const reaped = await provider.sweep(Date.now() + 120_000)
  assert.deepEqual(reaped, ['session-a'])
  assert.match(trace.join('\n'), /e2b-kill:sbx-1/)

  // releaseAll terminates everything remaining.
  await provider.get('session-b')
  await provider.releaseAll()
  assert.match(trace.join('\n'), /e2b-kill:sbx-2/)
  assert.deepEqual(provider.summaries(), [])
})

test('e2b provider availability degrades when the SDK is missing', async () => {
  const provider = new E2BSandboxProvider(
    { sdkFactory: async () => { throw new Error("Cannot find package 'e2b'") } },
    60_000,
    silentLog,
  )
  const state = await provider.availability()
  assert.equal(state.ok, false)
  assert.match(state.detail, /e2b/)
})

// -- opensandbox backend (fake SDK) ------------------------------------------

function fakeOSBSandbox(id: string, trace: string[]): OSBSandboxLike {
  return {
    commands: {
      run: async (cmd, opts) => {
        trace.push(`osb-exec:${id}:${cmd}:${JSON.stringify(opts ?? {})}`)
        return { logs: { stdout: [{ text: `osb-ran ${cmd}` }], stderr: [{ text: 'warn-line' }] }, exitCode: 0 }
      },
    },
    files: {
      read_file: async (path) => `osb-content-${path}`,
      write_files: async (entries) => {
        trace.push(`osb-write:${id}:${entries.map((entry) => entry.path).join(',')}`)
      },
    },
    getEndpointUrl: async (port) => `https://osb-${id}-${port}.example`,
    renew: async () => {
      trace.push(`osb-renew:${id}`)
    },
    kill: async () => {
      trace.push(`osb-kill:${id}`)
    },
    close: async () => {
      trace.push(`osb-close:${id}`)
    },
    getInfo: async () => ({ id }),
  }
}

test('opensandbox provider: execution mapping, endpoint and lifecycle', async () => {
  const trace: string[] = []
  const provider = new OpenSandboxProvider(
    { image: 'chrome:stable', sdkFactory: osbSdkFactoryOf([fakeOSBSandbox('osb-1', trace)]), domain: 'sandbox.corp.example', apiKey: 'k' },
    120_000,
    silentLog,
  )

  const state = await provider.availability()
  assert.equal(state.ok, true)
  assert.match(state.detail, /chrome:stable/)

  const handle = await provider.get('session-osb')
  assert.equal(handle.sandboxId, 'osb-1')

  const result = await handle.exec('ps aux', { cwd: '/srv', timeoutMs: 30_000 })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'osb-ran ps aux')
  assert.match(result.stderr, /warn-line/)
  assert.match(trace[0] ?? '', /osb-exec:osb-1:ps aux/)
  assert.match(trace[0] ?? '', /"workingDirectory":"\/srv"/)

  assert.equal(await handle.cdpEndpoint(), 'https://osb-osb-1-9222.example')

  // Renew maps to the SDK's renew(timeoutSeconds) with a second-granularity TTL.
  await handle.renew()
  assert.match(trace.join('\n'), /osb-renew:osb-1/)

  await provider.release('session-osb')
  assert.match(trace.join('\n'), /osb-kill:osb-1/)
  assert.match(trace.join('\n'), /osb-close:osb-1/)
})

// -- routing: sre_shell goes through the provider ----------------------------

test('sre_shell executes inside the configured sandbox and records it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-sb-route-'))
  const config = resolveConfig({ home })
  const db = openDatabase(':memory:', silentLog)
  const store = new Store(db)
  const kb = new KnowledgeBase(db, silentLog)
  const trace: string[] = []
  const provider = new OpenSandboxProvider({ sdkFactory: osbSdkFactoryOf([fakeOSBSandbox('routed-1', trace)]) }, 60_000, silentLog)

  const tools = createPlatformTools({ config, log: silentLog, kb, store, sandbox: provider })
  const result = await tools.execute('sre_shell', { command: 'echo hi' }, { sessionId: 'routing-session', origin: 'chat' })

  assert.equal(result.ok, true)
  assert.match(result.content, /osb-ran echo hi/)
  assert.match(result.content, /on sandbox routed-1/)
  assert.match(trace[0] ?? '', /osb-exec:routed-1:echo hi/)
  // The audit trail records where the command ran.
  const audit = store.listAudit(5)
  assert.equal(audit.some((entry) => entry.action === 'tool.shell' && JSON.stringify(entry.detail ?? {}).includes('opensandbox:routed-1')), true)
  db.close()
})

test('sre_shell stays on the host with the local provider (default)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-sb-route2-'))
  const config = resolveConfig({ home, workspace: home })
  const db = openDatabase(':memory:', silentLog)
  const store = new Store(db)
  const kb = new KnowledgeBase(db, silentLog)
  const provider = new LocalSandboxProvider(config)

  const tools = createPlatformTools({ config, log: silentLog, kb, store, sandbox: provider })
  const result = await tools.execute('sre_shell', { command: 'echo host-default' }, { sessionId: 's', origin: 'chat' })
  assert.equal(result.ok, true)
  assert.match(result.content, /host-default/)
  assert.match(result.content, /on host/)
  db.close()
})

// -- provider selection ------------------------------------------------------

test('createSandboxProvider routes on config', () => {
  const home = mkdtempSync(join(tmpdir(), 'sre-sb-cfg-'))
  const e2bConfig = resolveConfig({ home, sandbox: { provider: 'e2b', template: 'sre-code' } })
  assert.equal(createSandboxProvider(e2bConfig, silentLog).id, 'e2b')

  const osbConfig = resolveConfig({ home, sandbox: { provider: 'opensandbox', template: 'chrome:stable' } })
  assert.equal(createSandboxProvider(osbConfig, silentLog).id, 'opensandbox')

  const localConfig = resolveConfig({ home, sandbox: { provider: 'local' } })
  assert.equal(createSandboxProvider(localConfig, silentLog).id, 'local')

  const defaultConfig = resolveConfig({ home })
  assert.equal(createSandboxProvider(defaultConfig, silentLog).id, 'local')
})

// -- browser driver CDP branch (fake playwright) -----------------------------

test('browser driver attaches to the sandbox CDP endpoint instead of launching Chrome', { timeout: 60_000 }, async () => {
  const connected: string[] = []
  let launched = 0
  const fakePage = {
    setDefaultTimeout: () => {},
    goto: async () => ({}),
    title: async () => 'sandbox page',
    url: () => 'https://inside-sandbox/',
    content: async () => '<html><body>hello from sandbox</body></html>',
    screenshot: async () => Buffer.from('png'),
    click: async () => {},
    fill: async () => {},
    evaluate: async () => 'ok',
    close: async () => {},
  }
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {} }
  const fakeLoader = async (): Promise<LoadedPlaywright> =>
    ({
      chromium: {
        launch: async () => {
          launched += 1
          return fakeBrowser
        },
        connectOverCDP: async (endpoint: string) => {
          connected.push(endpoint)
          return fakeBrowser
        },
      },
    }) as unknown as LoadedPlaywright

  const driver = new PlaywrightBrowserDriver(
    { channel: 'chrome', headless: true },
    { cdpEndpoint: async () => 'https://sandbox-9222.example', loader: fakeLoader },
  )
  assert.match(driver.target, /CDP/)

  const info = await driver.navigate('session-b', 'https://example.com/')
  assert.equal(info.title, 'sandbox page')
  assert.deepEqual(connected, ['https://sandbox-9222.example'])
  assert.equal(launched, 0)

  await driver.closeAll()
})
