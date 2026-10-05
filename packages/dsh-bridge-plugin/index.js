/**
 * SRE Agent <-> DeepSeek Harness bridge plugin.
 *
 * Loaded by the dsh runtime from the platform-generated profile. It owns four
 * responsibilities, all through officially supported extension points:
 *
 *   1. `ctx.tools.register`      — inject platform tools; execution is delegated
 *                                  back to the platform over loopback HTTP.
 *   2. `tools/pre-execute`       — the permission gate. Every tool call (platform
 *                                  or builtin or MCP) asks the platform for a
 *                                  verdict before it runs. Fail closed.
 *   3. `session/event` + `agent/assistant-stream` — relay durable and token-level
 *                                  activity to the platform so the web UI streams.
 *   4. `agent/request`           — per-session model override.
 *
 * Design notes that matter:
 * - The platform is the single policy authority. This plugin holds no policy of
 *   its own beyond a fail-closed default, so a platform outage cannot silently
 *   authorize anything.
 * - `tools/pre-execute` has no built-in deadline (verified against 0.2.0-rc.2),
 *   so the HTTP call here carries its own timeout and observes `exec.signal`.
 * - Named exports only. A default export makes the dsh loader drop `inject`.
 */

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'sre-agent-bridge'

/** Hard dependencies: the tool registry must exist before we register. */
export const inject = ['tools']

export const Config = Schema.object({
  /** Platform HTTP base, loopback only. */
  platformBase: Schema.string().default('http://127.0.0.1:8787'),
  /** Shared secret issued by the platform for this dsh profile. */
  token: Schema.string().default(''),
  /** Platform tools are named with this prefix and always gated. */
  platformToolPrefix: Schema.string().default('sre_'),
  /** Hard ceiling for one approval round trip (ms). */
  approvalTimeoutMs: Schema.number().default(600_000),
  /** Relay token-level assistant deltas (noisy but gives a live UI). */
  relayStreamFrames: Schema.boolean().default(true),
  /**
   * Relay durable `session/event` frames. Off by default: the sdk wire already
   * delivers the same events as `session.event` notifications, and relaying both
   * would duplicate every message in the platform.
   */
  relaySessionEvents: Schema.boolean().default(false),
  /** Ask the platform for a per-session model override on every LLM request. */
  enableModelOverride: Schema.boolean().default(true),
})

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}${path}`
}

export function apply(ctx, config) {
  const base = config.platformBase
  const headers = {
    'content-type': 'application/json',
    ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
  }

  const post = async (path, body, signal) => {
    const res = await fetch(joinUrl(base, path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
    return res.json()
  }

  // --- 3/4. event relay -----------------------------------------------------
  const pending = []
  let flushTimer = null
  const flush = () => {
    flushTimer = null
    if (pending.length === 0) return
    const batch = pending.splice(0, pending.length)
    post('/internal/events', { batch }).catch(() => {
      // Telemetry is best effort by design: never break the agent turn because
      // the platform is briefly unavailable.
    })
  }
  const enqueue = (item) => {
    pending.push(item)
    if (pending.length >= 64) {
      flush()
      return
    }
    if (flushTimer === null) flushTimer = setTimeout(flush, 40)
  }
  ctx.effect(() => () => {
    if (flushTimer !== null) clearTimeout(flushTimer)
    flush()
  })

  ctx.on('session/event', (session, event) => {
    if (!config.relaySessionEvents) return
    enqueue({ kind: 'session-event', sessionId: session?.id, event })
  })
  if (config.relayStreamFrames) {
    ctx.on('agent/assistant-stream', (payload) => {
      const frame = payload?.frame
      if (!frame) return
      if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') {
        enqueue({ kind: 'assistant-delta', agentId: agentKey(payload?.agent), text: frame.chunk.text })
      } else if (frame.type === 'chunk' && frame.chunk?.type === 'reasoning-delta') {
        enqueue({ kind: 'reasoning-delta', agentId: agentKey(payload?.agent), text: frame.chunk.text })
      }
    })
  }

  // --- 2. permission gate ---------------------------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = String(exec?.name ?? '')
    if (toolName.length === 0) return next()

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    exec.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), config.approvalTimeoutMs)
    try {
      const verdict = await post(
        '/internal/tool-verdict',
        {
          toolName,
          callId: exec.callId === undefined ? undefined : String(exec.callId),
          rootCallId: exec.rootCallId === undefined ? undefined : String(exec.rootCallId),
          args: exec.arguments,
          sessionId: agentKey(exec.agent),
        },
        controller.signal,
      )
      if (verdict?.kind === 'allow') return { kind: 'allow' }
      if (verdict?.kind === 'deny') return { kind: 'deny', reason: String(verdict.reason ?? 'denied by platform policy') }
      return { kind: 'deny', reason: 'platform returned an unknown verdict' }
    } catch (error) {
      // Fail closed: no verdict means no execution.
      const text = error instanceof Error ? error.message : String(error)
      return { kind: 'deny', reason: `platform unavailable, refusing to run ${toolName}: ${text}` }
    } finally {
      clearTimeout(timer)
      exec.signal?.removeEventListener('abort', onAbort)
    }
  })

  // --- 1. platform tools ---------------------------------------------------
  const registered = new Set()
  const registerPlatformTools = async () => {
    let specs = []
    try {
      const res = await fetch(joinUrl(base, '/internal/kernel-tools?kernel=dsh'), { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      specs = (await res.json())?.tools ?? []
    } catch (error) {
      ctx.logger?.warn?.(`sre-agent bridge: platform tools unavailable: ${error?.message ?? error}`)
      return
    }
    for (const spec of specs) {
      if (registered.has(spec.name)) continue
      try {
        const disposer = ctx.tools.register(defineTool({
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
          },
          async execute(args, exec) {
            const result = await post('/internal/tools/execute', {
              name: spec.name,
              callId: String(exec.callId),
              sessionId: agentKey(exec.agent),
              args,
            })
            if (!result?.ok) throw new Error(String(result?.content ?? 'platform tool failed'))
            return result.detail === undefined ? result.content : { content: result.content, detail: result.detail }
          },
        }))
        ctx.effect(() => disposer)
        registered.add(spec.name)
      } catch (error) {
        ctx.logger?.warn?.(`sre-agent bridge: cannot register ${spec.name}: ${error?.message ?? error}`)
      }
    }
  }
  void registerPlatformTools()

  // --- 4. per-session model override ---------------------------------------
  if (config.enableModelOverride) {
    ctx.on('agent/request', async (payload, next) => {
      const current = await next()
      const sessionId = agentKey(payload?.agent)
      if (!sessionId) return current
      try {
        const override = await post('/internal/model-override', { sessionId, current })
        if (!override?.config) return current
        return { ...current, ...override.config }
      } catch {
        return current
      }
    })
  }
}

function agentKey(agent) {
  if (!agent) return undefined
  return agent.session?.id ?? agent.sessionId ?? agent.id
}

function renderValue(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
