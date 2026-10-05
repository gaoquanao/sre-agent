import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { App, VERSION } from './app.ts'
import { resolveConfig } from './config.ts'
import { createHttpServer } from './http.ts'
import { describeError, Logger } from './log.ts'

/**
 * Platform entrypoint.
 *
 * Prints `SRE_AGENT_READY <url>` on stdout once the HTTP server accepts
 * connections — that line is the contract the desktop shell waits for.
 */
async function main(): Promise<void> {
  const config = resolveConfig()
  if (config.webDist === undefined) {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const candidate = join(repoRoot, 'packages', 'web', 'dist')
    if (existsSync(join(candidate, 'index.html'))) config.webDist = candidate
  }

  const log = new Logger('platform')
  log.info(`SRE Agent ${VERSION} starting (home=${config.home}, kernel=${config.kernel})`)

  const app = new App(config, log)
  await app.start()

  const server = await createHttpServer(app)
  await server.listen({ host: config.host, port: config.port })

  const url = `http://${config.host}:${config.port}`
  process.stdout.write(`SRE_AGENT_READY ${url} kernel=${app.registry.activeId()} home=${config.home}\n`)
  log.info(`listening on ${url}${config.webDist === undefined ? ' (api only, no web dist found)' : ''}`)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`received ${signal}, shutting down`)
    const timer = setTimeout(() => process.exit(1), 15_000)
    timer.unref?.()
    try {
      await server.close()
      await app.stop()
    } catch (error) {
      log.error('shutdown failed', error)
    }
    clearTimeout(timer)
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason))
  process.on('uncaughtException', (error) => log.error('uncaught exception', error))
}

main().catch((error) => {
  process.stderr.write(`SRE Agent failed to start: ${describeError(error)}\n`)
  process.exit(1)
})
