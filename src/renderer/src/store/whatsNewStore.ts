import { create } from 'zustand'
import { RELEASE_NOTES, ReleaseNote, isNewer } from '@renderer/releaseNotes'

const SEEN_KEY = 'shub.lastSeenVersion'

interface WhatsNewState {
  /** The notes on screen, or null when the window is closed. */
  notes: ReleaseNote[] | null
  /** Shows what changed since the last version the user saw, once per update. Call at startup. */
  check: () => Promise<void>
  /** Opens every note, from Settings. */
  showAll: () => void
  dismiss: () => void
}

let currentVersion: string | null = null

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY)
  } catch {
    return null
  }
}

function writeSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version)
  } catch {
    // Worst case the notes show again next launch.
  }
}

export const useWhatsNewStore = create<WhatsNewState>((set) => ({
  notes: null,

  check: async () => {
    const current = await window.api.updater.currentVersion()
    currentVersion = current
    const seen = readSeen()
    if (seen === current) return
    // With nothing recorded (the first version to have this window), only this version's notes show.
    const unseen = RELEASE_NOTES.filter(
      (note) => (seen ? isNewer(note.version, seen) : note.version === current) && !isNewer(note.version, current)
    )
    if (unseen.length > 0) set({ notes: unseen })
    else writeSeen(current)
  },

  showAll: () => set({ notes: RELEASE_NOTES }),

  dismiss: () => {
    if (currentVersion) writeSeen(currentVersion)
    set({ notes: null })
  }
}))
