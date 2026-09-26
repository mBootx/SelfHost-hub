import { create } from 'zustand'
import { NDSong } from '@/services/navidrome'
import { storage } from '@/services/storage'

export interface HistoryEntry {
  id: string
  title: string
  artist: string
  album?: string
  coverArt?: string
  albumId?: string
  duration: number
  playedAt: number
}

const MAX_ENTRIES = 30
const STORAGE_KEY = 'navidrome.history'

interface HistoryState {
  entries: HistoryEntry[]
  loaded: boolean
  loadFromDisk: () => Promise<void>
  record: (song: NDSong) => void
  clear: () => void
}

/**
 * Subsonic has no generic "play history" endpoint, so this tracks locally on
 * this device only - not synced across devices, and lost if app data is
 * cleared. Good enough for a personal "what did I just listen to" shortcut.
 */
export const useHistoryStore = create<HistoryState>((set) => ({
  entries: [],
  loaded: false,

  loadFromDisk: async () => {
    const saved = await storage.loadPref<HistoryEntry[]>(STORAGE_KEY)
    set({ entries: saved || [], loaded: true })
  },

  record: (song) => {
    set((s) => {
      const entries = [
        {
          id: song.id,
          title: song.title,
          artist: song.artist,
          album: song.album,
          coverArt: song.coverArt,
          albumId: song.albumId,
          duration: song.duration,
          playedAt: Date.now()
        },
        ...s.entries.filter((e) => e.id !== song.id)
      ].slice(0, MAX_ENTRIES)
      storage.savePref(STORAGE_KEY, entries)
      return { entries }
    })
  },

  clear: () => {
    set({ entries: [] })
    storage.savePref(STORAGE_KEY, [])
  }
}))
