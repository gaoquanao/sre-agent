/**
 * Sandboxed preload bridge.
 *
 * CommonJS on purpose: with `sandbox: true` a renderer can only load a
 * CommonJS preload script, and package.json declares `"type": "module"`, so the
 * file has to use the explicit `.cjs` extension.
 *
 * Only these four fixed operations cross the bridge; there is no generic
 * `invoke(channel, ...)` passthrough, so the renderer cannot reach arbitrary
 * main-process channels.
 */
const { contextBridge, ipcRenderer } = require('electron')

const LOG_CHANNEL = 'server:log'

contextBridge.exposeInMainWorld('sreDesktop', {
  /** @returns {Promise<{url: string|null, port: number|null, home: string, kernel: string}>} */
  getServerInfo: () => ipcRenderer.invoke('server:info'),

  /** Stops and starts the backend, then reloads the window. */
  restartServer: () => ipcRenderer.invoke('server:restart'),

  /** Reveals the data directory (SRE_AGENT_HOME) in the OS file manager. */
  openDataDir: () => ipcRenderer.invoke('server:open-data-dir'),

  /**
   * Subscribes to backend log lines forwarded by the main process.
   * @param {(payload: {stream: 'stdout'|'stderr', line: string}) => void} callback
   * @returns {() => void} unsubscribe
   */
  onServerLog: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onServerLog expects a function')
    const listener = (_event, payload) => {
      callback(payload)
    }
    ipcRenderer.on(LOG_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(LOG_CHANNEL, listener)
    }
  },
})
