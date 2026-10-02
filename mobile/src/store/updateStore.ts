import { create } from 'zustand'
import { describeError, logEvent } from '@/services/diagnostics'
import { AvailableUpdate, downloadUpdate, findUpdate, isDownloaded, openInstaller } from '@/services/appUpdate'

/** GitHub allows 60 anonymous API calls an hour; automatic checks stay far below that. */
const AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'error'

interface UpdateState {
  update: AvailableUpdate | null
  /** The APK is already complete in the cache, so installing skips the download. */
  readyToInstall: boolean
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

function isBusy(phase: Phase): boolean {
  return phase === 'checking' || phase === 'downloading' || phase === 'installing'
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  update: null,
  readyToInstall: false,
  phase: 'idle',
  progress: 0,
  error: null,
  dismissed: false,
  lastCheckedAt: 0,

  check: async (manual = false) => {
    const { phase, lastCheckedAt } = get()
    if (isBusy(phase)) return 'skipped'
    if (!manual && Date.now() - lastCheckedAt < AUTO_CHECK_INTERVAL_MS) return 'skipped'
    set({ phase: 'checking', lastCheckedAt: Date.now() })
    try {
      const update = await findUpdate()
      if (update) {
        logEvent('update', `Version ${update.version} disponible`)
        set({ update, readyToInstall: isDownloaded(update), phase: 'available', error: null, dismissed: false })
        return 'available'
      }
      set({ update: null, readyToInstall: false, phase: 'idle' })
      return 'current'
    } catch (err) {
      logEvent('update', `Recherche de mise à jour impossible : ${describeError(err)}`, 'warn')
      set({ phase: get().update ? 'available' : 'idle' })
      return 'error'
    }
  },

  install: async () => {
    const { update, phase } = get()
    if (!update || isBusy(phase)) return
    set({ error: null })
    try {
      if (!get().readyToInstall) {
        set({ phase: 'downloading', progress: 0 })
        await downloadUpdate(update, (fraction) => {
          const progress = Math.min(100, Math.round(fraction * 100))
          if (progress !== get().progress) set({ progress })
        })
        set({ readyToInstall: true })
      }
      set({ phase: 'installing' })
      await openInstaller(update)
      // Back from the installer without updating (a successful install restarts the app instead).
      set({ phase: 'available' })
    } catch (err: any) {
      logEvent('update', `Échec de la mise à jour vers ${update.version} : ${describeError(err)}`, 'error')
      set({ phase: 'error', error: err?.message || 'La mise à jour a échoué', readyToInstall: isDownloaded(update) })
    }
  },

  dismiss: () => set({ dismissed: true })
}))
