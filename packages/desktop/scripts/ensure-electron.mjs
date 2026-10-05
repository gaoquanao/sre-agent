#!/usr/bin/env node
/**
 * Ensures the electron binary is actually present.
 *
 * npm >= 11.16 gates dependency install scripts behind an allowlist and skips
 * anything not approved, which silently disables electron's own postinstall —
 * the step that downloads the prebuilt binary. Without it `electron .` fails
 * with "Electron failed to install correctly", so run electron's installer
 * here as a no-op-safe fallback.
 *
 * Exits quietly when the binary exists or when electron is not installed (the
 * latter happens before the first `npm install`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FALLBACK_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'

function findElectronDir() {
  const candidates = []
  try {
    candidates.push(dirname(createRequire(import.meta.url).resolve('electron/package.json')))
  } catch {
    // electron is not resolvable from here; fall back to hoisted layouts.
  }
  candidates.push(join(HERE, '..', 'node_modules', 'electron'))
  candidates.push(join(HERE, '..', '..', '..', 'node_modules', 'electron'))
  return candidates.find((dir) => existsSync(join(dir, 'install.js'))) ?? null
}

const electronDir = findElectronDir()
if (electronDir === null) {
  process.exit(0)
}
if (existsSync(join(electronDir, 'path.txt'))) {
  process.exit(0)
}

const mirror = process.env.ELECTRON_MIRROR ?? FALLBACK_MIRROR
console.log(`[desktop] electron binary missing, running install.js (mirror: ${mirror})`)
execFileSync(process.execPath, [join(electronDir, 'install.js')], {
  cwd: electronDir,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_MIRROR: mirror },
})
