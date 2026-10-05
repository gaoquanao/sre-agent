import { Logger } from '../log.ts'
import type {
  SandboxAvailability,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxHandleSummary,
  SandboxProvider,
} from './types.ts'

/**
 * The slice of each remote SDK that our adapters actually touch. Both the real
 * SDKs (dynamically imported) and the test fakes are shaped into these, which
 * keeps the provider logic unit-testable without network or credentials.
 */
export interface RawRemoteSandbox {
  readonly sandboxId: string
  exec(command: string, options: SandboxExecOptions): Promise<SandboxExecResult>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  cdpEndpoint(): Promise<string | undefined>
  renew(): Promise<void>
  close(): Promise<void>
}

export type RemoteSdkFactory = () => Promise<unknown>

/**
 * Shared bookkeeping for remote backends: lazy per-session handles, idle TTL
 * reaping, and explicit release. Subclasses only translate one raw sandbox.
 */
export abstract class RemoteSandboxProviderBase implements SandboxProvider {
  abstract readonly id: 'opensandbox' | 'e2b'
  abstract readonly displayName: string
  readonly idleTtlMs: number

  protected readonly handles = new Map<string, { handle: SandboxHandle & { raw: RawRemoteSandbox }; raw: RawRemoteSandbox }>()

  protected readonly log: Logger

  constructor(idleTtlMs: number, log: Logger) {
    this.idleTtlMs = Math.max(60_000, idleTtlMs)
    this.log = log
  }

  abstract availability(): Promise<SandboxAvailability>
  protected abstract createRaw(sessionId: string): Promise<RawRemoteSandbox>
  protected abstract describeBackend(): Record<string, unknown>

  async get(sessionId: string): Promise<SandboxHandle> {
    const existing = this.handles.get(sessionId)
    if (existing !== undefined) {
      existing.handle.lastUsedAt = Date.now()
      return existing.handle
    }
    const raw = await this.createRaw(sessionId)
    const handle: SandboxHandle & { raw: RawRemoteSandbox } = {
      sandboxId: raw.sandboxId,
      provider: this.id,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      raw,
      exec: (command, options) => {
        handle.lastUsedAt = Date.now()
        return raw.exec(command, options ?? {})
      },
      readFile: (path) => {
        handle.lastUsedAt = Date.now()
        return raw.readFile(path)
      },
      writeFile: (path, content) => {
        handle.lastUsedAt = Date.now()
        return raw.writeFile(path, content)
      },
      cdpEndpoint: () => raw.cdpEndpoint(),
      renew: () => {
        handle.lastUsedAt = Date.now()
        return raw.renew()
      },
      close: () => raw.close(),
    }
    this.handles.set(sessionId, { handle, raw })
    this.log.info(`sandbox created: ${raw.sandboxId} (${this.id}) for session ${sessionId}`)
    return handle
  }

  async release(sessionId: string): Promise<void> {
    const entry = this.handles.get(sessionId)
    if (entry === undefined) return
    this.handles.delete(sessionId)
    try {
      await entry.raw.close()
      this.log.info(`sandbox released: ${entry.handle.sandboxId} (session ${sessionId})`)
    } catch (error) {
      this.log.warn(`sandbox release failed for session ${sessionId}: ${String(error)}`)
    }
  }

  async releaseAll(): Promise<void> {
    for (const sessionId of [...this.handles.keys()]) await this.release(sessionId)
  }

  async sweep(now: number): Promise<string[]> {
    const reaped: string[] = []
    for (const [sessionId, entry] of this.handles) {
      if (now - entry.handle.lastUsedAt < this.idleTtlMs) continue
      this.handles.delete(sessionId)
      try {
        await entry.raw.close()
        this.log.info(`sandbox reaped (idle): ${entry.handle.sandboxId} (session ${sessionId})`)
      } catch (error) {
        this.log.warn(`sandbox reap failed for session ${sessionId}: ${String(error)}`)
      }
      reaped.push(sessionId)
    }
    return reaped
  }

  summaries(): SandboxHandleSummary[] {
    return [...this.handles.entries()].map(([sessionId, entry]) => ({
      sessionId,
      sandboxId: entry.handle.sandboxId,
      provider: this.id,
      createdAt: entry.handle.createdAt,
      lastUsedAt: entry.handle.lastUsedAt,
    }))
  }

  describe(): Record<string, unknown> {
    return { ...this.describeBackend(), idleTtlMs: this.idleTtlMs, active: this.handles.size }
  }
}

export function executionToResult(execution: {
  logs?: { stdout?: { text?: string }[]; stderr?: { text?: string }[] }
  exitCode?: number | null
  error?: { message?: string } | string
}): SandboxExecResult {
  const join = (messages: { text?: string }[] | undefined): string =>
    (messages ?? [])
      .map((message) => message.text ?? '')
      .join('')
  const error = execution.error
  const stderr = join(execution.logs?.stderr)
  return {
    exitCode: execution.exitCode ?? null,
    stdout: join(execution.logs?.stdout),
    stderr: typeof error === 'string' ? `${stderr}\n${error}` : error?.message !== undefined ? `${stderr}\n${error.message}` : stderr,
  }
}
