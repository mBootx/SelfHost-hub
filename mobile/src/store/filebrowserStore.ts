import { create } from 'zustand'
import { FileBrowserClient, FBItem, SourceUsage } from '@/services/filebrowser'
import { storage } from '@/services/storage'
import { ConnectionStatus } from '@/types'

interface FileBrowserState {
  client: FileBrowserClient | null
  status: ConnectionStatus
  error: string | null

  currentPath: string
  items: FBItem[]
  viewMode: 'list' | 'grid'
  loading: boolean
  usage: SourceUsage | null

  history: string[]
  historyIndex: number
  canGoBack: boolean
  canGoForward: boolean

  connect: (url: string, username: string, password: string, remember: boolean) => Promise<void>
  restoreSession: () => Promise<void>
  logout: () => Promise<void>
  navigate: (path: string) => Promise<void>
  goBack: () => Promise<void>
  goForward: () => Promise<void>
  refresh: () => Promise<void>
  refreshUsage: () => Promise<void>
  /** Quiet check on app resume: renews an expired login without reloading the UI. */
  revalidate: () => Promise<void>
  setViewMode: (m: 'list' | 'grid') => void
}

/** Renews an expired JWT with the saved password; only a rejected password logs out (and wipes it). */
async function reauthenticate(get: () => FileBrowserState, client: FileBrowserClient): Promise<boolean> {
  try {
    await client.login()
    return true
  } catch (err: any) {
    if (err?.status === 401 || err?.status === 403) await get().logout()
    return false
  }
}

async function loadPath(
  get: () => FileBrowserState,
  set: (partial: Partial<FileBrowserState>) => void,
  path: string,
  retried = false
): Promise<void> {
  const { client } = get()
  if (!client) return
  set({ loading: true })
  try {
    const items = await client.list(path)
    set({ items, currentPath: path, loading: false })
  } catch (err: any) {
    if (err?.status === 401 && !retried && (await reauthenticate(get, client))) return loadPath(get, set, path, true)
    set({ loading: false, error: err?.message || 'Erreur de navigation' })
  }
}

export const useFileBrowserStore = create<FileBrowserState>((set, get) => ({
  client: null,
  status: 'disconnected',
  error: null,

  currentPath: '/',
  items: [],
  viewMode: 'list',
  loading: false,
  usage: null,

  history: ['/'],
  historyIndex: 0,
  canGoBack: false,
  canGoForward: false,

  connect: async (url, username, password, remember) => {
    set({ status: 'connecting', error: null })
    const client = new FileBrowserClient({ url, username, password })
    try {
      await client.login()
      set({ client, status: 'connected', history: ['/'], historyIndex: 0, canGoBack: false, canGoForward: false })
      if (remember) {
        await storage.saveConnection('filebrowser', { url, username })
        await storage.saveSecret('filebrowser', 'password', password)
      }
      await Promise.all([loadPath(get, set, '/'), get().refreshUsage()])
    } catch (err: any) {
      set({ status: 'error', error: err?.message || 'Connexion impossible' })
      throw err
    }
  },

  restoreSession: async () => {
    const conn = await storage.loadConnection('filebrowser')
    if (!conn) return
    const password = await storage.loadSecret('filebrowser', 'password')
    if (!password) return
    try {
      await get().connect(conn.url, conn.username, password, false)
    } catch {
      // stale credentials, stay logged out
    }
  },

  logout: async () => {
    await storage.clearConnection('filebrowser')
    await storage.clearSecret('filebrowser', 'password')
    set({
      client: null,
      status: 'disconnected',
      items: [],
      currentPath: '/',
      usage: null,
      history: ['/'],
      historyIndex: 0,
      canGoBack: false,
      canGoForward: false
    })
  },

  navigate: async (path) => {
    const { history, historyIndex } = get()
    const newHistory = [...history.slice(0, historyIndex + 1), path]
    set({ history: newHistory, historyIndex: newHistory.length - 1, canGoBack: newHistory.length > 1, canGoForward: false })
    await loadPath(get, set, path)
  },

  goBack: async () => {
    const { history, historyIndex } = get()
    if (historyIndex <= 0) return
    const newIndex = historyIndex - 1
    set({ historyIndex: newIndex, canGoBack: newIndex > 0, canGoForward: true })
    await loadPath(get, set, history[newIndex])
  },

  goForward: async () => {
    const { history, historyIndex } = get()
    if (historyIndex >= history.length - 1) return
    const newIndex = historyIndex + 1
    set({ historyIndex: newIndex, canGoBack: true, canGoForward: newIndex < history.length - 1 })
    await loadPath(get, set, history[newIndex])
  },

  refresh: async () => {
    await loadPath(get, set, get().currentPath)
    await get().refreshUsage()
  },

  refreshUsage: async () => {
    const { client } = get()
    if (!client) return
    try {
      const usage = await client.getCurrentSourceUsage()
      set({ usage })
    } catch {
      // usage reporting is best-effort, keep the explorer usable without it
    }
  },

  revalidate: async () => {
    const { client, status } = get()
    if (!client || status !== 'connected') {
      if (status !== 'connecting') await get().restoreSession()
      return
    }
    try {
      await client.list(get().currentPath)
    } catch (err: any) {
      if (err?.status === 401) await reauthenticate(get, client)
    }
  },

  setViewMode: (m) => set({ viewMode: m })
}))
