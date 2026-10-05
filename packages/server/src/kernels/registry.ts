import type { KernelHealth, KernelId, KernelInfo } from '@sre/protocol'
import type { Logger } from '../log.ts'
import type { KernelAdapter, KernelHost } from './types.ts'
import { PiKernelAdapter } from './pi.ts'
import { DshKernelAdapter } from './dsh.ts'
import { CliKernelAdapter, claudeCodeProfile, codexProfile, qoderProfile } from './cli.ts'
import type { CliManager } from '../climan.ts'
import type { CredentialVault } from '../vault.ts'

/**
 * Owns the available kernels and which one is active. Only one kernel serves
 * sessions at a time: switching is an explicit operator action, and the
 * previous kernel is shut down cleanly so its subprocess is not leaked.
 */
export class KernelRegistry {
  private readonly adapters = new Map<KernelId, KernelAdapter>()
  private readonly log: Logger
  private host: KernelHost | undefined
  private active: KernelId
  private lastError: Partial<Record<KernelId, string>> = {}

  constructor(log: Logger, active: KernelId, cli: CliManager, vault: CredentialVault) {
    this.log = log
    this.active = active
    this.adapters.set('pi', new PiKernelAdapter())
    this.adapters.set('dsh', new DshKernelAdapter())
    this.adapters.set('claude-code', new CliKernelAdapter(claudeCodeProfile, cli, vault))
    this.adapters.set('codex', new CliKernelAdapter(codexProfile, cli, vault))
    this.adapters.set('qoder', new CliKernelAdapter(qoderProfile, cli, vault))
  }

  ids(): KernelId[] {
    return [...this.adapters.keys()]
  }

  activeId(): KernelId {
    return this.active
  }

  activeAdapter(): KernelAdapter {
    const adapter = this.adapters.get(this.active)
    if (adapter === undefined) throw new Error(`kernel ${this.active} is unknown`)
    return adapter
  }

  adapter(id: KernelId): KernelAdapter {
    const adapter = this.adapters.get(id)
    if (adapter === undefined) throw new Error(`kernel ${id} is unknown`)
    return adapter
  }

  setHost(host: KernelHost): void {
    this.host = host
  }

  async startActive(): Promise<void> {
    if (this.host === undefined) throw new Error('kernel host is not attached')
    const adapter = this.activeAdapter()
    try {
      await adapter.start(this.host)
      delete this.lastError[adapter.id]
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError[adapter.id] = message
      this.log.error(`kernel ${adapter.id} failed to start`, error)
      throw error
    }
  }

  async start(id: KernelId): Promise<void> {
    if (this.host === undefined) throw new Error('kernel host is not attached')
    const adapter = this.adapter(id)
    try {
      await adapter.start(this.host)
      delete this.lastError[id]
    } catch (error) {
      this.lastError[id] = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async stop(id: KernelId): Promise<void> {
    await this.adapter(id).stop()
  }

  async stopActive(): Promise<void> {
    await this.stop(this.active)
  }

  async switchTo(id: KernelId): Promise<void> {
    if (id === this.active) return
    this.log.info(`switching kernel ${this.active} -> ${id}`)
    await this.stop(this.active)
    this.active = id
    await this.startActive()
  }

  async infos(version: string): Promise<KernelInfo[]> {
    const out: KernelInfo[] = []
    for (const [id, adapter] of this.adapters) {
      let health: KernelHealth
      try {
        health = await adapter.health()
      } catch (error) {
        health = { status: 'error', detail: error instanceof Error ? error.message : String(error) }
      }
      if (this.lastError[id] !== undefined && health.detail === undefined) {
        health = { ...health, detail: this.lastError[id] }
      }
      out.push({
        id,
        displayName: adapter.displayName,
        capabilities: adapter.capabilities(),
        health,
        ...(id === this.active ? { version } : {}),
      })
    }
    return out
  }

  /** Re-apply platform-managed configuration (skills, MCP, providers). */
  async resyncAll(): Promise<{ id: KernelId; ok: boolean; detail: string }[]> {
    const results: { id: KernelId; ok: boolean; detail: string }[] = []
    if (this.host === undefined) return results
    for (const [id, adapter] of this.adapters) {
      try {
        const reports = [
          await adapter.syncProviders(this.host.store.listProviders()),
          await adapter.syncSkills(this.host.store.listSkills()),
          await adapter.syncMcpServers(this.host.store.listMcpServers()),
        ]
        results.push({ id, ok: true, detail: reports.map((report) => report.message ?? report.target).join('; ') })
      } catch (error) {
        results.push({ id, ok: false, detail: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }
}
