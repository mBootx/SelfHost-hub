import { create } from 'zustand'

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
  addTask: (task: Omit<UploadTask, 'loaded' | 'speedBps' | 'status'>) => void
  updateProgress: (id: string, loaded: number, total: number, speedBps: number) => void
  markDone: (id: string) => void
  markError: (id: string, error: string) => void
  dismiss: (id: string) => void
  clearFinished: () => void
}

export const useUploadStore = create<UploadState>((set) => ({
  tasks: [],

  addTask: (task) =>
    set((s) => ({
      tasks: [...s.tasks, { ...task, loaded: 0, speedBps: 0, status: 'uploading' }]
    })),

  updateProgress: (id, loaded, total, speedBps) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, loaded, sizeBytes: total || t.sizeBytes, speedBps } : t))
    })),

  markDone: (id) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: 'done', loaded: t.sizeBytes, speedBps: 0 } : t))
    })),

  markError: (id, error) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: 'error', error, speedBps: 0 } : t))
    })),

  dismiss: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),

  clearFinished: () => set((s) => ({ tasks: s.tasks.filter((t) => t.status === 'uploading') }))
}))

if (typeof window !== 'undefined' && window.api?.fb?.onUploadProgress) {
  window.api.fb.onUploadProgress(({ id, loaded, total, speedBps }) => {
    useUploadStore.getState().updateProgress(id, loaded, total, speedBps)
  })
}
