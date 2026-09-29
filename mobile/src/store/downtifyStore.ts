import { create } from 'zustand'
import { DowntifyClient, DowntifySong, QueueItem } from '@/services/downtify'
import { storage } from '@/services/storage'
import { ConnectionStatus } from '@/types'

function generateClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

interface DowntifyState {
  client: DowntifyClient | null
  status: ConnectionStatus
  error: string | null

  queue: QueueItem[]
  /** Songs fired at the server but not yet reflected by a queue poll - see startPolling. */
  activeDownloads: number
  pollHandle: ReturnType<typeof setInterval> | null

  connect: (url: string, remember: boolean) => Promise<void>
  restoreSession: () => Promise<void>
  logout: () => Promise<void>
  refreshQueue: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
  queueDownload: (song: DowntifySong) => Promise<void>
  requestDownload: (query: string, type: 'track' | 'album') => Promise<void>
  cancelQueueItem: (songId: string) => Promise<void>
  clearQueue: () => Promise<void>
}

export const useDowntifyStore = create<DowntifyState>((set, get) => ({
  client: null,
  status: 'disconnected',
  error: null,
  queue: [],
  activeDownloads: 0,
  pollHandle: null,

  connect: async (url, remember) => {
    set({ status: 'connecting', error: null })
    let clientId = await storage.loadPref<string>('downtify.clientId')
    if (!clientId) {
      clientId = generateClientId()
      await storage.savePref('downtify.clientId', clientId)
    }
    const client = new DowntifyClient({ url }, clientId)
    try {
      await client.testConnection()
      set({ client, status: 'connected' })
      if (remember) {
        await storage.saveConnection('downtify', { url, username: '' })
      }
      get().startPolling()
      await get().refreshQueue()
    } catch (err: any) {
      set({ status: 'error', error: err?.message || 'Connexion impossible' })
      throw err
    }
  },

  restoreSession: async () => {
    const conn = await storage.loadConnection('downtify')
    if (!conn) return
    try {
      await get().connect(conn.url, false)
    } catch {
      // service unreachable, stay logged out
    }
  },

  logout: async () => {
    get().stopPolling()
    await storage.clearConnection('downtify')
    set({ client: null, status: 'disconnected', queue: [] })
  },

  refreshQueue: async () => {
    const { client } = get()
    if (!client) return
    try {
      const queue = await client.getQueue()
      set({ queue })
    } catch {
      // transient network hiccup, keep the last known queue
    }
  },

  startPolling: () => {
    get().stopPolling()
    // Only poll while something is actually moving. activeDownloads covers the
    // gap right after firing a download, before a queue refresh has had a
    // chance to show it as queued/downloading - without it, an idle connection
    // never re-checks and a fresh download sits invisible until it's done.
    const handle = setInterval(() => {
      const { queue, activeDownloads } = get()
      const active = activeDownloads > 0 || queue.some((q) => q.status === 'downloading' || q.status === 'queued')
      if (active) get().refreshQueue()
    }, 2000)
    set({ pollHandle: handle })
  },

  stopPolling: () => {
    const { pollHandle } = get()
    if (pollHandle) clearInterval(pollHandle)
    set({ pollHandle: null })
  },

  // A single song already resolved by search (no need to search again). Fires
  // the download and bootstraps polling immediately rather than waiting for the
  // request itself, which only resolves once the server has finished the whole
  // download and transcode - that wait is what made the UI look frozen with no
  // progress shown.
  queueDownload: async (song) => {
    const { client } = get()
    if (!client) throw new Error('Downtify non connecté')
    set((s) => ({ activeDownloads: s.activeDownloads + 1 }))
    get().startPolling()
    setTimeout(() => get().refreshQueue(), 500)
    setTimeout(() => set((s) => ({ activeDownloads: Math.max(0, s.activeDownloads - 1) })), 5000)
    await client.downloadByUrl(song.url)
  },

  requestDownload: async (query, type) => {
    const { client } = get()
    if (!client) throw new Error('Downtify non connecté')
    const targets = await client.queueByQuery(query, type)
    set((s) => ({ activeDownloads: s.activeDownloads + targets.length }))
    get().startPolling()
    setTimeout(() => get().refreshQueue(), 500)
    setTimeout(() => set((s) => ({ activeDownloads: Math.max(0, s.activeDownloads - targets.length) })), 5000)
  },

  cancelQueueItem: async (songId) => {
    const { client } = get()
    if (!client) return
    await client.cancelQueueItem(songId)
    await get().refreshQueue()
  },

  clearQueue: async () => {
    const { client } = get()
    if (!client) return
    await client.clearQueue()
    await get().refreshQueue()
  }
}))
