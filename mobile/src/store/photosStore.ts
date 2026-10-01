import { create } from 'zustand'
import type { FileBrowserClient } from '@/services/filebrowser'
import { deletePhotos, loadPhotos, Photo, VaultError, VaultErrorCode } from '@/services/photoVault'

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
  /** The folders those photos can be deleted from. */
  folders: string[]
  status: Status
  photos: Photo[]
  /** Videos are backed up too; the gallery only shows photos and says how many it is leaving out. */
  videos: number
  /** Some folder couldn't be read, so photos may be missing. */
  incomplete: boolean
  error: PhotosError | null
  loadedAt: number | null

  /**
   * Reads the folders. A load already running for the same folders is shared; with `fresh`, one more follows it,
   * because photos may have been uploaded since it listed the folders.
   */
  load: (client: FileBrowserClient, target: PhotoTarget, options?: { fresh?: boolean }) => Promise<void>
  /** Deletes photos on the server, for good, and drops the ones that went from the list. */
  remove: (client: FileBrowserClient, paths: string[]) => Promise<{ deleted: number; failed: number; message: string | null }>
  reset: () => void
}

const EMPTY = { key: null, folders: [], status: 'idle' as Status, photos: [], videos: 0, incomplete: false, error: null, loadedAt: null }

/** Bumped by every load, so a slow one that was overtaken (another account, a pull to refresh) can't overwrite a newer one. */
let generation = 0
let inFlight: { key: string; promise: Promise<void> } | null = null
let reloadAfter = false

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
        set({ status: 'ready', photos: listing.photos, videos: listing.videos, incomplete: listing.incomplete, loadedAt: Date.now() })
      } catch (err) {
        if (mine !== generation) return
        const error = err instanceof VaultError ? { code: err.code, message: err.message } : { code: 'failed' as const, message: 'Impossible de charger les photos' }
        set({ status: 'error', error })
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

  remove: async (client, paths) => {
    const { folders } = get()
    if (folders.length === 0) return { deleted: 0, failed: paths.length, message: null }
    const report = await deletePhotos(client, folders, paths)
    if (report.deleted.length > 0) {
      const gone = new Set(report.deleted)
      set((s) => ({ photos: s.photos.filter((p) => !gone.has(p.path)) }))
    }
    return { deleted: report.deleted.length, failed: report.failed.length, message: report.failed[0]?.message ?? null }
  },

  reset: () => {
    generation++
    inFlight = null
    reloadAfter = false
    set({ ...EMPTY })
  }
}))
