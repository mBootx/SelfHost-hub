import { create } from 'zustand'
import { DEFAULT_BACKUP_FOLDER, LEGACY_BACKUP_FOLDER } from '@/services/photoVault'
import { storage } from '@/services/storage'

export { DEFAULT_BACKUP_FOLDER }

/** A phone album (other than the camera's) that is backed up along with it. */
export interface BackupAlbum {
  /** The album's identifier on the phone; its title is only what it is called. */
  id: string
  title: string
}

export interface CameraBackupSettings {
  enabled: boolean
  /**
   * Where the photos go on the server, sorted into year/month sub-folders. {user} stands for the signed-in
   * account's name, so each account gets its own folder inside one central folder.
   */
  folder: string
  wifiOnly: boolean
  /** An older backup folder whose photos haven't been moved into the current layout yet, if there is one. */
  legacyFolder: string | null
  /** Backs up only while the phone is plugged in: a big backlog should not drain the battery. */
  chargingOnly: boolean
  /** Other albums backed up along with the camera's, each into a folder of its own named after it. */
  albums: BackupAlbum[]
}

export type CameraBackupPhase =
  | 'idle'
  | 'running'
  | 'waiting-wifi'
  | 'waiting-charger'
  | 'no-permission'
  | 'no-server'
  | 'error'

const SETTINGS_KEY = 'cameraBackup.settings'

const DEFAULT_SETTINGS: CameraBackupSettings = {
  enabled: false,
  folder: DEFAULT_BACKUP_FOLDER,
  wifiOnly: true,
  legacyFolder: null,
  chargingOnly: false,
  albums: []
}

interface CameraBackupState {
  settings: CameraBackupSettings
  loaded: boolean
  phase: CameraBackupPhase
  /** The file being sent and where it stands in the current run. */
  progress: { done: number; total: number; filename: string } | null
  /** Photos and videos found but not backed up yet, as of the last check. */
  pending: number | null
  uploadedTotal: number
  /** Files the server wouldn't take, given up on; the app offers to try them again. */
  gaveUp: number
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
  gaveUp: 0,
  lastSuccessAt: null,
  lastCheckAt: null,
  limitedAccess: false,
  error: null,

  load: async () => {
    if (get().loaded) return
    const saved = await storage.loadPref<Partial<CameraBackupSettings>>(SETTINGS_KEY).catch(() => null)
    const settings = { ...DEFAULT_SETTINGS, ...saved }
    // Backups used to go to one folder, "/Appareil photo". An install still on that default moves to the
    // per-account layout, and remembers the old folder so the photos already there can be moved across.
    if (saved && saved.folder === LEGACY_BACKUP_FOLDER && saved.legacyFolder === undefined) {
      settings.folder = DEFAULT_BACKUP_FOLDER
      settings.legacyFolder = LEGACY_BACKUP_FOLDER
      await storage.savePref(SETTINGS_KEY, settings).catch(() => {})
    }
    set({ settings, loaded: true })
  },

  saveSettings: async (next) => {
    const settings = { ...get().settings, ...next }
    set({ settings })
    await storage.savePref(SETTINGS_KEY, settings)
  }
}))
