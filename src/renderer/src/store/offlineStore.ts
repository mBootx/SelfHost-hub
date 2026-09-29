import { create } from 'zustand'
import { NavidromeClient, NDSong } from '@renderer/services/navidrome'
import { storage } from '@renderer/services/storage'

export interface OfflineTrack {
  id: string
  title: string
  artist: string
  album?: string
  coverArt?: string
  duration: number
  filename: string
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

  loadFromDisk: () => Promise<void>
  isOffline: (id: string) => boolean
  getLocalUrl: (id: string) => string | null
  downloadTrack: (song: NDSong, client: NavidromeClient) => Promise<void>
  downloadTracks: (songs: NDSong[], client: NavidromeClient) => Promise<void>
  removeOffline: (id: string) => Promise<void>
  dismissError: (id: string) => void
}

function offlineFileUrl(filename: string): string {
  // Needs a host: offline:///x is rewritten to offline://x/ (see the handler in src/main/index.ts).
  return `offline://tracks/${encodeURIComponent(filename)}`
}

async function persist(tracks: Record<string, OfflineTrack>): Promise<void> {
  await storage.savePref('navidrome.offlineTracks', tracks)
}

export const useOfflineStore = create<OfflineState>((set, get) => ({
  tracks: {},
  downloading: {},
  errors: {},
  loaded: false,

  loadFromDisk: async () => {
    if (get().loaded) return
    const saved = await storage.loadPref<Record<string, OfflineTrack>>('navidrome.offlineTracks')
    set({ tracks: saved || {}, loaded: true })
  },

  isOffline: (id) => !!get().tracks[id],

  getLocalUrl: (id) => {
    const track = get().tracks[id]
    return track ? offlineFileUrl(track.filename) : null
  },

  downloadTrack: async (song, client) => {
    if (get().tracks[song.id] || get().downloading[song.id]) return
    set((s) => ({
      downloading: { ...s.downloading, [song.id]: { loaded: 0, total: 0, speedBps: 0 } },
      errors: { ...s.errors, [song.id]: undefined as unknown as string }
    }))
    try {
      const url = client.streamUrl(song.id)
      const res = await window.api.offline.download({ id: song.id, url, extension: 'mp3' })
      if (!res.ok) throw new Error(res.error || 'Téléchargement impossible')
      const track: OfflineTrack = {
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        coverArt: song.coverArt || song.albumId,
        duration: song.duration,
        filename: res.filename
      }
      set((s) => {
        const { [song.id]: _removed, ...downloading } = s.downloading
        const tracks = { ...s.tracks, [song.id]: track }
        persist(tracks)
        return { tracks, downloading }
      })
    } catch (err: any) {
      set((s) => {
        const { [song.id]: _removed, ...downloading } = s.downloading
        return { downloading, errors: { ...s.errors, [song.id]: err?.message || 'Erreur de téléchargement' } }
      })
    }
  },

  downloadTracks: async (songs, client) => {
    // Bounded, not Promise.all over the whole album: firing every track at once
    // opened a socket and a write stream per track for no gain on one connection.
    const CONCURRENCY = 3
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < songs.length) {
        const song = songs[cursor++]
        await get().downloadTrack(song, client)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, songs.length) }, worker))
  },

  removeOffline: async (id) => {
    const track = get().tracks[id]
    if (!track) return
    await window.api.offline.delete({ filename: track.filename })
    set((s) => {
      const { [id]: _removed, ...tracks } = s.tracks
      persist(tracks)
      return { tracks }
    })
  },

  dismissError: (id) =>
    set((s) => {
      const { [id]: _removed, ...errors } = s.errors
      return { errors }
    })
}))

if (typeof window !== 'undefined' && window.api?.offline?.onDownloadProgress) {
  window.api.offline.onDownloadProgress(({ id, loaded, total, speedBps }) => {
    useOfflineStore.setState((s) => {
      if (!s.downloading[id]) return s
      return { downloading: { ...s.downloading, [id]: { loaded, total, speedBps } } }
    })
  })
}
