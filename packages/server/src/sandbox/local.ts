import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import type { AppConfig } from '../config.ts'
import {
  type SandboxAvailability,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxHandle,
  type SandboxHandleSummary,
  type SandboxProvider,
} from './types.ts'

/**
 * The host machine as a "sandbox". This is the pre-existing behaviour (Mac mini
 * form): agent commands run on the platform host. It exists so the rest of the
 * platform has exactly one execution seam — nothing above the provider knows
 * whether a real sandbox backend is configured or not.
 */
export class LocalSandboxProvider implements SandboxProvider {
  readonly id = 'local' as const
  readonly displayName = '宿主本机（无沙箱隔离）'
  readonly idleTtlMs = Number.POSITIVE_INFINITY

  private readonly config: AppConfig

  constructor(config: AppConfig) {
    this.config = config
  }

  async availability(): Promise<SandboxAvailability> {
    return { ok: true, detail: `命令在本机执行（workspace=${this.config.workspace}）` }
  }

  async get(sessionId: string): Promise<SandboxHandle> {
    void sessionId
    return new LocalHandle(this.config.workspace)
  }

  async release(): Promise<void> {}

  async releaseAll(): Promise<void> {}

  async sweep(): Promise<string[]> {
    return []
  }

  summaries(): SandboxHandleSummary[] {
    return []
  }

  describe(): Record<string, unknown> {
    return { workspace: this.config.workspace }
  }
}

class LocalHandle implements SandboxHandle {
  readonly sandboxId = 'host'
  readonly provider = 'local' as const
  readonly createdAt = Date.now()
  lastUsedAt = Date.now()

  private readonly workspace: string

  constructor(workspace: string) {
    this.workspace = workspace
  }

  async exec(command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    this.lastUsedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? 60_000
    return new Promise((resolvePromise) => {
      execFile(
        'sh',
        ['-lc', command],
        {
          cwd: options.cwd ?? this.workspace,
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          killSignal: 'SIGKILL',
        },
        (error, stdout, stderr) => {
          const exitCode =
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === 'number'
                ? ((error as { code?: number }).code ?? 1)
                : 1
          resolvePromise({
            exitCode,
            stdout: String(stdout),
            stderr: String(stderr) + (error !== null && (error as { killed?: boolean }).killed === true ? `\n[killed after ${timeoutMs}ms timeout]` : ''),
          })
        },
      )
    })
  }

  async readFile(path: string): Promise<string> {
    this.lastUsedAt = Date.now()
    return readFile(path, 'utf8')
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.lastUsedAt = Date.now()
    const { dirname } = await import('node:path')
    mkdirSync(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }

  async cdpEndpoint(): Promise<string | undefined> {
    return undefined
  }

  async renew(): Promise<void> {
    this.lastUsedAt = Date.now()
  }

  async close(): Promise<void> {}
}
