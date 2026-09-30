import { create } from 'zustand'
import type { FileBrowserClient } from '@/services/filebrowser'
import { deletePhotos, loadPhotos, Photo, VaultError, VaultErrorCode } from '@/services/photoVault'

type Status = 'idle' | 'loading' | 'ready' | 'error'

export interface PhotosError {
  code: VaultErrorCode
  message: string
}

interface PhotosState {
  /** The folder the photos below were read from: a different account or setting starts over. */
  root: string | null
  status: Status
  photos: Photo[]
  /** Videos are backed up too; the gallery only shows photos and says how many it is leaving out. */
  videos: number
  /** Some folder couldn't be read, so photos may be missing. */
  incomplete: boolean
  error: PhotosError | null
  loadedAt: number | null

  load: (client: FileBrowserClient, root: string) => Promise<void>
  /** Deletes photos on the server, for good, and drops the ones that went from the list. */
  remove: (client: FileBrowserClient, paths: string[]) => Promise<{ deleted: number; failed: number; message: string | null }>
  reset: () => void
}

const EMPTY = { root: null, status: 'idle' as Status, photos: [], videos: 0, incomplete: false, error: null, loadedAt: null }

/** Bumped by every load, so a slow one that was overtaken (another account, a pull to refresh) can't overwrite a newer one. */
let generation = 0
let inFlight: { root: string; promise: Promise<void> } | null = null

export const usePhotosStore = create<PhotosState>((set, get) => ({
  ...EMPTY,

  load: (client, root) => {
    if (inFlight && inFlight.root === root) return inFlight.promise
    const mine = ++generation
    const current = get()
    // The same folder keeps showing what it has while it refreshes; another one starts from nothing.
    set({ ...(current.root === root ? {} : { ...EMPTY }), root, status: 'loading', error: null })

    const promise = (async () => {
      try {
        const listing = await loadPhotos(client, root, {
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
        if (mine === generation) inFlight = null
      }
    })()
    inFlight = { root, promise }
    return promise
  },

  remove: async (client, paths) => {
    const { root } = get()
    if (!root) return { deleted: 0, failed: paths.length, message: null }
    const report = await deletePhotos(client, root, paths)
    if (report.deleted.length > 0) {
      const gone = new Set(report.deleted)
      set((s) => ({ photos: s.photos.filter((p) => !gone.has(p.path)) }))
    }
    return { deleted: report.deleted.length, failed: report.failed.length, message: report.failed[0]?.message ?? null }
  },

  reset: () => {
    generation++
    inFlight = null
    set({ ...EMPTY })
  }
}))
