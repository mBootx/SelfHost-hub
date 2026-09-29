import { create } from 'zustand'
import { RELEASE_NOTES, ReleaseNote } from '@/constants/releaseNotes'
import { installedVersion, isNewer } from '@/services/appUpdate'
import { storage } from '@/services/storage'

const SEEN_KEY = 'app.lastSeenVersion'

interface WhatsNewState {
  /** The notes on screen, or null when the window is closed. */
  notes: ReleaseNote[] | null
  /** Shows what changed since the last version the user saw, once per update. Call at startup. */
  check: () => Promise<void>
  /** Opens every note, from Settings. */
  showAll: () => void
  dismiss: () => void
}

export const useWhatsNewStore = create<WhatsNewState>((set) => ({
  notes: null,

  check: async () => {
    const current = installedVersion()
    const seen = await storage.loadPref<string>(SEEN_KEY).catch(() => null)
    if (seen === current) return
    // With nothing recorded (the first version to have this window), only this version's notes show.
    const unseen = RELEASE_NOTES.filter(
      (note) => (seen ? isNewer(note.version, seen) : note.version === current) && !isNewer(note.version, current)
    )
    if (unseen.length > 0) set({ notes: unseen })
    else storage.savePref(SEEN_KEY, current).catch(() => {})
  },

  showAll: () => set({ notes: RELEASE_NOTES }),

  dismiss: () => {
    storage.savePref(SEEN_KEY, installedVersion()).catch(() => {})
    set({ notes: null })
  }
}))
