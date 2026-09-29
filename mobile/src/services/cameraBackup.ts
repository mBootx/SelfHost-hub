import { AppState } from 'react-native'
import * as BackgroundTask from 'expo-background-task'
import { File } from 'expo-file-system'
import * as MediaLibrary from 'expo-media-library'
import { Album, Asset, AssetField, MediaType, Query } from 'expo-media-library'
import type { AssetInfo, AssetMetadata } from 'expo-media-library'
import * as Network from 'expo-network'
import * as TaskManager from 'expo-task-manager'
import { expectExternalScreen } from '@/services/appLock'
import { ApiError, FileBrowserClient } from '@/services/filebrowser'
import { storage } from '@/services/storage'
import { useCameraBackupStore } from '@/store/cameraBackupStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'

/**
 * Backs up the phone's camera roll (DCIM/Camera) to FileBrowser, sorted into year/month folders.
 * Runs when the app opens or comes back, when asked, and in the background every 15 minutes or so
 * (Android decides exactly when). Each photo is sent once: a journal records how far the backup got.
 */
const TASK_NAME = 'selfhost-camera-backup'
const JOURNAL_KEY = 'cameraBackup.journal'
const MEDIA_PERMISSIONS: MediaLibrary.GranularPermission[] = ['photo', 'video']
/** Photos saved late (a long video is dated from its start) are still caught this far back. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000
/** A file failing this many times for its own reasons (not the network or the server) is left out for good. */
const MAX_ATTEMPTS = 3
/** Android stops background work after 10 minutes: the rest waits for the next run. */
const BACKGROUND_BUDGET_MS = 8 * 60 * 1000
const BACKGROUND_INTERVAL_MIN = 15
/** Coming back to the app re-checks for new photos at most this often. */
const RESUME_MIN_GAP_MS = 2 * 60 * 1000
/** The journal is written at most this often during a run (and at its end): a big first backup sends thousands. */
const JOURNAL_SAVE_GAP_MS = 5000

interface Journal {
  /** Nothing taken before this moment (ms) is backed up: when backup was turned on, or 0 for the whole roll. */
  floor: number
  /** Everything taken up to this moment (ms) is backed up, or has been given up on. */
  cursor: number
  /** Backed-up files taken after cursor - LOOKBACK_MS, id -> capture time, so the look-back skips them. */
  recent: Record<string, number>
  /** Files that failed for their own reasons, id -> attempts and capture time. */
  failures: Record<string, { attempts: number; time: number }>
  uploadedTotal: number
  lastSuccessAt: number | null
}

const EMPTY_JOURNAL: Journal = { floor: 0, cursor: 0, recent: {}, failures: {}, uploadedTotal: 0, lastSuccessAt: null }

let running: Promise<void> | null = null
/** When the current run must stop starting new uploads; a background run joining a foreground one lowers it. */
let deadline = Number.POSITIVE_INFINITY
let cancelRequested = false
let started = false

async function loadJournal(): Promise<Journal> {
  const saved = await storage.loadPref<Journal>(JOURNAL_KEY).catch(() => null)
  return { ...EMPTY_JOURNAL, ...saved }
}

async function saveJournal(journal: Journal): Promise<void> {
  await storage.savePref(JOURNAL_KEY, journal)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The signed-in FileBrowser, or one signed in from the saved credentials when the app runs without a screen. */
async function getClient(): Promise<FileBrowserClient | null> {
  const live = useFileBrowserStore.getState().client
  if (live) return live
  const conn = await storage.loadConnection('filebrowser')
  const password = conn ? await storage.loadSecret('filebrowser', 'password') : null
  if (!conn || !password) return null
  const client = new FileBrowserClient({ url: conn.url, username: conn.username, password })
  await client.login()
  return client
}

function monthFolder(root: string, takenAt: number): string {
  const date = new Date(takenAt)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${root.replace(/\/+$/, '') || ''}/${date.getFullYear()}/${month}`
}

/** Creates the folder and its parents; "already exists" answers are expected and ignored. */
async function ensureFolder(client: FileBrowserClient, path: string, known: Set<string>): Promise<void> {
  const parts = path.split('/').filter(Boolean)
  for (let i = 1; i <= parts.length; i++) {
    const partial = `/${parts.slice(0, i).join('/')}`
    if (known.has(partial)) continue
    await client.createFolder(partial).catch(() => {})
    known.add(partial)
  }
}

/** 'signed-out': the session expired; signing in again and retrying is worth one try. */
type Outcome = 'sent' | 'file-problem' | 'signed-out' | 'stop'

/** What a failed upload says about the run: skip this file, or stop until the server or network is back. */
function classify(err: unknown): { outcome: Outcome; message: string } {
  if (err instanceof ApiError) {
    if (err.status === 413) return { outcome: 'file-problem', message: 'fichier trop volumineux pour le serveur' }
    if (err.status === 401 || err.status === 403) return { outcome: 'signed-out', message: 'FileBrowser a refusé la connexion' }
    if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
      return { outcome: 'file-problem', message: `refusé par le serveur (${err.status})` }
    }
    return { outcome: 'stop', message: `serveur indisponible (${err.status || 'hors ligne'})` }
  }
  // Errors thrown by the upload itself are network failures: the file was checked beforehand.
  return { outcome: 'stop', message: errorMessage(err) }
}

/** Sends one photo or video into its year/month folder. */
async function sendOne(
  client: FileBrowserClient,
  meta: AssetMetadata & { creationTime: number },
  folders: Set<string>
): Promise<{ outcome: Outcome; message: string }> {
  let info: AssetInfo
  try {
    info = await new Asset(meta.id).getInfo()
    if (!new File(info.uri).exists) throw new Error('fichier introuvable sur le téléphone')
  } catch (err) {
    // Deleted meanwhile, or unreadable: a problem with this file only.
    return { outcome: 'file-problem', message: errorMessage(err) }
  }
  const folder = monthFolder(useCameraBackupStore.getState().settings.folder, meta.creationTime)
  try {
    await ensureFolder(client, folder, folders)
    await client.uploadLocalFile(info.uri, folder, info.filename)
    return { outcome: 'sent', message: '' }
  } catch (err) {
    return classify(err)
  }
}

async function run(): Promise<void> {
  const store = useCameraBackupStore
  await store.getState().load()
  const { settings } = store.getState()
  if (!settings.enabled) return
  cancelRequested = false

  const permission = await MediaLibrary.getPermissionsAsync(false, MEDIA_PERMISSIONS)
  if (!permission.granted) {
    store.setState({ phase: 'no-permission', lastCheckAt: Date.now() })
    return
  }
  store.setState({ limitedAccess: permission.accessPrivileges === 'limited' })

  if (settings.wifiOnly) {
    const network = await Network.getNetworkStateAsync()
    if (network.type !== Network.NetworkStateType.WIFI && network.type !== Network.NetworkStateType.ETHERNET) {
      store.setState({ phase: 'waiting-wifi', lastCheckAt: Date.now() })
      return
    }
  }

  const journal = await loadJournal()
  store.setState({ uploadedTotal: journal.uploadedTotal, lastSuccessAt: journal.lastSuccessAt })

  const album = await Album.get('Camera')
  if (!album) {
    store.setState({ phase: 'idle', pending: 0, lastCheckAt: Date.now(), error: null })
    return
  }
  const from = Math.max(journal.floor, journal.cursor - LOOKBACK_MS)
  const all = (
    await new Query()
      .album(album)
      .gte(AssetField.CREATION_TIME, from)
      .orderBy({ key: AssetField.CREATION_TIME, ascending: true })
      .exeForMetadata()
  ).filter(
    (a): a is AssetMetadata & { creationTime: number } =>
      a.creationTime !== null && (a.mediaType === MediaType.IMAGE || a.mediaType === MediaType.VIDEO)
  )

  const isDone = (a: AssetMetadata): boolean =>
    a.id in journal.recent || (journal.failures[a.id]?.attempts ?? 0) >= MAX_ATTEMPTS

  // The cursor only moves past files that are backed up (or given up on), in capture order, so a file
  // that failed is retried next time instead of being left behind.
  let prefix = 0
  const advanceCursor = (): void => {
    const before = prefix
    while (prefix < all.length && isDone(all[prefix])) {
      journal.cursor = Math.max(journal.cursor, all[prefix].creationTime)
      prefix++
    }
    if (prefix === before) return
    const keepAfter = journal.cursor - LOOKBACK_MS
    for (const [id, time] of Object.entries(journal.recent)) if (time < keepAfter) delete journal.recent[id]
    for (const [id, failure] of Object.entries(journal.failures)) if (failure.time < keepAfter) delete journal.failures[id]
  }
  advanceCursor()

  const todo = all.filter((a) => !isDone(a))
  store.setState({ pending: todo.length, lastCheckAt: Date.now() })
  if (todo.length === 0) {
    await saveJournal(journal)
    store.setState({ phase: 'idle', error: null })
    return
  }

  let client: FileBrowserClient | null
  try {
    client = await getClient()
  } catch (err) {
    store.setState({ phase: 'no-server', error: errorMessage(err) })
    return
  }
  if (!client) {
    store.setState({ phase: 'no-server', error: null })
    return
  }

  store.setState({ phase: 'running', error: null })
  const folders = new Set<string>()
  let stopMessage: string | null = null
  let lastFileError: string | null = null
  let retryLater = 0
  let savedAt = Date.now()
  let signedInAgain = false

  for (const [index, meta] of todo.entries()) {
    if (cancelRequested || Date.now() > deadline) break
    const filename = meta.filename || meta.id.split('/').pop() || 'photo'
    store.setState({ progress: { done: index, total: todo.length, filename } })

    let { outcome, message } = await sendOne(client, meta, folders)
    // FileBrowser sessions expire: sign in again once per run (as the file screen does) and retry.
    if (outcome === 'signed-out' && !signedInAgain) {
      signedInAgain = true
      try {
        await client.login()
        ;({ outcome, message } = await sendOne(client, meta, folders))
      } catch (err) {
        outcome = 'stop'
        message = errorMessage(err)
      }
    }

    if (outcome === 'stop' || outcome === 'signed-out') {
      stopMessage = message
      break
    }
    if (outcome === 'sent') {
      journal.recent[meta.id] = meta.creationTime
      delete journal.failures[meta.id]
      journal.uploadedTotal++
      journal.lastSuccessAt = Date.now()
    } else {
      const attempts = (journal.failures[meta.id]?.attempts ?? 0) + 1
      journal.failures[meta.id] = { attempts, time: meta.creationTime }
      if (attempts < MAX_ATTEMPTS) retryLater++
      lastFileError = `${filename} : ${message}`
    }
    advanceCursor()
    if (Date.now() - savedAt > JOURNAL_SAVE_GAP_MS) {
      await saveJournal(journal)
      savedAt = Date.now()
    }
    store.setState({
      uploadedTotal: journal.uploadedTotal,
      lastSuccessAt: journal.lastSuccessAt,
      pending: todo.length - index - 1 + retryLater
    })
  }
  await saveJournal(journal)

  const error = stopMessage ?? lastFileError
  store.setState({ phase: stopMessage ? 'error' : 'idle', progress: null, error })
}

/** Checks for new photos and backs them up. Runs one at a time; calls during a run share it. */
export function runCameraBackup(budgetMs = Number.POSITIVE_INFINITY): Promise<void> {
  const until = Date.now() + budgetMs
  if (!running) {
    deadline = until
    running = run()
      .catch((err) => {
        useCameraBackupStore.setState({ phase: 'error', progress: null, error: errorMessage(err) })
      })
      .finally(() => {
        running = null
      })
  } else {
    deadline = Math.min(deadline, until)
  }
  return running
}

async function setBackgroundTask(enabled: boolean): Promise<void> {
  const registered = await TaskManager.isTaskRegisteredAsync(TASK_NAME).catch(() => false)
  if (enabled && !registered) {
    await BackgroundTask.registerTaskAsync(TASK_NAME, { minimumInterval: BACKGROUND_INTERVAL_MIN })
  } else if (!enabled && registered) {
    await BackgroundTask.unregisterTaskAsync(TASK_NAME)
  }
}

export async function countCameraRoll(): Promise<number> {
  const album = await Album.get('Camera')
  if (!album) return 0
  const all = await new Query().album(album).exeForMetadata()
  return all.filter((a) => a.mediaType === MediaType.IMAGE || a.mediaType === MediaType.VIDEO).length
}

/** Asks for access to photos and videos. Resolves to whether the backup can see the camera roll. */
export async function requestCameraRollAccess(): Promise<boolean> {
  expectExternalScreen()
  const permission = await MediaLibrary.requestPermissionsAsync(false, MEDIA_PERMISSIONS)
  useCameraBackupStore.setState({ limitedAccess: permission.accessPrivileges === 'limited' })
  return permission.granted
}

/** Turns backup on. `includeExisting`: the photos already on the phone too, not only the next ones. */
export async function enableCameraBackup(includeExisting: boolean): Promise<void> {
  const journal = await loadJournal()
  const now = Date.now()
  await saveJournal({
    ...journal,
    floor: includeExisting ? 0 : now,
    cursor: includeExisting ? 0 : now,
    recent: {},
    failures: {}
  })
  await useCameraBackupStore.getState().saveSettings({ enabled: true })
  useCameraBackupStore.setState({ phase: 'idle', error: null, pending: null })
  await setBackgroundTask(true)
  runCameraBackup()
}

export async function disableCameraBackup(): Promise<void> {
  cancelRequested = true
  await useCameraBackupStore.getState().saveSettings({ enabled: false })
  useCameraBackupStore.setState({ phase: 'idle', progress: null, error: null, pending: null })
  await setBackgroundTask(false)
}

/** At app start: shows the saved state, keeps the background task in place, and catches up. */
export function startCameraBackup(): void {
  if (started) return
  started = true
  const store = useCameraBackupStore.getState()
  store.load().then(async () => {
    const journal = await loadJournal()
    useCameraBackupStore.setState({ uploadedTotal: journal.uploadedTotal, lastSuccessAt: journal.lastSuccessAt })
    const { enabled } = useCameraBackupStore.getState().settings
    await setBackgroundTask(enabled).catch(() => {})
    if (enabled) runCameraBackup()
  })
  AppState.addEventListener('change', (next) => {
    if (next !== 'active' || !useCameraBackupStore.getState().settings.enabled) return
    const lastCheck = useCameraBackupStore.getState().lastCheckAt ?? 0
    if (Date.now() - lastCheck > RESUME_MIN_GAP_MS) runCameraBackup()
  })
}

// Defined as soon as the bundle loads (see index.js): Android may start the app without any screen to
// run it, and an unknown task gets unregistered.
TaskManager.defineTask(TASK_NAME, async () => {
  try {
    await runCameraBackup(BACKGROUND_BUDGET_MS)
    return BackgroundTask.BackgroundTaskResult.Success
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed
  }
})
