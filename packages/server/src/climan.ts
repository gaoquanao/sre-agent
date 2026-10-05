import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from './config.ts'
import { Logger } from './log.ts'

export interface CliToolInfo {
  name: string
  bin: string
  pkg?: string
  installed: boolean
  version?: string
  source?: 'path' | 'platform' | 'missing'
  note?: string
}

export interface CliCatalogEntry {
  name: string
  bin: string
  pkg?: string
  note?: string
}

/**
 * Catalog of agent CLIs the platform can drive (and therefore pre-install).
 * `qoder`'s npm package name is community-reported (`qodercli`), not verified
 * against an official source, so it is overridable via SRE_AGENT_QODER_PKG.
 */
export function cliCatalog(): CliCatalogEntry[] {
  return [
    { name: 'pi', bin: 'pi', pkg: '@earendil-works/pi-coding-agent' },
    { name: 'dsh', bin: 'dsh', pkg: '@deepseek-ai/dsh' },
    { name: 'claude-code', bin: 'claude', pkg: '@anthropic-ai/claude-code' },
    { name: 'codex', bin: 'codex', pkg: '@openai/codex' },
    {
      name: 'qoder',
      bin: 'qoder',
      pkg: process.env.SRE_AGENT_QODER_PKG ?? 'qodercli',
      note: 'qoder 的 npm 包名未经官方确认（默认 qodercli，可用 SRE_AGENT_QODER_PKG 覆盖）',
    },
  ]
}

/**
 * Installs and probes agent CLIs. Installs go into a platform-owned prefix
 * (`<home>/tools`) rather than the global npm tree, so the platform never
 * needs write access outside its own home; kernel subprocesses get that
 * prefix's `.bin` prepended to PATH.
 */
export class CliManager {
  private readonly log: Logger
  private readonly toolsBin: string

  /**
   * The repository's own .bin (where pi/dsh are installed as dependencies).
   * dist/climan.js -> packages/server/dist -> packages/server -> packages -> repo root.
   */
  private readonly repoBin: string = join(
    dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))),
    'node_modules',
    '.bin',
  )

  constructor(config: AppConfig, log: Logger) {
    this.log = log
    this.toolsBin = join(config.home, 'tools', 'node_modules', '.bin')
  }

  get pathPrefix(): string {
    return this.toolsBin
  }

  /** Directories to prepend to a subprocess PATH so platform CLIs resolve. */
  pathEntries(): string[] {
    return [this.toolsBin, this.repoBin]
  }

  async probe(): Promise<CliToolInfo[]> {
    const out: CliToolInfo[] = []
    for (const entry of cliCatalog()) {
      const resolved = await which(entry.bin, [this.toolsBin, this.repoBin])
      if (resolved === undefined) {
        out.push({ name: entry.name, bin: entry.bin, installed: false, source: 'missing', note: entry.note })
        continue
      }
      const version = await versionOf(resolved)
      const source = resolved.includes('node_modules/.bin') ? 'platform' : 'path'
      out.push({
        name: entry.name,
        bin: entry.bin,
        ...(entry.pkg === undefined ? {} : { pkg: entry.pkg }),
        installed: true,
        ...(version === undefined ? {} : { version }),
        source,
        ...(entry.note === undefined ? {} : { note: entry.note }),
      })
    }
    return out
  }

  async install(name: string): Promise<{ ok: boolean; log: string }> {
    const entry = cliCatalog().find((candidate) => candidate.name === name)
    if (entry === undefined) return { ok: false, log: `unknown CLI: ${name}` }
    const pkg = entry.pkg
    if (pkg === undefined) return { ok: false, log: `no npm package known for ${name}; set SRE_AGENT_QODER_PKG or install manually` }

    const prefix = join(this.toolsBin, '..', '..')
    mkdirSync(prefix, { recursive: true })
    this.log.info(`installing ${pkg} into ${prefix}`)
    const registry = process.env.SRE_AGENT_NPM_REGISTRY ?? 'http://mirrors.cloud.tencent.com/npm/'
    const result = await new Promise<{ ok: boolean; log: string }>((resolvePromise) => {
      execFile(
        'npm',
        ['install', '--prefix', prefix, '--registry', registry, pkg],
        { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env } } as never,
        (error: Error | null, stdout: string, stderr: string) => {
          const output = `${stdout}\n${stderr}`.trim()
          if (error !== null) {
            this.log.warn(`install ${pkg} failed: ${String(error).slice(0, 200)}`)
            resolvePromise({ ok: false, log: output.slice(-4000) || String(error) })
          } else {
            this.log.info(`installed ${pkg}`)
            resolvePromise({ ok: true, log: output.slice(-4000) })
          }
        },
      )
    })
    return result
  }
}

function which(bin: string, extraDirs: string[]): string | undefined {
  const pathEnv = process.env.PATH ?? ''
  const dirs = [...extraDirs, ...pathEnv.split(':').filter((dir) => dir.length > 0)]
  for (const dir of dirs) {
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function versionOf(bin: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    execFile(bin, ['--version'], { timeout: 5_000 }, (error, stdout) => {
      if (error !== null) {
        resolvePromise(undefined)
        return
      }
      resolvePromise(String(stdout).trim().split('\n')[0] || undefined)
    })
  })
}
