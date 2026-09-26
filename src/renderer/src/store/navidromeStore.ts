import { create } from 'zustand'
import { NavidromeClient, NDAlbum, NDArtist, NDPlaylist, NDSong } from '@renderer/services/navidrome'
import { seekTo } from '@renderer/services/playbackEngine'
import { storage } from '@renderer/services/storage'
import { prefetchCoverArt } from '@renderer/services/imagePrefetch'
import { ConnectionStatus } from '@renderer/types'

export type RepeatMode = 'off' | 'all' | 'one'

interface NavidromeState {
  client: NavidromeClient | null
  status: ConnectionStatus
  error: string | null
  username: string | null

  artists: NDArtist[]
  recentAlbums: NDAlbum[]
  playlists: NDPlaylist[]
  libraryLoaded: boolean

  queue: NDSong[]
  /** The pre-shuffle order, kept so turning shuffle off can restore it. */
  orderedQueue: NDSong[] | null
  queueIndex: number
  isPlaying: boolean
  repeatMode: RepeatMode
  shuffle: boolean
  volume: number
  playbackRate: number
  currentTime: number
  duration: number

  connect: (url: string, username: string, password: string, remember: boolean) => Promise<void>
  restoreSession: () => Promise<void>
  logout: () => Promise<void>
  loadLibrary: () => Promise<void>
  loadPlaybackPrefs: () => Promise<void>
  createPlaylist: (name: string, songIds?: string[]) => Promise<NDPlaylist>
  addSongsToPlaylist: (playlistId: string, songIds: string[]) => Promise<void>

  playQueue: (songs: NDSong[], startIndex: number) => void
  addToQueue: (songs: NDSong[]) => void
  playNext: (song: NDSong) => void
  removeFromQueueAt: (index: number) => void
  reorderQueue: (fromIndex: number, toIndex: number) => void
  clearQueue: () => void
  removeFromPlaylist: (playlistId: string, songIndex: number) => Promise<void>
  togglePlay: () => void
  next: () => void
  prev: () => void
  setRepeatMode: (m: RepeatMode) => void
  toggleShuffle: () => void
  setVolume: (v: number) => void
  setPlaybackRate: (rate: number) => void
  setProgress: (currentTime: number, duration: number) => void
  currentSong: () => NDSong | null
}

export const useNavidromeStore = create<NavidromeState>((set, get) => ({
  client: null,
  status: 'disconnected',
  error: null,
  username: null,

  artists: [],
  recentAlbums: [],
  playlists: [],
  libraryLoaded: false,

  queue: [],
  orderedQueue: null,
  queueIndex: -1,
  isPlaying: false,
  repeatMode: 'off',
  shuffle: false,
  volume: 0.8,
  playbackRate: 1,
  currentTime: 0,
  duration: 0,

  loadPlaybackPrefs: async () => {
    const [volume, playbackRate] = await Promise.all([
      storage.loadPref<number>('navidrome.volume'),
      storage.loadPref<number>('navidrome.playbackRate')
    ])
    set({
      volume: volume ?? 0.8,
      playbackRate: playbackRate ?? 1
    })
  },

  connect: async (url, username, password, remember) => {
    set({ status: 'connecting', error: null })
    const client = new NavidromeClient({ url, username, password })
    try {
      await client.testConnection()
      set({ client, status: 'connected', username })
      if (remember) {
        await storage.saveConnection('navidrome', { url, username })
        await storage.saveSecret('navidrome', 'password', password)
      }
      await get().loadLibrary()
    } catch (err: any) {
      set({ status: 'error', error: err?.message || 'Connexion impossible' })
      throw err
    }
  },

  loadLibrary: async () => {
    const { client } = get()
    if (!client) return
    try {
      const [recentAlbums, artists, playlists] = await Promise.all([
        client.getAlbumList('newest', 20),
        client.getArtists(),
        client.getPlaylists()
      ])
      set({ recentAlbums, artists, playlists, libraryLoaded: true })
      // Every section that renders these lists uses one fixed size each, so a
      // single prefetch per list covers Home, the dedicated section and
      // Favorites/search wherever they reuse the same data.
      prefetchCoverArt(client, recentAlbums.map((a) => a.coverArt), 300)
      prefetchCoverArt(client, artists.map((a) => a.coverArt), 200)
      prefetchCoverArt(client, playlists.map((p) => p.coverArt), 300)
    } catch {
      // best-effort: the library view will show empty sections and can retry via navigation
    }
  },

  createPlaylist: async (name, songIds) => {
    const { client } = get()
    if (!client) throw new Error('Non connecte')
    const playlist = await client.createPlaylist(name, songIds)
    set((s) => ({ playlists: [...s.playlists, playlist] }))
    return playlist
  },

  addSongsToPlaylist: async (playlistId, songIds) => {
    const { client } = get()
    if (!client) return
    await client.addToPlaylist(playlistId, songIds)
    set((s) => ({
      playlists: s.playlists.map((p) => (p.id === playlistId ? { ...p, songCount: p.songCount + songIds.length } : p))
    }))
  },

  restoreSession: async () => {
    const conn = await storage.loadConnection('navidrome')
    if (!conn) return
    const password = await storage.loadSecret('navidrome', 'password')
    if (!password) return
    try {
      await get().connect(conn.url, conn.username, password, false)
    } catch {
      // credentials rejected or server unavailable, stay on login screen
    }
  },

  logout: async () => {
    await storage.clearConnection('navidrome')
    await storage.clearSecret('navidrome', 'password')
    set({
      client: null,
      status: 'disconnected',
      username: null,
      artists: [],
      recentAlbums: [],
      playlists: [],
      libraryLoaded: false,
      queue: [],
      orderedQueue: null,
      queueIndex: -1,
      isPlaying: false
    })
  },

  playQueue: (songs, startIndex) => {
    // Warms the player bar's small cover for the whole queue up front, so
    // skipping through tracks never shows a blank/flashing thumbnail while a
    // fresh one loads.
    prefetchCoverArt(get().client, songs.map((s) => s.coverArt || s.albumId), 64)

    // Starting something new while shuffle is on should shuffle it too, with the
    // track you picked first.
    if (get().shuffle) {
      const picked = songs[startIndex]
      const rest = songs.filter((_, i) => i !== startIndex)
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[rest[i], rest[j]] = [rest[j], rest[i]]
      }
      set({
        orderedQueue: songs,
        queue: picked ? [picked, ...rest] : rest,
        queueIndex: 0,
        isPlaying: true,
        currentTime: 0
      })
      return
    }
    set({ queue: songs, orderedQueue: null, queueIndex: startIndex, isPlaying: true, currentTime: 0 })
  },

  // Both of these also extend orderedQueue when shuffle is on, otherwise turning
  // shuffle off would restore the old order and silently drop whatever was added.
  addToQueue: (songs) => {
    set((s) => ({
      queue: [...s.queue, ...songs],
      orderedQueue: s.orderedQueue ? [...s.orderedQueue, ...songs] : null
    }))
  },

  /** Slots a track straight after the one playing, without disturbing the rest. */
  playNext: (song) => {
    set((s) => {
      if (s.queue.length === 0) {
        return { queue: [song], orderedQueue: null, queueIndex: 0, isPlaying: true }
      }
      const queue = [...s.queue]
      queue.splice(s.queueIndex + 1, 0, song)
      return { queue, orderedQueue: s.orderedQueue ? [...s.orderedQueue, song] : null }
    })
  },

  removeFromQueueAt: (index) => {
    set((s) => {
      if (index < 0 || index >= s.queue.length) return s
      const removed = s.queue[index]
      const queue = s.queue.filter((_, i) => i !== index)
      let queueIndex = s.queueIndex
      if (index === s.queueIndex) {
        // The playing track itself was removed: stay at the same slot, which now
        // holds whatever came right after it (or nothing, if it was the last one).
        queueIndex = Math.min(s.queueIndex, queue.length - 1)
      } else if (index < s.queueIndex) {
        queueIndex -= 1
      }
      const orderedIdx = s.orderedQueue?.findIndex((song) => song.id === removed.id) ?? -1
      const orderedQueue = s.orderedQueue && orderedIdx >= 0 ? s.orderedQueue.filter((_, i) => i !== orderedIdx) : s.orderedQueue
      return {
        queue,
        orderedQueue,
        queueIndex,
        isPlaying: queue.length > 0 ? s.isPlaying : false,
        currentTime: index === s.queueIndex ? 0 : s.currentTime
      }
    })
  },

  reorderQueue: (fromIndex, toIndex) => {
    set((s) => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= s.queue.length || toIndex >= s.queue.length) {
        return s
      }
      const queue = [...s.queue]
      const [moved] = queue.splice(fromIndex, 1)
      queue.splice(toIndex, 0, moved)
      let queueIndex = s.queueIndex
      if (fromIndex === s.queueIndex) queueIndex = toIndex
      else if (fromIndex < s.queueIndex && toIndex >= s.queueIndex) queueIndex -= 1
      else if (fromIndex > s.queueIndex && toIndex <= s.queueIndex) queueIndex += 1
      return { queue, queueIndex }
    })
  },

  clearQueue: () => set({ queue: [], orderedQueue: null, queueIndex: -1, isPlaying: false, currentTime: 0, duration: 0 }),

  removeFromPlaylist: async (playlistId, songIndex) => {
    const { client } = get()
    if (!client) return
    await client.removeFromPlaylist(playlistId, songIndex)
    set((s) => ({
      playlists: s.playlists.map((p) => (p.id === playlistId ? { ...p, songCount: Math.max(0, p.songCount - 1) } : p))
    }))
  },

  togglePlay: () => set((s) => ({ isPlaying: s.queue.length > 0 ? !s.isPlaying : false })),

  // Shuffle reorders the queue itself rather than jumping to a random index on
  // every next(). That way the played order is a real sequence: "previous" walks
  // back through the tracks you actually heard instead of picking another random
  // one, and turning shuffle off restores the original order.
  next: () => {
    const { queue, queueIndex, repeatMode } = get()
    if (queue.length === 0) return
    let nextIndex = queueIndex + 1
    if (nextIndex >= queue.length) {
      if (repeatMode === 'all') nextIndex = 0
      else {
        set({ isPlaying: false })
        return
      }
    }
    set({ queueIndex: nextIndex, currentTime: 0, isPlaying: true })
  },

  prev: () => {
    const { queue, queueIndex, currentTime } = get()
    if (queue.length === 0) return
    // Restart the current track unless we're in its first seconds - the usual
    // behaviour for a "previous" button. Both of these cases leave queueIndex
    // untouched, so nothing else would move the player: seek it here, otherwise
    // the button silently does nothing (which is how it behaved before).
    if (currentTime > 3 || queueIndex <= 0) {
      seekTo(0)
      set({ currentTime: 0, isPlaying: true })
      return
    }
    set({ queueIndex: queueIndex - 1, currentTime: 0, isPlaying: true })
  },

  setRepeatMode: (m) => set({ repeatMode: m }),

  toggleShuffle: () => {
    const { shuffle, queue, queueIndex, orderedQueue } = get()
    const current = queue[queueIndex] || null

    if (!shuffle) {
      // The track playing stays put and becomes the head of the shuffled run, so
      // enabling shuffle never interrupts what you're listening to.
      const rest = queue.filter((_, i) => i !== queueIndex)
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[rest[i], rest[j]] = [rest[j], rest[i]]
      }
      set({
        shuffle: true,
        orderedQueue: queue,
        queue: current ? [current, ...rest] : rest,
        queueIndex: 0
      })
      return
    }

    const restored = orderedQueue ?? queue
    const resumeAt = current ? restored.findIndex((s) => s.id === current.id) : -1
    set({
      shuffle: false,
      orderedQueue: null,
      queue: restored,
      queueIndex: resumeAt >= 0 ? resumeAt : 0
    })
  },

  setVolume: (v) => {
    set({ volume: v })
    storage.savePref('navidrome.volume', v)
  },

  setPlaybackRate: (rate) => {
    set({ playbackRate: rate })
    storage.savePref('navidrome.playbackRate', rate)
  },
  setProgress: (currentTime, duration) => set({ currentTime, duration }),

  currentSong: () => {
    const { queue, queueIndex } = get()
    return queue[queueIndex] || null
  }
}))
