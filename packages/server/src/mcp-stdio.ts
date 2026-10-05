/**
 * MCP stdio bridge — exposes the platform's tool set to any MCP-capable kernel
 * (claude-code `--mcp-config`, codex `config.toml` mcp_servers, pi `mcp.json`).
 *
 * Protocol: newline-delimited JSON-RPC 2.0 over stdio (MCP stdio transport),
 * methods: initialize, tools/list, tools/call, ping. Tool calls are executed by
 * the platform over loopback HTTP and pass through the platform's permission
 * gate (tool-verdict) first, so CLI kernels get the same policy and approval
 * flow as the embedded kernels for platform tools.
 *
 * Usage (written by the platform into the kernel's MCP config):
 *   node packages/server/dist/mcp-stdio.js
 * Env: SRE_AGENT_URL, SRE_AGENT_HOME (token is derived from it),
 *      SRE_AGENT_INTERNAL_TOKEN (override), SRE_AGENT_SESSION_ID.
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

interface RpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string }
}

const url = process.env.SRE_AGENT_URL ?? `http://127.0.0.1:${process.env.SRE_AGENT_PORT ?? '8787'}`
const home = process.env.SRE_AGENT_HOME ?? ''
const sessionId = process.env.SRE_AGENT_SESSION_ID ?? ''
const token = process.env.SRE_AGENT_INTERNAL_TOKEN ?? deriveToken()

function deriveToken(): string {
  if (home.length === 0) return ''
  // Must stay in sync with config.deriveToken: sha256 of a stable home seed.
  // Importing the compiled config module would drag the whole app graph into
  // the bridge; the hash string is the contract between the two entrypoints.
  return createHash('sha256').update(`sre-agent:${home}:${homedir()}`).digest('hex').slice(0, 40)
}

function log(text: string): void {
  process.stderr.write(`[sre-mcp] ${text}\n`)
}

async function callPlatform<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`platform ${path} -> HTTP ${response.status}: ${body.slice(0, 300)}`)
  return (body.length === 0 ? {} : JSON.parse(body)) as T
}

interface PlatformToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

interface PlatformToolResult {
  ok: boolean
  content: string
  images?: { mimeType: string; base64: string }[]
  error?: string
}

function reply(message: RpcMessage, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
}

function replyError(message: RpcMessage, code: number, errorMessage: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code, message: errorMessage } })}\n`)
}

async function handle(message: RpcMessage): Promise<void> {
  if (typeof message.method !== 'string') return
  const isNotification = message.id === undefined || message.id === null

  switch (message.method) {
    case 'initialize':
      reply(message, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'sre-agent-platform', version: '0.1.0' },
      })
      return
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      if (!isNotification) reply(message, {})
      return
    case 'tools/list': {
      const payload = await callPlatform<{ tools: PlatformToolSpec[] }>('/internal/kernel-tools?kernel=mcp')
      reply(message, {
        tools: payload.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: { type: 'object', ...(tool.parameters as Record<string, unknown>) },
        })),
      })
      return
    }
    case 'tools/call': {
      const params = message.params ?? {}
      const name = String(params.name ?? '')
      const args = (params.arguments ?? {}) as Record<string, unknown>
      try {
        // The platform decides: preset/rules/unattended scope, and blocks here
        // for human approval when policy says ask. Fail closed on any error.
        const verdict = (await callPlatform<{ kind?: string; reason?: string }>('/internal/tool-verdict', {
          method: 'POST',
          body: JSON.stringify({ toolName: name, args, sessionId }),
        })) as { kind?: string; reason?: string }
        if (verdict.kind !== 'allow') {
          reply(message, {
            content: [{ type: 'text', text: `Tool ${name} denied by platform policy: ${verdict.reason ?? 'unknown reason'}` }],
            isError: true,
          })
          return
        }
        const result = await callPlatform<PlatformToolResult>('/internal/tools/execute', {
          method: 'POST',
          body: JSON.stringify({ name, args, sessionId }),
        })
        const content: Record<string, unknown>[] = []
        for (const image of result.images ?? []) {
          content.push({ type: 'image', data: image.base64, mimeType: image.mimeType })
        }
        content.push({ type: 'text', text: result.content })
        reply(message, { content, isError: result.ok !== true })
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        log(`tools/call ${name} failed: ${text}`)
        reply(message, { content: [{ type: 'text', text: `Tool ${name} failed: ${text}` }], isError: true })
      }
      return
    }
    default:
      if (!isNotification) replyError(message, -32601, `method not supported: ${message.method}`)
      return
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let message: RpcMessage
  try {
    message = JSON.parse(trimmed) as RpcMessage
  } catch {
    return
  }
  void handle(message).catch((error) => {
    const text = error instanceof Error ? error.message : String(error)
    log(`handler error: ${text}`)
    if (message.id !== undefined && message.id !== null) {
      replyError(message, -32603, text.slice(0, 300))
    }
  })
})
rl.on('close', () => {
  process.exit(0)
})
