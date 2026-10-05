/**
 * Fallback page shown while the backend starts and when it fails to start.
 * It only talks to main through the fixed `window.sreDesktop` bridge.
 */
const bridge = window.sreDesktop
const params = new URLSearchParams(window.location.search)
const startedInErrorState = params.get('state') === 'error'

const titleEl = document.getElementById('title')
const detailEl = document.getElementById('detail')
const metaEl = document.getElementById('meta')
const logEl = document.getElementById('log')
const retryEl = document.getElementById('retry')
const openDataDirEl = document.getElementById('open-data-dir')

let logLines = []
let busy = false
/** Message of the last failed restart attempt; kept visible across polls. */
let restartError = null

function setTitle(text, failed) {
  titleEl.textContent = ''
  if (!failed) {
    const spinner = document.createElement('span')
    spinner.className = 'spinner'
    titleEl.append(spinner)
  }
  titleEl.append(document.createTextNode(text))
  titleEl.className = failed ? 'failed' : ''
}

function renderLog() {
  logEl.textContent = logLines.length === 0 ? 'no log output yet' : logLines.join('\n')
  logEl.scrollTop = logEl.scrollHeight
}

function appendLog(line) {
  logLines.push(line)
  if (logLines.length > 500) logLines = logLines.slice(-500)
  renderLog()
}

function renderPending(info, elapsedMs) {
  setTitle('Starting the backend…', false)
  detailEl.textContent = `Waiting for the server process to report readiness (${Math.round(elapsedMs / 1000)}s).`
  metaEl.textContent = [info.home, info.logFile, info.entry === null ? null : info.entry.path]
    .filter(Boolean)
    .join('  ·  ')
  retryEl.hidden = true
}

function renderFailure(info) {
  const failure = info.error ?? {}
  setTitle('The backend could not be started', true)
  detailEl.textContent = restartError ?? failure.message ?? 'The server process is not running.'
  metaEl.textContent = [
    `state: ${info.state}`,
    `home: ${info.home}`,
    `log: ${info.logFile}`,
    info.lastExit === null ? null : `last exit: code=${info.lastExit.code} signal=${info.lastExit.signal}`,
  ]
    .filter(Boolean)
    .join('  ·  ')
  retryEl.hidden = false
}

async function refresh() {
  if (bridge === undefined) {
    setTitle('Desktop bridge unavailable', true)
    detailEl.textContent = 'This page is meant to run inside the SRE Agent desktop shell.'
    return
  }
  const info = await bridge.getServerInfo()
  if (info.logTail.length > 0) {
    logLines = info.logTail
    renderLog()
  }
  if (info.state === 'failed') {
    renderFailure(info)
    return
  }
  const elapsedMs = info.startedAt === null ? 0 : Date.now() - info.startedAt
  renderPending(info, elapsedMs)
}

async function onRetry() {
  if (busy) return
  busy = true
  restartError = null
  retryEl.disabled = true
  retryEl.textContent = 'Restarting…'
  setTitle('Starting the backend…', false)
  detailEl.textContent = 'Restarting the server process.'
  try {
    const result = await bridge.restartServer()
    if (!result.ok) {
      restartError = result.error?.message ?? 'Restart failed.'
      detailEl.textContent = restartError
      return
    }
    // On success the main process navigates this window to the app URL.
  } catch (error) {
    restartError = `Restart failed: ${error.message}`
    detailEl.textContent = restartError
  } finally {
    busy = false
    retryEl.disabled = false
    retryEl.textContent = 'Restart backend'
  }
}

retryEl.addEventListener('click', () => {
  void onRetry()
})

openDataDirEl.addEventListener('click', () => {
  if (bridge === undefined) return
  void bridge.openDataDir()
})

if (bridge !== undefined) {
  bridge.onServerLog(({ stream, line }) => {
    appendLog(`[${stream}] ${line}`)
  })
}

void refresh()
if (startedInErrorState) retryEl.hidden = false
setInterval(() => {
  if (!busy) void refresh()
}, 1000)
