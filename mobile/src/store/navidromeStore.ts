import { create } from 'zustand'
import { describeError, logEvent } from '@/services/diagnostics'
import { isUnreachable, NavidromeClient, NDAlbum, NDArtist, NDPlaylist, NDSong } from '@/services/navidrome'
import { seekTo } from '@/services/playbackEngine'
import { findRadioSongs, radioNeedsMore } from '@/services/radio'
import { storage } from '@/services/storage'
import { prefetchCoverArt } from '@/services/imagePrefetch'
import { ownPlaylists } from '@/services/navidromeAdmin'
import { ConnectionStatus } from '@/types'

export type RepeatMode = 'off' | 'all' | 'one'

/** The queue entries added with "play next": those still ahead of the song playing keep their order. */
const upNext = new WeakSet<NDSong>()

/** Where a song is in a list: the same entry if it is there, else the first with its id. */
function indexIn(list: NDSong[], song: NDSong): number {
  const same = list.indexOf(song)
  return same >= 0 ? same : list.findIndex((s) => s.id === song.id)
}

/**
 * A song moved in the shuffled queue moves in the order shuffle goes back to as well: it is put right after the song
 * it now follows (first if it now leads). Otherwise turning shuffle off undid every move made meanwhile.
 */
export function moveInOrder(ordered: NDSong[], moved: NDSong, after: NDSong | null): NDSong[] {
  const at = indexIn(ordered, moved)
  if (at < 0) return ordered
  const rest = ordered.filter((_, i) => i !== at)
  const anchor = after ? indexIn(rest, after) : -1
  rest.splice(anchor + 1, 0, moved)
  return rest
}

/** A radio adds songs only one request at a time. */
let extendingRadio = false
/** The saved login being tried, if it is. */
let restoring: Promise<void> | null = null

interface NavidromeState {
  client: NavidromeClient | null
  status: ConnectionStatus
  error: string | null
  username: string | null
  /**
   * Whether a login is saved on the phone: null until that is known (the app has just started). With one saved, a
   * server that can't be reached shows a "try again" screen instead of an empty login form.
   */
  savedSession: boolean | null

  artists: NDArtist[]
  recentAlbums: NDAlbum[]
  /** Albums most recently played on any device, from the plays reported to Navidrome. */
  recentlyPlayed: NDAlbum[]
  playlists: NDPlaylist[]
  libraryLoaded: boolean

  queue: NDSong[]
  /** The pre-shuffle order, kept so turning shuffle off can restore it. */
  orderedQueue: NDSong[] | null
  queueIndex: number
  isPlaying: boolean
  /** The song radio running, if any: what it was started from. It adds similar songs when the queue runs low. */
  radio: { seedId: string; seedTitle: string } | null
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
  refreshRecentlyPlayed: () => Promise<void>
  loadPlaybackPrefs: () => Promise<void>
  createPlaylist: (name: string, songIds?: string[]) => Promise<NDPlaylist>
  addSongsToPlaylist: (playlistId: string, songIds: string[]) => Promise<void>

  playQueue: (songs: NDSong[], startIndex: number) => void
  /** Plays the song at this place in the queue, which stays as it is (its order, the radio). */
  jumpTo: (index: number) => void
  /** Plays songs like `seed`, and keeps adding more. 'empty' when the server has nothing similar to offer. */
  startRadio: (seed: NDSong) => Promise<'started' | 'empty'>
  extendRadio: () => Promise<void>
  /** The track meant to be the last has ended: stays on the one after it, paused. */
  stopAtTrackEnd: () => void
  addToQueue: (songs: NDSong[]) => void
  /** Says how many songs added the same way will play before it (0: it plays next). */
  playNext: (song: NDSong) => number
  removeFromQueueAt: (index: number) => void
  reorderQueue: (fromIndex: number, toIndex: number) => void
  clearQueue: () => void
  removeFromPlaylist: (playlistId: string, songIndex: number) => Promise<void>
  deletePlaylist: (playlistId: string) => Promise<void>
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
  savedSession: null,

  artists: [],
  recentAlbums: [],
  recentlyPlayed: [],
  playlists: [],
  libraryLoaded: false,

  queue: [],
  orderedQueue: null,
  queueIndex: -1,
  isPlaying: false,
  radio: null,
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
      set({ client, status: 'connected', username, error: null })
      logEvent('connection', 'Navidrome connecté')
      if (remember) {
        await storage.saveConnection('navidrome', { url, username })
        await storage.saveSecret('navidrome', 'password', password)
        set({ savedSession: true })
      }
      await get().loadLibrary()
    } catch (err: any) {
      set({ status: 'error', error: err?.message || 'Connexion impossible' })
      logEvent('connection', `Navidrome : ${describeError(err)}`, 'warn')
      throw err
    }
  },

  loadLibrary: async () => {
    const { client } = get()
    if (!client) return
    try {
      const [recentAlbums, artists, allPlaylists] = await Promise.all([
        client.getAlbumList('newest', 20),
        client.getArtists(),
        client.getPlaylists()
      ])
      // Each account has its own playlists: those of the others (public ones, or all of them for an admin) stay out.
      const playlists = ownPlaylists(allPlaylists, get().username)
      set({ recentAlbums, artists, playlists, libraryLoaded: true })
      storage.savePref('navidrome.playlistsList', playlists).catch(() => {})
      // Home and Library render these same lists at different thumbnail sizes
      // (a rail vs a grid), so both get warmed regardless of which screen the
      // user opens first.
      prefetchCoverArt(client, recentAlbums.map((a) => a.coverArt), 300)
      prefetchCoverArt(client, artists.map((a) => a.coverArt), 200)
      prefetchCoverArt(client, artists.map((a) => a.coverArt), 100)
      prefetchCoverArt(client, playlists.map((p) => p.coverArt), 100)
      prefetchCoverArt(client, playlists.map((p) => p.coverArt), 300)
    } catch {
      // best-effort: the library view will show empty sections and can retry via navigation
    }
    await get().refreshRecentlyPlayed()
  },

  refreshRecentlyPlayed: async () => {
    const { client } = get()
    if (!client) return
    try {
      const recentlyPlayed = await client.getAlbumList('recent', 15)
      set({ recentlyPlayed })
      prefetchCoverArt(client, recentlyPlayed.map((a) => a.coverArt), 200)
    } catch {
      // best-effort: the home screen falls back to this device's own history
    }
  },

  createPlaylist: async (name, songIds) => {
    const { client } = get()
    if (!client) throw new Error('Non connecté')
    const playlist = await client.createPlaylist(name, songIds)
    // A new playlist is the account's own: private, whatever the server would make it by default.
    if (playlist.public !== false) await client.setPlaylistPublic(playlist.id, false).catch(() => {})
    const mine = { ...playlist, public: false, owner: playlist.owner ?? get().username ?? undefined }
    set((s) => ({ playlists: [...s.playlists, mine] }))
    return mine
  },

  addSongsToPlaylist: async (playlistId, songIds) => {
    const { client } = get()
    if (!client) return
    await client.addToPlaylist(playlistId, songIds)
    set((s) => ({
      playlists: s.playlists.map((p) => (p.id === playlistId ? { ...p, songCount: p.songCount + songIds.length } : p))
    }))
  },

  restoreSession: () => {
    // Asked from several places at once (the retry button, the network coming back, the app coming back): one try.
    restoring ??= restoreSaved().finally(() => {
      restoring = null
    })
    return restoring
  },

  logout: async () => {
    await storage.clearConnection('navidrome')
    await storage.clearSecret('navidrome', 'password')
    set({
      client: null,
      status: 'disconnected',
      error: null,
      username: null,
      savedSession: false,
      artists: [],
      recentAlbums: [],
      recentlyPlayed: [],
      playlists: [],
      libraryLoaded: false,
      queue: [],
      orderedQueue: null,
      queueIndex: -1,
      isPlaying: false,
      radio: null
    })
  },

  playQueue: (songs, startIndex) => {
    // Warms the whole queue's small thumbnails up front - the Now Playing
    // queue tab and mini player would otherwise only start fetching each
    // track's art the moment you skip to it.
    prefetchCoverArt(get().client, songs.map((s) => s.coverArt || s.albumId), 100)

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
        currentTime: 0,
        radio: null
      })
      return
    }
    set({ queue: songs, orderedQueue: null, queueIndex: startIndex, isPlaying: true, currentTime: 0, radio: null })
  },

  jumpTo: (index) => {
    const { queue, queueIndex } = get()
    if (index < 0 || index >= queue.length) return
    // The song already playing starts again: nothing else would reload it.
    if (index === queueIndex) seekTo(0)
    set({ queueIndex: index, currentTime: 0, isPlaying: true })
    if (get().radio && radioNeedsMore(queue.length, index)) void get().extendRadio()
  },

  startRadio: async (seed) => {
    const { client } = get()
    if (!client) return 'empty'
    const { songs } = await findRadioSongs(client, seed)
    if (songs.length === 0) return 'empty'
    get().playQueue([seed, ...songs], 0)
    set({ radio: { seedId: seed.id, seedTitle: seed.title } })
    logEvent('music', `Radio lancée depuis « ${seed.title} » (${songs.length} titres)`)
    return 'started'
  },

  extendRadio: async () => {
    const { client, radio, queue } = get()
    if (!client || !radio || extendingRadio) return
    const seed = queue[queue.length - 1]
    if (!seed) return
    extendingRadio = true
    try {
      // The radio drifts: each batch is made from the last song queued, and never repeats one already in the queue.
      const { songs } = await findRadioSongs(client, seed, { exclude: new Set(queue.map((song) => song.id)) })
      // Another radio, or something played by hand, took over while this was loading.
      if (songs.length > 0 && get().radio?.seedId === radio.seedId) get().addToQueue(songs)
    } catch {
      // the next skip tries again
    } finally {
      extendingRadio = false
    }
  },

  stopAtTrackEnd: () => {
    const { queue, queueIndex } = get()
    const hasNext = queueIndex + 1 < queue.length
    set({ queueIndex: hasNext ? queueIndex + 1 : queueIndex, currentTime: 0, isPlaying: false })
    // Nothing follows: the track just ended is put back at its start, ready to be played again.
    if (!hasNext) seekTo(0)
  },

  // Both of these also extend orderedQueue when shuffle is on, otherwise turning
  // shuffle off would restore the old order and silently drop whatever was added.
  addToQueue: (songs) => {
    set((s) => ({
      queue: [...s.queue, ...songs],
      orderedQueue: s.orderedQueue ? [...s.orderedQueue, ...songs] : null
    }))
  },

  /**
   * Slots a track after the one playing, without disturbing the rest. Songs added this way line up in the order they
   * were added: the first plays next, each later one after it (it used to be the last one added that played next).
   */
  playNext: (song) => {
    let ahead = 0
    set((s) => {
      // Its own copy: the songs added this way are told apart from the same song queued otherwise.
      const entry = { ...song }
      upNext.add(entry)
      if (s.queue.length === 0) {
        return { queue: [entry], orderedQueue: null, queueIndex: 0, isPlaying: true }
      }
      let at = s.queueIndex + 1
      while (at < s.queue.length && upNext.has(s.queue[at])) at++
      ahead = at - (s.queueIndex + 1)
      const queue = [...s.queue]
      queue.splice(at, 0, entry)
      return { queue, orderedQueue: s.orderedQueue ? [...s.orderedQueue, entry] : null }
    })
    return ahead
  },

  removeFromQueueAt: (index) => {
    set((s) => {
      if (index < 0 || index >= s.queue.length) return s
      const removed = s.queue[index]
      const queue = s.queue.filter((_, i) => i !== index)
      let queueIndex = s.queueIndex
      if (index === s.queueIndex) {
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
      return { queue, queueIndex, orderedQueue: s.orderedQueue ? moveInOrder(s.orderedQueue, moved, queue[toIndex - 1] ?? null) : null }
    })
  },

  clearQueue: () => set({ queue: [], orderedQueue: null, queueIndex: -1, isPlaying: false, currentTime: 0, duration: 0, radio: null }),

  removeFromPlaylist: async (playlistId, songIndex) => {
    const { client } = get()
    if (!client) return
    await client.removeFromPlaylist(playlistId, songIndex)
    set((s) => ({
      playlists: s.playlists.map((p) => (p.id === playlistId ? { ...p, songCount: Math.max(0, p.songCount - 1) } : p))
    }))
  },

  deletePlaylist: async (playlistId) => {
    const { client } = get()
    if (!client) throw new Error('Non connecté')
    await client.deletePlaylist(playlistId)
    set((s) => ({ playlists: s.playlists.filter((p) => p.id !== playlistId) }))
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
    if (get().radio && radioNeedsMore(queue.length, nextIndex)) void get().extendRadio()
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

/** Signs in with the login saved on the phone, if there is one. */
async function restoreSaved(): Promise<void> {
  const { setState: set, getState: get } = useNavidromeStore
  const conn = await storage.loadConnection('navidrome').catch(() => null)
  const password = conn ? await storage.loadSecret('navidrome', 'password').catch(() => null) : null
  if (!conn || !password) {
    set({ savedSession: false })
    return
  }
  set({ savedSession: true })
  try {
    await get().connect(conn.url, conn.username, password, false)
  } catch (err) {
    // The server can't be reached (no network, the server asleep): a client is kept all the same, so the songs
    // downloaded to the phone still play and the covers kept on it still show. The screens say the server is
    // unreachable and try again. A rejected password leaves no client: the login form is shown.
    if (!isUnreachable(err)) set({ client: null })
    else {
      const cachedPlaylists = await storage.loadPref<NDPlaylist[]>('navidrome.playlistsList').catch(() => null)
      set({
        client: get().client ?? new NavidromeClient({ url: conn.url, username: conn.username, password }),
        username: conn.username,
        ...(Array.isArray(cachedPlaylists) && cachedPlaylists.length > 0 ? { playlists: cachedPlaylists } : {})
      })
    }
  }
}
