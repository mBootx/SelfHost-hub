import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateCheckOutcome } from '../preload/index'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let downloadedVersion: string | null = null

/** Checks GitHub releases (`build.publish` in package.json) at launch and every 6 h; installs on quit. */
export function initAutoUpdates(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('updater:currentVersion', () => app.getVersion())
  ipcMain.handle('updater:downloadedVersion', () => downloadedVersion)
  ipcMain.handle('updater:installNow', () => {
    if (downloadedVersion) autoUpdater.quitAndInstall(true, true)
  })
  ipcMain.handle('updater:check', async (): Promise<UpdateCheckOutcome> => {
    if (!app.isPackaged) return { status: 'dev' }
    if (downloadedVersion) return { status: 'ready', version: downloadedVersion }
    const result = await autoUpdater.checkForUpdates()
    const latest = result?.updateInfo.version ?? app.getVersion()
    return latest === app.getVersion() ? { status: 'current', version: latest } : { status: 'downloading', version: latest }
  })

  // Updates only exist for installed builds; `npm run dev` has no update metadata to check against.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    getWindow()?.webContents.send('updater:downloaded', { version: info.version })
  })
  // Offline, rate-limited or no release yet: none of that is worth interrupting the user for.
  autoUpdater.on('error', () => {})

  const check = (): void => {
    autoUpdater.checkForUpdates().catch(() => {})
  }
  check()
  setInterval(check, CHECK_INTERVAL_MS)
}
