import { create } from 'zustand'
import { File, Directory, Paths } from 'expo-file-system'
import { NavidromeClient, NDSong } from '@/services/navidrome'
import { storage } from '@/services/storage'

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
  getLocalUri: (id: string) => string | null
  downloadTrack: (song: NDSong, client: NavidromeClient) => Promise<void>
  downloadTracks: (songs: NDSong[], client: NavidromeClient) => Promise<void>
  removeOffline: (id: string) => Promise<void>
}

const offlineDir = new Directory(Paths.document, 'offline-music')

function ensureOfflineDir(): void {
  if (!offlineDir.exists) offlineDir.create({ intermediates: true })
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

  getLocalUri: (id) => {
    const track = get().tracks[id]
    if (!track) return null
    return new File(offlineDir, track.filename).uri
  },

  downloadTrack: async (song, client) => {
    if (get().tracks[song.id] || get().downloading[song.id]) return
    ensureOfflineDir()
    set((s) => {
      const errors = { ...s.errors }
      delete errors[song.id]
      return { downloading: { ...s.downloading, [song.id]: { loaded: 0, total: 0, speedBps: 0 } }, errors }
    })
    try {
      const filename = `${song.id}.mp3`
      const destination = new File(offlineDir, filename)
      const url = client.streamUrl(song.id)
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
      const track: OfflineTrack = {
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        coverArt: song.coverArt || song.albumId,
        duration: song.duration,
        filename
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
        return { downloading, errors: { ...s.errors, [song.id]: err?.message || 'Erreur de telechargement' } }
      })
    }
  },

  downloadTracks: async (songs, client) => {
    // Bounded, not Promise.all over the whole album: firing twenty tracks at once
    // opened twenty sockets and twenty write streams on a phone, for no gain on a
    // single connection.
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
