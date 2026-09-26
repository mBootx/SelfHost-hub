import { create } from 'zustand'
import { NDSong } from '@/services/navidrome'

interface PlaylistPickerState {
  song: NDSong | null
  open: (song: NDSong) => void
  close: () => void
}

/** Same one-shared-sheet idea as trackSheetStore, for the "add to playlist" picker. */
export const usePlaylistPickerStore = create<PlaylistPickerState>((set) => ({
  song: null,
  open: (song) => set({ song }),
  close: () => set({ song: null })
}))
