import { create } from 'zustand'
import { AvailableUpdate, downloadAndInstall, findUpdate } from '@/services/appUpdate'

/** GitHub allows 60 anonymous API calls an hour; automatic checks stay far below that. */
const AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'error'

interface UpdateState {
  update: AvailableUpdate | null
  phase: Phase
  progress: number
  error: string | null
  dismissed: boolean
  lastCheckedAt: number
  /** `manual` skips the hourly throttle and reports failures instead of staying quiet. */
  check: (manual?: boolean) => Promise<'available' | 'current' | 'error' | 'skipped'>
  install: () => Promise<void>
  dismiss: () => void
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  update: null,
  phase: 'idle',
  progress: 0,
  error: null,
  dismissed: false,
  lastCheckedAt: 0,

  check: async (manual = false) => {
    const { phase, lastCheckedAt } = get()
    if (phase === 'checking' || phase === 'downloading') return 'skipped'
    if (!manual && Date.now() - lastCheckedAt < AUTO_CHECK_INTERVAL_MS) return 'skipped'
    set({ phase: 'checking', lastCheckedAt: Date.now() })
    try {
      const update = await findUpdate()
      if (update) {
        set({ update, phase: 'available', error: null, dismissed: false })
        return 'available'
      }
      set({ update: null, phase: 'idle' })
      return 'current'
    } catch {
      set({ phase: get().update ? 'available' : 'idle' })
      return 'error'
    }
  },

  install: async () => {
    const { update, phase } = get()
    if (!update || phase === 'downloading') return
    set({ phase: 'downloading', progress: 0, error: null })
    try {
      await downloadAndInstall(update, (fraction) => {
        const progress = Math.min(100, Math.round(fraction * 100))
        if (progress !== get().progress) set({ progress })
      })
      // Back from the installer without updating (a successful install restarts the app instead).
      set({ phase: 'available' })
    } catch (err: any) {
      set({ phase: 'error', error: err?.message || 'La mise a jour a echoue' })
    }
  },

  dismiss: () => set({ dismissed: true })
}))
