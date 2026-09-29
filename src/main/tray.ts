import { app, BrowserWindow, ipcMain, Menu, Tray } from 'electron'
import type Store from 'electron-store'
import type { NowPlaying, TrayCommand, TraySettings } from '../preload/index'
// Unpacked from the asar archive: Windows loads .ico files itself, and can't read inside it.
import trayIcon from '../../build/icon.ico?asset&asarUnpack'

const CLOSE_TO_TRAY_KEY = 'prefs.tray.closeToTray'
const HINT_SHOWN_KEY = 'prefs.tray.hintShown'
/** Passed by the login item, so a start with Windows doesn't pop the window up. */
export const HIDDEN_ARG = '--hidden'

let tray: Tray | null = null
let nowPlaying: NowPlaying | null = null
let quitting = false

// Every real quit (tray menu, installing an update, Windows shutting down) goes through here first.
app.on('before-quit', () => {
  quitting = true
})

/** Menu labels treat "&" as an accelerator marker. */
function menuText(text: string): string {
  const escaped = text.replace(/&/g, '&&')
  return escaped.length > 60 ? `${escaped.slice(0, 59)}…` : escaped
}

export function showWindow(win: BrowserWindow | null): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function initTray(getWindow: () => BrowserWindow | null, store: Store): void {
  const send = (command: TrayCommand): void => getWindow()?.webContents.send('tray:command', command)

  const rebuild = (): void => {
    if (!tray) return
    tray.setToolTip(nowPlaying ? `SelfHost Hub - ${nowPlaying.title} - ${nowPlaying.artist}`.slice(0, 127) : 'SelfHost Hub')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: nowPlaying ? menuText(`${nowPlaying.title} - ${nowPlaying.artist}`) : 'Aucune lecture', enabled: false },
        { type: 'separator' },
        { label: nowPlaying?.isPlaying ? 'Pause' : 'Lecture', enabled: !!nowPlaying, click: () => send('toggle') },
        { label: 'Suivant', enabled: !!nowPlaying, click: () => send('next') },
        { label: 'Précédent', enabled: !!nowPlaying, click: () => send('prev') },
        { type: 'separator' },
        { label: 'Afficher SelfHost Hub', click: () => showWindow(getWindow()) },
        { label: 'Quitter', click: () => app.quit() }
      ])
    )
  }

  tray = new Tray(trayIcon)
  tray.on('click', () => showWindow(getWindow()))
  rebuild()

  ipcMain.handle('tray:setNowPlaying', (_e, info: NowPlaying | null) => {
    nowPlaying = info
    rebuild()
  })

  ipcMain.handle('tray:getSettings', (): TraySettings => ({
    closeToTray: store.get(CLOSE_TO_TRAY_KEY, true) as boolean,
    openAtLogin: app.getLoginItemSettings().openAtLogin
  }))

  ipcMain.handle('tray:setSettings', (_e, next: Partial<TraySettings>): TraySettings => {
    if (next.closeToTray !== undefined) store.set(CLOSE_TO_TRAY_KEY, next.closeToTray)
    // Only an installed build can register itself: in development this would start electron.exe.
    if (next.openAtLogin !== undefined && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: next.openAtLogin, args: [HIDDEN_ARG] })
    }
    return {
      closeToTray: store.get(CLOSE_TO_TRAY_KEY, true) as boolean,
      openAtLogin: app.getLoginItemSettings().openAtLogin
    }
  })

  // Hide instead of closing, unless the app is really quitting.
  app.on('browser-window-created', (_e, win) => {
    win.on('close', (event) => {
      if (quitting || !(store.get(CLOSE_TO_TRAY_KEY, true) as boolean)) return
      event.preventDefault()
      win.hide()
      if (!store.get(HINT_SHOWN_KEY)) {
        store.set(HINT_SHOWN_KEY, true)
        tray?.displayBalloon({
          iconType: 'info',
          title: 'SelfHost Hub continue en arrière-plan',
          content: "La lecture continue. Pour quitter, faites un clic droit sur l'icône près de l'horloge."
        })
      }
    })
  })
}
