import { Logger } from '../log.ts'
import { RemoteSandboxProviderBase, executionToResult, type RawRemoteSandbox, type RemoteSdkFactory } from './remote.ts'
import type { SandboxAvailability, SandboxExecOptions } from './types.ts'

/**
 * Minimal shape of the `e2b` SDK surface we use (e2b >= 2.x). The real module
 * is dynamically imported and cast to this; tests inject a fake factory.
 * Alibaba Cloud Agent Sandbox Flash Edition is E2B-SDK compatible and reads
 * `E2B_API_KEY` / `E2B_API_URL` / `E2B_DOMAIN` from the environment, which the
 * SDK consumes natively — no extra configuration layer here.
 */
export interface E2BSandboxLike {
  sandboxId: string
  commands: {
    run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{
      exitCode: number
      stdout: string
      stderr: string
      error?: string
    }>
  }
  files: {
    read(path: string): Promise<string>
    write(path: string, data: string): Promise<unknown>
  }
  getHost(port: number): string
  setTimeout(ms: number): Promise<void>
  kill(): Promise<void>
}

export interface E2BModuleLike {
  Sandbox: {
    create(template: string, opts?: { timeoutMs?: number }): Promise<E2BSandboxLike>
    create(opts?: { timeoutMs?: number }): Promise<E2BSandboxLike>
  }
}

export interface E2BProviderOptions {
  /** Sandbox template / image id; omit for the backend default. */
  template?: string
  /** CDP port exposed by browser-type sandbox images (E2B browser templates use 9222). */
  cdpPort?: number
  /** Injectable for tests; production dynamically imports `e2b`. */
  sdkFactory?: RemoteSdkFactory
}

export class E2BSandboxProvider extends RemoteSandboxProviderBase {
  readonly id = 'e2b' as const
  readonly displayName = 'E2B 兼容沙箱（含阿里云 Agent Sandbox Flash 版）'
  private readonly template: string | undefined
  private readonly cdpPort: number
  private readonly sdkFactory: RemoteSdkFactory
  private module: E2BModuleLike | undefined

  constructor(options: E2BProviderOptions, idleTtlMs: number, log: Logger) {
    super(idleTtlMs, log)
    this.template = options.template
    this.cdpPort = options.cdpPort ?? 9222
    this.sdkFactory = options.sdkFactory ?? (async () => (await import('e2b')) as unknown as E2BModuleLike)
    this.template = options.template
    this.cdpPort = options.cdpPort ?? 9222
    this.sdkFactory = options.sdkFactory ?? (async () => (await import('e2b')) as unknown as E2BModuleLike)
  }

  async availability(): Promise<SandboxAvailability> {
    try {
      await this.load()
      return { ok: true, detail: `E2B SDK 就绪${this.template === undefined ? '' : `（template=${this.template}）`}；凭证与区域由 E2B_API_KEY / E2B_API_URL / E2B_DOMAIN 决定` }
    } catch (error) {
      return {
        ok: false,
        detail: `e2b SDK 未就绪：${String(error instanceof Error ? error.message : error)}（npm i e2b，并配置 E2B_API_KEY / E2B_API_URL / E2B_DOMAIN）`,
      }
    }
  }

  protected async createRaw(sessionId: string): Promise<RawRemoteSandbox> {
    const mod = await this.load()
    void sessionId
    const sandbox = this.template === undefined ? await mod.Sandbox.create() : await mod.Sandbox.create(this.template)
    return {
      sandboxId: sandbox.sandboxId,
      exec: async (command: string, options: SandboxExecOptions) => {
        const result = await sandbox.commands.run(command, {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        })
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.error === undefined ? result.stderr : `${result.stderr}\n${result.error}`,
        }
      },
      readFile: (path) => sandbox.files.read(path),
      writeFile: (path, content) => sandbox.files.write(path, content).then(() => undefined),
      cdpEndpoint: async () => {
        try {
          return sandbox.getHost(this.cdpPort)
        } catch {
          return undefined
        }
      },
      renew: () => sandbox.setTimeout(this.idleTtlMs).then(() => undefined),
      close: () => sandbox.kill().then(() => undefined),
    }
  }

  protected describeBackend(): Record<string, unknown> {
    return { template: this.template ?? '(backend default)', cdpPort: this.cdpPort }
  }

  private async load(): Promise<E2BModuleLike> {
    if (this.module !== undefined) return this.module
    try {
      this.module = (await this.sdkFactory()) as E2BModuleLike
      return this.module
    } catch (error) {
      throw new Error(String(error instanceof Error ? error.message : error))
    }
  }
}

/** Test seam: adapt an already-shaped fake sandbox into the provider. */
export function e2bSdkFactoryOf(sandboxes: E2BSandboxLike[]): RemoteSdkFactory {
  let index = 0
  return async () => ({
    Sandbox: {
      async create(templateOrOpts?: string | { timeoutMs?: number }, opts?: { timeoutMs?: number }) {
        const sandbox = sandboxes[index++]
        if (sandbox === undefined) throw new Error('no more fake e2b sandboxes')
        void templateOrOpts
        void opts
        return sandbox
      },
    },
  })
}

export { executionToResult }
