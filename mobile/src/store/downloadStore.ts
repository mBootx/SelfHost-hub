import { create } from 'zustand'
import { File } from 'expo-file-system'
import { downloadsDir } from '@/services/filebrowser'
import { storage } from '@/services/storage'

export interface DownloadedFile {
  /** Filename on disk, which is also the identity: downloads are de-duplicated by it. */
  filename: string
  /** Where it came from on the server, so the row can show a meaningful subtitle. */
  sourcePath: string
  sizeBytes: number
  downloadedAt: number
}

interface DownloadState {
  files: DownloadedFile[]
  loaded: boolean

  loadFromDisk: () => Promise<void>
  record: (file: DownloadedFile) => Promise<void>
  remove: (filename: string) => Promise<void>
  clear: () => Promise<void>
  uriFor: (filename: string) => string
}

const MANIFEST_KEY = 'filebrowser.downloads'

async function persist(files: DownloadedFile[]): Promise<void> {
  await storage.savePref(MANIFEST_KEY, files)
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  files: [],
  loaded: false,

  loadFromDisk: async () => {
    if (get().loaded) return
    const saved = (await storage.loadPref<DownloadedFile[]>(MANIFEST_KEY)) || []
    // The manifest can drift from reality - the user may have cleared app storage,
    // or an older build wrote into the cache directory - so trust the disk.
    const present = saved.filter((f) => {
      try {
        return new File(downloadsDir, f.filename).exists
      } catch {
        return false
      }
    })
    if (present.length !== saved.length) await persist(present)
    set({ files: present, loaded: true })
  },

  record: async (file) => {
    const files = [file, ...get().files.filter((f) => f.filename !== file.filename)]
    set({ files })
    await persist(files)
  },

  remove: async (filename) => {
    try {
      const file = new File(downloadsDir, filename)
      if (file.exists) file.delete()
    } catch {
      // already gone; drop it from the manifest either way
    }
    const files = get().files.filter((f) => f.filename !== filename)
    set({ files })
    await persist(files)
  },

  clear: async () => {
    for (const file of get().files) {
      try {
        const handle = new File(downloadsDir, file.filename)
        if (handle.exists) handle.delete()
      } catch {
        // keep going, the manifest is reset below regardless
      }
    }
    set({ files: [] })
    await persist([])
  },

  uriFor: (filename) => new File(downloadsDir, filename).uri
}))
