import { Logger } from '../log.ts'
import { RemoteSandboxProviderBase, executionToResult, type RawRemoteSandbox, type RemoteSdkFactory } from './remote.ts'
import type { SandboxAvailability, SandboxExecOptions } from './types.ts'

/**
 * Minimal shape of the Alibaba OpenSandbox TypeScript SDK surface we use
 * (`@alibaba-group/opensandbox`, verified against its published types).
 * The real module is dynamically imported; tests inject a fake factory.
 */
export interface OSBSandboxLike {
  commands: {
    run(
      cmd: string,
      opts?: { workingDirectory?: string; timeoutSeconds?: number },
    ): Promise<{
      logs?: { stdout?: { text?: string }[]; stderr?: { text?: string }[] }
      exitCode?: number | null
      error?: { message?: string } | string
    }>
  }
  files: {
    read_file(path: string, opts?: { format?: string }): Promise<string | Uint8Array>
    write_files(entries: { path: string; data?: string | Uint8Array }[]): Promise<void>
  }
  getEndpointUrl(port: number): Promise<string>
  renew(timeoutSeconds: number): Promise<unknown>
  kill(): Promise<void>
  close(): Promise<void>
  getInfo(): Promise<{ id?: string; sandboxId?: string }>
}

export interface OSBModuleLike {
  Sandbox: {
    create(opts?: { image?: string; connectionConfig?: Record<string, unknown> }): Promise<OSBSandboxLike>
  }
}

export interface OSBProviderOptions {
  /** Sandbox image, e.g. an alpine image for code execution or a Chrome image for browser use. */
  image?: string
  cdpPort?: number
  /** Loopback connection override for a self-hosted backend; the SDK defaults to its local Docker runtime. */
  domain?: string
  apiKey?: string
  protocol?: 'http' | 'https' | 'ws' | 'wss'
  /** Injectable for tests; production dynamically imports the SDK. */
  sdkFactory?: RemoteSdkFactory
}

export class OpenSandboxProvider extends RemoteSandboxProviderBase {
  readonly id = 'opensandbox' as const
  readonly displayName = 'OpenSandbox（阿里巴巴开源，Docker/K8s/Firecracker 运行时）'
  private readonly image: string
  private readonly cdpPort: number
  private readonly sdkFactory: RemoteSdkFactory
  private readonly connectionConfig: Record<string, unknown> | undefined
  private module: OSBModuleLike | undefined

  constructor(options: OSBProviderOptions, idleTtlMs: number, log: Logger) {
    super(idleTtlMs, log)
    this.image = options.image ?? 'alpine:latest'
    this.cdpPort = options.cdpPort ?? 9222
    this.sdkFactory = options.sdkFactory ?? (async () => (await import('@alibaba-group/opensandbox')) as unknown as OSBModuleLike)
    const config: Record<string, unknown> = {}
    if (options.domain !== undefined) config.domain = options.domain
    if (options.apiKey !== undefined) config.apiKey = options.apiKey
    if (options.protocol !== undefined) config.protocol = options.protocol
    this.connectionConfig = Object.keys(config).length === 0 ? undefined : config
  }

  async availability(): Promise<SandboxAvailability> {
    try {
      await this.load()
      return {
        ok: true,
        detail: `OpenSandbox SDK 就绪（image=${this.image}${this.connectionConfig === undefined ? '，本地 Docker 运行时' : '，远端 connectionConfig 已配置'}）`,
      }
    } catch (error) {
      return {
        ok: false,
        detail: `@alibaba-group/opensandbox 未就绪：${String(error instanceof Error ? error.message : error)}（npm i @alibaba-group/opensandbox）`,
      }
    }
  }

  protected async createRaw(sessionId: string): Promise<RawRemoteSandbox> {
    const mod = await this.load()
    void sessionId
    const sandbox = await mod.Sandbox.create({
      image: this.image,
      ...(this.connectionConfig === undefined ? {} : { connectionConfig: this.connectionConfig }),
    })
    const sandboxId = await sandbox
      .getInfo()
      .then((info) => info.id ?? info.sandboxId ?? 'opensandbox-unknown')
      .catch(() => 'opensandbox-unknown')

    return {
      sandboxId,
      exec: async (command: string, options: SandboxExecOptions) => {
        const execution = await sandbox.commands.run(command, {
          ...(options.cwd === undefined ? {} : { workingDirectory: options.cwd }),
          ...(options.timeoutMs === undefined ? {} : { timeoutSeconds: Math.ceil(options.timeoutMs / 1000) }),
        })
        return executionToResult(execution)
      },
      readFile: async (path) => {
        const content = await sandbox.files.read_file(path)
        return typeof content === 'string' ? content : Buffer.from(content).toString('utf8')
      },
      writeFile: (path, content) => sandbox.files.write_files([{ path, data: content }]).then(() => undefined),
      cdpEndpoint: async () => {
        try {
          return await sandbox.getEndpointUrl(this.cdpPort)
        } catch {
          return undefined
        }
      },
      renew: () => sandbox.renew(Math.ceil(this.idleTtlMs / 1000)).then(() => undefined),
      close: () =>
        sandbox
          .kill()
          .catch(() => undefined)
          .then(() => sandbox.close())
          .catch(() => undefined)
          .then(() => undefined),
    }
  }

  protected describeBackend(): Record<string, unknown> {
    return {
      image: this.image,
      cdpPort: this.cdpPort,
      connectionConfigured: this.connectionConfig !== undefined,
    }
  }

  private async load(): Promise<OSBModuleLike> {
    if (this.module !== undefined) return this.module
    try {
      this.module = (await this.sdkFactory()) as OSBModuleLike
      return this.module
    } catch (error) {
      throw new Error(String(error instanceof Error ? error.message : error))
    }
  }
}

/** Test seam: adapt pre-shaped fake sandboxes into the provider. */
export function osbSdkFactoryOf(sandboxes: OSBSandboxLike[]): RemoteSdkFactory {
  let index = 0
  return async () => ({
    Sandbox: {
      async create(opts?: { image?: string }) {
        void opts
        const sandbox = sandboxes[index++]
        if (sandbox === undefined) throw new Error('no more fake opensandboxes')
        return sandbox
      },
    },
  })
}
