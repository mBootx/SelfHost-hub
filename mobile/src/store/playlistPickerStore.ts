import { create } from 'zustand'
import { NDSong } from '@/services/navidrome'

/** What is to be added to a playlist: one song, or several (a whole album) under one name. */
export interface PlaylistPick {
  songs: NDSong[]
  /** What the picker calls it: the song's title, or the album's name. */
  label: string
}

interface PlaylistPickerState {
  pick: PlaylistPick | null
  open: (song: NDSong) => void
  /** Several songs at once (an album), shown as `label`. */
  openMany: (songs: NDSong[], label: string) => void
  close: () => void
}

/** Same one-shared-sheet idea as trackSheetStore, for the "add to playlist" picker. */
export const usePlaylistPickerStore = create<PlaylistPickerState>((set) => ({
  pick: null,
  open: (song) => set({ pick: { songs: [song], label: song.title } }),
  openMany: (songs, label) => set({ pick: songs.length > 0 ? { songs, label } : null }),
  close: () => set({ pick: null })
}))
