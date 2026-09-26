import { create } from 'zustand'
import { findArtwork, loadArtworkOverrides } from '@/services/artwork'

interface ArtworkState {
  /** Song/album id -> externally sourced cover URL, for entries Navidrome has none for. */
  overrides: Record<string, string>
  loadFromDisk: () => Promise<void>
  search: (key: string, artist: string, album: string) => Promise<string | null>
}

export const useArtworkStore = create<ArtworkState>((set, get) => ({
  overrides: {},

  loadFromDisk: async () => {
    set({ overrides: await loadArtworkOverrides() })
  },

  search: async (key, artist, album) => {
    const found = await findArtwork(key, artist, album)
    if (found) set((s) => ({ overrides: { ...s.overrides, [key]: found } }))
    return found
  }
}))
