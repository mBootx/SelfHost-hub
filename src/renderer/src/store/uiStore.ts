import { create } from 'zustand'

interface UIState {
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  /** The full-screen player ("Big Picture") covers the app while this is on. */
  bigPicture: boolean
  openBigPicture: () => void
  closeBigPicture: () => void
  toggleBigPicture: () => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  bigPicture: false,
  openBigPicture: () => set({ bigPicture: true }),
  closeBigPicture: () => set({ bigPicture: false }),
  toggleBigPicture: () => set((s) => ({ bigPicture: !s.bigPicture }))
}))
