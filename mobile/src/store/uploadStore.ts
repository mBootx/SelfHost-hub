import { create } from 'zustand'
import { FileBrowserClient } from '@/services/filebrowser'

export interface UploadTask {
  id: string
  filename: string
  destPath: string
  sizeBytes: number
  loaded: number
  speedBps: number
  status: 'uploading' | 'done' | 'error'
  error?: string
}

interface UploadState {
  tasks: UploadTask[]
  startUpload: (
    file: { uri: string; name: string; size: number },
    destDir: string,
    client: FileBrowserClient
  ) => Promise<void>
  dismiss: (id: string) => void
  clearFinished: () => void
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export const useUploadStore = create<UploadState>((set, get) => ({
  tasks: [],

  startUpload: async (file, destDir, client) => {
    const id = generateId()
    set((s) => ({
      tasks: [
        ...s.tasks,
        { id, filename: file.name, destPath: destDir, sizeBytes: file.size, loaded: 0, speedBps: 0, status: 'uploading' }
      ]
    }))

    let lastLoaded = 0
    let lastTick = Date.now()

    try {
      await client.uploadLocalFile(file.uri, destDir, file.name, (loaded, total) => {
        const now = Date.now()
        const elapsed = (now - lastTick) / 1000
        if (elapsed < 0.2 && loaded !== total) return
        const speedBps = elapsed > 0 ? (loaded - lastLoaded) / elapsed : 0
        lastLoaded = loaded
        lastTick = now
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, loaded, sizeBytes: total || t.sizeBytes, speedBps } : t))
        }))
      })
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: 'done', loaded: t.sizeBytes, speedBps: 0 } : t))
      }))
    } catch (err: any) {
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id ? { ...t, status: 'error', error: err?.message || 'Echec du televersement', speedBps: 0 } : t
        )
      }))
    }
  },

  dismiss: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  clearFinished: () => set((s) => ({ tasks: s.tasks.filter((t) => t.status === 'uploading') }))
}))
