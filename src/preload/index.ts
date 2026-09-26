import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AxiosRequestConfig } from 'axios'

const api = {
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
  remote: {
    start: (args: { accountHash: string; deviceName: string }) => ipcRenderer.invoke('remote:start', args),
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
