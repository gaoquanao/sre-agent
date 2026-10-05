import type { AppConfig } from '../config.ts'
import { Logger } from '../log.ts'
import { LocalSandboxProvider } from './local.ts'
import { E2BSandboxProvider } from './e2b.ts'
import { OpenSandboxProvider } from './opensandbox.ts'
import type { SandboxProvider, SandboxProviderId } from './types.ts'

export * from './types.ts'
export { LocalSandboxProvider } from './local.ts'
export { E2BSandboxProvider } from './e2b.ts'
export { OpenSandboxProvider } from './opensandbox.ts'

export function parseSandboxProvider(raw: string | undefined): SandboxProviderId {
  if (raw === 'opensandbox' || raw === 'e2b' || raw === 'local') return raw
  return 'local'
}

/** Build the provider selected by config/environment (default: host execution). */
export function createSandboxProvider(config: AppConfig, log: Logger): SandboxProvider {
  switch (config.sandbox.provider) {
    case 'e2b':
      log.info(`sandbox provider: e2b (template=${config.sandbox.template ?? 'default'}, idleTtl=${config.sandbox.idleTtlMs}ms)`)
      return new E2BSandboxProvider(
        {
          ...(config.sandbox.template === undefined ? {} : { template: config.sandbox.template }),
          cdpPort: config.sandbox.cdpPort,
        },
        config.sandbox.idleTtlMs,
        log,
      )
    case 'opensandbox':
      log.info(`sandbox provider: opensandbox (image=${config.sandbox.template ?? 'alpine:latest'}, idleTtl=${config.sandbox.idleTtlMs}ms)`)
      return new OpenSandboxProvider(
        {
          ...(config.sandbox.template === undefined ? {} : { image: config.sandbox.template }),
          cdpPort: config.sandbox.cdpPort,
          ...(process.env.SRE_AGENT_OS_DOMAIN === undefined ? {} : { domain: process.env.SRE_AGENT_OS_DOMAIN }),
          ...(process.env.SRE_AGENT_OS_API_KEY === undefined ? {} : { apiKey: process.env.SRE_AGENT_OS_API_KEY }),
          ...(process.env.SRE_AGENT_OS_PROTOCOL === undefined
            ? {}
            : { protocol: process.env.SRE_AGENT_OS_PROTOCOL as 'http' | 'https' | 'ws' | 'wss' }),
        },
        config.sandbox.idleTtlMs,
        log,
      )
    case 'local':
    default:
      return new LocalSandboxProvider(config)
  }
}
