import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { KernelId, PermissionPreset } from '@sre/protocol'
import { parseSandboxProvider, type SandboxProviderId } from './sandbox/index.ts'

export interface AppConfig {
  /** All platform state lives under here: db, kernel homes, skills, workspace. */
  home: string
  host: string
  port: number
  /** Bearer token the dsh bridge plugin uses on the /internal routes. */
  internalToken: string
  kernel: KernelId
  /** Directory the agent operates in (repo under inspection, etc). */
  workspace: string
  permissionPreset: PermissionPreset
  /** Pi kernel state, isolated from the user's ~/.pi. */
  piHome: string
  piSessions: string
  piSkills: string
  piModelsPath: string
  piAuthPath: string
  piMcpPath: string
  /** dsh kernel state, isolated from the user's ~/.dsh. */
  dshHome: string
  dshProfile: string
  /** Skills authored in the platform UI; mirrored into each kernel. */
  skillsDir: string
  dbPath: string
  webDist?: string
  /** Longest an approval may sit pending before it is auto-denied. */
  approvalTimeoutMs: number
  /**
   * Deterministic offline LLM, for tests and key-less demos. When enabled the
   * dsh profile mounts a mock adapter and the expected provider/model switch to
   * it, so the whole pipeline can be exercised without a provider account.
   */
  mockLlm: boolean
  mockLlmTool: string
  mockLlmToolArguments: string
  mockLlmFinalText: string
  /**
   * Execution layer for agent-initiated commands (Agent Use Sandbox mode).
   * `local` runs them on this host (pre-existing behaviour); `opensandbox` and
   * `e2b` delegate them to isolated per-session sandboxes.
   */
  sandbox: {
    provider: SandboxProviderId
    /** e2b template id / opensandbox image name. */
    template?: string
    /** Idle reaping for remote providers. */
    idleTtlMs: number
    /** Browser DevTools port exposed by browser-type sandbox images. */
    cdpPort: number
  }
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw.length === 0) return fallback
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase())
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.length === 0) return fallback
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fallback
  return port
}

export function resolveConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const home = resolve(
    overrides.home ??
      process.env.SRE_AGENT_HOME ??
      join(process.env.SRE_AGENT_REPO_ROOT ?? process.cwd(), '.sre-agent'),
  )
  const kernelEnv = process.env.SRE_AGENT_KERNEL
  const kernelIds: KernelId[] = ['pi', 'dsh', 'claude-code', 'codex', 'qoder']
  const selectedKernel = kernelIds.find((id) => id === kernelEnv)
  const presetEnv = process.env.SRE_AGENT_PERMISSION_PRESET
  const preset: PermissionPreset =
    presetEnv === 'read-only' || presetEnv === 'workspace-write' || presetEnv === 'full-access'
      ? presetEnv
      : 'workspace-write'

  const piHome = join(home, 'kernels', 'pi')
  const dshHome = join(home, 'kernels', 'dsh')
  const skillsDir = join(home, 'skills')

  const config: AppConfig = {
    home,
    host: overrides.host ?? process.env.SRE_AGENT_HOST ?? '127.0.0.1',
    port: overrides.port ?? parsePort(process.env.SRE_AGENT_PORT, 8787),
    internalToken: overrides.internalToken ?? process.env.SRE_AGENT_INTERNAL_TOKEN ?? deriveToken(home),
    kernel: overrides.kernel ?? selectedKernel ?? 'pi',
    workspace: resolve(
      overrides.workspace ?? process.env.SRE_AGENT_WORKSPACE ?? join(home, 'workspace'),
    ),
    permissionPreset: overrides.permissionPreset ?? preset,
    piHome,
    piSessions: join(piHome, 'sessions'),
    piSkills: join(piHome, 'skills'),
    piModelsPath: join(piHome, 'models.json'),
    piAuthPath: join(piHome, 'auth.json'),
    piMcpPath: join(piHome, 'mcp.json'),
    dshHome,
    dshProfile: overrides.dshProfile ?? join(dshHome, 'profiles', 'sre-agent'),
    skillsDir,
    dbPath: overrides.dbPath ?? join(home, 'sre-agent.db'),
    webDist: overrides.webDist ?? process.env.SRE_AGENT_WEB_DIST,
    approvalTimeoutMs: overrides.approvalTimeoutMs ?? 15 * 60 * 1000,
    mockLlm: overrides.mockLlm ?? envFlag('SRE_AGENT_MOCK_LLM', false),
    mockLlmTool: overrides.mockLlmTool ?? process.env.SRE_AGENT_MOCK_TOOL ?? 'sre_shell',
    mockLlmToolArguments:
      overrides.mockLlmToolArguments ?? process.env.SRE_AGENT_MOCK_TOOL_ARGS ?? '{"command":"echo mock-llm-pipeline-ok"}',
    mockLlmFinalText:
      overrides.mockLlmFinalText ?? process.env.SRE_AGENT_MOCK_FINAL_TEXT ?? 'mock-llm: 工具调用已闭环，巡检结论已生成。',
    sandbox: {
      provider: overrides.sandbox?.provider ?? parseSandboxProvider(process.env.SRE_AGENT_SANDBOX),
      ...(overrides.sandbox?.template !== undefined || process.env.SRE_AGENT_SANDBOX_TEMPLATE !== undefined
        ? { template: overrides.sandbox?.template ?? process.env.SRE_AGENT_SANDBOX_TEMPLATE }
        : {}),
      idleTtlMs:
        overrides.sandbox?.idleTtlMs ?? parsePort(process.env.SRE_AGENT_SANDBOX_TTL_MS, 30 * 60 * 1000),
      cdpPort: overrides.sandbox?.cdpPort ?? parsePort(process.env.SRE_AGENT_SANDBOX_CDP_PORT, 9222),
    },
  }
  return config
}

/**
 * The internal token is stable per home directory so a restart does not
 * invalidate a profile already installed on disk. Exported because the MCP
 * stdio bridge recomputes it to authenticate against the platform.
 */
export function deriveToken(home: string): string {
  const seed = process.env.SRE_AGENT_TOKEN_SEED
  if (seed !== undefined && seed.length > 0) {
    return createHash('sha256').update(seed).digest('hex').slice(0, 40)
  }
  return createHash('sha256').update(`sre-agent:${home}:${homedir()}`).digest('hex').slice(0, 40)
}

export function generateSecret(): string {
  return randomBytes(24).toString('hex')
}

export function ensureDirs(config: AppConfig): void {
  for (const dir of [
    config.home,
    config.workspace,
    config.piHome,
    config.piSessions,
    config.piSkills,
    config.skillsDir,
    config.dshHome,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

export function webDistExists(config: AppConfig): boolean {
  return config.webDist !== undefined && existsSync(join(config.webDist, 'index.html'))
}

export { envFlag }
