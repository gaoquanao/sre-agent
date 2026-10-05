/**
 * Manual diagnostic for the dsh adapter. Not part of the test suite:
 * `node --experimental-strip-types packages/server/test/dsh-diagnose.ts`
 *
 * Boots the platform with the dsh kernel and the deterministic mock LLM, drives
 * one prompt, then dumps the raw dsh session log so failures inside the
 * subprocess are visible instead of guessed at.
 */
import { mkdtempSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { App } from '../src/app.ts'
import { resolveConfig } from '../src/config.ts'
import { createHttpServer } from '../src/http.ts'

const home = mkdtempSync(join(tmpdir(), 'sre-dsh-diag-'))
const tool = process.argv[2] ?? 'sre_shell'
const config = resolveConfig({
  home,
  kernel: 'dsh',
  port: 0,
  mockLlm: true,
  mockLlmTool: tool,
  mockLlmToolArguments: process.argv[3] ?? JSON.stringify({ command: 'echo diag-ok' }),
  mockLlmFinalText: 'mock-llm: diag done.',
})

const app = new App(config)
const server = await createHttpServer(app)
await server.listen({ host: '127.0.0.1', port: 0 })
config.port = (server.server.address() as AddressInfo).port
const base = `http://127.0.0.1:${config.port}`
console.log(`home=${home} port=${config.port} tool=${tool}`)

await app.start()
const session = await app.sessions.create({ title: 'diagnose' })
console.log(`session=${session.id}`)

await fetch(`${base}/api/sessions/${session.id}/prompt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '执行诊断' }),
})

await new Promise((resolve) => setTimeout(resolve, 12_000))

console.log('\n=== platform messages ===')
for (const message of app.store.listMessages(session.id)) {
  console.log(`[${message.role}] ok=${message.ok ?? '-'} ${message.text.slice(0, 400).replace(/\n/g, '\n    ')}`)
}
console.log('\n=== approvals ===')
console.log(JSON.stringify(app.store.listApprovals({ limit: 10 }), null, 2))
console.log('\n=== audit ===')
for (const entry of app.store.listAudit(20)) console.log(`${entry.action} ${entry.subject}`)

console.log('\n=== dsh session log (raw) ===')
const root = join(home, 'kernels', 'dsh', 'sessions')
if (existsSync(root)) {
  for (const project of readdirSync(root)) {
    const projectPath = join(root, project)
    if (!statSync(projectPath).isDirectory()) continue
    console.log(`project dir: ${project}`)
    for (const sessionDir of readdirSync(projectPath)) {
      const dir = join(projectPath, sessionDir)
      for (const file of readdirSync(dir)) {
        console.log(`  file: ${file} (${statSync(join(dir, file)).size} bytes)`)
        if (file.endsWith('.jsonl')) {
          for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
            if (line.trim().length > 0) console.log(`    ${line.slice(0, 500)}`)
          }
        }
      }
    }
  }
} else {
  console.log('(no session files)')
}

await server.close()
await app.stop()
