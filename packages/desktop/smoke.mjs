#!/usr/bin/env node
/**
 * Node-level smoke test for the desktop shell's server lifecycle.
 *
 * Runs server-process.js against a real child process (the fake backend in
 * test/fixtures/fake-server.mjs) without starting Electron, and covers:
 *
 *   1. ready-line parsing and the startup info returned to the shell
 *   2. entry discovery (dist preferred, TypeScript source fallback)
 *   3. ready timeout when the backend never reports readiness
 *   4. SIGTERM reclamation (graceful exit) and SIGKILL escalation
 *   5. crash auto-restart with backoff, and exhaustion of the restart budget
 *
 * Usage: node smoke.mjs   (exit code 0 = all scenarios passed)
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ServerProcess } from './server-process.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'test', 'fixtures', 'fake-server.mjs')
const WORKDIR = mkdtempSync(join(tmpdir(), 'sre-desktop-smoke-'))

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

function makeServer(mode, overrides = {}) {
  const dir = mkdtempSync(join(WORKDIR, 'case-'))
  const instance = new ServerProcess({
    repoRoot: HERE,
    entry: FIXTURE,
    home: join(dir, 'home'),
    logFile: join(dir, 'logs', 'server.log'),
    kernel: 'pi',
    port: overrides.port,
    extraEnv: { FAKE_MODE: mode, ...(overrides.extraEnv ?? {}) },
    readyTimeoutMs: overrides.readyTimeoutMs ?? 10_000,
    shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 3_000,
    restartBackoffMs: overrides.restartBackoffMs ?? 80,
    maxRestarts: overrides.maxRestarts ?? 3,
  })
  instance.caseDir = dir
  return instance
}

const scenarios = []
function scenario(name, fn) {
  scenarios.push({ name, fn })
}

// 1 ---------------------------------------------------------------------------
scenario('ready line: start() resolves with the url/port/home/kernel of the running backend', async () => {
  const sp = makeServer('ready', { port: 18787 })
  const logs = []
  sp.on('log', (payload) => logs.push(payload))
  try {
    const info = await sp.start()
    // The ready line is authoritative, so it wins over the SRE_AGENT_PORT value
    // the shell passed in.
    assert.equal(info.url, 'http://127.0.0.1:1')
    assert.equal(info.port, 1)
    assert.equal(info.home, join(sp.caseDir, 'home'))
    assert.equal(info.kernel, 'pi')
    assert.equal(info.state, 'ready')
    assert.equal(typeof info.pid, 'number')
    assert.equal(sp.kernel, 'pi')

    // The child really is running and holds the environment the shell injected.
    assert.equal(isAlive(info.pid), true, 'child process should be alive')
    const banner = logs.find((entry) => entry.line.includes('fake-server: mode=ready'))
    assert.ok(banner !== undefined, 'expected the boot banner on the log stream')
    assert.match(banner.line, new RegExp(`home=${info.home}`))
    assert.match(banner.line, /kernel=pi/)
    assert.match(banner.line, /electron_run_as_node=1/)
    assert.match(banner.line, /env_port=18787/, 'SRE_AGENT_PORT must reach the child')
    assert.match(banner.line, /web_dist=unset/, 'no web dist passed here, since none was configured')
    // stderr travels on its own pipe, so it may land a tick after the ready line.
    await waitFor(() => logs.some((entry) => entry.stream === 'stderr'), 3_000, 'the stderr line to be forwarded')
    assert.ok(
      logs.some((entry) => entry.stream === 'stderr'),
      'stderr must be forwarded too',
    )

    const stopped = await sp.stop()
    assert.equal(stopped.state, 'stopped')

    // Everything the child printed is on disk, shell lines included.
    const log = readFileSync(info.logFile, 'utf8')
    assert.match(log, /SRE_AGENT_READY http:\/\/127\.0\.0\.1:1/)
    assert.match(log, /fake-server: booting/)
    assert.match(log, /spawned pid=\d+ mode=override/)
    return `url=${info.url} pid=${info.pid} log=${info.logFile}`
  } finally {
    await sp.stop()
    sp.dispose()
  }
})

// 2 ---------------------------------------------------------------------------
scenario('entry discovery: packages/server/dist wins, src/index.ts falls back to --experimental-strip-types', async () => {
  const root = mkdtempSync(join(WORKDIR, 'tree-'))
  mkdirSync(join(root, 'packages', 'server', 'src'), { recursive: true })

  assert.equal(ServerProcess.resolveEntry(root), null, 'no server package means no entry')

  const src = join(root, 'packages', 'server', 'src', 'index.ts')
  writeFileSync(src, 'export {}\n')
  const fromSource = ServerProcess.resolveEntry(root)
  assert.deepEqual(fromSource, { entry: src, nodeArgs: ['--experimental-strip-types'], mode: 'source' })

  mkdirSync(join(root, 'packages', 'server', 'dist'), { recursive: true })
  const dist = join(root, 'packages', 'server', 'dist', 'index.js')
  writeFileSync(dist, 'export {}\n')
  const fromDist = ServerProcess.resolveEntry(root)
  assert.deepEqual(fromDist, { entry: dist, nodeArgs: [], mode: 'dist' })
  return `source=${src} dist=${dist}`
})

// 3 ---------------------------------------------------------------------------
scenario('ready timeout: a backend that never prints the ready line fails the start and is killed', async () => {
  const sp = makeServer('silent', { readyTimeoutMs: 800 })
  try {
    const started = Date.now()
    await assert.rejects(sp.start(), (error) => {
      assert.match(error.message, /did not report "SRE_AGENT_READY" within 800ms/)
      assert.equal(error.code, 'READY_TIMEOUT')
      return true
    })
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 750, `timeout fired too early (${elapsed}ms)`)
    assert.ok(elapsed < 5_000, `timeout fired too late (${elapsed}ms)`)

    const info = sp.getInfo()
    assert.equal(info.state, 'failed')
    assert.equal(info.error.code, 'READY_TIMEOUT')
    // The failure is reported as soon as it is known; the teardown of the
    // unresponsive child happens right after.
    await waitFor(() => sp.getInfo().pid === null, 3_000, 'the timed-out child to be reaped')
    return `rejected after ${elapsed}ms, state=${info.state}, pid reaped`
  } finally {
    await sp.stop()
    sp.dispose()
  }
})

// 4 ---------------------------------------------------------------------------
scenario('SIGTERM reclamation: stop() lets the backend exit gracefully and the child is gone', async () => {
  const sp = makeServer('ready')
  try {
    const info = await sp.start()
    const pid = info.pid
    assert.equal(isAlive(pid), true)

    const stopped = await sp.stop()
    assert.equal(stopped.lastExit.code, 0)
    assert.equal(stopped.lastExit.signal, null, 'a SIGTERM kill would report signal=SIGTERM')
    assert.equal(isAlive(pid), false, 'pid must be reaped')
    assert.equal(sp.getInfo().pid, null)
    return `pid=${pid} exit=${JSON.stringify(stopped.lastExit)}`
  } finally {
    await sp.stop()
    sp.dispose()
  }
})

// 5 ---------------------------------------------------------------------------
scenario('SIGKILL escalation: a backend that ignores SIGTERM is force-killed after the shutdown timeout', async () => {
  const sp = makeServer('ignore-sigterm', { shutdownTimeoutMs: 400 })
  try {
    const info = await sp.start()
    const pid = info.pid

    const started = Date.now()
    const stopped = await sp.stop()
    const elapsed = Date.now() - started

    assert.equal(stopped.lastExit.signal, 'SIGKILL')
    assert.equal(stopped.lastExit.code, null)
    assert.equal(isAlive(pid), false, 'pid must be reaped')
    assert.ok(elapsed >= 350, `escalation happened too early (${elapsed}ms)`)
    assert.ok(elapsed < 3_000, `escalation happened too late (${elapsed}ms)`)
    return `pid=${pid} killed after ${elapsed}ms, signal=${stopped.lastExit.signal}`
  } finally {
    await sp.stop()
    sp.dispose()
  }
})

// 6 ---------------------------------------------------------------------------
scenario('auto-restart: a crash after ready restarts the backend (backoff) and it becomes ready again', async () => {
  const marker = join(mkdtempSync(join(WORKDIR, 'marker-')), 'crashed-once')
  const sp = makeServer('crash-once', {
    restartBackoffMs: 80,
    extraEnv: { FAKE_MARKER: marker },
  })
  const states = []
  sp.on('status', (status) => states.push(status.state))
  try {
    const first = await sp.start()
    const firstPid = first.pid

    await waitFor(() => states.includes('crashed'), 5_000, 'the crash to be observed')
    await waitFor(() => states.includes('restarting'), 5_000, 'the restart to be scheduled')
    await waitFor(() => sp.getInfo().state === 'ready', 5_000, 'the backend to be ready again')

    const info = sp.getInfo()
    assert.notEqual(info.pid, firstPid, 'a new child process must have been spawned')
    assert.equal(info.restartAttempts, 1)
    assert.equal(info.url, 'http://127.0.0.1:1')
    assert.ok(states.includes('crashed') && states.includes('restarting') && states.includes('ready'))
    assert.equal(sp.lastExit.code, 7)
    return `states=${states.join(' -> ')} pid ${firstPid} -> ${info.pid}`
  } finally {
    await sp.stop()
    sp.dispose()
  }
})

// 7 ---------------------------------------------------------------------------
scenario('restart budget: repeated crashes give up after maxRestarts with RESTARTS_EXHAUSTED', async () => {
  const sp = makeServer('crash-always', { maxRestarts: 2, restartBackoffMs: 60 })
  const states = []
  sp.on('status', (status) => states.push(status.state))
  try {
    await sp.start()
    await waitFor(() => sp.getInfo().state === 'failed', 10_000, 'the restart budget to run out')

    const info = sp.getInfo()
    assert.equal(info.error.code, 'RESTARTS_EXHAUSTED')
    assert.equal(info.restartAttempts, 2)
    assert.equal(info.pid, null)
    assert.equal(states.filter((state) => state === 'ready').length, 3, 'one initial start plus two restarts')
    return `states=${states.join(' -> ')}`
  } finally {
    await sp.stop()
    sp.dispose()
  }
})

// 8 ---------------------------------------------------------------------------
scenario('shell wiring: files referenced by main.js and the builder file list all exist', () => {
  const mainSource = readFileSync(join(HERE, 'main.js'), 'utf8')
  for (const reference of ['preload.cjs', 'renderer', 'status.html', 'server-process.js']) {
    assert.ok(mainSource.includes(reference), `main.js should reference ${reference}`)
  }
  // Electron only emits `ready` once the main module finished evaluating, so a
  // top-level await in main.js deadlocks the whole app (see the header comment).
  // Guard the invariant instead of relying on anyone remembering it.
  assert.ok(mainSource.includes('void bootstrap()'), 'main.js must call bootstrap() without await')
  assert.ok(
    !/^await\s/m.test(mainSource),
    'main.js must not contain a top-level await (the app would never become ready)',
  )
  for (const file of ['main.js', 'preload.cjs', 'server-process.js', 'renderer/status.html', 'renderer/status.js']) {
    assert.ok(existsSync(join(HERE, file)), `${file} is missing`)
  }
  const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@sre/desktop')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'main.js')
  for (const pattern of ['main.js', 'preload.cjs', 'server-process.js', 'renderer/**/*']) {
    assert.ok(pkg.build.files.includes(pattern), `electron-builder files should include ${pattern}`)
  }
  assert.ok(pkg.build.mac.target.some((entry) => entry.target === 'dmg'))
  assert.ok(pkg.build.win.target.some((entry) => entry.target === 'nsis'))
  return `dev=${pkg.scripts.dev} build=${pkg.scripts.build} smoke=${pkg.scripts.smoke}`
})

// 9 ---------------------------------------------------------------------------
scenario('dynamic ready url: the port is taken from the ready line and the url really serves', async () => {
  const sp = makeServer('http')
  try {
    const info = await sp.start()
    const port = Number.parseInt(new URL(info.url).port, 10)
    assert.equal(info.port, port, 'the parsed port must match the ready line')
    assert.ok(port > 1024, `expected an ephemeral port, got ${info.port}`)

    const response = await fetch(info.url)
    assert.equal(response.status, 200)
    assert.equal((await response.text()).trim(), 'fake-sre-agent-web')

    const stopped = await sp.stop()
    assert.equal(stopped.lastExit.code, 0)
    return `url=${info.url} http 200 from the reported url`
  } finally {
    await sp.stop()
    sp.dispose()
  }
})

// ---------------------------------------------------------------------------

console.log(`SRE Agent desktop shell — server-process smoke test`)
console.log(`node ${process.version}`)
console.log(`fixture ${FIXTURE}`)
console.log('')

let failed = 0
let index = 0
for (const { name, fn } of scenarios) {
  index += 1
  try {
    const detail = await fn()
    console.log(`ok ${index} - ${name}`)
    if (typeof detail === 'string' && detail.length > 0) console.log(`       ${detail}`)
  } catch (error) {
    failed += 1
    console.log(`not ok ${index} - ${name}`)
    console.log(`       ${error.message}`)
    if (error.stack !== undefined) {
      console.log(
        error.stack
          .split('\n')
          .slice(1, 4)
          .map((line) => `       ${line.trim()}`)
          .join('\n'),
      )
    }
  }
}

rmSync(WORKDIR, { recursive: true, force: true })
console.log('')
console.log(`${index - failed}/${index} scenarios passed`)
if (failed > 0) {
  console.log(`not ok - ${failed} scenario(s) failed`)
  process.exitCode = 1
} else {
  console.log('ok - all scenarios passed')
}

// Every scenario stops the child it started, so the event loop should drain on
// its own. If a leaked child keeps it alive, exit anyway instead of hanging
// forever; all output above is flushed by then.
setTimeout(() => {
  process.exit(process.exitCode ?? 0)
}, 1_000).unref()
