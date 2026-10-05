/**
 * Sandbox provider abstraction.
 *
 * The platform's execution layer (agent-initiated commands today, browser CDP
 * endpoints) can run on the host machine (`local`) or inside a remote sandbox
 * backend — Alibaba OpenSandbox (`opensandbox`) or any E2B-compatible service
 * including Alibaba Cloud Agent Sandbox Flash Edition (`e2b`).
 *
 * This is the "Agent Use Sandbox" mode from the Agent Sandbox product model:
 * the platform (and its kernels) stay where they are, and untrusted tool
 * execution is delegated to an isolated, per-session VM. The inverse mode
 * ("Agent in Sandbox" — the whole platform instantiated inside a sandbox by a
 * control plane) reuses the same primitives but is a deployment concern, see
 * docs/sandbox-providers.md.
 *
 * Semantics deliberately shared by both remote SDKs:
 * - lazy, session-scoped handles: one sandbox per platform session, created on
 *   first use, renewed while active, reaped after an idle TTL;
 * - exec with cwd + timeout;
 * - text-oriented file read/write (screenshots and artifacts stay platform-side);
 * - optional endpoints: a browser CDP port for browser-type sandboxes.
 */

export type SandboxProviderId = 'local' | 'opensandbox' | 'e2b'

export interface SandboxExecOptions {
  cwd?: string
  timeoutMs?: number
}

export interface SandboxExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface SandboxHandle {
  readonly sandboxId: string
  readonly provider: SandboxProviderId
  readonly createdAt: number
  lastUsedAt: number
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  /** Browser DevTools endpoint (http(s)/ws), when this sandbox type exposes one. */
  cdpEndpoint(): Promise<string | undefined>
  /** Refresh the backend-side expiry and the local idle clock. */
  renew(): Promise<void>
  /** Terminate the sandbox (kill + client cleanup). */
  close(): Promise<void>
}

export interface SandboxAvailability {
  ok: boolean
  detail: string
}

export interface SandboxHandleSummary {
  sessionId: string
  sandboxId: string
  provider: SandboxProviderId
  createdAt: number
  lastUsedAt: number
}

export interface SandboxProvider {
  readonly id: SandboxProviderId
  readonly displayName: string
  availability(): Promise<SandboxAvailability>
  /** Get (lazily creating) the sandbox bound to this platform session. */
  get(sessionId: string): Promise<SandboxHandle>
  /** Terminate and forget the session's sandbox (no-op if none). */
  release(sessionId: string): Promise<void>
  releaseAll(): Promise<void>
  /** Reap idle handles; returns the session ids reaped. */
  sweep(now: number): Promise<string[]>
  summaries(): SandboxHandleSummary[]
  describe(): Record<string, unknown>
}
