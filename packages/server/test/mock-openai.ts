import { createServer, type Server } from 'node:http'

/**
 * A minimal OpenAI-compatible chat-completions endpoint that streams SSE.
 *
 * Turn 1 asks for one tool call; once a `role: "tool"` message is present in the
 * request it streams the final text and stops. That is enough to drive both
 * kernels through a complete tool round trip with no provider account.
 */
export interface MockOpenAiOptions {
  toolName?: string
  toolArguments?: string
  finalText?: string
  /** Stream the final text in this many chunks (exercises delta handling). */
  textChunks?: number
  /** Bind a fixed port instead of an ephemeral one. */
  port?: number
}

export interface MockOpenAi {
  baseUrl: string
  port: number
  requests: Record<string, unknown>[]
  toolCallCount: () => number
  close: () => Promise<void>
}

export async function startMockOpenAi(options: MockOpenAiOptions = {}): Promise<MockOpenAi> {
  const toolName = options.toolName ?? 'sre_shell'
  const toolArguments = options.toolArguments ?? '{"command":"echo mock-llm-pipeline-ok"}'
  const finalText = options.finalText ?? 'mock-llm: 工具调用已闭环，巡检结论已生成。'
  const textChunks = Math.max(1, options.textChunks ?? 3)
  const requests: Record<string, unknown>[] = []
  let toolCalls = 0

  const server: Server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      if (request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
      return
    }

    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      const payload = JSON.parse(body) as { model?: string; messages?: { role?: string }[] }
      requests.push(payload)
      const alreadyCalledTool = (payload.messages ?? []).some((message) => message.role === 'tool')

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: `chatcmpl-mock-${requests.length}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: payload.model ?? 'mock-model',
      }
      const send = (frame: Record<string, unknown>): void => {
        response.write(`data: ${JSON.stringify(frame)}\n\n`)
      }
      const usage = { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }

      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })

      if (!alreadyCalledTool && toolName.length > 0) {
        toolCalls += 1
        const callId = `call_mock_${toolCalls}`
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: toolName, arguments: '' } }],
              },
              finish_reason: null,
            },
          ],
        })
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: toolArguments } }] },
              finish_reason: null,
            },
          ],
        })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage })
      } else {
        const size = Math.max(1, Math.ceil(finalText.length / textChunks))
        for (let index = 0; index < finalText.length; index += size) {
          send({
            ...base,
            choices: [
              { index: 0, delta: { content: finalText.slice(index, index + size) }, finish_reason: null },
            ],
          })
        }
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
      }

      response.write('data: [DONE]\n\n')
      response.end()
    })
  })

  await new Promise<void>((resolvePromise) => server.listen(options.port ?? 0, '127.0.0.1', resolvePromise))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server did not bind a port')

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    requests,
    toolCallCount: () => toolCalls,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.closeAllConnections?.()
        server.close(() => resolvePromise())
      }),
  }
}
