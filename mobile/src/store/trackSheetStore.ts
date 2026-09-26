import { create } from 'zustand'
import { NDSong } from '@/services/navidrome'

interface TrackSheetState {
  song: NDSong | null
  open: (song: NDSong) => void
  close: () => void
}

/**
 * One shared sheet for the whole app rather than a <Modal> and a useState per
 * row: a library screen can hold hundreds of TrackRows, and paying for that
 * state in every one of them would undo the list work elsewhere.
 */
export const useTrackSheetStore = create<TrackSheetState>((set) => ({
  song: null,
  open: (song) => set({ song }),
  close: () => set({ song: null })
}))
