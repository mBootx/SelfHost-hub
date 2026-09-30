import { create } from 'zustand'
import type { NavidromeClient, NDSong } from '@/services/navidrome'
import { useToastStore } from '@/store/toastStore'

interface StarState {
  /**
   * What the user chose this session, by song id. A queued song keeps the `starred` it was fetched with,
   * which goes stale the moment it is toggled, so the heart and the track menu both read this first.
   */
  overrides: Record<string, boolean>
  /** Resolves true when the server took the change; on failure the heart goes back and a toast says so. */
  toggle: (song: NDSong, client: NavidromeClient) => Promise<boolean>
}

/** Whether a song is a favourite, counting changes made since it was loaded. For use inside a selector. */
export const isStarred = (state: StarState, song: NDSong): boolean => state.overrides[song.id] ?? !!song.starred

export const useStarStore = create<StarState>((set, get) => ({
  overrides: {},
  toggle: async (song, client) => {
    const was = isStarred(get(), song)
    set((s) => ({ overrides: { ...s.overrides, [song.id]: !was } }))
    try {
      if (was) await client.unstar(song.id)
      else await client.star(song.id)
      return true
    } catch {
      set((s) => ({ overrides: { ...s.overrides, [song.id]: was } }))
      useToastStore.getState().show('Impossible de modifier les favoris')
      return false
    }
  }
}))
