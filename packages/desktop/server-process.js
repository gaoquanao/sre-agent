/**
 * Lifetime manager for the @sre/server child process.
 *
 * This module deliberately uses no Electron API (only node:child_process,
 * node:events, node:fs and node:path) so the whole lifecycle can be exercised
 * by plain Node — see `smoke.mjs`. Everything Electron specific (userData
 * paths, forwarding log lines into a BrowserWindow) is injected by the caller
 * as plain option values.
 *
 * Contract with @sre/server:
 *   - entry: `packages/server/dist/index.js`, falling back to
 *     `packages/server/src/index.ts` executed with --experimental-strip-types.
 *   - env:   SRE_AGENT_HOME, SRE_AGENT_HOST, SRE_AGENT_PORT, SRE_AGENT_WEB_DIST.
 *   - ready: exactly one stdout line `SRE_AGENT_READY <url>` printed once the
 *     HTTP server listens. This line is the only readiness signal; a start that
 *     does not see it within `readyTimeoutMs` is a failure.
 *   - exit:  SIGTERM first, escalated to SIGKILL after `shutdownTimeoutMs`.
 *
 * State machine (getInfo().state):
 *   idle -> starting -> ready -> stopping -> stopped
 *                |         |
 *                |         +-> crashed -> starting (auto-restart, backoff)
 *                |                        (budget exhausted -> failed)
 *                +-> failed            (ready timeout / early crash)
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** `SRE_AGENT_READY <url>` plus optional `key=value` extras for forward compatibility. */
const READY_PATTERN = /^SRE_AGENT_READY\s+(\S+)(?:\s+(.*))?$/

const DEFAULT_READY_TIMEOUT_MS = 30_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_MAX_RESTARTS = 3
const DEFAULT_RESTART_BACKOFF_MS = 500
/** Continuous uptime after which the auto-restart budget is refilled. */
const DEFAULT_HEALTHY_UPTIME_MS = 5 * 60_000
/** How many recent log lines are kept in memory for the failure/status page. */
const LOG_RING_LIMIT = 300
/** Polling granularity while waiting for a child to disappear. */
const POLL_INTERVAL_MS = 25

/** A child that has been reaped (or never spawned) is no longer killable. */
function hasExited(child) {
  return child === null || child.exitCode !== null || child.signalCode !== null
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

/** Parses `kernel=dsh retries=2` style extras attached to the ready line. */
function parseReadyExtras(raw = '') {
  const extras = {}
  for (const token of raw.trim().split(/\s+/)) {
    if (token.length === 0) continue
    const eq = token.indexOf('=')
    if (eq <= 0) continue
    extras[token.slice(0, eq)] = token.slice(eq + 1)
  }
  return extras
}

function parsePortFromEnv(raw) {
  if (raw === undefined || raw.length === 0) return undefined
  const port = Number.parseInt(raw, 10)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
}

export class ServerProcess extends EventEmitter {
  #child = null
  #logStream = null
  #logClosed = null
  #readyTimer = null
  #healthyTimer = null
  #restartTimer = null
  #resolveStopped = null
  #stoppedSettled = null
  #pendingStart = null
  #exitGuard = null
  #partials = { stdout: '', stderr: '' }

  constructor(options = {}) {
    super()
    const { repoRoot, home, logFile } = options
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new TypeError('repoRoot is required')
    if (typeof home !== 'string' || home.length === 0) throw new TypeError('home is required')
    if (typeof logFile !== 'string' || logFile.length === 0) throw new TypeError('logFile is required')

    this.repoRoot = resolve(repoRoot)
    /** Data directory handed to the server as SRE_AGENT_HOME. */
    this.home = resolve(home)
    this.logFile = resolve(logFile)
    this.host = options.host ?? process.env.SRE_AGENT_HOST ?? '127.0.0.1'
    /** undefined => let the server use its own default port. */
    this.port = options.port ?? parsePortFromEnv(process.env.SRE_AGENT_PORT)
    this.webDist = typeof options.webDist === 'string' ? resolve(options.webDist) : undefined
    this.kernel = options.kernel ?? process.env.SRE_AGENT_KERNEL ?? 'pi'
    this.extraEnv = { ...(options.extraEnv ?? {}) }
    this.cwd = options.cwd === undefined ? this.repoRoot : resolve(options.cwd)

    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
    /** A child that stays ready this long earns a fresh crash budget. */
    this.healthyUptimeMs = options.healthyUptimeMs ?? DEFAULT_HEALTHY_UPTIME_MS
    /** Default runtime: Electron's binary acts as Node when ELECTRON_RUN_AS_NODE=1. */
    this.execPath = options.execPath ?? process.execPath

    // Explicit entry (used by tests and by custom builds) wins over discovery.
    this.entryOverride =
      typeof options.entry === 'string'
        ? { entry: resolve(options.entry), nodeArgs: options.nodeArgs ?? [], mode: 'override' }
        : null

    this.entry = null
    this.state = 'idle'
    this.url = null
    this.startedAt = null
    this.restartAttempts = 0
    this.lastExit = null
    this.startFailure = null
    this.logRing = []

    // Last-resort safety net: if the host process dies without running its
    // asynchronous shutdown (uncaught exception, forced Electron exit) the
    // child would survive as an orphan. SIGKILL it synchronously instead.
    this.#exitGuard = () => {
      this.killSync()
    }
    process.on('exit', this.#exitGuard)
  }

  /**
   * Finds the server entry: the built output first, then the TypeScript source
   * which modern Node runs directly by stripping types.
   */
  static resolveEntry(repoRoot) {
    const dist = join(repoRoot, 'packages', 'server', 'dist', 'index.js')
    if (existsSync(dist)) return { entry: dist, nodeArgs: [], mode: 'dist' }
    const src = join(repoRoot, 'packages', 'server', 'src', 'index.ts')
    if (existsSync(src)) return { entry: src, nodeArgs: ['--experimental-strip-types'], mode: 'source' }
    return null
  }

  getInfo() {
    return {
      url: this.url,
      port: this.port ?? null,
      home: this.home,
      kernel: this.kernel,
      pid: hasExited(this.#child) ? null : (this.#child?.pid ?? null),
      state: this.state,
      entry: this.entry === null ? null : { ...this.entry },
      logFile: this.logFile,
      startedAt: this.startedAt,
      restartAttempts: this.restartAttempts,
      lastExit: this.lastExit,
      error: this.startFailure,
      logTail: [...this.logRing],
    }
  }

  /**
   * Starts the child and resolves with `getInfo()` once the ready line has been
   * seen. Rejects on a ready timeout or on a crash before the ready line.
   * Manual starts reset the auto-restart budget.
   */
  async start() {
    this.restartAttempts = 0
    this.startFailure = null
    this.lastExit = null
    return this.#launch()
  }

  async #launch() {
    if (this.state === 'starting' || this.state === 'ready') {
      throw new Error(`@sre/server is already ${this.state}`)
    }
    const entry = this.entryOverride ?? ServerProcess.resolveEntry(this.repoRoot)
    if (entry === null) {
      const error = new Error(
        `@sre/server entry not found under ${this.repoRoot} ` +
          '(expected packages/server/dist/index.js or packages/server/src/index.ts)',
      )
      this.startFailure = { message: error.message, code: 'ENTRY_MISSING' }
      this.#setState('failed', { reason: 'entry-missing', message: error.message })
      throw error
    }

    this.entry = entry
    this.url = null

    const args = [...entry.nodeArgs, entry.entry]
    const child = spawn(this.execPath, args, {
      cwd: this.cwd,
      env: this.#buildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#child = child
    this.startedAt = Date.now()
    this.#partials = { stdout: '', stderr: '' }
    this.#openLog()
    if (this.webDist !== undefined && !existsSync(this.webDist)) {
      this.#writeLog('desktop', `warning: web dist not found at ${this.webDist}, starting without SRE_AGENT_WEB_DIST`)
    }
    this.#writeLog('desktop', `spawned pid=${child.pid} mode=${entry.mode} cmd=${this.execPath} ${args.join(' ')}`)
    this.#setState('starting', { pid: child.pid, mode: entry.mode })

    child.stdout.on('data', (chunk) => {
      this.#consume('stdout', chunk)
    })
    child.stderr.on('data', (chunk) => {
      this.#consume('stderr', chunk)
    })
    child.on('error', (error) => {
      this.#writeLog('desktop', `spawn error: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      this.#onChildExit(code, signal)
    })

    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null
      this.#failStart(Object.assign(
        new Error(`@sre/server did not report "SRE_AGENT_READY" within ${this.readyTimeoutMs}ms`),
        { code: 'READY_TIMEOUT' },
      ), true)
    }, this.readyTimeoutMs)

    return await new Promise((resolvePromise, rejectPromise) => {
      this.#pendingStart = { resolve: resolvePromise, reject: rejectPromise }
    })
  }

  /**
   * SIGTERM, then SIGKILL after `shutdownTimeoutMs`. Safe to call repeatedly and
   * while a restart is pending; resolves once the child is gone.
   */
  async stop() {
    this.#clearRestartTimer()
    this.#clearHealthyTimer()
    if (hasExited(this.#child)) {
      this.#rejectPendingStart(new Error('@sre/server was stopped before it reported ready'))
      if (this.#readyTimer !== null) {
        clearTimeout(this.#readyTimer)
        this.#readyTimer = null
      }
      this.#setState('stopped')
      await this.#closeLog()
      this.#logClosed = null
      return this.getInfo()
    }

    this.#stoppedSettled = new Promise((resolvePromise) => {
      this.#resolveStopped = resolvePromise
    })
    this.#setState('stopping')
    await this.#terminateChild()
    // #onChildExit resolves the promise above; the race only guards against a
    // pathological child that reports no exit at all.
    await Promise.race([this.#stoppedSettled, delay(this.shutdownTimeoutMs + 1_000)])
    await this.#logClosed
    this.#logClosed = null
    this.#rejectPendingStart(new Error('@sre/server was stopped before it reported ready'))
    if (this.state !== 'stopped') this.#setState('stopped')
    return this.getInfo()
  }

  /** Manual restart: stop the current child, reset the crash budget, start again. */
  async restart() {
    await this.stop()
    return this.start()
  }

  /**
   * Synchronous SIGKILL, for `process.on('exit')` / `will-quit` where no async
   * work is possible. Returns true when a signal was delivered.
   */
  killSync() {
    const child = this.#child
    if (hasExited(child) || child.pid === undefined) return false
    try {
      process.kill(child.pid, 'SIGKILL')
      return true
    } catch {
      return false
    }
  }

  /** Detaches the process-exit guard; only needed when the host keeps running. */
  dispose() {
    if (this.#exitGuard !== null) {
      process.off('exit', this.#exitGuard)
      this.#exitGuard = null
    }
  }

  // -- internals ------------------------------------------------------------

  #buildEnv() {
    const env = {
      ...process.env,
      ...this.extraEnv,
      // Makes the Electron binary behave as plain Node; ignored by real node.
      ELECTRON_RUN_AS_NODE: '1',
      // Fixed contract values win over anything inherited from the host.
      SRE_AGENT_HOME: this.home,
      SRE_AGENT_HOST: this.host,
      SRE_AGENT_KERNEL: this.kernel,
    }
    if (this.port !== undefined) env.SRE_AGENT_PORT = String(this.port)
    if (this.webDist !== undefined && existsSync(this.webDist)) env.SRE_AGENT_WEB_DIST = this.webDist
    return env
  }

  #consume(stream, chunk) {
    const text = this.#partials[stream] + chunk.toString('utf8')
    const lines = text.split(/\r?\n/)
    this.#partials[stream] = lines.pop() ?? ''
    for (const line of lines) this.#handleLine(stream, line)
  }

  #handleLine(stream, rawLine) {
    const line = rawLine.trimEnd()
    if (line.length === 0) return
    this.#writeLog(stream, line)
    this.emit('log', { stream, line })

    const match = READY_PATTERN.exec(line)
    if (match === null || this.state !== 'starting') return
    this.#onReady(match[1], parseReadyExtras(match[2]))
  }

  #onReady(rawUrl, extras) {
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch {
      this.#failStart(Object.assign(
        new Error(`@sre/server printed an unparseable ready line: "${rawUrl}"`),
        { code: 'READY_URL_INVALID' },
      ), true)
      return
    }
    if (typeof extras.kernel === 'string' && extras.kernel.length > 0) this.kernel = extras.kernel

    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer)
      this.#readyTimer = null
    }
    const port = Number.parseInt(parsed.port, 10)
    this.port = Number.isInteger(port) ? port : parsed.protocol === 'https:' ? 443 : 80
    this.url = rawUrl
    this.startFailure = null
    this.#setState('ready', { url: this.url, port: this.port })

    // Refill the crash budget only after a genuinely healthy period, otherwise a
    // crash loop that reaches `ready` every time would restart forever.
    this.#clearHealthyTimer()
    this.#healthyTimer = setTimeout(() => {
      this.#healthyTimer = null
      this.restartAttempts = 0
    }, this.healthyUptimeMs)
    // Never let the budget refill keep an exiting host process alive.
    this.#healthyTimer.unref()

    const pending = this.#pendingStart
    this.#pendingStart = null
    pending?.resolve(this.getInfo())
  }

  #onChildExit(code, signal) {
    const wasStopping = this.state === 'stopping'
    this.#child = null
    this.startedAt = null
    this.#clearHealthyTimer()
    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer)
      this.#readyTimer = null
    }
    this.lastExit = { code, signal, at: Date.now() }
    this.#writeLog('desktop', `exited code=${code} signal=${signal}`)
    // stop() awaits this so that the log file is complete once a child is gone.
    this.#logClosed = this.#closeLog()

    if (wasStopping) {
      this.#setState('stopped', { code, signal })
      this.#resolveStopped?.()
      this.#resolveStopped = null
      return
    }
    if (this.#pendingStart !== null) {
      // Died before ever reporting ready: a start failure, not a crash.
      this.#failStart(new Error(`@sre/server exited before reporting ready (code=${code}, signal=${signal})`))
      return
    }
    if (this.state !== 'ready') return // failed/stopped/idle teardown, nothing to do

    this.#setState('crashed', { code, signal })
    if (this.restartAttempts >= this.maxRestarts) {
      this.startFailure = {
        message: `@sre/server crashed ${this.restartAttempts + 1} times, giving up`,
        code: 'RESTARTS_EXHAUSTED',
      }
      this.#setState('failed', { reason: 'restarts-exhausted', message: this.startFailure.message })
      return
    }
    this.restartAttempts += 1
    const backoffMs = this.restartBackoffMs * 2 ** (this.restartAttempts - 1)
    this.#setState('restarting', { attempt: this.restartAttempts, maxRestarts: this.maxRestarts, backoffMs })
    this.emit('restarting', { attempt: this.restartAttempts, delayMs: backoffMs })
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null
      this.#launch().catch((error) => {
        this.startFailure = { message: error.message, code: error.code ?? 'RESTART_FAILED' }
        this.#setState('failed', { reason: 'restart-failed', message: error.message })
      })
    }, backoffMs)
  }

  /**
   * Turns a failed start (timeout, early crash, bad ready line) into a terminal
   * `failed` state: the pending `start()` promise is rejected and the child, if
   * any, is torn down. No auto-restart here — failures to start are surfaced to
   * the user with an explicit retry instead of being retried silently.
   */
  #failStart(error, killChild = false) {
    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer)
      this.#readyTimer = null
    }
    this.#clearHealthyTimer()
    this.startFailure = { message: error.message, code: error.code ?? null }
    this.#setState('failed', { reason: error.code ?? 'start-failed', message: error.message })
    this.#rejectPendingStart(error)
    if (killChild && !hasExited(this.#child)) void this.#terminateChild()
  }

  async #terminateChild() {
    const child = this.#child
    if (hasExited(child)) return
    try {
      child.kill('SIGTERM')
    } catch {
      /* the process may have exited between the liveness check and the signal */
    }
    const deadline = Date.now() + this.shutdownTimeoutMs
    while (!hasExited(child) && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
    if (hasExited(child)) return
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    const hardDeadline = Date.now() + 2_000
    while (!hasExited(child) && Date.now() < hardDeadline) await delay(POLL_INTERVAL_MS)
  }

  #rejectPendingStart(error) {
    const pending = this.#pendingStart
    this.#pendingStart = null
    pending?.reject(error)
  }

  #clearRestartTimer() {
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = null
    }
  }

  #clearHealthyTimer() {
    if (this.#healthyTimer !== null) {
      clearTimeout(this.#healthyTimer)
      this.#healthyTimer = null
    }
  }

  #setState(state, extra = {}) {
    this.state = state
    this.emit('status', { state, pid: this.#child?.pid ?? null, ...extra })
  }

  #openLog() {
    mkdirSync(dirname(this.logFile), { recursive: true })
    const stream = createWriteStream(this.logFile, { flags: 'a' })
    // Logging must never take the app down.
    stream.on('error', () => {
      if (this.#logStream === stream) this.#logStream = null
    })
    this.#logStream = stream
  }

  #closeLog() {
    const stream = this.#logStream
    this.#logStream = null
    if (stream === null) return Promise.resolve()
    return new Promise((resolvePromise) => {
      stream.once('close', resolvePromise)
      stream.end()
    })
  }

  /** Mirrors a line into the in-memory ring buffer, the log file and listeners. */
  #writeLog(stream, line) {
    const entry = `${new Date().toISOString()} [${stream}] ${line}`
    this.logRing.push(entry)
    if (this.logRing.length > LOG_RING_LIMIT) this.logRing.splice(0, this.logRing.length - LOG_RING_LIMIT)
    this.#logStream?.write(`${entry}\n`)
  }
}
