#!/usr/bin/env node
/**
 * Test double for @sre/server, used by smoke.mjs.
 *
 * Selected with FAKE_MODE:
 *   ready          (default) log a boot banner, print the ready line, stay alive
 *   silent         stay alive without ever printing the ready line
 *   http           serve real HTTP on an ephemeral port (or SRE_AGENT_PORT) and
 *                  print the ready line with the port it actually bound
 *   crash-once     print the ready line, crash 150ms later — first run only,
 *                  a marker file makes every later run stay alive
 *   crash-always   print the ready line, crash 100ms later, every run
 *   ignore-sigterm print the ready line, then ignore SIGTERM (forces SIGKILL)
 *
 * FAKE_MARKER: path used by `crash-once` to remember it already crashed once.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const mode = process.env.FAKE_MODE ?? 'ready'
const readyLine = 'SRE_AGENT_READY http://127.0.0.1:1'

function log(line) {
  process.stdout.write(`${line}\n`)
}

function fail(reason) {
  process.stderr.write(`fake-server: ${reason}\n`)
}

process.on('SIGTERM', () => {
  if (mode === 'ignore-sigterm') {
    fail('ignoring SIGTERM')
    return
  }
  // Exit through the handler (code 0, signal null) to prove the parent used
  // SIGTERM and the child shut down gracefully.
  process.stderr.write('fake-server: SIGTERM received, shutting down\n', () => {
    process.exit(0)
  })
  setTimeout(() => {
    process.exit(0)
  }, 200).unref()
})

if (mode === 'silent') {
  // No output at all: the parent must fall back to its ready timeout.
  setInterval(() => {}, 1_000)
} else if (mode === 'http') {
  const desired = Number.parseInt(process.env.SRE_AGENT_PORT ?? '', 10)
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/plain')
    response.end('fake-sre-agent-web\n')
  })
  server.listen(Number.isInteger(desired) ? desired : 0, '127.0.0.1', () => {
    const address = server.address()
    log(`fake-server: http listening on port ${address.port}`)
    log(`SRE_AGENT_READY http://127.0.0.1:${address.port}`)
  })
} else {
  log(
    `fake-server: mode=${mode} home=${process.env.SRE_AGENT_HOME} host=${process.env.SRE_AGENT_HOST}` +
      ` kernel=${process.env.SRE_AGENT_KERNEL} env_port=${process.env.SRE_AGENT_PORT ?? 'unset'}` +
      ` web_dist=${process.env.SRE_AGENT_WEB_DIST ?? 'unset'}` +
      ` electron_run_as_node=${process.env.ELECTRON_RUN_AS_NODE}`,
  )
  fail('fake-server: booting')
  log(readyLine)

  if (mode === 'crash-once') {
    const marker = process.env.FAKE_MARKER ?? ''
    if (marker === '' || existsSync(marker)) {
      setInterval(() => {}, 1_000)
    } else {
      writeFileSync(marker, 'crashed once\n')
      setTimeout(() => {
        fail('crashing after ready (first run)')
        process.exit(7)
      }, 150)
    }
  } else if (mode === 'crash-always') {
    setTimeout(() => {
      fail('crashing after ready')
      process.exit(7)
    }, 100)
  } else {
    setInterval(() => {}, 1_000)
  }
}
