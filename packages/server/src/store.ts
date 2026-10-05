import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AgentRun,
  AgentSpec,
  ApprovalRecord,
  ApprovalStatus,
  AuditEntry,
  ChatMessage,
  KbDoc,
  McpServerSpec,
  MemoryItem,
  MessageRole,
  PermissionRule,
  ProviderSpec,
  RiskLevel,
  RunbookSpec,
  ScheduleSpec,
  SessionInfo,
  SkillSpec,
  ToolOrigin,
  WorkflowRun,
  WorkflowSpec,
  WorkflowStepResult,
} from '@sre/protocol'
import { fromBool, parseJson, toBool } from './db.ts'

export interface CredentialRow {
  ref: string
  kind: 'oauth' | 'api-key' | 'env-json'
  enc: Buffer
  iv: Buffer
  tag: Buffer
  hasRefresh: boolean
  updatedAt: number
}

export class Store {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  // -- settings ------------------------------------------------------------
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row === undefined ? fallback : parseJson<T>(row.value, fallback)
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  // -- sessions ------------------------------------------------------------
  insertSession(session: SessionInfo, allowedTools?: string[]): void {
    this.db
      .prepare(
        `INSERT INTO sessions(id, kernel, kernel_session_id, title, model_provider, model, cwd, origin, status,
            parent_session_id, runbook_id, alert_id, allowed_tools, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.kernel,
        session.kernelSessionId ?? null,
        session.title,
        session.model?.provider ?? null,
        session.model?.model ?? null,
        session.cwd,
        session.origin,
        session.status,
        session.parentSessionId ?? null,
        session.runbookId ?? null,
        session.alertId ?? null,
        allowedTools === undefined ? null : JSON.stringify(allowedTools),
        session.createdAt,
        session.updatedAt,
      )
  }

  updateSession(
    id: string,
    patch: Partial<Pick<SessionInfo, 'title' | 'status' | 'kernelSessionId' | 'model'>> & { updatedAt?: number },
  ): void {
    const sets: string[] = []
    const values: unknown[] = []
    if (patch.title !== undefined) {
      sets.push('title = ?')
      values.push(patch.title)
    }
    if (patch.status !== undefined) {
      sets.push('status = ?')
      values.push(patch.status)
    }
    if (patch.kernelSessionId !== undefined) {
      sets.push('kernel_session_id = ?')
      values.push(patch.kernelSessionId)
    }
    if (patch.model !== undefined) {
      sets.push('model_provider = ?', 'model = ?')
      values.push(patch.model.provider, patch.model.model)
    }
    sets.push('updated_at = ?')
    values.push(patch.updatedAt ?? Date.now())
    values.push(id)
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...(values as never[]))
  }

  getSession(id: string): SessionInfo | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : mapSession(row)
  }

  listSessions(options: { limit?: number; origin?: ToolOrigin; kernel?: string } = {}): SessionInfo[] {
    const clauses: string[] = []
    const values: unknown[] = []
    if (options.origin !== undefined) {
      clauses.push('origin = ?')
      values.push(options.origin)
    }
    if (options.kernel !== undefined) {
      clauses.push('kernel = ?')
      values.push(options.kernel)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    values.push(options.limit ?? 100)
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s${where} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...(values as never[])) as Row[]
    return rows.map(mapSession)
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  getSessionAllowedTools(id: string): string[] | undefined {
    const row = this.db.prepare('SELECT allowed_tools FROM sessions WHERE id = ?').get(id) as
      | { allowed_tools: string | null }
      | undefined
    if (row === undefined || row.allowed_tools === null) return undefined
    return parseJson<string[]>(row.allowed_tools, [])
  }

  // -- messages ------------------------------------------------------------
  appendMessage(message: Omit<ChatMessage, 'id'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO messages(session_id, role, text, tool_name, call_id, ok, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.sessionId,
        message.role,
        message.text,
        message.toolName ?? null,
        message.callId ?? null,
        message.ok === undefined ? null : fromBool(message.ok),
        message.createdAt,
      )
    return Number(result.lastInsertRowid)
  }

  listMessages(sessionId: string, limit = 500): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?')
      .all(sessionId, limit) as Row[]
    return rows.map((row) => ({
      id: Number(row.id),
      sessionId: String(row.session_id),
      role: String(row.role) as MessageRole,
      text: String(row.text),
      toolName: row.tool_name === null ? undefined : String(row.tool_name),
      callId: row.call_id === null ? undefined : String(row.call_id),
      ok: row.ok === null ? undefined : toBool(row.ok),
      createdAt: Number(row.created_at),
    }))
  }

  // -- approvals -----------------------------------------------------------
  insertApproval(record: ApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO approvals(id, session_id, kernel, tool_name, args, risk, reason, origin, status,
            requested_at, expires_at, decided_at, decided_by, decision_reason)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.kernel,
        record.toolName,
        JSON.stringify(record.args ?? null),
        record.risk,
        record.reason,
        record.origin,
        record.status,
        record.requestedAt,
        record.expiresAt,
        record.decidedAt ?? null,
        record.decidedBy ?? null,
        record.decisionReason ?? null,
      )
  }

  updateApproval(
    id: string,
    patch: { status: ApprovalStatus; decidedAt?: number; decidedBy?: string; decisionReason?: string },
  ): void {
    this.db
      .prepare(
        'UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ?',
      )
      .run(patch.status, patch.decidedAt ?? null, patch.decidedBy ?? null, patch.decisionReason ?? null, id)
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : mapApproval(row)
  }

  listApprovals(options: { status?: ApprovalStatus; limit?: number; sessionId?: string } = {}): ApprovalRecord[] {
    const clauses: string[] = []
    const values: unknown[] = []
    if (options.status !== undefined) {
      clauses.push('status = ?')
      values.push(options.status)
    }
    if (options.sessionId !== undefined) {
      clauses.push('session_id = ?')
      values.push(options.sessionId)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    values.push(options.limit ?? 100)
    const rows = this.db
      .prepare(`SELECT * FROM approvals${where} ORDER BY requested_at DESC LIMIT ?`)
      .all(...(values as never[])) as Row[]
    return rows.map(mapApproval)
  }

  /** Expire pending approvals whose deadline passed; returns the affected ids. */
  expireApprovals(now = Date.now()): string[] {
    const rows = this.db
      .prepare("SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= ?")
      .all(now) as { id: string }[]
    if (rows.length === 0) return []
    this.db
      .prepare(
        "UPDATE approvals SET status = 'expired', decided_at = ?, decision_reason = 'approval timed out' WHERE status = 'pending' AND expires_at <= ?",
      )
      .run(now, now)
    return rows.map((row) => row.id)
  }

  // -- audit ---------------------------------------------------------------
  audit(entry: Omit<AuditEntry, 'id' | 'ts'> & { ts?: number }): void {
    this.db
      .prepare('INSERT INTO audit(ts, actor, action, subject, detail) VALUES(?, ?, ?, ?, ?)')
      .run(
        entry.ts ?? Date.now(),
        entry.actor,
        entry.action,
        entry.subject,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      )
  }

  listAudit(limit = 200): AuditEntry[] {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as Row[]
    return rows.map((row) => ({
      id: Number(row.id),
      ts: Number(row.ts),
      actor: String(row.actor),
      action: String(row.action),
      subject: String(row.subject),
      detail: row.detail === null ? undefined : parseJson<unknown>(row.detail, undefined),
    }))
  }

  // -- skills --------------------------------------------------------------
  upsertSkill(skill: SkillSpec): void {
    this.db
      .prepare(
        `INSERT INTO skills(name, description, body, enabled, source, updated_at) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET description = excluded.description, body = excluded.body,
           enabled = excluded.enabled, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(skill.name, skill.description, skill.body, fromBool(skill.enabled), skill.source, skill.updatedAt)
  }

  listSkills(): SkillSpec[] {
    const rows = this.db.prepare('SELECT * FROM skills ORDER BY name ASC').all() as Row[]
    return rows.map((row) => ({
      name: String(row.name),
      description: String(row.description),
      body: String(row.body),
      enabled: toBool(row.enabled),
      source: String(row.source) as SkillSpec['source'],
      updatedAt: Number(row.updated_at),
    }))
  }

  deleteSkill(name: string): void {
    this.db.prepare('DELETE FROM skills WHERE name = ?').run(name)
  }

  // -- mcp -----------------------------------------------------------------
  upsertMcpServer(spec: McpServerSpec): void {
    this.db
      .prepare(
        `INSERT INTO mcp_servers(name, spec, enabled, updated_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET spec = excluded.spec, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(spec.name, JSON.stringify(spec), fromBool(spec.enabled), Date.now())
  }

  listMcpServers(): McpServerSpec[] {
    const rows = this.db.prepare('SELECT spec FROM mcp_servers ORDER BY name ASC').all() as Row[]
    return rows.map((row) => parseJson<McpServerSpec>(row.spec, { name: 'unknown', transport: 'stdio', enabled: false }))
  }

  deleteMcpServer(name: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE name = ?').run(name)
  }

  // -- providers -----------------------------------------------------------
  upsertProvider(spec: ProviderSpec): void {
    this.db
      .prepare(
        `INSERT INTO providers(id, spec, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at`,
      )
      .run(spec.id, JSON.stringify(spec), Date.now())
  }

  listProviders(): ProviderSpec[] {
    const rows = this.db.prepare('SELECT spec FROM providers ORDER BY id ASC').all() as Row[]
    return rows.map((row) => parseJson<ProviderSpec>(row.spec, { id: 'unknown', name: 'unknown', api: 'openai-completions', baseUrl: '', models: [], enabled: false }))
  }

  deleteProvider(id: string): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id)
  }

  // -- permission rules ----------------------------------------------------
  upsertPermissionRule(rule: PermissionRule): void {
    this.db
      .prepare(
        `INSERT INTO permission_rules(id, priority, enabled, tool, risk, origins, effect, description)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET priority = excluded.priority, enabled = excluded.enabled, tool = excluded.tool,
           risk = excluded.risk, origins = excluded.origins, effect = excluded.effect, description = excluded.description`,
      )
      .run(
        rule.id,
        rule.priority,
        fromBool(rule.enabled),
        rule.tool ?? null,
        rule.risk ?? null,
        rule.origins === undefined ? null : JSON.stringify(rule.origins),
        rule.effect,
        rule.description ?? null,
      )
  }

  listPermissionRules(): PermissionRule[] {
    const rows = this.db.prepare('SELECT * FROM permission_rules ORDER BY priority ASC').all() as Row[]
    return rows.map((row) => ({
      id: String(row.id),
      priority: Number(row.priority),
      enabled: toBool(row.enabled),
      tool: row.tool === null ? undefined : String(row.tool),
      risk: row.risk === null ? undefined : (String(row.risk) as RiskLevel),
      origins: row.origins === null ? undefined : parseJson<ToolOrigin[]>(row.origins, []),
      effect: String(row.effect) as PermissionRule['effect'],
      description: row.description === null ? undefined : String(row.description),
    }))
  }

  deletePermissionRule(id: string): void {
    this.db.prepare('DELETE FROM permission_rules WHERE id = ?').run(id)
  }

  // -- runbooks / schedules / runs ----------------------------------------
  upsertRunbook(spec: RunbookSpec): void {
    this.db
      .prepare(
        `INSERT INTO runbooks(id, spec, enabled, updated_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET spec = excluded.spec, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(spec.id, JSON.stringify(spec), fromBool(spec.enabled), spec.updatedAt)
  }

  listRunbooks(): RunbookSpec[] {
    const rows = this.db.prepare('SELECT spec FROM runbooks ORDER BY id ASC').all() as Row[]
    return rows.map((row) => parseJson<RunbookSpec>(row.spec, emptyRunbook()))
  }

  getRunbook(id: string): RunbookSpec | undefined {
    const row = this.db.prepare('SELECT spec FROM runbooks WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : parseJson<RunbookSpec>(row.spec, emptyRunbook())
  }

  deleteRunbook(id: string): void {
    this.db.prepare('DELETE FROM runbooks WHERE id = ?').run(id)
  }

  upsertSchedule(spec: ScheduleSpec): void {
    this.db
      .prepare(
        `INSERT INTO schedules(id, runbook_id, cron, timezone, enabled, last_run_at, next_run_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET runbook_id = excluded.runbook_id, cron = excluded.cron,
           timezone = excluded.timezone, enabled = excluded.enabled, next_run_at = excluded.next_run_at`,
      )
      .run(
        spec.id,
        spec.runbookId,
        spec.cron,
        spec.timezone ?? null,
        fromBool(spec.enabled),
        spec.lastRunAt ?? null,
        spec.nextRunAt ?? null,
      )
  }

  listSchedules(): ScheduleSpec[] {
    const rows = this.db.prepare('SELECT * FROM schedules ORDER BY id ASC').all() as Row[]
    return rows.map((row) => ({
      id: String(row.id),
      runbookId: String(row.runbook_id),
      cron: String(row.cron),
      timezone: row.timezone === null ? undefined : String(row.timezone),
      enabled: toBool(row.enabled),
      lastRunAt: row.last_run_at === null ? undefined : Number(row.last_run_at),
      nextRunAt: row.next_run_at === null ? undefined : Number(row.next_run_at),
    }))
  }

  deleteSchedule(id: string): void {
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id)
  }

  markScheduleRun(id: string, at: number, next: number | undefined): void {
    this.db
      .prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?')
      .run(at, next ?? null, id)
  }

  insertRun(run: { id: string; runbookId: string; sessionId?: string; status: string; startedAt: number }): void {
    this.db
      .prepare(
        'INSERT INTO runs(id, runbook_id, session_id, status, started_at, findings) VALUES(?, ?, ?, ?, ?, ?)',
      )
      .run(run.id, run.runbookId, run.sessionId ?? null, run.status, run.startedAt, '[]')
  }

  finishRun(
    id: string,
    patch: { status: string; finishedAt: number; report?: string; findings?: unknown; error?: string },
  ): void {
    this.db
      .prepare('UPDATE runs SET status = ?, finished_at = ?, report = ?, findings = ?, error = ? WHERE id = ?')
      .run(
        patch.status,
        patch.finishedAt,
        patch.report ?? null,
        JSON.stringify(patch.findings ?? []),
        patch.error ?? null,
        id,
      )
  }

  listRuns(limit = 50, runbookId?: string): RunRow[] {
    const rows =
      runbookId === undefined
        ? (this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit) as Row[])
        : (this.db
            .prepare('SELECT * FROM runs WHERE runbook_id = ? ORDER BY started_at DESC LIMIT ?')
            .all(runbookId, limit) as Row[])
    return rows.map((row) => ({
      id: String(row.id),
      runbookId: String(row.runbook_id),
      sessionId: row.session_id === null ? undefined : String(row.session_id),
      status: String(row.status) as RunRow['status'],
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at === null ? undefined : Number(row.finished_at),
      report: row.report === null ? undefined : String(row.report),
      findings: parseJson<unknown[]>(row.findings, []),
      error: row.error === null ? undefined : String(row.error),
    }))
  }

  // -- alerts --------------------------------------------------------------
  insertAlert(alert: {
    id: string
    fingerprint: string
    source: string
    name: string
    severity: string
    target?: string
    summary?: string
    labels: Record<string, string>
    status: string
    sessionId?: string
    receivedAt: number
    raw?: unknown
  }): void {
    this.db
      .prepare(
        `INSERT INTO alerts(id, fingerprint, source, name, severity, target, summary, labels, status, session_id, received_at, raw)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        alert.id,
        alert.fingerprint,
        alert.source,
        alert.name,
        alert.severity,
        alert.target ?? null,
        alert.summary ?? null,
        JSON.stringify(alert.labels),
        alert.status,
        alert.sessionId ?? null,
        alert.receivedAt,
        alert.raw === undefined ? null : JSON.stringify(alert.raw),
      )
  }

  listAlerts(limit = 100): AlertRow[] {
    const rows = this.db.prepare('SELECT * FROM alerts ORDER BY received_at DESC LIMIT ?').all(limit) as Row[]
    return rows.map(mapAlert)
  }

  findAlertByFingerprint(fingerprint: string): AlertRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM alerts WHERE fingerprint = ? ORDER BY received_at DESC LIMIT 1')
      .get(fingerprint) as Row | undefined
    return row === undefined ? undefined : mapAlert(row)
  }

  attachAlertSession(id: string, sessionId: string): void {
    this.db.prepare('UPDATE alerts SET session_id = ? WHERE id = ?').run(sessionId, id)
  }

  // -- knowledge -----------------------------------------------------------
  listKbDocs(): KbDoc[] {
    const rows = this.db.prepare('SELECT * FROM kb_docs ORDER BY created_at DESC').all() as Row[]
    return rows.map(mapKbDoc)
  }

  getKbDocByHash(hash: string): KbDoc | undefined {
    const row = this.db.prepare('SELECT * FROM kb_docs WHERE hash = ?').get(hash) as Row | undefined
    return row === undefined ? undefined : mapKbDoc(row)
  }

  deleteKbDoc(id: string): void {
    this.db.prepare('DELETE FROM kb_docs WHERE id = ?').run(id)
  }

  // -- memory --------------------------------------------------------------
  insertMemory(item: MemoryItem): void {
    this.db
      .prepare(
        `INSERT INTO memory(id, kind, subject, text, tags, importance, source, source_session_id, created_at, last_accessed_at, access_count)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.kind,
        item.subject,
        item.text,
        JSON.stringify(item.tags),
        item.importance,
        item.source,
        item.sourceSessionId ?? null,
        item.createdAt,
        item.lastAccessedAt,
        item.accessCount,
      )
  }

  listMemory(limit = 200, kind?: string): MemoryItem[] {
    const rows =
      kind === undefined
        ? (this.db.prepare('SELECT * FROM memory ORDER BY created_at DESC LIMIT ?').all(limit) as Row[])
        : (this.db
            .prepare('SELECT * FROM memory WHERE kind = ? ORDER BY created_at DESC LIMIT ?')
            .all(kind, limit) as Row[])
    return rows.map(mapMemory)
  }

  getMemory(id: string): MemoryItem | undefined {
    const row = this.db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : mapMemory(row)
  }

  deleteMemory(id: string): void {
    this.db.prepare('DELETE FROM memory WHERE id = ?').run(id)
  }

  touchMemory(ids: string[], now = Date.now()): void {
    const statement = this.db.prepare('UPDATE memory SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?')
    for (const id of ids) statement.run(now, id)
  }

  /** Full-text candidates (trigram FTS5, LIKE fallback for short queries). */
  searchMemoryRows(query: string, limit: number): { item: MemoryItem; score: number }[] {
    const terms = query
      .split(/[\s,，。；;、]+/)
      .map((term) => term.trim())
      .filter((term) => term.length > 0)
    const rows: Row[] = []
    const ftsQuery = terms
      .filter((term) => term.length >= 3)
      .map((term) => `"${term.replace(/"/g, '""')}"`)
      .join(' OR ')
    if (ftsQuery.length > 0) {
      try {
        rows.push(
          ...(this.db
            .prepare(
              `SELECT m.*, bm25(memory_fts) AS score FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
               WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?`,
            )
            .all(ftsQuery, limit) as Row[]),
        )
      } catch {
        // fall through to LIKE
      }
    }
    if (rows.length === 0 && terms.length > 0) {
      rows.push(
        ...(this.db
          .prepare('SELECT *, 0 AS score FROM memory WHERE text LIKE ? OR subject LIKE ? ORDER BY importance DESC, created_at DESC LIMIT ?')
          .all(`%${terms[0]}%`, `%${terms[0]}%`, limit) as Row[]),
      )
    }
    return rows.map((row) => ({
      item: mapMemory(row),
      // bm25() is negative-is-better and unbounded, so map it through a sigmoid:
      // a linear inversion collapses every match onto the same floored score and
      // loses the ranking that makes full-text search useful.
      score: row.score === undefined ? 0.4 : 1 / (1 + Math.exp(Number(row.score) / 2)),
    }))
  }

  /** Least valuable memories first: low importance, old, rarely read. */
  weakMemories(limit: number): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory ORDER BY importance ASC, access_count ASC, last_accessed_at ASC LIMIT ?`,
      )
      .all(limit) as Row[]
    return rows.map(mapMemory)
  }

  countMemory(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM memory').get() as { n: number }
    return Number(row.n)
  }

  // -- workflows -----------------------------------------------------------
  upsertWorkflow(spec: WorkflowSpec): void {
    this.db
      .prepare(
        `INSERT INTO workflows(id, spec, enabled, updated_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET spec = excluded.spec, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(spec.id, JSON.stringify(spec), fromBool(spec.enabled), spec.updatedAt)
  }

  listWorkflows(): WorkflowSpec[] {
    const rows = this.db.prepare('SELECT spec FROM workflows ORDER BY id ASC').all() as Row[]
    return rows.map((row) => parseJson<WorkflowSpec>(row.spec, emptyWorkflow()))
  }

  getWorkflow(id: string): WorkflowSpec | undefined {
    const row = this.db.prepare('SELECT spec FROM workflows WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : parseJson<WorkflowSpec>(row.spec, emptyWorkflow())
  }

  deleteWorkflow(id: string): void {
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id)
  }

  insertWorkflowRun(run: { id: string; workflowId: string; sessionId?: string; trigger: string; startedAt: number }): void {
    this.db
      .prepare(
        'INSERT INTO workflow_runs(id, workflow_id, session_id, trigger, status, started_at, steps) VALUES(?, ?, ?, ?, ?, ?, ?)',
      )
      .run(run.id, run.workflowId, run.sessionId ?? null, run.trigger, 'running', run.startedAt, '[]')
  }

  finishWorkflowRun(
    id: string,
    patch: { status: string; finishedAt: number; steps: WorkflowStepResult[]; report?: string; error?: string },
  ): void {
    this.db
      .prepare('UPDATE workflow_runs SET status = ?, finished_at = ?, steps = ?, report = ?, error = ? WHERE id = ?')
      .run(patch.status, patch.finishedAt, JSON.stringify(patch.steps), patch.report ?? null, patch.error ?? null, id)
  }

  listWorkflowRuns(limit = 50, workflowId?: string): WorkflowRun[] {
    const rows =
      workflowId === undefined
        ? (this.db.prepare('SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?').all(limit) as Row[])
        : (this.db
            .prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?')
            .all(workflowId, limit) as Row[])
    return rows.map(mapWorkflowRun)
  }

  getWorkflowRun(id: string): WorkflowRun | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : mapWorkflowRun(row)
  }

  // -- defined agents ------------------------------------------------------
  upsertAgent(spec: AgentSpec): void {
    this.db
      .prepare(
        `INSERT INTO agents(id, spec, enabled, updated_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET spec = excluded.spec, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(spec.id, JSON.stringify(spec), fromBool(spec.enabled), spec.updatedAt)
  }

  listAgents(): AgentSpec[] {
    const rows = this.db.prepare('SELECT spec FROM agents ORDER BY id ASC').all() as Row[]
    return rows.map((row) => parseJson<AgentSpec>(row.spec, emptyAgent()))
  }

  getAgent(id: string): AgentSpec | undefined {
    const row = this.db.prepare('SELECT spec FROM agents WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : parseJson<AgentSpec>(row.spec, emptyAgent())
  }

  deleteAgent(id: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
  }

  insertAgentRun(run: { id: string; agentId: string; trigger: string; startedAt: number; alertId?: string }): void {
    this.db
      .prepare(
        'INSERT INTO agent_runs(id, agent_id, trigger, alert_id, status, started_at) VALUES(?, ?, ?, ?, ?, ?)',
      )
      .run(run.id, run.agentId, run.trigger, run.alertId ?? null, 'running', run.startedAt)
  }

  finishAgentRun(
    id: string,
    patch: {
      status: string
      finishedAt: number
      summary?: string
      error?: string
      sessionId?: string
      workflowRunId?: string
    },
  ): void {
    this.db
      .prepare(
        `UPDATE agent_runs SET status = ?, finished_at = ?, summary = ?, error = ?,
           session_id = COALESCE(?, session_id), workflow_run_id = COALESCE(?, workflow_run_id) WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.finishedAt,
        patch.summary ?? null,
        patch.error ?? null,
        patch.sessionId ?? null,
        patch.workflowRunId ?? null,
        id,
      )
  }

  listAgentRuns(limit = 50, agentId?: string): AgentRun[] {
    const rows =
      agentId === undefined
        ? (this.db.prepare('SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?').all(limit) as Row[])
        : (this.db
            .prepare('SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?')
            .all(agentId, limit) as Row[])
    return rows.map(mapAgentRun)
  }

  // -- credentials (ciphertext lives here; crypto lives in vault.ts) ------
  upsertCredential(row: CredentialRow): void {
    this.db
      .prepare(
        `INSERT INTO credentials(ref, kind, enc, iv, tag, has_refresh, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET kind = excluded.kind, enc = excluded.enc, iv = excluded.iv,
           tag = excluded.tag, has_refresh = excluded.has_refresh, updated_at = excluded.updated_at`,
      )
      .run(row.ref, row.kind, row.enc, row.iv, row.tag, fromBool(row.hasRefresh), row.updatedAt)
  }

  getCredential(ref: string): CredentialRow | undefined {
    const row = this.db.prepare('SELECT * FROM credentials WHERE ref = ?').get(ref) as Row | undefined
    return row === undefined ? undefined : mapCredential(row)
  }

  listCredentials(): CredentialRow[] {
    const rows = this.db.prepare('SELECT * FROM credentials ORDER BY ref ASC').all() as Row[]
    return rows.map(mapCredential)
  }

  deleteCredential(ref: string): void {
    this.db.prepare('DELETE FROM credentials WHERE ref = ?').run(ref)
  }

  newId(): string {
    return randomUUID()
  }
}

type Row = Record<string, unknown>

export interface RunRow {
  id: string
  runbookId: string
  sessionId?: string
  status: 'running' | 'ok' | 'warn' | 'fail' | 'error'
  startedAt: number
  finishedAt?: number
  report?: string
  findings: unknown[]
  error?: string
}

export interface AlertRow {
  id: string
  fingerprint: string
  source: string
  name: string
  severity: string
  target?: string
  summary?: string
  labels: Record<string, string>
  status: string
  sessionId?: string
  receivedAt: number
  raw?: unknown
}

function mapSession(row: Row): SessionInfo {
  return {
    id: String(row.id),
    kernel: String(row.kernel) as SessionInfo['kernel'],
    kernelSessionId: row.kernel_session_id === null ? undefined : String(row.kernel_session_id),
    title: String(row.title),
    model:
      row.model === null
        ? undefined
        : { provider: String(row.model_provider ?? ''), model: String(row.model) },
    cwd: String(row.cwd),
    origin: String(row.origin) as SessionInfo['origin'],
    status: String(row.status) as SessionInfo['status'],
    parentSessionId: row.parent_session_id === null || row.parent_session_id === undefined ? undefined : String(row.parent_session_id),
    runbookId: row.runbook_id === null ? undefined : String(row.runbook_id),
    alertId: row.alert_id === null ? undefined : String(row.alert_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messageCount: row.message_count === undefined ? 0 : Number(row.message_count),
  }
}

function mapApproval(row: Row): ApprovalRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    kernel: String(row.kernel) as ApprovalRecord['kernel'],
    toolName: String(row.tool_name),
    args: parseJson<unknown>(row.args, null),
    risk: String(row.risk) as ApprovalRecord['risk'],
    reason: String(row.reason),
    origin: String(row.origin) as ApprovalRecord['origin'],
    status: String(row.status) as ApprovalStatus,
    requestedAt: Number(row.requested_at),
    expiresAt: Number(row.expires_at),
    decidedAt: row.decided_at === null ? undefined : Number(row.decided_at),
    decidedBy: row.decided_by === null ? undefined : String(row.decided_by),
    decisionReason: row.decision_reason === null ? undefined : String(row.decision_reason),
  }
}

function mapAlert(row: Row): AlertRow {
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    source: String(row.source),
    name: String(row.name),
    severity: String(row.severity),
    target: row.target === null ? undefined : String(row.target),
    summary: row.summary === null ? undefined : String(row.summary),
    labels: parseJson<Record<string, string>>(row.labels, {}),
    status: String(row.status),
    sessionId: row.session_id === null ? undefined : String(row.session_id),
    receivedAt: Number(row.received_at),
    raw: row.raw === null ? undefined : parseJson<unknown>(row.raw, undefined),
  }
}

function mapKbDoc(row: Row): KbDoc {
  return {
    id: String(row.id),
    title: String(row.title),
    source: String(row.source),
    tags: parseJson<string[]>(row.tags, []),
    mime: String(row.mime),
    hash: String(row.hash),
    chunkCount: Number(row.chunk_count),
    createdAt: Number(row.created_at),
  }
}

function mapMemory(row: Row): MemoryItem {
  return {
    id: String(row.id),
    kind: String(row.kind) as MemoryItem['kind'],
    subject: String(row.subject),
    text: String(row.text),
    tags: parseJson<string[]>(row.tags, []),
    importance: Number(row.importance),
    source: String(row.source) as MemoryItem['source'],
    sourceSessionId: row.source_session_id === null ? undefined : String(row.source_session_id),
    createdAt: Number(row.created_at),
    lastAccessedAt: Number(row.last_accessed_at),
    accessCount: Number(row.access_count),
  }
}

function mapWorkflowRun(row: Row): WorkflowRun {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    sessionId: row.session_id === null ? undefined : String(row.session_id),
    trigger: String(row.trigger) as WorkflowRun['trigger'],
    status: String(row.status) as WorkflowRun['status'],
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? undefined : Number(row.finished_at),
    steps: parseJson<WorkflowStepResult[]>(row.steps, []),
    report: row.report === null ? undefined : String(row.report),
    error: row.error === null ? undefined : String(row.error),
  }
}

function mapAgentRun(row: Row): AgentRun {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    trigger: String(row.trigger) as AgentRun['trigger'],
    alertId: row.alert_id === null ? undefined : String(row.alert_id),
    sessionId: row.session_id === null ? undefined : String(row.session_id),
    workflowRunId: row.workflow_run_id === null ? undefined : String(row.workflow_run_id),
    status: String(row.status) as AgentRun['status'],
    summary: row.summary === null ? undefined : String(row.summary),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? undefined : Number(row.finished_at),
    error: row.error === null ? undefined : String(row.error),
  }
}

function emptyWorkflow(): WorkflowSpec {
  return { id: 'unknown', name: 'unknown', description: '', steps: [], enabled: false, updatedAt: 0 }
}

function emptyAgent(): AgentSpec {
  return { id: 'unknown', name: 'unknown', role: '', kind: 'worker', allowedTools: [], enabled: false, updatedAt: 0 }
}

function mapCredential(row: Row): CredentialRow {
  return {
    ref: String(row.ref),
    kind: String(row.kind) as CredentialRow['kind'],
    enc: row.enc as Buffer,
    iv: row.iv as Buffer,
    tag: row.tag as Buffer,
    hasRefresh: toBool(row.has_refresh),
    updatedAt: Number(row.updated_at),
  }
}

function emptyRunbook(): RunbookSpec {
  return {
    id: 'unknown',
    name: 'unknown',
    description: '',
    prompt: '',
    checks: [],
    allowedTools: [],
    enabled: false,
    updatedAt: 0,
  }
}
