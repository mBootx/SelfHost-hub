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
import { VaultError, vaultRootFor } from '@/services/photoVault'
import { useCameraBackupStore } from '@/store/cameraBackupStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'

/**
 * Backs up the phone's camera roll (DCIM/Camera) to FileBrowser, sorted into year/month folders.
 * Runs when the app opens or comes back, when asked, and in the background every 15 minutes or so
 * (Android decides exactly when). Each photo is sent once: a journal records how far the backup got.
 * The newest photos go first, photos before videos, so the gallery is up to date as early as possible
 * even in the middle of a big first backup.
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
/**
 * Files sent ahead of older ones still waiting are remembered one by one. Past this many (a camera roll of
 * tens of thousands) the older files go first instead, so the journal stays small enough to store.
 */
const RECENT_LIMIT = 20_000
/** Files given up on that are remembered, so the app can offer to send them again. */
const MAX_GAVE_UP = 200
/** This many uploads in a row failing while the server still answers: it refuses everything, so the run stops. */
const SUSPECT_LIMIT = 3

/** What the backup needs to know about one photo or video of the camera roll. */
type Item = { id: string; filename: string | null; mediaType: MediaType; creationTime: number }

interface Journal {
  /** Nothing taken before this moment (ms) is backed up: when backup was turned on, or 0 for the whole roll. */
  floor: number
  /** Everything taken up to this moment (ms) is backed up, or has been given up on. */
  cursor: number
  /** Backed-up files taken after cursor - LOOKBACK_MS, id -> capture time, so the look-back skips them. */
  recent: Record<string, number>
  /** Files that failed for their own reasons, id -> attempts and capture time. */
  failures: Record<string, { attempts: number; time: number }>
  /** Files given up on because of the server (too big, refused), id -> what to send again and why it failed. */
  gaveUp: Record<string, { name: string; time: number; message: string }>
  uploadedTotal: number
  lastSuccessAt: number | null
}

const EMPTY_JOURNAL: Journal = { floor: 0, cursor: 0, recent: {}, failures: {}, gaveUp: {}, uploadedTotal: 0, lastSuccessAt: null }

let running: Promise<void> | null = null
/** Set by "send anyway" and "try again": the next run ignores "Wi-Fi only" / also tries the files given up on. */
let overMobileDataNext = false
let retryFailedNext = false
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

/** The signed-in account's own backup folder: the folder setting with the account's name in place of {user}. */
function backupRoot(client: FileBrowserClient): string {
  return vaultRootFor(useCameraBackupStore.getState().settings.folder, client.getAccountName())
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

/**
 * 'signed-out': the session expired; signing in again and retrying is worth one try.
 * 'stop': the upload failed in a way that could be the file's doing or the network's (a timeout, a server
 * error); the next file tells which. 'abort': every file would fail the same way, so there is no point going on.
 */
type Outcome = 'sent' | 'file-problem' | 'signed-out' | 'stop' | 'abort'

interface SendResult {
  outcome: Outcome
  message: string
  /** The trouble is on the phone (the file is gone or unreadable), not at the server: nothing to offer to retry. */
  local?: boolean
}

/** What a failed upload says about the run: skip this file, or stop until the server or network is back. */
function classify(err: unknown): SendResult {
  // A backup folder that can't be used (a setting that leaves the account's area, say) affects every file.
  if (err instanceof VaultError) return { outcome: 'abort', message: `dossier de sauvegarde invalide : ${err.message}` }
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

/**
 * The order to send in: photos before videos (the gallery shows photos, and one big video must not hold
 * them back), newest first within each. A camera roll so large that remembering every file sent ahead of the
 * older ones would swell the journal sends its newest `limit - alreadySent` files that way and the rest
 * oldest first, which lets the journal's cursor catch up and forget them.
 */
export function sendingOrder<T extends Item>(items: T[], alreadySent: number, limit = RECENT_LIMIT): T[] {
  const isVideo = (item: T): boolean => item.mediaType === MediaType.VIDEO
  const newestFirst = [...items].sort((a, b) => Number(isVideo(a)) - Number(isVideo(b)) || b.creationTime - a.creationTime)
  const room = Math.max(0, limit - alreadySent)
  if (newestFirst.length <= room) return newestFirst
  const rest = newestFirst.slice(room).sort((a, b) => a.creationTime - b.creationTime)
  return [...newestFirst.slice(0, room), ...rest]
}

/** Sends one photo or video into its year/month folder. */
async function sendOne(client: FileBrowserClient, meta: Item, folders: Set<string>): Promise<SendResult> {
  let info: AssetInfo
  try {
    info = await new Asset(meta.id).getInfo()
    if (!new File(info.uri).exists) throw new Error('fichier introuvable sur le téléphone')
  } catch (err) {
    // Deleted meanwhile, or unreadable: a problem with this file only.
    return { outcome: 'file-problem', message: errorMessage(err), local: true }
  }
  try {
    const folder = monthFolder(backupRoot(client), meta.creationTime)
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
  // "Send anyway" and "try again" are for this run only.
  const overMobileData = overMobileDataNext
  const retryFailed = retryFailedNext
  overMobileDataNext = false
  retryFailedNext = false

  const permission = await MediaLibrary.getPermissionsAsync(false, MEDIA_PERMISSIONS)
  if (!permission.granted) {
    store.setState({ phase: 'no-permission', lastCheckAt: Date.now() })
    return
  }
  store.setState({ limitedAccess: permission.accessPrivileges === 'limited' })

  if (settings.wifiOnly && !overMobileData) {
    const network = await Network.getNetworkStateAsync()
    if (network.type !== Network.NetworkStateType.WIFI && network.type !== Network.NetworkStateType.ETHERNET) {
      store.setState({ phase: 'waiting-wifi', lastCheckAt: Date.now() })
      return
    }
  }

  const journal = await loadJournal()
  store.setState({
    uploadedTotal: journal.uploadedTotal,
    lastSuccessAt: journal.lastSuccessAt,
    gaveUp: Object.keys(journal.gaveUp).length
  })

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

  const isDone = (a: { id: string }): boolean =>
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
  // Files given up on are older than the cursor, so they only come back when asked.
  const todoIds = new Set(todo.map((a) => a.id))
  const again: Item[] = retryFailed
    ? Object.entries(journal.gaveUp)
        .filter(([id]) => !todoIds.has(id))
        .map(([id, entry]) => ({ id, filename: entry.name, mediaType: MediaType.IMAGE, creationTime: entry.time }))
    : []
  const retried = new Set(again.map((item) => item.id))
  const order: Item[] = [...sendingOrder(todo, Object.keys(journal.recent).length), ...again]
  store.setState({ pending: order.length, lastCheckAt: Date.now() })
  if (order.length === 0) {
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
  /** Files whose upload failed the way a dead connection would too, though the server still answered. */
  let suspects: { item: Item; message: string }[] = []
  /** Files that are settled for good by now: sent, or given up on. */
  const finished = new Set<string>()

  const nameOf = (item: Item): string => item.filename || item.id.split('/').pop() || 'photo'

  /** The server won't take this file again: remembered, so the app can offer to try once more. */
  const giveUp = (item: Item, message: string): void => {
    journal.gaveUp[item.id] = { name: nameOf(item), time: item.creationTime, message }
    const ids = Object.keys(journal.gaveUp)
    if (ids.length > MAX_GAVE_UP) {
      ids.sort((a, b) => journal.gaveUp[a].time - journal.gaveUp[b].time)
      for (const id of ids.slice(0, ids.length - MAX_GAVE_UP)) delete journal.gaveUp[id]
    }
  }
  /** A file that could not be sent. Three strikes and it is given up on, unless it is gone from the phone. */
  const fail = (item: Item, message: string, local: boolean): void => {
    lastFileError = `${nameOf(item)} : ${message}`
    if (retried.has(item.id)) {
      // Sent again on request: one try per request, and it stays on the list if it fails.
      if (local) delete journal.gaveUp[item.id]
      else giveUp(item, message)
      return
    }
    const attempts = (journal.failures[item.id]?.attempts ?? 0) + 1
    journal.failures[item.id] = { attempts, time: item.creationTime }
    if (attempts < MAX_ATTEMPTS) {
      retryLater++
      return
    }
    finished.add(item.id)
    if (!local) giveUp(item, message)
  }
  const sent = (item: Item): void => {
    // A file older than the look-back is not in the cursor's range, so there is nothing to remember it by.
    if (!retried.has(item.id) || item.creationTime >= journal.cursor - LOOKBACK_MS) journal.recent[item.id] = item.creationTime
    delete journal.failures[item.id]
    delete journal.gaveUp[item.id]
    finished.add(item.id)
    journal.uploadedTotal++
    journal.lastSuccessAt = Date.now()
  }
  /** The server took a later file, or the run ended with it still answering: the files before were the problem. */
  const settleSuspects = (): void => {
    for (const suspect of suspects) fail(suspect.item, suspect.message, false)
    suspects = []
  }

  for (const [index, item] of order.entries()) {
    if (cancelRequested || Date.now() > deadline) break
    store.setState({ progress: { done: index, total: order.length, filename: nameOf(item) } })

    let result = await sendOne(client, item, folders)
    // FileBrowser sessions expire: sign in again once per run (as the file screen does) and retry.
    if (result.outcome === 'signed-out' && !signedInAgain) {
      signedInAgain = true
      try {
        await client.login()
        result = await sendOne(client, item, folders)
      } catch (err) {
        result = { outcome: 'abort', message: errorMessage(err) }
      }
    }

    if (result.outcome === 'abort' || result.outcome === 'signed-out') {
      stopMessage = result.message
      break
    }
    if (result.outcome === 'stop') {
      // The file or the connection? A server that no longer answers, or refuses file after file, is the
      // run's problem: stop and hold nothing against the files. One that answers is held against this file
      // once a later one goes through, so a single file that never uploads can't block the ones behind it.
      if (suspects.length + 1 >= SUSPECT_LIMIT || !(await client.isReachable())) {
        stopMessage = result.message
        break
      }
      suspects.push({ item, message: result.message })
      continue
    }
    settleSuspects()
    if (result.outcome === 'sent') sent(item)
    else fail(item, result.message, result.local === true)
    advanceCursor()
    if (Date.now() - savedAt > JOURNAL_SAVE_GAP_MS) {
      await saveJournal(journal)
      savedAt = Date.now()
    }
    store.setState({
      uploadedTotal: journal.uploadedTotal,
      lastSuccessAt: journal.lastSuccessAt,
      pending: order.length - index - 1 + retryLater + suspects.length
    })
  }
  // Nothing was sent after them, but the server answered each time: they were the files' own failures.
  if (!stopMessage) {
    settleSuspects()
    advanceCursor()
  }
  await saveJournal(journal)

  const error = stopMessage ?? lastFileError
  store.setState({
    phase: stopMessage ? 'error' : 'idle',
    progress: null,
    error,
    gaveUp: Object.keys(journal.gaveUp).length,
    pending: order.filter((item) => !retried.has(item.id) && !finished.has(item.id)).length
  })
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

/**
 * Runs one backup with a one-off exception. A run already going finishes first, and the exception is gone
 * once this one is over, so it can't be left waiting for some later run (hours on, perhaps on mobile data).
 */
async function runOnceWith(flag: 'overMobileData' | 'retryFailed'): Promise<void> {
  await running
  if (flag === 'overMobileData') overMobileDataNext = true
  else retryFailedNext = true
  try {
    await runCameraBackup()
  } finally {
    overMobileDataNext = false
    retryFailedNext = false
  }
}

/** Backs up once even though "Wi-Fi only" is on and the phone is on mobile data; the setting itself stays. */
export function backupOverMobileData(): Promise<void> {
  return runOnceWith('overMobileData')
}

/** Tries again the files that were given up on (too big for the server, refused), along with anything new. */
export function retryFailedBackups(): Promise<void> {
  return runOnceWith('retryFailed')
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
    failures: {},
    gaveUp: {}
  })
  await useCameraBackupStore.getState().saveSettings({ enabled: true })
  useCameraBackupStore.setState({ phase: 'idle', error: null, pending: null, gaveUp: 0 })
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
    useCameraBackupStore.setState({
      uploadedTotal: journal.uploadedTotal,
      lastSuccessAt: journal.lastSuccessAt,
      gaveUp: Object.keys(journal.gaveUp).length
    })
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
