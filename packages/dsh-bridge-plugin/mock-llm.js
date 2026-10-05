/**
 * Deterministic offline LlmAdapter for tests and first-run demos.
 *
 * Turn 1 emits one tool call for the configured tool; once an assistant tool-call
 * is already in the transcript it emits the configured final text and stops. This
 * lets the full dsh pipeline (agent loop -> tool/call -> tools/pre-execute ->
 * platform approval -> platform tool body -> tools/result) run with no network.
 */

import Schema from '@deepseek-ai/schemastery'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'sre-mock-llm'

export const inject = ['llm']

export const Config = Schema.object({
  provider: Schema.string().default('sre-mock'),
  model: Schema.string().default('mock-1'),
  /** Empty string = never call a tool, answer directly. */
  toolName: Schema.string().default('sre_http_probe'),
  toolArguments: Schema.string().default('{"url":"http://127.0.0.1:1/health"}'),
  finalText: Schema.string().default('mock-llm: tool round complete.'),
  /** Print module-resolution diagnostics to stderr (debugging the bridge). */
  debugResolve: Schema.boolean().default(false),
})

class MockAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = config
    this.calls = 0
  }

  async *stream(options) {
    this.calls += 1
    const alreadyCalledTool = options.messages.some(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool-call'),
    )

    if (this.config.toolName && !alreadyCalledTool) {
      const id = `mock-call-${this.calls}`
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id,
        name: this.config.toolName,
        argumentsDelta: this.config.toolArguments,
      }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: this.config.toolName, arguments: this.config.toolArguments },
      }
      yield { type: 'usage', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.config.finalText }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.config.finalText } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx, config) {
  if (config.debugResolve) {
    const report = {
      dshLlm: import.meta.resolve('@deepseek-ai/dsh-llm'),
      dshTools: import.meta.resolve('@deepseek-ai/dsh-tools'),
      baseHasPrepareCall: typeof LlmAdapter.prototype.prepareCall,
      baseHasProviderInfo: typeof LlmAdapter.prototype.providerInfo,
      instance: (() => {
        try {
          return typeof new MockAdapter(config).prepareCall
        } catch (error) {
          return `ctor failed: ${error?.message ?? error}`
        }
      })(),
    }
    process.stderr.write(`sre-agent mock-llm resolve: ${JSON.stringify(report)}\n`)
  }
  const handle = ctx.llm.registerAdapter([config.provider], new MockAdapter(config))
  ctx.effect(() => handle)
}

export default { name, inject, Config, apply }
