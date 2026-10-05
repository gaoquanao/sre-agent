/**
 * Standalone OpenAI-compatible mock endpoint, so the platform can be driven
 * end to end without a provider account. Usage:
 *   node --experimental-strip-types packages/server/test/mock-openai-standalone.ts [port]
 */
import { startMockOpenAi } from './mock-openai.ts'

const port = Number.parseInt(process.argv[2] ?? '19100', 10)
const server = await startMockOpenAi({
  port,
  toolName: process.env.MOCK_TOOL ?? 'sre_shell',
  toolArguments: process.env.MOCK_TOOL_ARGS ?? JSON.stringify({ command: 'uptime && df -h /' }),
  finalText: process.env.MOCK_FINAL_TEXT ?? 'mock-llm: 已通过审批执行只读诊断，负载与磁盘水位正常。',
})

process.stdout.write(`MOCK_OPENAI_READY http://127.0.0.1:${server.port}/v1\n`)
process.on('SIGTERM', () => {
  void server.close().then(() => process.exit(0))
})
