import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import type { WebSocket } from 'ws'
import {
  jsonSchemaToDshParameters,
  type ClientMessage,
  type KernelId,
  type PermissionPreset,
  type PermissionRule,
  type ProviderSpec,
  type RunbookSpec,
  type ScheduleSpec,
  type ServerMessage,
  type SkillSpec,
} from '@sre/protocol'
import { VERSION, type App, type Hub } from './app.ts'
import { evaluateToolCall } from './kernels/verdict.ts'

/** Fan-out of platform events to every connected browser. */
class WsHub implements Hub {
  private readonly sockets = new Set<WebSocket>()

  add(socket: WebSocket): void {
    this.sockets.add(socket)
  }

  remove(socket: WebSocket): void {
    this.sockets.delete(socket)
  }

  broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message)
    for (const socket of this.sockets) {
      try {
        socket.send(payload)
      } catch {
        this.sockets.delete(socket)
      }
    }
  }
}

export async function createHttpServer(app: App): Promise<FastifyInstance> {
  const server = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 })
  await server.register(cors, { origin: true })
  await server.register(websocket)
  const hub = new WsHub()
  app.setHub(hub)

  // Platform logs also go to the browser, bounded by the logger's ring buffer.
  app.log.addSink((entry) => {
    hub.broadcast({ type: 'log', level: entry.level === 'debug' ? 'info' : entry.level, scope: entry.scope, text: entry.text })
  })

  if (app.config.webDist !== undefined && existsSync(join(app.config.webDist, 'index.html'))) {
    await server.register(fastifyStatic, { root: app.config.webDist, prefix: '/' })
    server.setNotFoundHandler((request, reply) => {
      if (isApiPath(request.url)) {
        void reply.code(404).send({ error: 'not-found', detail: request.url })
        return
      }
      void reply.sendFile('index.html')
    })
  }

  // -- helpers -------------------------------------------------------------
  const ok = (reply: FastifyReply, value: unknown): FastifyReply => reply.send(value ?? { ok: true })
  const fail = (reply: FastifyReply, error: unknown, code = 500): FastifyReply => {
    const message = error instanceof Error ? error.message : String(error)
    app.log.warn(`http error: ${message}`)
    return reply.code(code).send({ error: message })
  }
  const requireBody = <T>(request: FastifyRequest): T => (request.body ?? {}) as T

  // -- platform ------------------------------------------------------------
  server.get('/api/health', async () => ({
    ok: true,
    version: VERSION,
    kernel: app.registry.activeId(),
    uptimeSec: Math.round(process.uptime()),
  }))

  server.get('/api/bootstrap', async () => ({
    ...app.bootstrap(),
    kernels: await app.registry.infos(VERSION),
  }))

  server.get('/api/logs', async (request) => {
    const limit = clampInt((request.query as { limit?: string }).limit, 200, 1, 1000)
    return app.log.history().slice(-limit)
  })

  // -- kernels -------------------------------------------------------------
  server.get('/api/kernels', async () => app.registry.infos(VERSION))

  server.post('/api/kernels/:id/start', async (request, reply) => {
    const id = (request.params as { id: string }).id as KernelId
    try {
      await app.registry.start(id)
      return ok(reply, await app.registry.infos(VERSION))
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.post('/api/kernels/:id/stop', async (request, reply) => {
    const id = (request.params as { id: string }).id as KernelId
    try {
      await app.registry.stop(id)
      return ok(reply, await app.registry.infos(VERSION))
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.post('/api/kernels/select', async (request, reply) => {
    const body = requireBody<{ kernel?: KernelId }>(request)
    if (body.kernel !== 'pi' && body.kernel !== 'dsh') {
      return reply.code(400).send({ error: 'kernel must be "pi" or "dsh"' })
    }
    try {
      await app.registry.switchTo(body.kernel)
      app.scheduler.stop()
      app.scheduler.start()
      for (const session of app.sessions.list(50)) {
        try {
          await app.sessions.reopen(session)
        } catch (error) {
          app.log.warn(`reopening session ${session.id} in ${body.kernel} failed: ${String(error)}`)
        }
      }
      return ok(reply, await app.registry.infos(VERSION))
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.post('/api/kernels/resync', async (_request, reply) => {
    try {
      return ok(reply, await app.resyncKernel())
    } catch (error) {
      return fail(reply, error)
    }
  })

  // -- sessions ------------------------------------------------------------
  server.get('/api/sessions', async () => app.sessions.list(200))

  server.post('/api/sessions', async (request, reply) => {
    const body = requireBody<{
      title?: string
      cwd?: string
      model?: { provider: string; model: string }
      origin?: 'chat'
    }>(request)
    try {
      return ok(
        reply,
        await app.sessions.create({
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.cwd === undefined ? {} : { cwd: body.cwd }),
          ...(body.model === undefined ? {} : { model: body.model }),
          origin: body.origin ?? 'chat',
        }),
      )
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.get('/api/sessions/:id', async (request, reply) => {
    const session = app.sessions.get((request.params as { id: string }).id)
    if (session === undefined) return reply.code(404).send({ error: 'unknown session' })
    return session
  })

  server.get('/api/sessions/:id/messages', async (request, reply) => {
    const id = (request.params as { id: string }).id
    if (app.sessions.get(id) === undefined) return reply.code(404).send({ error: 'unknown session' })
    return app.sessions.messages(id)
  })

  server.delete('/api/sessions/:id', async (request, reply) => {
    try {
      await app.sessions.delete((request.params as { id: string }).id)
      return { ok: true }
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.post('/api/sessions/:id/prompt', async (request, reply) => {
    const id = (request.params as { id: string }).id
    const body = requireBody<{ text?: string }>(request)
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return reply.code(400).send({ error: 'text is required' })
    }
    try {
      // Kernel turns run longer than the HTTP request; acknowledge immediately
      // and stream progress over the websocket.
      void app.sessions.prompt(id, body.text).catch((error) => {
        app.log.error(`prompt on ${id} failed`, error)
        hub.broadcast({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
      return { ok: true }
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.post('/api/sessions/:id/abort', async (request, reply) => {
    try {
      await app.sessions.abort((request.params as { id: string }).id)
      return { ok: true }
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.post('/api/sessions/:id/model', async (request, reply) => {
    const body = requireBody<{ provider?: string; model?: string }>(request)
    if (typeof body.provider !== 'string' || typeof body.model !== 'string') {
      return reply.code(400).send({ error: 'provider and model are required' })
    }
    try {
      await app.sessions.setModel((request.params as { id: string }).id, {
        provider: body.provider,
        model: body.model,
      })
      return { ok: true }
    } catch (error) {
      return fail(reply, error)
    }
  })

  // -- approvals / audit ---------------------------------------------------
  server.get('/api/approvals', async (request) => {
    const status = (request.query as { status?: string }).status
    return status === 'pending' ? app.approvals.pending() : app.approvals.listRecent(200)
  })

  server.post('/api/approvals/:id/decide', async (request, reply) => {
    const body = requireBody<{ decision?: string; reason?: string; answer?: string }>(request)
    const decision = body.decision
    if (decision !== 'allowed-once' && decision !== 'allowed-session' && decision !== 'denied') {
      return reply.code(400).send({ error: 'decision must be allowed-once, allowed-session or denied' })
    }
    const existing = app.approvals.get((request.params as { id: string }).id)
    // `ask_user` approvals carry the operator's structured answer in the
    // decision reason: it is the only field the kernel-facing result exposes.
    const reason =
      existing?.toolName === 'ask_user' && typeof body.answer === 'string' && body.answer.trim().length > 0
        ? body.answer.trim()
        : body.reason
    const record = app.approvals.decide(
      (request.params as { id: string }).id,
      decision,
      'operator',
      reason,
    )
    if (record === undefined) return reply.code(404).send({ error: 'unknown approval' })
    return record
  })

  server.get('/api/audit', async (request) => {
    const limit = clampInt((request.query as { limit?: string }).limit, 200, 1, 2000)
    return app.store.listAudit(limit)
  })

  // -- skills --------------------------------------------------------------
  server.get('/api/skills', async () => app.store.listSkills())

  server.put('/api/skills/:name', async (request, reply) => {
    const name = (request.params as { name: string }).name
    const body = requireBody<Partial<SkillSpec>>(request)
    if (typeof body.description !== 'string' || typeof body.body !== 'string') {
      return reply.code(400).send({ error: 'description and body are required' })
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      return reply.code(400).send({ error: 'skill name must be kebab-case (a-z, 0-9, dashes) and <= 64 chars' })
    }
    try {
      await app.saveSkill({
        name,
        description: body.description,
        body: body.body,
        enabled: body.enabled ?? true,
        source: 'platform',
        updatedAt: Date.now(),
      })
      return app.store.listSkills()
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.delete('/api/skills/:name', async (request, reply) => {
    try {
      await app.deleteSkill((request.params as { name: string }).name)
      return { ok: true }
    } catch (error) {
      return fail(reply, error)
    }
  })

  // -- mcp -----------------------------------------------------------------
  server.get('/api/mcp', async () => app.store.listMcpServers())

  server.put('/api/mcp/:name', async (request, reply) => {
    const name = (request.params as { name: string }).name
    const body = requireBody<Record<string, unknown>>(request)
    const transport = body.transport === 'http' ? 'http' : 'stdio'
    if (transport === 'stdio' && typeof body.command !== 'string') {
      return reply.code(400).send({ error: 'stdio servers need a command' })
    }
    if (transport === 'http' && typeof body.url !== 'string') {
      return reply.code(400).send({ error: 'http servers need a url' })
    }
    try {
      await app.saveMcpServer({
        name,
        transport,
        enabled: body.enabled !== false,
        ...(typeof body.command === 'string' ? { command: body.command } : {}),
        ...(Array.isArray(body.args) ? { args: body.args.map((entry) => String(entry)) } : {}),
        ...(isRecord(body.env) ? { env: body.env as Record<string, string> } : {}),
        ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
        ...(typeof body.url === 'string' ? { url: body.url } : {}),
        ...(isRecord(body.headers) ? { headers: body.headers as Record<string, string> } : {}),
        ...(typeof body.timeoutSec === 'number' ? { timeoutSec: body.timeoutSec } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
      })
      return app.store.listMcpServers()
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.delete('/api/mcp/:name', async (request, reply) => {
    try {
      await app.deleteMcpServer((request.params as { name: string }).name)
      return { ok: true }
    } catch (error) {
      return fail(reply, error)
    }
  })

  // -- providers -----------------------------------------------------------
  server.get('/api/providers', async () => app.store.listProviders())

  server.put('/api/providers/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id
    const body = requireBody<Partial<ProviderSpec>>(request)
    if (typeof body.baseUrl !== 'string' || !Array.isArray(body.models)) {
      return reply.code(400).send({ error: 'baseUrl and models are required' })
    }
    try {
      await app.saveProvider({
        id,
        name: typeof body.name === 'string' ? body.name : id,
        api: body.api ?? 'openai-completions',
        baseUrl: body.baseUrl,
        enabled: body.enabled !== false,
        models: body.models.map((model) => ({
          id: String(model.id),
          ...(model.name === undefined ? {} : { name: String(model.name) }),
          ...(model.contextWindow === undefined ? {} : { contextWindow: Number(model.contextWindow) }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: Number(model.maxTokens) }),
          ...(model.reasoning === undefined ? {} : { reasoning: Boolean(model.reasoning) }),
        })),
        ...(typeof body.apiKeyEnv === 'string' && body.apiKeyEnv.length > 0 ? { apiKeyEnv: body.apiKeyEnv } : {}),
        ...(typeof body.apiKey === 'string' && body.apiKey.length > 0 ? { apiKey: body.apiKey } : {}),
      })
      return app.store.listProviders()
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.delete('/api/providers/:id', async (request, reply) => {
    try {
      await app.deleteProvider((request.params as { id: string }).id)
      return { ok: true }
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.post('/api/providers/:id/default', async (request, reply) => {
    const id = (request.params as { id: string }).id
    const provider = app.store.listProviders().find((entry) => entry.id === id)
    const model = provider?.models[0]
    if (provider === undefined || model === undefined) {
      return reply.code(404).send({ error: 'provider has no models to default to' })
    }
    app.store.setSetting('models.default', { provider: id, model: model.id })
    return { ok: true, defaultModel: { provider: id, model: model.id } }
  })

  // -- permissions ---------------------------------------------------------
  server.get('/api/permissions', async () => app.permissionSnapshot())

  server.put('/api/permissions/preset', async (request, reply) => {
    const body = requireBody<{ preset?: PermissionPreset }>(request)
    const preset = body.preset
    if (preset !== 'read-only' && preset !== 'workspace-write' && preset !== 'full-access') {
      return reply.code(400).send({ error: 'preset must be read-only, workspace-write or full-access' })
    }
    app.setPermissionPreset(preset)
    return app.permissionSnapshot()
  })

  server.put('/api/permissions/rules/:id', async (request, reply) => {
    const body = requireBody<Partial<PermissionRule>>(request)
    if (body.effect !== 'allow' && body.effect !== 'ask' && body.effect !== 'deny') {
      return reply.code(400).send({ error: 'effect must be allow, ask or deny' })
    }
    try {
      app.savePermissionRule({
        id: (request.params as { id: string }).id,
        priority: typeof body.priority === 'number' ? body.priority : 100,
        enabled: body.enabled !== false,
        effect: body.effect,
        ...(body.tool === undefined ? {} : { tool: body.tool }),
        ...(body.risk === undefined ? {} : { risk: body.risk }),
        ...(body.origins === undefined ? {} : { origins: body.origins }),
        ...(body.description === undefined ? {} : { description: body.description }),
      })
      return app.permissionSnapshot()
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.delete('/api/permissions/rules/:id', async (request, reply) => {
    app.deletePermissionRule((request.params as { id: string }).id)
    return app.permissionSnapshot()
  })

  // -- knowledge base ------------------------------------------------------
  server.get('/api/kb/docs', async () => app.kb.listDocs())

  server.post('/api/kb/docs', async (request, reply) => {
    const body = requireBody<{ title?: string; source?: string; tags?: string[]; mime?: string; text?: string }>(
      request,
    )
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return reply.code(400).send({ error: 'text is required' })
    }
    try {
      return app.kb.ingest({
        source: body.source ?? `pasted-${Date.now()}`,
        text: body.text,
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.tags === undefined ? {} : { tags: body.tags }),
        ...(body.mime === undefined ? {} : { mime: body.mime }),
      })
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.delete('/api/kb/docs/:id', async (request, reply) => {
    app.kb.deleteDoc((request.params as { id: string }).id)
    return { ok: true }
  })

  server.post('/api/kb/search', async (request, reply) => {
    const body = requireBody<{ query?: string; topK?: number; tags?: string[] }>(request)
    if (typeof body.query !== 'string' || body.query.trim().length === 0) {
      return reply.code(400).send({ error: 'query is required' })
    }
    try {
      return await app.kb.search(body.query, {
        ...(body.topK === undefined ? {} : { topK: body.topK }),
        ...(body.tags === undefined ? {} : { tags: body.tags }),
      })
    } catch (error) {
      return fail(reply, error)
    }
  })

  // -- runbooks / schedules / runs ----------------------------------------
  server.get('/api/runbooks', async () => app.store.listRunbooks())

  server.put('/api/runbooks/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id
    const body = requireBody<Partial<RunbookSpec>>(request)
    if (typeof body.name !== 'string' || typeof body.prompt !== 'string') {
      return reply.code(400).send({ error: 'name and prompt are required' })
    }
    const runbook: RunbookSpec = {
      id,
      name: body.name,
      description: body.description ?? '',
      prompt: body.prompt,
      checks: Array.isArray(body.checks) ? body.checks : [],
      allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools.map((tool) => String(tool)) : [],
      enabled: body.enabled !== false,
      updatedAt: Date.now(),
      ...(body.model === undefined ? {} : { model: body.model }),
      ...(body.notify === undefined ? {} : { notify: body.notify }),
    }
    app.saveRunbook(runbook)
    return app.store.listRunbooks()
  })

  server.delete('/api/runbooks/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id
    app.deleteRunbook(id)
    for (const schedule of app.store.listSchedules().filter((entry) => entry.runbookId === id)) {
      app.deleteSchedule(schedule.id)
    }
    return { ok: true }
  })

  server.post('/api/runbooks/:id/run', async (request, reply) => {
    const id = (request.params as { id: string }).id
    if (app.store.getRunbook(id) === undefined) return reply.code(404).send({ error: 'unknown runbook' })
    try {
      const run = await app.runner.run(id, { trigger: 'manual' })
      return run
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.get('/api/schedules', async () => {
    const schedules = app.store.listSchedules()
    return schedules.map((schedule) => ({
      ...schedule,
      nextRunAt: app.scheduler.nextRunAt(schedule.id) ?? schedule.nextRunAt,
    }))
  })

  server.put('/api/schedules/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id
    const body = requireBody<Partial<ScheduleSpec>>(request)
    if (typeof body.cron !== 'string' || typeof body.runbookId !== 'string') {
      return reply.code(400).send({ error: 'cron and runbookId are required' })
    }
    if (app.store.getRunbook(body.runbookId) === undefined) {
      return reply.code(400).send({ error: `unknown runbook: ${body.runbookId}` })
    }
    const schedule: ScheduleSpec = {
      id,
      runbookId: body.runbookId,
      cron: body.cron,
      enabled: body.enabled !== false,
      ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
    }
    const result = app.saveSchedule(schedule)
    if (!result.ok) return reply.code(400).send({ error: result.detail })
    return { ...schedule, ...(result.nextRunAt === undefined ? {} : { nextRunAt: result.nextRunAt }) }
  })

  server.delete('/api/schedules/:id', async (request, reply) => {
    app.deleteSchedule((request.params as { id: string }).id)
    return { ok: true }
  })

  server.get('/api/runs', async (request) => {
    const query = request.query as { limit?: string; runbookId?: string }
    return app.store.listRuns(clampInt(query.limit, 50, 1, 500), query.runbookId)
  })

  // -- alerts --------------------------------------------------------------
  server.get('/api/alerts', async (request) => {
    const limit = clampInt((request.query as { limit?: string }).limit, 100, 1, 500)
    return app.store.listAlerts(limit)
  })

  server.post('/api/alerts', async (request, reply) => {
    const body = requireBody<Record<string, unknown>>(request)
    if (typeof body.name !== 'string' && typeof body.alertname !== 'string') {
      return reply.code(400).send({ error: 'name (or alertname) is required' })
    }
    try {
      const result = await app.ingestAlert({
        ...body,
        name: String(body.name ?? body.alertname),
      } as never)
      return { alert: app.store.listAlerts(1)[0], ...result }
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.post('/api/alerts/:id/triage', async (request, reply) => {
    const id = (request.params as { id: string }).id
    try {
      const sessionId = await app.triageAlert(id)
      if (sessionId === undefined) return reply.code(404).send({ error: 'unknown alert' })
      return { sessionId }
    } catch (error) {
      return fail(reply, error)
    }
  })

  // -- memory --------------------------------------------------------------
  server.get('/api/memory', async (request) => {
    const query = request.query as { limit?: string; kind?: string }
    return app.memory.list(clampInt(query.limit, 200, 1, 1000), query.kind as never)
  })

  server.post('/api/memory', async (request, reply) => {
    const body = requireBody<Record<string, unknown>>(request)
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return reply.code(400).send({ error: 'text is required' })
    }
    const kind = String(body.kind ?? 'fact')
    if (kind !== 'fact' && kind !== 'episode' && kind !== 'preference') {
      return reply.code(400).send({ error: 'kind must be fact, episode or preference' })
    }
    try {
      return app.memory.save({
        kind,
        subject: String(body.subject ?? 'global'),
        text: body.text,
        ...(Array.isArray(body.tags) ? { tags: body.tags.map((tag) => String(tag)) } : {}),
        ...(typeof body.importance === 'number' ? { importance: body.importance } : {}),
        source: 'operator',
      })
    } catch (error) {
      return fail(reply, error, 400)
    }
  })

  server.post('/api/memory/search', async (request, reply) => {
    const body = requireBody<{ query?: string; kind?: string; topK?: number }>(request)
    if (typeof body.query !== 'string' || body.query.trim().length === 0) {
      return reply.code(400).send({ error: 'query is required' })
    }
    return app.memory.search(body.query, {
      ...(body.kind === undefined ? {} : { kind: body.kind as never }),
      ...(body.topK === undefined ? {} : { topK: body.topK }),
    })
  })

  server.delete('/api/memory/:id', async (request) => {
    app.memory.delete((request.params as { id: string }).id)
    return { ok: true }
  })

  // -- workflows -----------------------------------------------------------
  server.get('/api/workflows', async () => app.store.listWorkflows())

  server.put('/api/workflows/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id
    const body = requireBody<Partial<import('@sre/protocol').WorkflowSpec>>(request)
    if (typeof body.name !== 'string' || !Array.isArray(body.steps)) {
      return reply.code(400).send({ error: 'name and steps are required' })
    }
    try {
      app.saveWorkflow({
        id,
        name: body.name,
        description: body.description ?? '',
        steps: body.steps,
        enabled: body.enabled !== false,
        updatedAt: Date.now(),
      })
      return app.store.listWorkflows()
    } catch (error) {
      return fail(reply, error, 400)
    }
  })

  server.delete('/api/workflows/:id', async (request) => {
    app.deleteWorkflow((request.params as { id: string }).id)
    return { ok: true }
  })

  server.post('/api/workflows/:id/run', async (request, reply) => {
    const id = (request.params as { id: string }).id
    if (app.store.getWorkflow(id) === undefined) return reply.code(404).send({ error: 'unknown workflow' })
    try {
      // Approval steps block this request until the operator answers.
      return await app.workflows.run(id, { trigger: 'manual' })
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.get('/api/workflow-runs', async (request) => {
    const query = request.query as { limit?: string; workflowId?: string }
    return app.store.listWorkflowRuns(clampInt(query.limit, 50, 1, 500), query.workflowId)
  })

  // -- defined agents ------------------------------------------------------
  server.get('/api/agents', async () => app.agents.list())

  server.put('/api/agents/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id
    const body = requireBody<Partial<import('@sre/protocol').AgentSpec>>(request)
    if (typeof body.name !== 'string' || typeof body.role !== 'string') {
      return reply.code(400).send({ error: 'name and role are required' })
    }
    const kind = body.kind === 'supervisor' ? 'supervisor' : 'worker'
    if (body.cron !== undefined && typeof body.cron !== 'string') {
      return reply.code(400).send({ error: 'cron must be a string' })
    }
    try {
      const saved = app.saveAgent({
        id,
        name: body.name,
        role: body.role,
        kind,
        allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools.map((tool) => String(tool)) : [],
        enabled: body.enabled !== false,
        updatedAt: Date.now(),
        ...(body.cron === undefined || body.cron.length === 0 ? {} : { cron: body.cron }),
        ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
        ...(body.alertMatchers === undefined ? {} : { alertMatchers: body.alertMatchers }),
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.workflowId === undefined ? {} : { workflowId: body.workflowId }),
        ...(body.runbookId === undefined ? {} : { runbookId: body.runbookId }),
        ...(body.escalation === undefined ? {} : { escalation: body.escalation }),
        ...(body.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: body.maxRuntimeMs }),
      })
      return saved
    } catch (error) {
      return fail(reply, error, 400)
    }
  })

  server.delete('/api/agents/:id', async (request) => {
    app.deleteAgent((request.params as { id: string }).id)
    return { ok: true }
  })

  server.post('/api/agents/:id/run', async (request, reply) => {
    const id = (request.params as { id: string }).id
    if (app.agents.get(id) === undefined) return reply.code(404).send({ error: 'unknown agent' })
    try {
      return await app.agents.run(id, { trigger: 'manual' })
    } catch (error) {
      return fail(reply, error)
    }
  })

  server.get('/api/agent-runs', async (request) => {
    const query = request.query as { limit?: string; agentId?: string }
    return app.agents.listRuns(clampInt(query.limit, 50, 1, 500), query.agentId)
  })

  // -- sandbox provider ----------------------------------------------------
  server.get('/api/sandbox', async () => ({
    provider: app.sandboxes.id,
    displayName: app.sandboxes.displayName,
    availability: await app.sandboxes.availability(),
    describe: app.sandboxes.describe(),
    handles: app.sandboxes.summaries(),
  }))

  // -- CLI tools -----------------------------------------------------------
  server.get('/api/clis', async () => app.cli.probe())

  server.post('/api/clis/:name/install', async (request, reply) => {
    const name = (request.params as { name: string }).name
    try {
      const result = await app.cli.install(name)
      if (!result.ok) return reply.code(400).send({ ok: false, log: result.log })
      return result
    } catch (error) {
      return fail(reply, error)
    }
  })

  // -- credential vault ----------------------------------------------------
  server.get('/api/credentials', async () => app.vault.list())

  server.put('/api/credentials/:ref', async (request, reply) => {
    const ref = (request.params as { ref: string }).ref
    const body = requireBody<Record<string, unknown>>(request)
    const kind = String(body.kind ?? '')
    try {
      if (kind === 'oauth') {
        if (typeof body.token !== 'string' || body.token.length === 0) {
          return reply.code(400).send({ error: 'token is required' })
        }
        app.vault.put(ref, {
          kind: 'oauth',
          token: body.token,
          ...(typeof body.refreshToken === 'string' && body.refreshToken.length > 0 ? { refreshToken: body.refreshToken } : {}),
          ...(typeof body.expiresAt === 'number' ? { expiresAt: body.expiresAt } : {}),
          ...(typeof body.account === 'string' ? { account: body.account } : {}),
        })
      } else if (kind === 'api-key') {
        if (typeof body.apiKey !== 'string' || body.apiKey.length === 0) {
          return reply.code(400).send({ error: 'apiKey is required' })
        }
        app.vault.put(ref, { kind: 'api-key', apiKey: body.apiKey })
      } else if (kind === 'env-json') {
        if (body.env === undefined || typeof body.env !== 'object' || Array.isArray(body.env)) {
          return reply.code(400).send({ error: 'env must be an object of strings' })
        }
        const env: Record<string, string> = {}
        for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
          if (typeof value === 'string') env[key] = value
        }
        if (Object.keys(env).length === 0) return reply.code(400).send({ error: 'env has no string values' })
        app.vault.put(ref, { kind: 'env-json', env })
      } else {
        return reply.code(400).send({ error: 'kind must be oauth, api-key or env-json' })
      }
      app.store.audit({ actor: 'operator', action: 'credential.save', subject: ref, detail: { kind } })
      return app.vault.list()
    } catch (error) {
      return fail(reply, error, 400)
    }
  })

  server.delete('/api/credentials/:ref', async (request) => {
    const ref = (request.params as { ref: string }).ref
    app.vault.delete(ref)
    app.store.audit({ actor: 'operator', action: 'credential.delete', subject: ref })
    return { ok: true }
  })

  server.post('/api/credentials/import', async (request, reply) => {
    const body = requireBody<{ kernel?: string }>(request)
    const kernel = body.kernel
    if (kernel !== 'claude-code' && kernel !== 'codex' && kernel !== 'qoder') {
      return reply.code(400).send({ error: 'kernel must be claude-code, codex or qoder' })
    }
    try {
      const result = app.vault.importFromLocalCli(kernel)
      app.store.audit({ actor: 'operator', action: 'credential.import', subject: kernel, detail: result })
      return result
    } catch (error) {
      return fail(reply, error)
    }
  })

  // -- websocket -----------------------------------------------------------
  server.get('/ws', { websocket: true }, (socket, request) => {
    hub.add(socket)
    socket.send(JSON.stringify({ type: 'hello', kernel: app.registry.activeId(), serverTime: Date.now() }))
    app.log.debug(`ws client connected from ${request.ip}`)
    socket.on('message', (raw: Buffer | string) => {
      let message: ClientMessage
      try {
        message = JSON.parse(String(raw)) as ClientMessage
      } catch {
        return
      }
      void handleClientMessage(app, socket, message)
    })
    socket.on('close', () => hub.remove(socket))
    socket.on('error', () => hub.remove(socket))
  })

  // -- internal (called by the dsh bridge plugin over loopback) -----------
  const internalAuth = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const header = request.headers.authorization ?? ''
    if (header !== `Bearer ${app.config.internalToken}`) {
      void reply.code(401).send({ error: 'unauthorized' })
      return false
    }
    return true
  }

  server.get('/internal/kernel-tools', async (request, reply) => {
    if (!internalAuth(request, reply)) return reply
    const kernel = (request.query as { kernel?: string }).kernel ?? 'dsh'
    return {
      kernel,
      tools: app.tools.list().map((spec) => ({
        name: spec.name,
        description: spec.description,
        // The MCP bridge and future kernels speak plain JSON Schema; dsh takes
        // its own property-map DSL, translated here so the plugin stays free of
        // schema logic.
        parameters: kernel === 'mcp' ? spec.parameters : jsonSchemaToDshParameters(spec.parameters),
        annotations: spec.annotations,
      })),
    }
  })

  server.post('/internal/tool-verdict', async (request, reply) => {
    if (!internalAuth(request, reply)) return reply
    const body = requireBody<{
      toolName?: string
      sessionId?: string
      callId?: string
      args?: unknown
    }>(request)
    const toolName = String(body.toolName ?? '')
    const sessionId = String(body.sessionId ?? '')
    if (toolName.length === 0) return reply.code(400).send({ error: 'toolName is required' })
    app.log.debug(`bridge verdict request: ${toolName} session=${sessionId || 'unknown'}`)

    const verdict = await evaluateToolCall(
      {
        permissions: app.permissions,
        approvals: app.approvals,
        log: app.log,
        sessionScope: (id) => app.sessionScope(id) ?? { origin: 'chat' },
      },
      {
        sessionId: sessionId.length === 0 ? 'unknown' : sessionId,
        kernel: 'dsh',
        toolName,
        args: body.args,
        origin: app.sessionScope(sessionId)?.origin ?? 'chat',
        ...(app.tools.annotationsOf(toolName) === undefined
          ? {}
          : { annotations: app.tools.annotationsOf(toolName) }),
        ...(app.tools.permittedOriginsOf(toolName) === undefined
          ? {}
          : { permittedOrigins: app.tools.permittedOriginsOf(toolName) }),
      },
    )
    return verdict.effect === 'allow' ? { kind: 'allow' } : { kind: 'deny', reason: verdict.reason }
  })

  server.post('/internal/tools/execute', async (request, reply) => {
    if (!internalAuth(request, reply)) return reply
    const body = requireBody<{ name?: string; callId?: string; args?: unknown; sessionId?: string }>(request)
    const name = String(body.name ?? '')
    const sessionId = String(body.sessionId ?? '')
    const scope = app.sessionScope(sessionId)
    app.log.debug(`bridge tool execution: ${name} session=${sessionId || 'unknown'}`)
    const result = await app.tools.execute(name, (body.args ?? {}) as Record<string, unknown>, {
      sessionId: sessionId.length === 0 ? 'unknown' : sessionId,
      origin: scope?.origin ?? 'chat',
      ...(body.callId === undefined ? {} : { callId: body.callId }),
    })
    if (result.images !== undefined && result.images.length > 0) {
      // dsh tool output cannot carry raw image blocks back to its model, so the
      // platform persists them as artifacts and names the paths; the MCP bridge
      // path returns images inline and does not depend on this.
      const dir = join(app.config.home, 'artifacts')
      mkdirSync(dir, { recursive: true })
      const saved: string[] = []
      for (const [index, image] of result.images.entries()) {
        const file = join(dir, `${Date.now()}-${name}-${index}.${image.mimeType.split('/')[1] ?? 'png'}`)
        writeFileSync(file, Buffer.from(image.base64, 'base64'))
        saved.push(file)
      }
      result.content = `${result.content}\n[images saved: ${saved.join(', ')}]`
      result.detail = { ...((result.detail ?? {}) as Record<string, unknown>), images: saved }
    }
    return result
  })

  server.post('/internal/events', async (request, reply) => {
    if (!internalAuth(request, reply)) return reply
    const body = requireBody<{ batch?: unknown[] }>(request)
    for (const item of body.batch ?? []) {
      const record = item as { kind?: string; sessionId?: string; text?: string; agentId?: string; event?: unknown }
      const sessionId = record.sessionId ?? record.agentId
      if (record.kind === 'assistant-delta' && typeof record.text === 'string' && sessionId !== undefined) {
        app.emit(sessionId, { type: 'assistant_delta', text: record.text })
      } else if (record.kind === 'reasoning-delta' && typeof record.text === 'string' && sessionId !== undefined) {
        app.emit(sessionId, { type: 'reasoning_delta', text: record.text })
      }
    }
    return { ok: true, received: (body.batch ?? []).length }
  })

  server.post('/internal/model-override', async (request, reply) => {
    if (!internalAuth(request, reply)) return reply
    const body = requireBody<{ sessionId?: string; current?: { provider?: string; model?: string } }>(request)
    const sessionId = String(body.sessionId ?? '')
    const override = app.modelOverride(sessionId) ?? app.sessions.get(sessionId)?.model
    if (override === undefined) return {}
    return { config: { provider: override.provider, model: override.model } }
  })

  return server
}

async function handleClientMessage(app: App, socket: WebSocket, message: ClientMessage): Promise<void> {
  try {
    switch (message.type) {
      case 'ping':
        socket.send(JSON.stringify({ type: 'log', level: 'info', scope: 'ws', text: 'pong' }))
        return
      case 'prompt':
        await app.sessions.prompt(message.sessionId, message.text)
        return
      case 'abort':
        await app.sessions.abort(message.sessionId)
        return
      case 'approval_decide': {
        const existing = app.approvals.get(message.approvalId)
        const reason =
          existing?.toolName === 'ask_user' && typeof message.answer === 'string' && message.answer.trim().length > 0
            ? message.answer.trim()
            : message.reason
        const record = app.approvals.decide(message.approvalId, message.decision, 'operator', reason)
        if (record === undefined) {
          socket.send(JSON.stringify({ type: 'error', message: `unknown approval ${message.approvalId}` }))
        }
        return
      }
      default:
        return
    }
  } catch (error) {
    socket.send(
      JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
  }
}

function isApiPath(url: string): boolean {
  return url.startsWith('/api') || url.startsWith('/internal') || url.startsWith('/ws')
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isInteger(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

function isRecord(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
