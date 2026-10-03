import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AxiosRequestConfig } from 'axios'

export type UpdateCheckOutcome = { status: 'dev' } | { status: 'current' | 'downloading' | 'ready'; version: string }

export interface NowPlaying {
  title: string
  artist: string
  isPlaying: boolean
}

export interface TraySettings {
  /** Closing the window hides it in the notification area and playback carries on. */
  closeToTray: boolean
  /** Starts with Windows, straight into the notification area. */
  openAtLogin: boolean
}

export type TrayCommand = 'toggle' | 'next' | 'prev'

const api = {
  window: {
    /** Real full screen (the taskbar goes too), for the full-screen player. Resolves with whether the window is in it. */
    setFullScreen: (on: boolean): Promise<boolean> => ipcRenderer.invoke('window:setFullScreen', on),
    isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:isFullScreen'),
    /** Told when the window enters or leaves full screen, whoever asked. */
    onFullScreenChange: (callback: (on: boolean) => void) => {
      const listener = (_event: unknown, on: boolean): void => callback(on)
      ipcRenderer.on('window:fullScreen', listener)
      return (): void => {
        ipcRenderer.removeListener('window:fullScreen', listener)
      }
    }
  },
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('store:delete', key)
  },
  secure: {
    get: (key: string) => ipcRenderer.invoke('secure:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('secure:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('secure:delete', key)
  },
  net: {
    request: (config: AxiosRequestConfig) => ipcRenderer.invoke('net:request', config)
  },
  shell: {
    showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
    openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath)
  },
  fb: {
    pickFiles: () => ipcRenderer.invoke('fb:pickFiles'),
    // Electron 32 removed the nonstandard File.path property (security fix), so
    // dropped-file paths must be resolved this way instead - see webUtils docs.
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    uploadFile: (args: {
      uploadId: string
      url: string
      filePath: string
      headers: Record<string, string>
      method?: 'PUT' | 'POST'
    }) => ipcRenderer.invoke('fb:uploadFile', args),
    downloadFile: (args: { url: string; suggestedName: string; headers: Record<string, string> }) =>
      ipcRenderer.invoke('fb:downloadFile', args),
    onUploadProgress: (
      callback: (data: { id: string; loaded: number; total: number; speedBps: number }) => void
    ) => {
      const listener = (_event: unknown, data: { id: string; loaded: number; total: number; speedBps: number }): void =>
        callback(data)
      ipcRenderer.on('fb:uploadProgress', listener)
      return () => ipcRenderer.removeListener('fb:uploadProgress', listener)
    }
  },
  offline: {
    download: (args: { id: string; url: string; extension: string }) => ipcRenderer.invoke('offline:download', args),
    delete: (args: { filename: string }) => ipcRenderer.invoke('offline:delete', args),
    onDownloadProgress: (
      callback: (data: { id: string; loaded: number; total: number; speedBps: number }) => void
    ) => {
      const listener = (_event: unknown, data: { id: string; loaded: number; total: number; speedBps: number }): void =>
        callback(data)
      ipcRenderer.on('offline:downloadProgress', listener)
      return () => ipcRenderer.removeListener('offline:downloadProgress', listener)
    }
  },
  updater: {
    check: (): Promise<UpdateCheckOutcome> => ipcRenderer.invoke('updater:check'),
    currentVersion: (): Promise<string> => ipcRenderer.invoke('updater:currentVersion'),
    downloadedVersion: (): Promise<string | null> => ipcRenderer.invoke('updater:downloadedVersion'),
    installNow: () => ipcRenderer.invoke('updater:installNow'),
    onDownloaded: (callback: (info: { version: string }) => void) => {
      const listener = (_event: unknown, info: { version: string }): void => callback(info)
      ipcRenderer.on('updater:downloaded', listener)
      return (): void => {
        ipcRenderer.removeListener('updater:downloaded', listener)
      }
    }
  },
  tray: {
    setNowPlaying: (info: NowPlaying | null) => ipcRenderer.invoke('tray:setNowPlaying', info),
    getSettings: (): Promise<TraySettings> => ipcRenderer.invoke('tray:getSettings'),
    setSettings: (next: Partial<TraySettings>): Promise<TraySettings> => ipcRenderer.invoke('tray:setSettings', next),
    onCommand: (callback: (command: TrayCommand) => void) => {
      const listener = (_event: unknown, command: TrayCommand): void => callback(command)
      ipcRenderer.on('tray:command', listener)
      return (): void => {
        ipcRenderer.removeListener('tray:command', listener)
      }
    }
  },
  wol: {
    wake: (mac: string, broadcast: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('wol:wake', { mac, broadcast })
  },
  remote: {
    start: (args: { deviceName: string }) => ipcRenderer.invoke('remote:start', args),
    pairingCode: (): Promise<string> => ipcRenderer.invoke('remote:pairingCode'),
    newPairingCode: (): Promise<string> => ipcRenderer.invoke('remote:newPairingCode'),
    stop: () => ipcRenderer.invoke('remote:stop'),
    status: () => ipcRenderer.invoke('remote:status'),
    pushState: (state: Record<string, unknown>) => ipcRenderer.invoke('remote:pushState', state),
    sendCommand: (targetId: string, command: unknown) => ipcRenderer.invoke('remote:sendCommand', { targetId, command }),
    getDevices: () => ipcRenderer.invoke('remote:getDevices'),
    onDeviceListChanged: (callback: (devices: unknown[]) => void) => {
      const listener = (_event: unknown, devices: unknown[]): void => callback(devices)
      ipcRenderer.on('remote:deviceListChanged', listener)
      return () => ipcRenderer.removeListener('remote:deviceListChanged', listener)
    },
    onDeviceState: (callback: (data: Record<string, any>) => void) => {
      const listener = (_event: unknown, data: Record<string, any>): void => callback(data)
      ipcRenderer.on('remote:deviceState', listener)
      return () => ipcRenderer.removeListener('remote:deviceState', listener)
    },
    onCommand: (callback: (command: Record<string, any>) => void) => {
      const listener = (_event: unknown, command: Record<string, any>): void => callback(command)
      ipcRenderer.on('remote:command', listener)
      return () => ipcRenderer.removeListener('remote:command', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type HubApi = typeof api
