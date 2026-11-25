import { create } from 'zustand'
import { describeError, logEvent } from '@/services/diagnostics'
import { DowntifyClient, DowntifySong, HubDowntifyProxy, QueueItem } from '@/services/downtify'
import { HubServerClient } from '@/services/hubServer'
import { scanLibrary } from '@/services/libraryScan'
import { storage } from '@/services/storage'
import { useRemoteStore } from '@/store/remoteStore'
import { ConnectionStatus } from '@/types'

function generateClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getHubProxy(): HubDowntifyProxy | null {
  const { client } = useRemoteStore.getState()
  if (!(client instanceof HubServerClient) || !client.connected) return null
  if (!client.hasFeature('downtify')) return null
  const apiToken = client.getApiToken()
  const baseUrl = client.getServerUrl()
  if (!apiToken || !baseUrl) return null
  return { baseUrl, apiToken }
}

let hubSubscribed = false
let loggedOutByUser = false

interface DowntifyState {
  client: DowntifyClient | null
  status: ConnectionStatus
  error: string | null
  /** True when requests are currently routed through the Hub server proxy instead of the LAN Downtify URL. */
  viaHub: boolean

  queue: QueueItem[]
  completedSongs: DowntifySong[]
  /** Songs fired at the server but not yet reflected by a queue poll - see startPolling. */
  activeDownloads: number
  /** Timestamp bumped whenever a Downtify download finishes and Navidrome has scanned it. */
  lastCompletedAt: number
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

export const useDowntifyStore = create<DowntifyState>((set, get) => {
  function ensureHubSubscription(): void {
    if (hubSubscribed || typeof useRemoteStore.subscribe !== 'function') return
    hubSubscribed = true
    useRemoteStore.subscribe((remote, prev) => {
      if (remote.serverUrl !== prev.serverUrl) loggedOutByUser = false
      if (remote.status === 'connected' && getHubProxy()) {
        if (!loggedOutByUser && get().status !== 'connected') {
          void get().restoreSession()
        }
      } else if (prev.status === 'connected' && remote.status !== 'connected' && get().viaHub) {
        void storage.loadConnection('downtify').then((conn) => {
          if (conn?.url) {
            void get().restoreSession()
          } else if (get().viaHub) {
            get().stopPolling()
            set({ client: null, status: 'disconnected', viaHub: false, queue: [] })
          }
        })
      }
    })
  }

  return {
    client: null,
    status: 'disconnected',
    error: null,
    viaHub: false,
    queue: [],
    completedSongs: [],
    activeDownloads: 0,
    lastCompletedAt: 0,
    pollHandle: null,

    connect: async (url, remember) => {
      ensureHubSubscription()
      loggedOutByUser = false
      const normalizedUrl = (url ?? '').trim()
      set({ status: 'connecting', error: null, viaHub: false })
      if (!normalizedUrl && !getHubProxy()) {
        const msg = 'Adresse Downtify manquante'
        set({ status: 'error', error: msg })
        throw new Error(msg)
      }
      let clientId = await storage.loadPref<string>('downtify.clientId')
      if (!clientId) {
        clientId = generateClientId()
        await storage.savePref('downtify.clientId', clientId)
      }
      const client = new DowntifyClient(
        {
          url: normalizedUrl,
          getHubProxy,
          onTransportChange: (viaHub) => {
            if (get().client === client) set({ viaHub })
          }
        },
        clientId
      )
      try {
        await client.testConnection()
        const viaHub = client.isViaHub
        set({ client, status: 'connected', viaHub })
        logEvent('connection', viaHub ? 'Downtify connecté (via serveur Hub)' : 'Downtify connecté')
        if (remember && normalizedUrl) {
          await storage.saveConnection('downtify', { url: normalizedUrl, username: '' })
        }
        get().startPolling()
        await get().refreshQueue()
      } catch (err: any) {
        set({ status: 'error', error: err?.message || 'Connexion impossible', viaHub: false })
        logEvent('connection', `Downtify : ${describeError(err)}`, 'warn')
        throw err
      }
    },

    restoreSession: async () => {
      ensureHubSubscription()
      const conn = await storage.loadConnection('downtify')
      const url = conn?.url ?? ''
      if (!url && !getHubProxy()) return
      try {
        await get().connect(url, false)
      } catch {
        // service unreachable, stay logged out
      }
    },

    logout: async () => {
      loggedOutByUser = true
      get().stopPolling()
      await storage.clearConnection('downtify')
      set({ client: null, status: 'disconnected', viaHub: false, queue: [] })
    },

  refreshQueue: async () => {
    const { client, queue: prevQueue } = get()
    if (!client) return
    try {
      const prevDone = new Set(prevQueue.filter((q) => q.status === 'done').map((q) => q.song.song_id))
      const queue = await client.getQueue()
      set({ queue })
      const newlyDoneItems = queue.filter((q) => q.status === 'done' && !prevDone.has(q.song.song_id))
      if (newlyDoneItems.length > 0) {
        set((s) => {
          const existing = new Set(s.completedSongs.map((c) => c.song_id))
          const added = newlyDoneItems.map((q) => q.song).filter((c) => !existing.has(c.song_id))
          return added.length > 0 ? { completedSongs: [...added, ...s.completedSongs] } : {}
        })
        await scanLibrary().catch(() => {})
        set({ lastCompletedAt: Date.now() })
      }
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
    set((s) =>
      s.completedSongs.some((c) => c.song_id === song.song_id)
        ? {}
        : { completedSongs: [song, ...s.completedSongs] }
    )
    await get().refreshQueue()
    await scanLibrary().catch(() => {})
    set({ lastCompletedAt: Date.now() })
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
  }
})
