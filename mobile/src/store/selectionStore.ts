import { create } from 'zustand'
import { NDSong } from '@/services/navidrome'

interface SelectionState {
  /** Rows show a checkbox and a tap picks instead of playing. */
  active: boolean
  /** The songs picked, in the order they were picked (that is the order they are queued in). */
  picked: NDSong[]
  /** Which song ids are picked, for the rows to read cheaply. */
  ids: Record<string, true>
  /** The songs of the list on screen, for "Tout sélectionner". */
  pool: NDSong[]
  start: (song?: NDSong) => void
  toggle: (song: NDSong) => void
  selectAll: () => void
  clear: () => void
  setPool: (songs: NDSong[]) => void
}

/** Picks songs in a list (album, playlist, favourites, search) to act on them together. */
export const useSelectionStore = create<SelectionState>((set, get) => ({
  active: false,
  picked: [],
  ids: {},
  pool: [],
  start: (song) =>
    set({
      active: true,
      picked: song ? [song] : [],
      ids: song ? { [song.id]: true } : {}
    }),
  toggle: (song) => {
    const { picked, ids } = get()
    if (ids[song.id]) {
      const { [song.id]: _removed, ...rest } = ids
      set({ picked: picked.filter((p) => p.id !== song.id), ids: rest })
    } else {
      set({ active: true, picked: [...picked, song], ids: { ...ids, [song.id]: true } })
    }
  },
  selectAll: () => {
    const { pool, picked, ids } = get()
    // Everything already picked stays first, so the order they were picked in is kept.
    const next = [...picked]
    const taken = { ...ids }
    for (const song of pool) {
      if (!taken[song.id]) {
        taken[song.id] = true
        next.push(song)
      }
    }
    set({ active: true, picked: next, ids: taken })
  },
  clear: () => set({ active: false, picked: [], ids: {} }),
  setPool: (songs) => set({ pool: songs })
}))
