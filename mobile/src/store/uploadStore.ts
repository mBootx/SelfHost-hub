import { create } from 'zustand'
import { FileBrowserClient } from '@/services/filebrowser'

export interface UploadTask {
  id: string
  filename: string
  destPath: string
  sizeBytes: number
  loaded: number
  speedBps: number
  status: 'queued' | 'uploading' | 'done' | 'error'
  error?: string
}

interface UploadState {
  tasks: UploadTask[]
  /** Bumped each time an upload ends well, with the folder it went to: the file list reads that folder again. */
  finished: { seq: number; destPath: string }
  /** Replaces a file of the same name only when `override` is set; otherwise the upload fails with a clear message. */
  startUpload: (
    file: { uri: string; name: string; size: number },
    destDir: string,
    client: FileBrowserClient,
    options?: { override?: boolean }
  ) => Promise<void>
  dismiss: (id: string) => void
  clearFinished: () => void
}

/** More than a couple of uploads at once only slow each other down and use up memory. */
const MAX_PARALLEL = 2

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const waiting: (() => Promise<void>)[] = []
let running = 0

function pump(): void {
  while (running < MAX_PARALLEL && waiting.length > 0) {
    const next = waiting.shift()!
    running++
    next().finally(() => {
      running--
      pump()
    })
  }
}

export const useUploadStore = create<UploadState>((set) => {
  const update = (id: string, patch: Partial<UploadTask>): void =>
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))

  return {
    tasks: [],
    finished: { seq: 0, destPath: '/' },

    startUpload: (file, destDir, client, options) =>
      new Promise<void>((resolve) => {
        const id = generateId()
        set((s) => ({
          tasks: [
            ...s.tasks,
            { id, filename: file.name, destPath: destDir, sizeBytes: file.size, loaded: 0, speedBps: 0, status: 'queued' }
          ]
        }))

        waiting.push(async () => {
          update(id, { status: 'uploading' })
          let lastLoaded = 0
          let lastTick = Date.now()
          try {
            await client.uploadLocalFile(
              file.uri,
              destDir,
              file.name,
              (loaded, total) => {
                const now = Date.now()
                const elapsed = (now - lastTick) / 1000
                if (elapsed < 0.2 && loaded !== total) return
                const speedBps = elapsed > 0 ? (loaded - lastLoaded) / elapsed : 0
                lastLoaded = loaded
                lastTick = now
                set((s) => ({
                  tasks: s.tasks.map((t) => (t.id === id ? { ...t, loaded, sizeBytes: total || t.sizeBytes, speedBps } : t))
                }))
              },
              { override: options?.override === true }
            )
            set((s) => ({
              tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: 'done', loaded: t.sizeBytes, speedBps: 0 } : t)),
              finished: { seq: s.finished.seq + 1, destPath: destDir }
            }))
          } catch (err: any) {
            update(id, { status: 'error', error: err?.message || 'Échec du téléversement', speedBps: 0 })
          }
          resolve()
        })
        pump()
      }),

    dismiss: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
    clearFinished: () => set((s) => ({ tasks: s.tasks.filter((t) => t.status === 'uploading' || t.status === 'queued') }))
  }
})
