import { create } from 'zustand'
import { logEvent } from '@/services/diagnostics'
import { describeRefusal, UpdatePhase, WatchAppVersion, WatchUpdateStatus } from '@/services/watchUpdateProtocol'

export type { UpdatePhase }

/** The newest watch APK of the latest GitHub release. `digest` is the SHA-256 GitHub gives the file, when it gives one. */
export interface WatchRelease {
  version: string
  code: number
  url: string
  size: number
  digest: string | null
}

export interface WatchUpdateState {
  /** The watch that last said which version of the app it has, and which version that is. */
  watch: { nodeId: string; version: string; code: number } | null
  latest: WatchRelease | null
  checkedAt: number
  phase: UpdatePhase
  /** 0 to 1, for the downloading and sending phases. */
  progress: number
  /** What to tell the person: how an update ended, or why it could not start. */
  message: string | null
  /** A request for the state carried the version of the watch app. */
  noteWatch: (nodeId: string, app: WatchAppVersion) => void
  /** The watch said something about an update, or about which version it is. */
  applyStatus: (nodeId: string, status: WatchUpdateStatus) => void
}

/** The phases in which an update is under way: another one is not started, and the watch's statuses are about it. */
export const BUSY_PHASES: readonly UpdatePhase[] = ['checking', 'downloading', 'sending', 'installing', 'confirm']
const FROM_WATCH: readonly UpdatePhase[] = ['sending', 'installing', 'confirm']

export const useWatchUpdate = create<WatchUpdateState>((set, get) => ({
  watch: null,
  latest: null,
  checkedAt: 0,
  phase: 'idle',
  progress: 0,
  message: null,

  noteWatch: (nodeId, app) => {
    const current = get().watch
    if (current && current.nodeId === nodeId && current.version === app.name && current.code === app.code) return
    set({ watch: { nodeId, version: app.name, code: app.code } })
  },

  applyStatus: (nodeId, status) => {
    const { phase } = get()
    if ((status.state === 'version' || status.state === 'installed') && status.versionName && status.versionCode) {
      set({ watch: { nodeId, version: status.versionName, code: status.versionCode } })
    }
    switch (status.state) {
      case 'installed':
        // Said by the new version as soon as it runs; also when it was installed some other way, which is no news here.
        if (FROM_WATCH.includes(phase)) {
          set({ phase: 'done', progress: 1, message: `La montre est à jour (version ${status.versionName ?? '?'}).` })
          logEvent('watch', `Montre mise à jour : ${status.versionName ?? '?'}`)
        }
        return
      case 'received':
        if (FROM_WATCH.includes(phase)) set({ phase: 'installing', progress: 1, message: null })
        return
      case 'confirm':
        if (FROM_WATCH.includes(phase)) set({ phase: 'confirm', message: 'Confirmez la mise à jour sur la montre.' })
        return
      case 'refused': {
        if (!FROM_WATCH.includes(phase)) return
        const message = describeRefusal(status.reason, status.message)
        logEvent('watch', `Mise à jour de la montre refusée (${status.reason ?? 'sans raison'}) : ${status.message ?? ''}`, 'warn')
        set({ phase: 'error', message })
        return
      }
      case 'failed':
        if (!FROM_WATCH.includes(phase)) return
        logEvent('watch', `Mise à jour de la montre échouée : ${status.message ?? ''}`, 'warn')
        set({ phase: 'error', message: status.message || "L'installation a échoué sur la montre." })
        return
      default:
        return
    }
  }
}))
