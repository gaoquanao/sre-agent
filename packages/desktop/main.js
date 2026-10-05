/**
 * SRE Agent desktop shell.
 *
 * The web UI is the only functional surface; this process does two things:
 *   1. own the @sre/server child process (start, readiness, restart, teardown),
 *   2. display whatever the server serves in a hardened BrowserWindow.
 *
 * Written as an ES module (`"type": "module"` in package.json, Electron >= 28
 * supports ESM in the main process). Two consequences worth knowing:
 *   - the module must not contain a top-level `await`: Electron emits `ready`
 *     only after the main module has finished evaluating, so a pending
 *     top-level await keeps it pending forever and `app.whenReady()` never
 *     settles. Verified on Electron 44.5.1: with a top-level await the app
 *     never becomes ready, with the identical code wrapped in a function it is
 *     ready in ~250ms. All asynchronous work therefore lives in `bootstrap()`,
 *     which is called without `await`,
 *   - the sandboxed preload script stays CommonJS (`preload.cjs`), because a
 *     sandboxed renderer can only load CommonJS preloads.
 */
import { app, BrowserWindow, Menu, ipcMain, screen, session, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ServerProcess } from './server-process.js'

const APP_DIR = dirname(fileURLToPath(import.meta.url))
const RENDERER_DIR = join(APP_DIR, 'renderer')
const WINDOW_WIDTH = 1440
const WINDOW_HEIGHT = 900
const MIN_WIDTH = 1024
const MIN_HEIGHT = 640
const SAVE_WINDOW_STATE_DEBOUNCE_MS = 400

/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {ServerProcess | null} */
let server = null
/** Origin of the loaded app; navigations inside it are allowed. */
let appOrigin = null
/** True once the initial URL has been loaded, so later `ready` states reload. */
let initialLoadDone = false
let windowStateSaveTimer = null
let shutdownPromise = null
let shutdownDone = false

// A stable app name (and therefore a stable userData directory) regardless of
// how the shell was launched: `electron .`, `npm run dev -w @sre/desktop`,
// a packaged build, or a bare `electron main.js`.
app.setName('SRE Agent')

if (!app.requestSingleInstanceLock()) {
  // Another instance already owns the profile and the server child process.
  app.quit()
} else {
  // Deliberately not awaited — see the header note: a top-level await here
  // would keep the module's evaluation pending and `ready` would never fire.
  void bootstrap().catch((error) => {
    console.error('[desktop] fatal error during startup:', error)
    app.exit(1)
  })
}

async function bootstrap() {
  app.on('second-instance', () => {
    focusMainWindow()
  })

  // Navigation guards only touch `app`, so they can be installed before ready.
  registerNavigationGuards()

  await app.whenReady()

  buildApplicationMenu()
  registerSecurityGuards()

  const paths = resolvePaths()
  server = new ServerProcess({
    repoRoot: paths.repoRoot,
    home: paths.home,
    logFile: paths.logFile,
    webDist: paths.webDist,
    // readyTimeoutMs defaults to 30s inside ServerProcess.
  })
  registerIpcHandlers()
  wireServerEvents(server)

  createWindow()
  showStatusPage('loading')

  registerShutdownHandlers()

  try {
    const info = await server.start()
    await loadAppUrl(info.url)
  } catch (error) {
    showStatusPage('error', error)
  }
}

function registerShutdownHandlers() {
  app.on('window-all-closed', () => {
    // Closing the last window ends the session on every platform: the desktop
    // shell exists to manage the server process, so it must not linger in the
    // background holding a live backend while showing no UI.
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (shutdownDone) return
    event.preventDefault()
    void shutdown().finally(() => {
      shutdownDone = true
      app.exit(0)
    })
  })

  app.on('will-quit', () => {
    // Last synchronous chance to make sure the child cannot outlive us.
    server?.killSync()
  })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      // Installing a listener disables Node's default exit-on-signal, so the
      // app has to terminate explicitly after the child is reaped.
      void shutdown().finally(() => app.exit(0))
    })
  }
}

// -- paths ------------------------------------------------------------------

/**
 * Repository root that contains `packages/server`. In development the shell
 * runs from `<repo>/packages/desktop`, so the lock file is a few levels up.
 */
function resolveRepoRoot() {
  const fromEnv = process.env.SRE_AGENT_REPO_ROOT
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv)
  let dir = APP_DIR
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'packages', 'server'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(APP_DIR, '..', '..')
}

function resolvePaths() {
  const repoRoot = resolveRepoRoot()
  const userData = app.getPath('userData')
  return {
    repoRoot,
    // All platform state (db, kernel homes, skills, workspace) lives here.
    home: join(userData, 'sre-agent'),
    logFile: join(userData, 'logs', 'server.log'),
    // The server serves the built web UI itself; the shell only points at it.
    webDist: join(repoRoot, 'packages', 'web', 'dist'),
  }
}

// -- window -----------------------------------------------------------------

function createWindow() {
  const state = sanitizeWindowState(readWindowState())
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x === undefined ? {} : { x: state.x, y: state.y }),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'SRE Agent',
    show: false,
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(APP_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  })

  mainWindow = win
  if (state.maximized) win.maximize()
  win.once('ready-to-show', () => {
    win.show()
  })
  // Keep the window title fixed; the web UI owns its own in-page headings.
  win.on('page-title-updated', (event) => {
    event.preventDefault()
  })
  for (const eventName of ['resize', 'move', 'maximize', 'unmaximize']) {
    win.on(eventName, scheduleWindowStateSave)
  }
  win.on('close', () => {
    saveWindowState()
  })
  win.on('closed', () => {
    mainWindow = null
  })
  return win
}

function focusMainWindow() {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    createWindow()
    const info = server?.getInfo()
    if (info !== null && info !== undefined && info.state === 'ready' && info.url !== null) {
      void loadAppUrl(info.url)
    } else {
      showStatusPage('loading')
    }
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function windowStatePath() {
  return join(app.getPath('userData'), 'window-state.json')
}

function readWindowState() {
  try {
    const parsed = JSON.parse(readFileSync(windowStatePath(), 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    // First run, unreadable file or corrupt JSON: fall back to defaults.
    return {}
  }
}

/** Clamps persisted bounds so the window cannot be restored off-screen. */
function sanitizeWindowState(state) {
  const width = Number.isFinite(state.width) ? Math.max(MIN_WIDTH, Math.round(state.width)) : WINDOW_WIDTH
  const height = Number.isFinite(state.height) ? Math.max(MIN_HEIGHT, Math.round(state.height)) : WINDOW_HEIGHT
  let x = Number.isFinite(state.x) ? Math.round(state.x) : undefined
  let y = Number.isFinite(state.y) ? Math.round(state.y) : undefined
  if (x !== undefined && y !== undefined && !isVisibleOnSomeDisplay({ x, y, width, height })) {
    x = undefined
    y = undefined
  }
  return { width, height, x, y, maximized: state.maximized === true }
}

function isVisibleOnSomeDisplay(rect) {
  const MIN_VISIBLE = 80
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    const overlapW = Math.min(area.x + area.width, rect.x + rect.width) - Math.max(area.x, rect.x)
    const overlapH = Math.min(area.y + area.height, rect.y + rect.height) - Math.max(area.y, rect.y)
    return overlapW >= MIN_VISIBLE && overlapH >= MIN_VISIBLE
  })
}

function scheduleWindowStateSave() {
  if (windowStateSaveTimer !== null) clearTimeout(windowStateSaveTimer)
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null
    saveWindowState()
  }, SAVE_WINDOW_STATE_DEBOUNCE_MS)
}

function saveWindowState() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  try {
    const bounds = mainWindow.getNormalBounds()
    const payload = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: mainWindow.isMaximized(),
    }
    const file = windowStatePath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  } catch {
    // Window geometry is a convenience; never let it break shutdown.
  }
}

// -- rendering --------------------------------------------------------------

async function loadAppUrl(url) {
  appOrigin = new URL(url).origin
  if (mainWindow === null || mainWindow.isDestroyed()) return
  await mainWindow.loadURL(url)
  initialLoadDone = true
}

/**
 * Fallback surface used while the backend starts and when it fails to start:
 * it shows the live server log, the failure reason, a retry button and a button
 * that reveals the data directory.
 */
function showStatusPage(state, error) {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (error !== undefined) console.error(`[desktop] server unavailable: ${error.message}`)
  void mainWindow.loadFile(join(RENDERER_DIR, 'status.html'), { query: { state } })
}

function wireServerEvents(instance) {
  instance.on('log', (payload) => {
    sendToRenderer('server:log', payload)
  })
  instance.on('status', (status) => {
    if (status.state === 'crashed' || status.state === 'restarting') {
      showStatusPage('loading')
      return
    }
    if (status.state === 'failed') {
      showStatusPage('error')
      return
    }
    if (status.state === 'ready' && initialLoadDone) {
      // The backend came back on possibly new port: point the window at it.
      void loadAppUrl(status.url).catch(() => {
        showStatusPage('error')
      })
    }
  })
}

function sendToRenderer(channel, payload) {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

// -- ipc --------------------------------------------------------------------

/**
 * Fixed, purpose-built channels only: the renderer can never invoke an
 * arbitrary IPC channel through the preload bridge.
 */
function registerIpcHandlers() {
  ipcMain.handle('server:info', () => server.getInfo())

  ipcMain.handle('server:restart', async () => {
    try {
      const info = await server.restart()
      await loadAppUrl(info.url)
      return { ok: true, info }
    } catch (error) {
      showStatusPage('error', error)
      return {
        ok: false,
        error: { message: error.message, code: error.code ?? null },
        info: server.getInfo(),
      }
    }
  })

  ipcMain.handle('server:open-data-dir', async () => {
    // The directory only appears once the server initializes; make sure the
    // file manager has something to reveal either way.
    mkdirSync(server.home, { recursive: true })
    const error = await shell.openPath(server.home)
    return error.length === 0 ? { ok: true } : { ok: false, error }
  })
}

// -- menu -------------------------------------------------------------------

function buildApplicationMenu() {
  const isMac = process.platform === 'darwin'
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    ...(isMac
      ? []
      : [
          {
            label: 'File',
            submenu: [{ label: 'Exit', accelerator: 'Ctrl+Q', click: () => app.quit() }],
          },
        ]),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Restart Backend', click: () => void restartFromMenu() },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function restartFromMenu() {
  if (server === null) return
  showStatusPage('loading')
  try {
    const info = await server.restart()
    await loadAppUrl(info.url)
  } catch (error) {
    showStatusPage('error', error)
  }
}

// -- security ---------------------------------------------------------------

function registerNavigationGuards() {
  // Applied to every webContents (including ones created in the future).
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (isInternalUrl(url)) return
      event.preventDefault()
      openExternal(url)
    })
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
  })
}

function registerSecurityGuards() {
  // The UI needs no device permissions; deny anything a page might ask for.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
}

function isInternalUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      // Local fallback pages shipped with the shell.
      return resolve(parsed.pathname) === RENDERER_DIR || resolve(parsed.pathname).startsWith(`${RENDERER_DIR}/`)
    }
    if (appOrigin === null) return false
    return parsed.origin === appOrigin
  } catch {
    return false
  }
}

/** Only ever hands web/mail URLs to the OS; anything else is dropped. */
function openExternal(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return
  void shell.openExternal(url)
}

// -- shutdown ---------------------------------------------------------------

/** Memoised so concurrent quit paths cannot stop the child twice. */
function shutdown() {
  if (shutdownPromise === null) {
    shutdownPromise = (async () => {
      try {
        await server?.stop()
      } catch {
        // A stop failure must not block quitting; the killSync fallbacks cover it.
        server?.killSync()
      }
    })()
  }
  return shutdownPromise
}
