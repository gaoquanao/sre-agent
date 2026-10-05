import { execFile } from 'node:child_process'

/**
 * Computer-use driver abstraction.
 *
 * v1 ships the macOS driver because the deployment target is a Mac mini: the
 * platform process drives THAT machine's UI (screenshots via `screencapture`,
 * input via osascript/JXA posting CoreGraphics events — no external binaries).
 * Both features require the host to grant the platform's process (or its
 * parent terminal/app) Screen Recording and Accessibility permissions; the
 * driver probes for this and reports honestly instead of failing obscurely.
 *
 * A Linux implementation (xdotool/wmctrl against X11, or a headless container
 * path) plugs in behind the same interface when the managed-agent sandbox
 * form lands; nothing above the driver knows which machine it is on.
 */
export interface ComputerDriver {
  readonly id: 'macos' | 'linux'
  /** Human-readable description of what this driver controls. */
  readonly target: string
  probe(): Promise<{ ok: boolean; detail: string }>
  screenshot(): Promise<{ png: Buffer }>
  click(x: number, y: number, options?: { button?: 'left' | 'right'; double?: boolean }): Promise<void>
  type(text: string): Promise<void>
  key(key: string): Promise<void>
  scroll(dx: number, dy: number): Promise<void>
  frontmostApp(): Promise<string>
}

type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<string>

const realExec: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) rejectPromise(new Error(`${file} ${args[0] ?? ''} failed: ${String(error).slice(0, 300)} ${String(stderr).slice(0, 300)}`))
      else resolvePromise(String(stdout))
    })
  })

export class MacComputerDriver implements ComputerDriver {
  readonly id = 'macos' as const
  readonly target = '本机 macOS 桌面（运行平台进程的这台机器）'
  private readonly exec: ExecFn

  constructor(exec?: ExecFn) {
    this.exec = exec ?? realExec
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      // Screen Recording permission: screencapture succeeds but writes an
      // image of only the desktop wallpaper when denied, so we can only verify
      // the command path here; the tool result tells the operator how to grant.
      await this.exec('/usr/sbin/screencapture', ['-x', '-t', 'png', '/dev/null'], 5_000)
      await this.frontmostApp()
      return { ok: true, detail: 'screencapture 与辅助功能调用可用；若截图全黑/点击无效，请在 系统设置→隐私与安全性 中授予屏幕录制与辅助功能权限' }
    } catch (error) {
      return { ok: false, detail: `macOS 自动化不可用：${String(error)}（需要屏幕录制 + 辅助功能权限）` }
    }
  }

  async screenshot(): Promise<{ png: Buffer }> {
    // screencapture only writes files, so capture to a temp file and read it.
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'sre-screen-'))
    const file = join(dir, 'screen.png')
    try {
      await this.exec('/usr/sbin/screencapture', ['-x', '-t', 'png', file], 10_000)
      return { png: await readFile(file) }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async click(x: number, y: number, options: { button?: 'left' | 'right'; double?: boolean } = {}): Promise<void> {
    const button = options.button ?? 'left'
    const down = button === 'right' ? 'kCGEventRightMouseDown' : 'kCGEventLeftMouseDown'
    const up = button === 'right' ? 'kCGEventRightMouseUp' : 'kCGEventLeftMouseUp'
    const buttonConst = button === 'right' ? 'kCGEventRightMouseButton' : 'kCGEventLeftMouseButton'
    const point = JSON.stringify({ x, y })
    const script = [
      'ObjC.import("CoreGraphics");',
      `function post(type){ const e=$.CGEventCreateMouseEvent($(), $[type], ${point}, $.${buttonConst}); $.CGEventPost($.kCGHIDEventTap, e); }`,
      `post('${down}');`,
      `post('${up}');`,
      ...(options.double === true ? [`post('${down}');`, `post('${up}');`] : []),
    ].join('\n')
    await this.exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], 10_000)
  }

  async type(text: string): Promise<void> {
    // System Events keystroke handles unicode and the active app focus model.
    await this.exec(
      '/usr/bin/osascript',
      ['-e', `tell application "System Events" to keystroke ${JSON.stringify(text)}`],
      15_000,
    )
  }

  async key(key: string): Promise<void> {
    const mapped = KEY_NAMES.get(key.toLowerCase()) ?? key.toLowerCase()
    await this.exec(
      '/usr/bin/osascript',
      ['-e', `tell application "System Events" to key code ${mapped}`],
      10_000,
    )
  }

  async scroll(dx: number, dy: number): Promise<void> {
    const script = [
      'ObjC.import("CoreGraphics");',
      `const e=$.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitPixel, 1, ${JSON.stringify(-dy)});`,
      '$.CGEventPost($.kCGHIDEventTap, e);',
    ].join('\n')
    void dx
    await this.exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], 10_000)
  }

  async frontmostApp(): Promise<string> {
    const out = await this.exec(
      '/usr/bin/osascript',
      ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'],
      5_000,
    )
    return out.trim()
  }
}

/** System Events key codes for the subset SRE workflows need. */
const KEY_NAMES = new Map<string, string>([
  ['enter', '36'],
  ['return', '36'],
  ['tab', '48'],
  ['escape', '53'],
  ['esc', '53'],
  ['space', '49'],
  ['delete', '51'],
  ['backspace', '51'],
  ['forwarddelete', '117'],
  ['up', '126'],
  ['down', '125'],
  ['left', '123'],
  ['right', '124'],
  ['home', '115'],
  ['end', '119'],
  ['pageup', '116'],
  ['pagedown', '121'],
])

/** Unavailable driver: returned on non-macOS hosts until the Linux driver lands. */
export class UnsupportedComputerDriver implements ComputerDriver {
  readonly id = 'linux' as const
  readonly target = '（当前宿主不支持桌面控制）'

  async probe(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: '当前宿主不是 macOS：桌面控制驱动未实现（Linux 沙箱形态落地时接入 xdotool 驱动）' }
  }

  async screenshot(): Promise<{ png: Buffer }> {
    throw new Error('computer use is not available on this host')
  }

  async click(): Promise<void> {
    throw new Error('computer use is not available on this host')
  }

  async type(): Promise<void> {
    throw new Error('computer use is not available on this host')
  }

  async key(): Promise<void> {
    throw new Error('computer use is not available on this host')
  }

  async scroll(): Promise<void> {
    throw new Error('computer use is not available on this host')
  }

  async frontmostApp(): Promise<string> {
    throw new Error('computer use is not available on this host')
  }
}

export function createComputerDriver(): ComputerDriver {
  return process.platform === 'darwin' ? new MacComputerDriver() : new UnsupportedComputerDriver()
}
