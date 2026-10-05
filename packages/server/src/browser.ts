/**
 * Browser-use driver.
 *
 * Playwright-core drives the machine's own Chrome (channel: 'chrome'), so there
 * is no browser download: the Mac mini is expected to have Chrome installed,
 * and on a later Linux sandbox the same code runs headless Chromium from the
 * image. `playwright-core` is an optional dependency — when it (or Chrome) is
 * missing the tools degrade to an explicit provisioning message instead of
 * crashing the platform.
 */
export interface BrowserPageInfo {
  url: string
  title: string
  /** Visible text excerpt for quick orientation. */
  textExcerpt: string
  /** Links in a compact "text -> href" list (first 30). */
  links: string[]
}

export interface BrowserDriver {
  readonly target: string
  provisioned(): Promise<{ ok: boolean; detail: string }>
  navigate(sessionId: string, url: string): Promise<BrowserPageInfo>
  snapshot(sessionId: string): Promise<BrowserPageInfo>
  screenshot(sessionId: string): Promise<{ png: Buffer; url: string }>
  click(sessionId: string, selector: string): Promise<void>
  fill(sessionId: string, selector: string, text: string): Promise<void>
  evaluate(sessionId: string, js: string): Promise<string>
  close(sessionId: string): Promise<void>
  closeAll(): Promise<void>
}

interface LoadedPlaywright {
  chromium: {
    launch(options: Record<string, unknown>): Promise<PlaywrightBrowser>
    connectOverCDP(endpoint: string): Promise<PlaywrightBrowser>
  }
}

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>
  close(): Promise<void>
}

interface PlaywrightPage {
  setDefaultTimeout?(timeout: number): void
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>
  title(): Promise<string>
  url(): string
  content(): Promise<string>
  screenshot(options?: Record<string, unknown>): Promise<Buffer>
  click(selector: string, options?: Record<string, unknown>): Promise<void>
  fill(selector: string, text: string, options?: Record<string, unknown>): Promise<void>
  evaluate(js: string): Promise<unknown>
  close(): Promise<void>
}

const NAV_TIMEOUT_MS = 20_000
const TEXT_EXCERPT = 4000

export class PlaywrightBrowserDriver implements BrowserDriver {
  readonly target: string
  private browser: PlaywrightBrowser | undefined
  private readonly pages = new Map<string, PlaywrightPage>()
  private readonly launchOptions: Record<string, unknown>
  private loadError: string | undefined
  private launchPromise: Promise<PlaywrightBrowser> | undefined
  private readonly loader: () => Promise<LoadedPlaywright>
  private readonly cdpEndpoint: (() => Promise<string | undefined>) | undefined

  constructor(
    launchOptions: Record<string, unknown> = { channel: 'chrome', headless: true },
    options: {
      /** When provided (and returning a value), attach to that CDP endpoint instead of launching local Chrome. */
      cdpEndpoint?: () => Promise<string | undefined>
      /** Injectable playwright module loader for tests. */
      loader?: () => Promise<LoadedPlaywright>
    } = {},
  ) {
    this.launchOptions = launchOptions
    this.target = options.cdpEndpoint === undefined ? '本机 Chrome（无头，playwright-core 驱动）' : '沙箱浏览器（CDP 远程连接）'
    this.cdpEndpoint = options.cdpEndpoint
    this.loader = options.loader ?? (async () => (await import('playwright-core')) as unknown as LoadedPlaywright)
  }

  async provisioned(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.load()
      return { ok: true, detail: this.target }
    } catch (error) {
      return { ok: false, detail: this.describeLoadError(error) }
    }
  }

  private describeLoadError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error)
    if (raw.includes("Cannot find package 'playwright-core'")) {
      return 'browser use 未就绪：缺少 playwright-core。在 packages/server 目录执行 npm i playwright-core 并确认本机装有 Chrome。'
    }
    return `browser use 未就绪：${raw.slice(0, 200)}`
  }

  private async load(): Promise<LoadedPlaywright> {
    if (this.loadError !== undefined) throw new Error(this.loadError)
    try {
      return await this.loader()
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private async getBrowser(): Promise<PlaywrightBrowser> {
    if (this.browser !== undefined) return this.browser
    if (this.launchPromise === undefined) {
      this.launchPromise = this.load()
        .then(async (pw) => {
          // Sandbox mode: attach to the browser running inside the sandbox
          // (browser-type image) instead of launching a local Chrome.
          if (this.cdpEndpoint !== undefined) {
            const endpoint = await this.cdpEndpoint()
            if (endpoint !== undefined) return (await pw.chromium.connectOverCDP(endpoint)) as PlaywrightBrowser
          }
          return pw.chromium.launch(this.launchOptions)
        })
        .then((browser) => {
          this.browser = browser
          return browser
        })
        .catch((error) => {
          this.launchPromise = undefined
          this.loadError = error instanceof Error ? error.message : String(error)
          throw error
        })
    }
    return this.launchPromise
  }

  private async getPage(sessionId: string): Promise<PlaywrightPage> {
    const existing = this.pages.get(sessionId)
    if (existing !== undefined) return existing
    const browser = await this.getBrowser()
    const page = await browser.newPage()
    page.setDefaultTimeout?.(NAV_TIMEOUT_MS)
    this.pages.set(sessionId, page)
    return page
  }

  async navigate(sessionId: string, url: string): Promise<BrowserPageInfo> {
    const page = await this.getPage(sessionId)
    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
    return this.snapshot(sessionId)
  }

  async snapshot(sessionId: string): Promise<BrowserPageInfo> {
    const page = await this.getPage(sessionId)
    const html = await page.content()
    return {
      url: page.url(),
      title: await page.title(),
      textExcerpt: htmlToText(html).slice(0, TEXT_EXCERPT),
      links: extractLinks(html),
    }
  }

  async screenshot(sessionId: string): Promise<{ png: Buffer; url: string }> {
    const page = await this.getPage(sessionId)
    return { png: await page.screenshot({ type: 'png' }), url: page.url() }
  }

  async click(sessionId: string, selector: string): Promise<void> {
    const page = await this.getPage(sessionId)
    await page.click(selector, { timeout: 10_000 })
  }

  async fill(sessionId: string, selector: string, text: string): Promise<void> {
    const page = await this.getPage(sessionId)
    await page.fill(selector, text, { timeout: 10_000 })
  }

  async evaluate(sessionId: string, js: string): Promise<string> {
    const page = await this.getPage(sessionId)
    const result = await page.evaluate(js)
    return typeof result === 'string' ? result : JSON.stringify(result)
  }

  async close(sessionId: string): Promise<void> {
    const page = this.pages.get(sessionId)
    if (page === undefined) return
    this.pages.delete(sessionId)
    await page.close().catch(() => undefined)
  }

  async closeAll(): Promise<void> {
    for (const [, page] of this.pages) await page.close().catch(() => undefined)
    this.pages.clear()
    const browser = this.browser
    this.browser = undefined
    this.launchPromise = undefined
    await browser?.close().catch(() => undefined)
  }

  /** True when pages live in a remote sandbox browser rather than local Chrome. */
  isRemote(): boolean {
    return this.cdpEndpoint !== undefined
  }
}

/** Honest degradation when playwright-core or Chrome is missing. */
export class UnavailableBrowserDriver implements BrowserDriver {
  readonly target = '（不可用）'

  async provisioned(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: 'browser use 未就绪：需要安装 playwright-core（可选依赖）与 Chrome/Chromium' }
  }

  private unavailable(): never {
    throw new Error('browser use is not provisioned on this host')
  }

  async navigate(): Promise<BrowserPageInfo> {
    this.unavailable()
  }

  async snapshot(): Promise<BrowserPageInfo> {
    this.unavailable()
  }

  async screenshot(): Promise<{ png: Buffer; url: string }> {
    this.unavailable()
  }

  async click(): Promise<void> {
    this.unavailable()
  }

  async fill(): Promise<void> {
    this.unavailable()
  }

  async evaluate(): Promise<string> {
    this.unavailable()
  }

  async close(): Promise<void> {}

  async closeAll(): Promise<void> {}
}

export function createBrowserDriver(
  launchOptions: Record<string, unknown> = { channel: 'chrome', headless: true },
  options: {
    cdpEndpoint?: () => Promise<string | undefined>
    loader?: () => Promise<LoadedPlaywright>
  } = {},
): BrowserDriver {
  // Lazy: even constructing the playwright driver is safe without the package;
  // the first provisioned()/call surfaces the real provisioning state.
  return new PlaywrightBrowserDriver(launchOptions, options)
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractLinks(html: string): string[] {
  const links: string[] = []
  const pattern = /<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null && links.length < 30) {
    const text = htmlToText(match[2] ?? '').slice(0, 80)
    const href = match[1] ?? ''
    if (href.startsWith('javascript:')) continue
    links.push(`${text || '(no text)'} -> ${href}`)
  }
  return links
}
