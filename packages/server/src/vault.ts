import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { KernelId } from '@sre/protocol'
import type { AppConfig } from './config.ts'
import { Logger } from './log.ts'
import type { Store } from './store.ts'

export type CredentialKind = 'oauth' | 'api-key' | 'env-json'

export interface CredentialSecret {
  kind: CredentialKind
  /** oauth */
  token?: string
  refreshToken?: string
  /** epoch ms */
  expiresAt?: number
  account?: string
  /** api-key */
  apiKey?: string
  /** env-json */
  env?: Record<string, string>
}

export interface CredentialView {
  ref: string
  kind: CredentialKind
  masked: string
  hasRefresh: boolean
  updatedAt: number
}

/**
 * Credential escrow for kernel CLIs.
 *
 * Secrets are encrypted at rest (AES-256-GCM, key derived with scrypt from
 * `SRE_AGENT_SECRET` plus the home directory, salt stored in the settings
 * table) inside the platform home — never in the repo, never returned to the
 * UI in full. Kernel adapters consume them through `envFor()`, which is also
 * the only place a decrypted value is ever materialized.
 */
export class CredentialVault {
  private readonly store: Store
  private readonly log: Logger
  private readonly config: AppConfig
  private key: Buffer | undefined

  constructor(store: Store, log: Logger, config: AppConfig) {
    this.store = store
    this.log = log
    this.config = config
  }

  private deriveKey(): Buffer {
    if (this.key !== undefined) return this.key
    const salt = this.store.getSetting<string>('credentials.salt', '')
    const material = process.env.SRE_AGENT_SECRET ?? ''
    if (material.length === 0 && salt.length === 0) {
      this.log.warn(
        'SRE_AGENT_SECRET is not set: credential encryption falls back to a home-derived key. ' +
          'Set SRE_AGENT_SECRET in production to bind the vault to an operator-chosen secret.',
      )
    }
    this.key = scryptSync(`${material}:${this.config.home}`, salt.length === 0 ? 'sre-agent-v1' : salt, 32)
    return this.key
  }

  private encrypt(plain: string): { enc: Buffer; iv: Buffer; tag: Buffer } {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.deriveKey(), iv)
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return { enc, iv, tag: cipher.getAuthTag() }
  }

  private decrypt(row: { enc: Buffer; iv: Buffer; tag: Buffer }): string {
    const decipher = createDecipheriv('aes-256-gcm', this.deriveKey(), row.iv)
    decipher.setAuthTag(row.tag)
    return Buffer.concat([decipher.update(row.enc), decipher.final()]).toString('utf8')
  }

  put(ref: string, secret: CredentialSecret): void {
    const normalized = ref.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
      throw new Error('credential ref must be kebab/dot/underscore, <= 64 chars')
    }
    const { enc, iv, tag } = this.encrypt(JSON.stringify(secret))
    this.store.upsertCredential({
      ref: normalized,
      kind: secret.kind,
      enc,
      iv,
      tag,
      hasRefresh: secret.refreshToken !== undefined && secret.refreshToken.length > 0,
      updatedAt: Date.now(),
    })
    this.log.info(`credential stored: ${normalized} (${secret.kind})`)
  }

  get(ref: string): CredentialSecret | undefined {
    const row = this.store.getCredential(ref.trim().toLowerCase())
    if (row === undefined) return undefined
    try {
      return JSON.parse(this.decrypt(row)) as CredentialSecret
    } catch (error) {
      this.log.error(`credential ${row.ref} cannot be decrypted (wrong SRE_AGENT_SECRET?): ${String(error)}`)
      return undefined
    }
  }

  list(): CredentialView[] {
    return this.store.listCredentials().map((row) => {
      const secret = this.get(row.ref)
      return {
        ref: row.ref,
        kind: row.kind,
        masked: mask(secret),
        hasRefresh: row.hasRefresh,
        updatedAt: row.updatedAt,
      }
    })
  }

  delete(ref: string): void {
    this.store.deleteCredential(ref.trim().toLowerCase())
    this.log.info(`credential deleted: ${ref}`)
  }

  /**
   * Environment variables a kernel subprocess should receive. Only entries the
   * vault actually holds are returned; unknown kernels get nothing.
   */
  envFor(kernel: KernelId): Record<string, string> {
    const secret = this.get(kernel)
    if (secret === undefined) return {}
    const env: Record<string, string> = {}
    if (secret.kind === 'oauth' && secret.token !== undefined) {
      if (kernel === 'claude-code') env['CLAUDE_CODE_OAUTH_TOKEN'] = secret.token
      else if (kernel === 'qoder') env['QODER_OAUTH_TOKEN'] = secret.token
    } else if (secret.kind === 'api-key' && secret.apiKey !== undefined) {
      if (kernel === 'codex') env['OPENAI_API_KEY'] = secret.apiKey
      else if (kernel === 'qoder') env['QODER_API_KEY'] = secret.apiKey
      else if (kernel === 'claude-code') env['ANTHROPIC_API_KEY'] = secret.apiKey
    } else if (secret.kind === 'env-json' && secret.env !== undefined) {
      Object.assign(env, secret.env)
    }
    return env
  }

  /**
   * Import credentials from CLIs already logged in on this machine. Read-only
   * against the source files; the vault copy becomes authoritative afterwards.
   */
  importFromLocalCli(kernel: 'claude-code' | 'codex' | 'qoder'): { imported: string[]; missing: string[] } {
    const imported: string[] = []
    const missing: string[] = []
    const home = homedir()

    if (kernel === 'claude-code') {
      const file = join(home, '.claude', '.credentials.json')
      if (!existsSync(file)) {
        missing.push(file)
      } else {
        try {
          const raw = JSON.parse(readFileSync(file, 'utf8')) as {
            claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number; account?: { emailAddress?: string } }
          }
          const oauth = raw.claudeAiOauth
          if (oauth?.accessToken === undefined) {
            missing.push(`${file} (no claudeAiOauth.accessToken)`)
          } else {
            this.put(kernel, {
              kind: 'oauth',
              token: oauth.accessToken,
              ...(oauth.refreshToken === undefined ? {} : { refreshToken: oauth.refreshToken }),
              ...(oauth.expiresAt === undefined ? {} : { expiresAt: oauth.expiresAt }),
              ...(oauth.account?.emailAddress === undefined ? {} : { account: oauth.account.emailAddress }),
            })
            imported.push(file)
          }
        } catch (error) {
          missing.push(`${file} (unreadable: ${String(error)})`)
        }
      }
    }

    if (kernel === 'codex') {
      const file = join(home, '.codex', 'auth.json')
      if (!existsSync(file)) {
        missing.push(file)
      } else {
        try {
          const raw = JSON.parse(readFileSync(file, 'utf8')) as {
            OPENAI_API_KEY?: string
            tokens?: { access_token?: string; refresh_token?: string; account_id?: string }
          }
          if (raw.tokens?.access_token !== undefined) {
            this.put(kernel, {
              kind: 'oauth',
              token: raw.tokens.access_token,
              ...(raw.tokens.refresh_token === undefined ? {} : { refreshToken: raw.tokens.refresh_token }),
              ...(raw.tokens.account_id === undefined ? {} : { account: raw.tokens.account_id }),
            })
            imported.push(file)
          } else if (raw.OPENAI_API_KEY !== undefined) {
            this.put(kernel, { kind: 'api-key', apiKey: raw.OPENAI_API_KEY })
            imported.push(file)
          } else {
            missing.push(`${file} (no tokens or OPENAI_API_KEY)`)
          }
        } catch (error) {
          missing.push(`${file} (unreadable: ${String(error)})`)
        }
      }
    }

    if (kernel === 'qoder') {
      // The CLI's token file location is not documented; scan the common spots.
      const candidates = [join(home, '.qoder', 'credentials.json'), join(home, '.qodercli', 'credentials.json')]
      const found = candidates.find((file) => existsSync(file))
      if (found === undefined) {
        missing.push(...candidates)
      } else {
        try {
          const raw = JSON.parse(readFileSync(found, 'utf8')) as Record<string, unknown>
          this.put(kernel, { kind: 'env-json', env: raw as Record<string, string> })
          imported.push(found)
        } catch (error) {
          missing.push(`${found} (unreadable: ${String(error)})`)
        }
      }
    }

    return { imported, missing }
  }
}

function mask(secret: CredentialSecret | undefined): string {
  if (secret === undefined) return '(无法解密：密钥不匹配)'
  const tail = (value: string): string =>
    value.length <= 8 ? `…${value.slice(-2)}` : `${value.slice(0, 5)}…${value.slice(-4)}`
  if (secret.kind === 'oauth' && secret.token !== undefined) {
    const expiry = secret.expiresAt === undefined ? '' : ` (expires ${new Date(secret.expiresAt).toISOString()})`
    return `OAuth ${tail(secret.token)}${expiry}`
  }
  if (secret.kind === 'api-key' && secret.apiKey !== undefined) return `key ${tail(secret.apiKey)}`
  if (secret.kind === 'env-json' && secret.env !== undefined) {
    return `env {${Object.keys(secret.env).join(', ')}}`
  }
  return secret.kind
}
