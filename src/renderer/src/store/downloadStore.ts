import { create } from 'zustand'
import { storage } from '@renderer/services/storage'

export interface DownloadedFile {
  name: string
  /** Absolute path the user chose in the save dialog. */
  path: string
  /** Where it came from on the server. */
  sourcePath: string
  downloadedAt: number
}

interface DownloadState {
  files: DownloadedFile[]
  loaded: boolean
  loadFromDisk: () => Promise<void>
  record: (file: DownloadedFile) => Promise<void>
  forget: (path: string) => Promise<void>
  clear: () => Promise<void>
}

const MANIFEST_KEY = 'filebrowser.downloads'
const MAX_ENTRIES = 100

/**
 * A history, not a store of files: on desktop the save dialog puts the file
 * wherever the user chose and the OS owns it from then on. This only remembers
 * what was fetched and where it went, so "where did that end up?" has an answer.
 */
export const useDownloadStore = create<DownloadState>((set, get) => ({
  files: [],
  loaded: false,

  loadFromDisk: async () => {
    if (get().loaded) return
    const saved = (await storage.loadPref<DownloadedFile[]>(MANIFEST_KEY)) || []
    set({ files: saved, loaded: true })
  },

  record: async (file) => {
    const files = [file, ...get().files.filter((f) => f.path !== file.path)].slice(0, MAX_ENTRIES)
    set({ files })
    await storage.savePref(MANIFEST_KEY, files)
  },

  /** Drops the entry only. Deleting a file the user placed themselves isn't ours to do. */
  forget: async (path) => {
    const files = get().files.filter((f) => f.path !== path)
    set({ files })
    await storage.savePref(MANIFEST_KEY, files)
  },

  clear: async () => {
    set({ files: [] })
    await storage.savePref(MANIFEST_KEY, [])
  }
}))

/**
 * Single entry point for "save this file", so every call site lands in the
 * history. A cancelled save dialog records nothing.
 */
export async function downloadAndRecord(
  client: { downloadTo: (path: string, name: string) => Promise<{ ok: boolean; path?: string; canceled?: boolean }> },
  item: { path: string; name: string }
): Promise<void> {
  const result = await client.downloadTo(item.path, item.name)
  if (!result?.ok || !result.path) return
  await useDownloadStore.getState().record({
    name: item.name,
    path: result.path,
    sourcePath: item.path,
    downloadedAt: Date.now()
  })
}
