import { create } from 'zustand'
import { storage } from '@/services/storage'

export interface CameraBackupSettings {
  enabled: boolean
  /** FileBrowser folder the photos go to, sorted into year/month sub-folders. */
  folder: string
  wifiOnly: boolean
}

export type CameraBackupPhase =
  | 'idle'
  | 'running'
  | 'waiting-wifi'
  | 'no-permission'
  | 'no-server'
  | 'error'

const SETTINGS_KEY = 'cameraBackup.settings'

export const DEFAULT_BACKUP_FOLDER = '/Appareil photo'

const DEFAULT_SETTINGS: CameraBackupSettings = { enabled: false, folder: DEFAULT_BACKUP_FOLDER, wifiOnly: true }

interface CameraBackupState {
  settings: CameraBackupSettings
  loaded: boolean
  phase: CameraBackupPhase
  /** The file being sent and where it stands in the current run. */
  progress: { done: number; total: number; filename: string } | null
  /** Photos and videos found but not backed up yet, as of the last check. */
  pending: number | null
  uploadedTotal: number
  lastSuccessAt: number | null
  lastCheckAt: number | null
  /** Only the photos the user picked are visible (Android's "limited" access). */
  limitedAccess: boolean
  error: string | null

  load: () => Promise<void>
  saveSettings: (next: Partial<CameraBackupSettings>) => Promise<void>
}

export const useCameraBackupStore = create<CameraBackupState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  phase: 'idle',
  progress: null,
  pending: null,
  uploadedTotal: 0,
  lastSuccessAt: null,
  lastCheckAt: null,
  limitedAccess: false,
  error: null,

  load: async () => {
    if (get().loaded) return
    const saved = await storage.loadPref<Partial<CameraBackupSettings>>(SETTINGS_KEY).catch(() => null)
    set({ settings: { ...DEFAULT_SETTINGS, ...saved }, loaded: true })
  },

  saveSettings: async (next) => {
    const settings = { ...get().settings, ...next }
    set({ settings })
    await storage.savePref(SETTINGS_KEY, settings)
  }
}))
