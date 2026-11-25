import { create } from 'zustand'
import { File, Directory, Paths } from 'expo-file-system'
import { fileExtension, NavidromeClient, NDPlaylist, NDSong } from '@/services/navidrome'
import { storage } from '@/services/storage'
import { SONG_COVER_SIZES, storeCover } from '@/services/coverStore'
import { describeError, logEvent } from '@/services/diagnostics'
import { plural } from '@/services/plural'
import { useStarStore } from '@/store/starStore'
import { useToastStore } from '@/store/toastStore'

export const OFFLINE_PLAYLIST_ID = '__offline__'

export interface OfflineTrack {
  id: string
  title: string
  artist: string
  album?: string
  coverArt?: string
  duration: number
  filename: string
  /** The file's size in bytes (songs downloaded before 2.7.1 don't have it: their file is measured). */
  size?: number
  /** Downloaded automatically by Wi-Fi pre-caching; eligible for LRU eviction when maxCacheMb is set. */
  autoCached?: boolean
  /** Epoch ms when this track was last played (or auto-cached), used for LRU eviction. */
  lastPlayedAt?: number
  /** Whether this track was starred when downloaded (protects favorites from eviction when keepFavorites is on). */
  starred?: boolean
}

export interface CachedPlaylist {
  playlist: NDPlaylist
  songs: NDSong[]
}

export interface DownloadOptions {
  /** A download the app starts on its own (a playlist kept on the phone): it only speaks up when it got something. */
  quiet?: boolean
  /** What the songs are, for that message ("Route"). */
  label?: string
}

export interface OfflineProgress {
  loaded: number
  total: number
  speedBps: number
}

interface OfflineState {
  tracks: Record<string, OfflineTrack>
  downloading: Record<string, OfflineProgress>
  errors: Record<string, string>
  loaded: boolean
  /** The playlists kept on the phone (id -> name): the songs added to them later are downloaded too. */
  keptPlaylists: Record<string, string>
  /** Cached playlist metadata and track lists so playlists can be browsed and played when the server is unreachable. */
  playlistCache: Record<string, CachedPlaylist>
  /** Whether starred/liked tracks are automatically downloaded on Wi-Fi. */
  keepFavorites: boolean
  /** Maximum auto-cache size in MiB (0 = illimité). */
  maxCacheMb: number
  /** Number of upcoming queue tracks to pre-cache on Wi-Fi (0 = désactivé). */
  preCacheCount: number

  loadFromDisk: () => Promise<void>
  isOffline: (id: string) => boolean
  getLocalUri: (id: string) => string | null
  /** Downloads one song; a failure is said in a toast. */
  downloadTrack: (song: NDSong, client: NavidromeClient) => Promise<void>
  /** Downloads what isn't on the phone yet; resolves to how many songs it downloaded. */
  downloadTracks: (songs: NDSong[], client: NavidromeClient, options?: DownloadOptions) => Promise<number>
  /** Quietly downloads upcoming tracks as auto-cached (no toast); resolves to how many songs it downloaded. */
  downloadAutoTracks: (songs: NDSong[], client: NavidromeClient) => Promise<number>
  removeOffline: (id: string) => Promise<void>
  /** Keeps a playlist on the phone, or stops (the songs already downloaded stay). */
  setKeptPlaylist: (playlistId: string, name: string, keep: boolean) => void
  /** Saves a playlist's metadata and songs on disk so it stays accessible offline. */
  cachePlaylist: (playlistId: string, playlist: NDPlaylist, songs: NDSong[]) => void
  removeCachedPlaylist: (playlistId: string) => void
  /** Keeps all starred tracks on the phone, or stops. */
  setKeepFavorites: (keep: boolean) => void
  /** Sets max auto-cache size in MiB (0 = illimité) and evicts excess auto-cached tracks. */
  setMaxCacheMb: (mb: number) => void
  /** Sets how many upcoming queue tracks to pre-cache on Wi-Fi (0 = désactivé). */
  setPreCacheCount: (count: number) => void
  /** Updates `lastPlayedAt` to now for `id` (and remembers it as active) and persists. */
  touchPlayed: (id: string) => void
  /** Evicts oldest auto-cached tracks until total offline size <= maxCacheMb, sparing protected tracks. */
  evictIfNeeded: (protectedIds?: Set<string>) => Promise<void>
}

const offlineDir = new Directory(Paths.document, 'offline-music')
/** Most recently started track ID, spared from auto-eviction while playing. */
let activeTrackId: string | null = null

function ensureOfflineDir(): void {
  if (!offlineDir.exists) offlineDir.create({ intermediates: true })
}

async function persist(tracks: Record<string, OfflineTrack>): Promise<void> {
  await storage.savePref('navidrome.offlineTracks', tracks)
}

const KEPT_KEY = 'navidrome.keptPlaylists'
const PLAYLIST_CACHE_KEY = 'navidrome.cachedPlaylists'
const KEEP_FAVORITES_KEY = 'navidrome.keepFavorites'
const MAX_CACHE_MB_KEY = 'navidrome.maxCacheMb'
const PRE_CACHE_COUNT_KEY = 'navidrome.preCacheCount'

/** Virtual playlist representing all songs downloaded to the phone. */
export function offlinePlaylist(tracks: Record<string, OfflineTrack>): NDPlaylist {
  const list = Object.values(tracks)
  return {
    id: OFFLINE_PLAYLIST_ID,
    name: 'Titres téléchargés',
    songCount: list.length,
    duration: list.reduce((sum, t) => sum + (t.duration || 0), 0),
    coverArt: list[0]?.coverArt
  }
}

export function offlineTrackToSong(track: OfflineTrack): NDSong {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    coverArt: track.coverArt,
    duration: track.duration
  }
}

/** How much room the downloaded songs take on the phone, in bytes. */
export function offlineBytes(tracks: Record<string, OfflineTrack>): number {
  let total = 0
  for (const track of Object.values(tracks)) {
    if (typeof track.size === 'number') {
      total += track.size
      continue
    }
    try {
      total += new File(offlineDir, track.filename).size ?? 0
    } catch {
      // a file gone missing counts for nothing
    }
  }
  return total
}

function trackBytes(track: OfflineTrack): number {
  return typeof track.size === 'number' ? track.size : offlineBytes({ [track.id]: track })
}

/**
 * Selects auto-cached track IDs to delete in LRU order (`lastPlayedAt ?? 0` ascending)
 * until total offline storage is at or below `maxBytes`.
 * Never selects manual downloads (`autoCached !== true`) or IDs in `protectedIds`.
 */
export function selectEvictions(
  tracks: Record<string, OfflineTrack>,
  maxBytes: number,
  protectedIds: ReadonlySet<string> = new Set()
): string[] {
  if (maxBytes <= 0) return []
  let remaining = offlineBytes(tracks)
  if (remaining <= maxBytes) return []

  const candidates = Object.values(tracks)
    .filter((track) => track.autoCached === true && !protectedIds.has(track.id))
    .sort((a, b) => (a.lastPlayedAt ?? 0) - (b.lastPlayedAt ?? 0))

  const evict: string[] = []
  for (const track of candidates) {
    if (remaining <= maxBytes) break
    evict.push(track.id)
    remaining -= trackBytes(track)
  }
  return evict
}

/** Downloads a song to the phone. Resolves to null when it is there (or already was), else to why it failed. */
async function fetchTrack(song: NDSong, client: NavidromeClient, autoCached = false): Promise<string | null> {
  const { getState: get, setState: set } = useOfflineStore
  if (get().tracks[song.id] || get().downloading[song.id]) return null
  ensureOfflineDir()
  set((s) => {
    const errors = { ...s.errors }
    delete errors[song.id]
    return { downloading: { ...s.downloading, [song.id]: { loaded: 0, total: 0, speedBps: 0 } }, errors }
  })
  // The file as it is on the server, under its own extension: a FLAC stays a FLAC (it used to be fetched as a stream,
  // which the server may convert, and always named .mp3).
  const filename = `${song.id}.${fileExtension(song.suffix)}`
  const destination = new File(offlineDir, filename)
  try {
    const url = client.originalUrl(song.id)
    let lastLoaded = 0
    let lastTick = Date.now()
    const task = File.createDownloadTask(url, destination, {
      onProgress: ({ bytesWritten, totalBytes }) => {
        const now = Date.now()
        const elapsed = (now - lastTick) / 1000
        if (elapsed >= 0.2 || bytesWritten === totalBytes) {
          const speedBps = elapsed > 0 ? (bytesWritten - lastLoaded) / elapsed : 0
          set((s) => ({
            downloading: { ...s.downloading, [song.id]: { loaded: bytesWritten, total: totalBytes, speedBps } }
          }))
          lastLoaded = bytesWritten
          lastTick = now
        }
      }
    })
    await task.downloadAsync()
    let size: number | undefined
    try {
      size = destination.size ?? undefined
    } catch {
      size = undefined
    }
    const track: OfflineTrack = {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      coverArt: song.coverArt || song.albumId,
      duration: song.duration,
      filename,
      size,
      ...(autoCached ? { autoCached: true, lastPlayedAt: Date.now() } : {}),
      ...(song.starred ? { starred: true } : {})
    }
    // Its cover too, at every size the app shows, so the song looks the same with no network.
    if (track.coverArt) for (const size of SONG_COVER_SIZES) void storeCover(client.coverArtUrl(track.coverArt, size))
    set((s) => {
      const { [song.id]: _removed, ...downloading } = s.downloading
      const tracks = { ...s.tracks, [song.id]: track }
      persist(tracks)
      return { tracks, downloading }
    })
    return null
  } catch (err: any) {
    // What was written of it is not a song: it goes, so a later try starts clean.
    try {
      if (destination.exists) destination.delete()
    } catch {
      // nothing to remove
    }
    const reason = err?.message || 'Erreur de téléchargement'
    set((s) => {
      const { [song.id]: _removed, ...downloading } = s.downloading
      return { downloading, errors: { ...s.errors, [song.id]: reason } }
    })
    logEvent('music', `Téléchargement de « ${song.title} » impossible : ${describeError(err)}`, 'warn')
    return reason
  }
}

/** Downloads `wanted` with bounded concurrency so a full album doesn't open dozens of simultaneous sockets. */
async function runDownloadBatch(
  wanted: NDSong[],
  client: NavidromeClient,
  autoCached: boolean
): Promise<{ done: number; failed: number; lastFailure: string }> {
  const CONCURRENCY = 3
  let cursor = 0
  let failed = 0
  let lastFailure = ''
  const worker = async (): Promise<void> => {
    while (cursor < wanted.length) {
      const failure = await fetchTrack(wanted[cursor++], client, autoCached)
      if (failure) {
        failed++
        lastFailure = failure
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker))
  return { done: wanted.length - failed, failed, lastFailure }
}

function uniqueWanted(songs: NDSong[], tracks: Record<string, OfflineTrack>, downloading: Record<string, OfflineProgress>): NDSong[] {
  return songs.filter((song, i) => !tracks[song.id] && !downloading[song.id] && songs.findIndex((s) => s.id === song.id) === i)
}

export const useOfflineStore = create<OfflineState>((set, get) => ({
  tracks: {},
  downloading: {},
  errors: {},
  loaded: false,
  keptPlaylists: {},
  playlistCache: {},
  keepFavorites: false,
  maxCacheMb: 0,
  preCacheCount: 0,

  loadFromDisk: async () => {
    if (get().loaded) return
    const [saved, kept, playlistCache, keepFavorites, maxCacheMb, preCacheCount] = await Promise.all([
      storage.loadPref<Record<string, OfflineTrack>>('navidrome.offlineTracks'),
      storage.loadPref<Record<string, string>>(KEPT_KEY).catch(() => null),
      storage.loadPref<Record<string, CachedPlaylist>>(PLAYLIST_CACHE_KEY).catch(() => null),
      storage.loadPref<boolean>(KEEP_FAVORITES_KEY).catch(() => false),
      storage.loadPref<number>(MAX_CACHE_MB_KEY).catch(() => 0),
      storage.loadPref<number>(PRE_CACHE_COUNT_KEY).catch(() => 0)
    ])
    set({
      tracks: saved || {},
      keptPlaylists: kept && typeof kept === 'object' ? kept : {},
      playlistCache: playlistCache && typeof playlistCache === 'object' ? playlistCache : {},
      keepFavorites: !!keepFavorites,
      maxCacheMb: typeof maxCacheMb === 'number' && maxCacheMb > 0 ? maxCacheMb : 0,
      preCacheCount: typeof preCacheCount === 'number' && preCacheCount > 0 ? preCacheCount : 0,
      loaded: true
    })
  },

  isOffline: (id) => !!get().tracks[id],

  getLocalUri: (id) => {
    const track = get().tracks[id]
    if (!track) return null
    return new File(offlineDir, track.filename).uri
  },

  downloadTrack: async (song, client) => {
    const existing = get().tracks[song.id]
    if (existing) {
      // Explicitly requesting a previously auto-cached track promotes it to a permanent manual download.
      if (existing.autoCached || (song.starred && !existing.starred)) {
        set((s) => {
          const cur = s.tracks[song.id]
          if (!cur) return s
          const { autoCached: _auto, ...rest } = cur
          const next: OfflineTrack = { ...rest, ...(song.starred ? { starred: true } : {}) }
          const tracks = { ...s.tracks, [song.id]: next }
          void persist(tracks)
          return { tracks }
        })
      }
      return
    }
    const failure = await fetchTrack(song, client, false)
    if (failure) useToastStore.getState().show(`« ${song.title} » n’a pas pu être téléchargé : ${failure}`)
  },

  downloadTracks: async (songs, client, options = {}) => {
    // Promote any existing auto-cached tracks now claimed manually / by kept playlists / favorites, and record starred status.
    const markStarred = options.label === 'Titres aimés'
    set((s) => {
      let changed = false
      const tracks = { ...s.tracks }
      for (const song of songs) {
        const cur = tracks[song.id]
        if (!cur) continue
        const wantStarred = (markStarred || !!song.starred) && !cur.starred
        if (cur.autoCached || wantStarred) {
          const { autoCached: _auto, ...rest } = cur
          tracks[song.id] = { ...rest, ...(cur.starred || markStarred || song.starred ? { starred: true } : {}) }
          changed = true
        }
      }
      if (!changed) return s
      void persist(tracks)
      return { tracks }
    })

    const wanted = uniqueWanted(songs, get().tracks, get().downloading)
    const toast = useToastStore.getState().show
    if (wanted.length === 0) {
      if (songs.length > 0 && !options.quiet) toast('Déjà téléchargé sur le téléphone')
      return 0
    }
    if (!options.quiet) toast(`Téléchargement de ${plural(wanted.length, 'titre', 'titres')}…`)
    const { done, failed, lastFailure } = await runDownloadBatch(wanted, client, false)
    if (options.quiet) {
      // Kept playlists: only news is told (new songs downloaded); failures go to the diagnostics log.
      if (done > 0) toast(`${plural(done, 'nouveau titre', 'nouveaux titres')}${options.label ? ` de « ${options.label} »` : ''} sur le téléphone`)
    } else if (failed === 0) {
      toast(`${plural(wanted.length, 'titre téléchargé', 'titres téléchargés')} sur le téléphone`)
    } else {
      toast(`${failed} sur ${wanted.length} ${failed > 1 ? "n'ont pas pu être téléchargés" : "n'a pas pu être téléchargé"} : ${lastFailure}`)
    }
    return done
  },

  downloadAutoTracks: async (songs, client) => {
    const wanted = uniqueWanted(songs, get().tracks, get().downloading)
    if (wanted.length === 0) return 0
    const { done } = await runDownloadBatch(wanted, client, true)
    return done
  },

  setKeptPlaylist: (playlistId, name, keep) => {
    set((s) => {
      const keptPlaylists = { ...s.keptPlaylists }
      if (keep) keptPlaylists[playlistId] = name
      else delete keptPlaylists[playlistId]
      storage.savePref(KEPT_KEY, keptPlaylists).catch(() => {})
      return { keptPlaylists }
    })
  },

  cachePlaylist: (playlistId, playlist, songs) => {
    if (!playlistId || playlistId === OFFLINE_PLAYLIST_ID) return
    set((s) => {
      const playlistCache = {
        ...s.playlistCache,
        [playlistId]: {
          playlist: { ...playlist, songCount: songs.length },
          songs
        }
      }
      storage.savePref(PLAYLIST_CACHE_KEY, playlistCache).catch(() => {})
      return { playlistCache }
    })
  },

  removeCachedPlaylist: (playlistId) => {
    set((s) => {
      if (!(playlistId in s.playlistCache)) return s
      const { [playlistId]: _removed, ...playlistCache } = s.playlistCache
      storage.savePref(PLAYLIST_CACHE_KEY, playlistCache).catch(() => {})
      return { playlistCache }
    })
  },

  setKeepFavorites: (keep) => {
    set({ keepFavorites: keep })
    storage.savePref(KEEP_FAVORITES_KEY, keep).catch(() => {})
  },

  setMaxCacheMb: (mb) => {
    const normalized = mb > 0 ? mb : 0
    set({ maxCacheMb: normalized })
    storage.savePref(MAX_CACHE_MB_KEY, normalized).catch(() => {})
    void get().evictIfNeeded()
  },

  setPreCacheCount: (count) => {
    const normalized = count > 0 ? count : 0
    set({ preCacheCount: normalized })
    storage.savePref(PRE_CACHE_COUNT_KEY, normalized).catch(() => {})
  },

  touchPlayed: (id) => {
    activeTrackId = id
    if (!get().tracks[id]) return
    const now = Date.now()
    set((s) => {
      const existing = s.tracks[id]
      if (!existing) return s
      const tracks = { ...s.tracks, [id]: { ...existing, lastPlayedAt: now } }
      void persist(tracks)
      return { tracks }
    })
  },

  evictIfNeeded: async (protectedIds) => {
    const { maxCacheMb, tracks, keptPlaylists, playlistCache, keepFavorites } = get()
    if (maxCacheMb <= 0) return

    const protectedSet = new Set<string>(protectedIds)
    if (activeTrackId) protectedSet.add(activeTrackId)
    for (const playlistId of Object.keys(keptPlaylists)) {
      const cached = playlistCache[playlistId]
      if (cached) {
        for (const song of cached.songs) protectedSet.add(song.id)
      }
    }
    if (keepFavorites) {
      const overrides = useStarStore.getState().overrides
      for (const track of Object.values(tracks)) {
        const isFav = overrides[track.id] ?? !!track.starred
        if (isFav) protectedSet.add(track.id)
      }
    }

    const toEvict = selectEvictions(tracks, maxCacheMb * 1024 * 1024, protectedSet)
    if (toEvict.length === 0) return

    for (const id of toEvict) {
      const track = tracks[id]
      if (!track) continue
      try {
        const file = new File(offlineDir, track.filename)
        if (file.exists) file.delete()
      } catch {
        // if the file is already gone, still drop it from the manifest below
      }
    }

    const evictSet = new Set(toEvict)
    set((s) => {
      const nextTracks: Record<string, OfflineTrack> = {}
      for (const [id, track] of Object.entries(s.tracks)) {
        if (!evictSet.has(id)) nextTracks[id] = track
      }
      void persist(nextTracks)
      return { tracks: nextTracks }
    })
    logEvent('music', `Cache auto : ${plural(toEvict.length, 'titre supprimé', 'titres supprimés')}`)
  },

  removeOffline: async (id) => {
    const track = get().tracks[id]
    if (!track) return
    try {
      const file = new File(offlineDir, track.filename)
      if (file.exists) file.delete()
    } catch {
      // if the file is already gone, still drop it from the manifest below
    }
    set((s) => {
      const { [id]: _removed, ...tracks } = s.tracks
      persist(tracks)
      return { tracks }
    })
  }
}))
