import { useCallback, useEffect } from 'react'
import { useFocusEffect } from 'expo-router'
import { NDSong } from '@/services/navidrome'
import { useSelectionStore } from '@/store/selectionStore'

/**
 * Tells the selection bar which songs this screen lists (for "Tout sélectionner"), and drops the selection when the
 * screen is left, so a selection never follows you to another list.
 */
export function useSelectionPool(songs: NDSong[]): void {
  const setPool = useSelectionStore((s) => s.setPool)

  useEffect(() => {
    setPool(songs)
  }, [songs, setPool])

  useFocusEffect(
    useCallback(() => {
      return () => {
        const state = useSelectionStore.getState()
        if (state.active) state.clear()
        state.setPool([])
      }
    }, [])
  )
}
