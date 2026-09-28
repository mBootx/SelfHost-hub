import { app, shell, BrowserWindow, ipcMain, dialog, safeStorage, protocol, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { createWriteStream, createReadStream, statSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { PassThrough } from 'stream'
import Store from 'electron-store'
import axios, { AxiosRequestConfig } from 'axios'
import {
  startHub,
  stopHub,
  pushLocalState,
  sendToDevice,
  currentDeviceList,
  isRunning,
  localLanAddress,
  REMOTE_CONTROL_PORT
} from './remoteHub'
import { initAutoUpdates } from './updater'

const store = new Store({ name: 'selfhost-hub-config' })

let mainWindow: BrowserWindow | null = null
let offlineDir = ''

// Must run before app is ready. Marking the scheme "standard"+"secure" lets a
// plain <audio src="offline://..."> load like any other media URL, in both
// dev (renderer served over http) and production (renderer served over
// file://) - a raw file:// src for a path outside the app bundle would be
// blocked as cross-origin in the http case and is unreliable in the other.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'offline',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true }
  }
])

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Lets the FileBrowser preview modal render PDFs inline via Chromium's
      // built-in viewer (an <iframe src="...pdf"> is a no-op without this).
      plugins: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  offlineDir = join(app.getPath('userData'), 'offline-music')
  mkdirSync(offlineDir, { recursive: true })

  protocol.handle('offline', (request) => {
    // Built with no authority (offline:///<filename>), so the whole path after
    // the scheme is the filename - keeps the mapping to disk unambiguous.
    const filename = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''))
    return net.fetch(pathToFileURL(join(offlineDir, filename)).toString())
  })

  registerIpc()
  createWindow()
  initAutoUpdates(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopHub()
  if (process.platform !== 'darwin') app.quit()
})

function registerIpc(): void {
  // Plain (non-sensitive) settings: server URLs, usernames, UI prefs
  ipcMain.handle('store:get', (_e, key: string) => store.get(key) ?? null)
  ipcMain.handle('store:set', (_e, key: string, value: unknown) => {
    store.set(key, value)
    return true
  })
  ipcMain.handle('store:delete', (_e, key: string) => {
    store.delete(key)
    return true
  })

  // Sensitive secrets (passwords/tokens): encrypted at rest via OS keychain (safeStorage)
  ipcMain.handle('secure:set', (_e, key: string, value: string) => {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(value)
      store.set(`secure.${key}`, encrypted.toString('base64'))
    } else {
      // Fallback: still keep it out of plain settings namespace
      store.set(`secure.${key}`, Buffer.from(value, 'utf-8').toString('base64'))
    }
    return true
  })
  ipcMain.handle('secure:get', (_e, key: string) => {
    const raw = store.get(`secure.${key}`) as string | undefined
    if (!raw) return null
    try {
      const buf = Buffer.from(raw, 'base64')
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(buf)
      }
      return buf.toString('utf-8')
    } catch {
      return null
    }
  })
  ipcMain.handle('secure:delete', (_e, key: string) => {
    store.delete(`secure.${key}`)
    return true
  })

  // Generic HTTP proxy so renderer calls to self-hosted services never hit
  // browser CORS restrictions (requests are issued from the main process).
  ipcMain.handle('net:request', async (_e, config: AxiosRequestConfig) => {
    try {
      const res = await axios.request({
        ...config,
        timeout: config.timeout ?? 20000,
        validateStatus: () => true
      })
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        data: res.data,
        headers: res.headers
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error'
      return { ok: false, status: 0, data: null, headers: {}, error: message }
    }
  })

  // FileBrowser: upload a locally-picked file by streaming its bytes with a raw PUT
  ipcMain.handle('fb:pickFiles', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (res.canceled) return []
    return res.filePaths.map((path) => ({ path, size: statSync(path).size }))
  })

  ipcMain.handle(
    'fb:uploadFile',
    async (
      event,
      args: {
        uploadId: string
        url: string
        filePath: string
        headers: Record<string, string>
        method?: 'PUT' | 'POST'
      }
    ) => {
      try {
        const total = statSync(args.filePath).size
        const sender = event.sender

        // Stream from disk instead of reading the whole file into memory so we can
        // report real progress/speed as the upload panel expects. Piping through a
        // PassThrough (rather than handing the fs stream straight to axios) means
        // backpressure from a slow network connection also throttles disk reads,
        // which keeps our "bytes read" progress an honest proxy for "bytes sent".
        const passthrough = new PassThrough()
        let loaded = 0
        let lastLoaded = 0
        let lastTick = Date.now()
        const readStream = createReadStream(args.filePath)
        readStream.on('data', (chunk: string | Buffer) => {
          loaded += Buffer.byteLength(chunk)
          const now = Date.now()
          const elapsed = (now - lastTick) / 1000
          if (elapsed >= 0.2 || loaded === total) {
            const speedBps = elapsed > 0 ? (loaded - lastLoaded) / elapsed : 0
            sender.send('fb:uploadProgress', { id: args.uploadId, loaded, total, speedBps })
            lastLoaded = loaded
            lastTick = now
          }
        })
        readStream.pipe(passthrough)

        const res = await axios.request({
          url: args.url,
          method: args.method || 'PUT',
          data: passthrough,
          headers: {
            ...args.headers,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(total)
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          validateStatus: () => true
        })
        return { ok: res.status >= 200 && res.status < 300, status: res.status }
      } catch (err) {
        return { ok: false, status: 0, error: err instanceof Error ? err.message : 'Upload failed' }
      }
    }
  )

  // Lets the downloads history reveal or launch a file the user saved earlier.
  ipcMain.handle('shell:showItemInFolder', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
    return { ok: true }
  })

  ipcMain.handle('shell:openPath', async (_e, filePath: string) => {
    const error = await shell.openPath(filePath)
    return { ok: !error, error: error || undefined }
  })

  // FileBrowser: download a remote file to a user-picked destination on disk
  ipcMain.handle(
    'fb:downloadFile',
    async (_e, args: { url: string; suggestedName: string; headers: Record<string, string> }) => {
      const save = await dialog.showSaveDialog({ defaultPath: args.suggestedName })
      if (save.canceled || !save.filePath) return { ok: false, canceled: true }
      try {
        const res = await axios.get(args.url, {
          headers: args.headers,
          responseType: 'stream',
          validateStatus: () => true
        })
        if (res.status < 200 || res.status >= 300) return { ok: false, status: res.status }
        await new Promise<void>((resolve, reject) => {
          const stream = createWriteStream(save.filePath as string)
          res.data.pipe(stream)
          stream.on('finish', () => resolve())
          stream.on('error', reject)
        })
        return { ok: true, path: save.filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Download failed' }
      }
    }
  )

  // Navidrome offline caching: pull a track's stream to local disk so playback
  // can later use it instead of hitting the server (see the "offline" protocol
  // registered above).
  ipcMain.handle(
    'offline:download',
    async (event, args: { id: string; url: string; extension: string }) => {
      const filename = `${args.id}.${args.extension || 'mp3'}`
      const filePath = join(offlineDir, filename)
      const sender = event.sender
      try {
        const res = await axios.get(args.url, { responseType: 'stream', validateStatus: () => true })
        if (res.status < 200 || res.status >= 300) return { ok: false, status: res.status }
        const total = Number(res.headers['content-length'] || 0)
        let loaded = 0
        let lastLoaded = 0
        let lastTick = Date.now()
        await new Promise<void>((resolve, reject) => {
          const stream = createWriteStream(filePath)
          res.data.on('data', (chunk: Buffer) => {
            loaded += chunk.length
            const now = Date.now()
            const elapsed = (now - lastTick) / 1000
            if (elapsed >= 0.2 || loaded === total) {
              const speedBps = elapsed > 0 ? (loaded - lastLoaded) / elapsed : 0
              sender.send('offline:downloadProgress', { id: args.id, loaded, total, speedBps })
              lastLoaded = loaded
              lastTick = now
            }
          })
          res.data.pipe(stream)
          stream.on('finish', () => resolve())
          stream.on('error', reject)
        })
        return { ok: true, filename }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Download failed' }
      }
    }
  )

  ipcMain.handle('offline:delete', (_e, args: { filename: string }) => {
    try {
      const filePath = join(offlineDir, args.filename)
      if (existsSync(filePath)) unlinkSync(filePath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Delete failed' }
    }
  })

  // Remote control: this app is the only side able to accept incoming
  // connections (see remoteHub.ts), so it hosts the local WebSocket hub that
  // phones on the same LAN connect to.
  ipcMain.handle('remote:start', (_e, args: { accountHash: string; deviceName: string }) => {
    if (!mainWindow) return { ok: false, error: 'Fenetre indisponible' }
    return startHub({ window: mainWindow, accountHash: args.accountHash, deviceName: args.deviceName })
  })
  ipcMain.handle('remote:stop', () => {
    stopHub()
    return { ok: true }
  })
  ipcMain.handle('remote:status', () => ({ running: isRunning(), address: localLanAddress(), port: REMOTE_CONTROL_PORT }))
  ipcMain.handle('remote:pushState', (_e, state: Record<string, unknown>) => {
    pushLocalState(state)
    return true
  })
  ipcMain.handle('remote:sendCommand', (_e, args: { targetId: string; command: unknown }) => {
    sendToDevice(args.targetId, args.command)
    return true
  })
  ipcMain.handle('remote:getDevices', () => currentDeviceList())
}
