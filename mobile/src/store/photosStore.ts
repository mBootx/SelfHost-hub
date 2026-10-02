import { create } from 'zustand'
import { describeError, logEvent } from '@/services/diagnostics'
import type { FileBrowserClient } from '@/services/filebrowser'
import { loadPhotos, Photo, purgeExpiredTrash, TRASH_DAYS, trashPhotos, VaultError, VaultErrorCode } from '@/services/photoVault'

type Status = 'idle' | 'loading' | 'ready' | 'error'

export interface PhotosError {
  code: VaultErrorCode
  message: string
}

/** What the gallery reads: the account's own backup folder, and older backup folders whose photos haven't been moved into it. */
export interface PhotoTarget {
  root: string
  older: string[]
}

export function targetKey(target: PhotoTarget): string {
  return [target.root, ...target.older].join('|')
}

interface PhotosState {
  /** What the photos below were read from (see targetKey): a different account or setting starts over. */
  key: string | null
  /** The account's backup folder first, then older ones: where photos can be deleted from (into the first one's bin). */
  folders: string[]
  status: Status
  /** Photos and videos together; the screen filters. */
  photos: Photo[]
  /** Some folder couldn't be read, so photos may be missing. */
  incomplete: boolean
  error: PhotosError | null
  loadedAt: number | null

  /**
   * Reads the folders. A load already running for the same folders is shared; with `fresh`, one more follows it,
   * because photos may have been uploaded since it listed the folders.
   */
  load: (client: FileBrowserClient, target: PhotoTarget, options?: { fresh?: boolean }) => Promise<void>
  /** Moves photos into the account's bin on the server and drops the ones that went from the list. */
  trash: (client: FileBrowserClient, paths: string[]) => Promise<{ moved: number; failed: number; message: string | null }>
  reset: () => void
}

const EMPTY = { key: null, folders: [], status: 'idle' as Status, photos: [], incomplete: false, error: null, loadedAt: null }

/** Bumped by every load, so a slow one that was overtaken (another account, a pull to refresh) can't overwrite a newer one. */
let generation = 0
let inFlight: { key: string; promise: Promise<void> } | null = null
let reloadAfter = false
/** The bin is cleaned at most once a day, after the gallery has loaded (so the account is known to work). */
const PURGE_EVERY_MS = 24 * 60 * 60 * 1000
let lastPurge = 0

export const usePhotosStore = create<PhotosState>((set, get) => ({
  ...EMPTY,

  load: (client, target, options) => {
    const key = targetKey(target)
    if (inFlight && inFlight.key === key) {
      if (options?.fresh) reloadAfter = true
      return inFlight.promise
    }
    const mine = ++generation
    const current = get()
    // The same folders keep showing what they have while they refresh; others start from nothing.
    set({ ...(current.key === key ? {} : { ...EMPTY }), key, folders: [target.root, ...target.older], status: 'loading', error: null })

    const promise = (async () => {
      try {
        const listing = await loadPhotos(client, target.root, {
          olderFolders: target.older,
          isCancelled: () => mine !== generation,
          onPartial: (photos) => {
            if (mine === generation) set({ photos })
          }
        })
        if (mine !== generation) return
        set({ status: 'ready', photos: listing.photos, incomplete: listing.incomplete, loadedAt: Date.now() })
        if (Date.now() - lastPurge > PURGE_EVERY_MS) {
          lastPurge = Date.now()
          void purgeExpiredTrash(client, target.root)
            .then((result) => {
              if (result.removed > 0) logEvent('photos', `Corbeille : ${result.removed} jour(s) de plus de ${TRASH_DAYS} jours effacé(s)`)
            })
            .catch(() => {})
        }
      } catch (err) {
        if (mine !== generation) return
        const error = err instanceof VaultError ? { code: err.code, message: err.message } : { code: 'failed' as const, message: 'Impossible de charger les photos' }
        set({ status: 'error', error })
        logEvent('photos', `Impossible de lire les photos : ${describeError(err)}`, 'warn')
      } finally {
        if (mine === generation) {
          inFlight = null
          if (reloadAfter) {
            reloadAfter = false
            void get().load(client, target)
          }
        }
      }
    })()
    inFlight = { key, promise }
    return promise
  },

  trash: async (client, paths) => {
    const { folders } = get()
    if (folders.length === 0) return { moved: 0, failed: paths.length, message: null }
    const report = await trashPhotos(client, folders, paths)
    if (report.moved.length > 0) {
      const gone = new Set(report.moved.map((m) => m.from))
      set((s) => ({ photos: s.photos.filter((p) => !gone.has(p.path)) }))
    }
    return { moved: report.moved.length, failed: report.failed.length, message: report.failed[0]?.message ?? null }
  },

  reset: () => {
    lastPurge = 0
    generation++
    inFlight = null
    reloadAfter = false
    set({ ...EMPTY })
  }
}))
