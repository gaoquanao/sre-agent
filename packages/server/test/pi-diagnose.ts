/**
 * Manual diagnostic for the pi adapter. Not part of the test suite:
 *   node --experimental-strip-types packages/server/test/pi-diagnose.ts
 *
 * Boots the platform with the Pi kernel, drives one prompt, and prints every
 * kernel event plus the resulting transcript, so silent no-ops are visible.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { resolveConfig } from '../src/config.ts'
import { startMockOpenAi } from './mock-openai.ts'

const home = mkdtempSync(join(tmpdir(), 'sre-pi-diag-'))
const mock = await startMockOpenAi({
  toolName: process.argv[2] ?? 'kb_search',
  toolArguments: process.argv[3] ?? JSON.stringify({ query: 'diag' }),
  finalText: 'mock-llm: diag complete.',
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

const events: string[] = []
const originalEmit = app.emit.bind(app)
app.emit = (sessionId: string, event: Parameters<typeof originalEmit>[1]) => {
  events.push(`${event.type}${'text' in event ? `(${String(event.text).slice(0, 60)})` : ''}${'message' in event ? `(${event.message})` : ''}`)
  originalEmit(sessionId, event)
}

await app.start()
const session = await app.sessions.create({ title: 'pi diagnose' })
console.log(`home=${home} mock=${mock.baseUrl} session=${session.id}`)
console.log(`session.model=${JSON.stringify(session.model)}`)

await app.sessions.prompt(session.id, '执行诊断')
await new Promise((resolve) => setTimeout(resolve, 12_000))

console.log('\n=== kernel events ===')
console.log(events.join('\n') || '(none)')
console.log('\n=== messages ===')
for (const message of app.store.listMessages(session.id)) {
  console.log(`[${message.role}] ok=${message.ok ?? '-'} ${message.text.slice(0, 300).replace(/\n/g, ' ')}`)
}
console.log(`\n=== mock requests: ${mock.requests.length}, tool calls: ${mock.toolCallCount()} ===`)
await app.stop()
await mock.close()
