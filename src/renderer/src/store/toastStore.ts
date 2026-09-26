import { create } from 'zustand'

export interface ToastItem {
  id: string
  message: string
}

interface ToastState {
  toasts: ToastItem[]
  show: (message: string) => void
  dismiss: (id: string) => void
}

const TOAST_DURATION_MS = 3000

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  show: (message) => {
    const id = Math.random().toString(36).slice(2)
    set((s) => ({ toasts: [...s.toasts, { id, message }] }))
    setTimeout(() => get().dismiss(id), TOAST_DURATION_MS)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))
