import { AppState } from 'react-native'
import * as BackgroundTask from 'expo-background-task'
import { File } from 'expo-file-system'
import * as MediaLibrary from 'expo-media-library'
import { Album, Asset, AssetField, MediaType, Query } from 'expo-media-library'
import type { AssetInfo, AssetMetadata } from 'expo-media-library'
import * as Network from 'expo-network'
import * as TaskManager from 'expo-task-manager'
import SelfHostNative from '../../modules/selfhost-native'
import { expectExternalScreen } from '@/services/appLock'
import { describeError, flushDiagnostics, logEvent } from '@/services/diagnostics'
import { ApiError, FileBrowserClient } from '@/services/filebrowser'
import { freeName } from '@/services/fileNames'
import { storage } from '@/services/storage'
import { albumFolderName, VaultError, vaultRootFor } from '@/services/photoVault'
import { BackupAlbum, useCameraBackupStore } from '@/store/cameraBackupStore'
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
/** The state last written to the diagnostic record, so a run that finds the same thing again says nothing. */
let lastLogged: string | null = null

/** Writes a line when the situation changed since the last one (a run every 15 minutes mustn't fill the record). */
function noteState(state: string, message: string, level: 'info' | 'warn' = 'info'): void {
  if (lastLogged === state) return
  lastLogged = state
  logEvent('backup', message, level)
}
/** Set by "send anyway" and "try again": the next run ignores "Wi-Fi only" and "charging only" / also tries the files given up on. */
let anywayNext = false
let retryFailedNext = false
/** When the current run must stop starting new uploads; a background run joining a foreground one lowers it. */
let deadline = Number.POSITIVE_INFINITY
let cancelRequested = false
let started = false

async function loadJournal(key = JOURNAL_KEY): Promise<Journal> {
  const saved = await storage.loadPref<Journal>(key).catch(() => null)
  return { ...EMPTY_JOURNAL, ...saved }
}

async function saveJournal(journal: Journal, key = JOURNAL_KEY): Promise<void> {
  await storage.savePref(key, journal)
}

/** Whether the phone is plugged in; true when this build can't tell, so the setting can never block the backup for good. */
function isCharging(): boolean {
  try {
    return SelfHostNative?.isCharging?.() ?? true
  } catch {
    return true
  }
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
  /** The server already had this very file (same name and size): nothing was sent, but it is backed up. */
  already?: boolean
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

/** The files a server folder already holds (name -> size), read once per run and kept up to date as files go in. */
type Listings = Map<string, Map<string, number>>

async function filesIn(client: FileBrowserClient, folder: string, listings: Listings): Promise<Map<string, number>> {
  let names = listings.get(folder)
  if (names) return names
  names = new Map()
  try {
    for (const item of await client.list(folder)) if (!item.isDir) names.set(item.name, item.size)
  } catch (err) {
    // A folder that isn't there yet holds nothing; any other failure is the upload's own.
    if (!(err instanceof ApiError && err.status === 404)) throw err
  }
  listings.set(folder, names)
  return names
}

/**
 * Sends one photo or video into its year/month folder. Nothing already on the server is ever replaced: the
 * very same file (name and size) is left alone - it is simply backed up - and a different file with the same
 * name goes in under a numbered name.
 */
async function sendOne(client: FileBrowserClient, meta: Item, source: Source, folders: Set<string>, listings: Listings): Promise<SendResult> {
  let info: AssetInfo
  let size: number
  try {
    info = await new Asset(meta.id).getInfo()
    const file = new File(info.uri)
    if (!file.exists) throw new Error('fichier introuvable sur le téléphone')
    size = file.size
  } catch (err) {
    // Deleted meanwhile, or unreadable: a problem with this file only.
    return { outcome: 'file-problem', message: errorMessage(err), local: true }
  }
  try {
    const folder = monthFolder(source.folder(client), meta.creationTime)
    await ensureFolder(client, folder, folders)
    for (let attempt = 0; attempt < 2; attempt++) {
      const names = await filesIn(client, folder, listings)
      let name = info.filename
      const existing = names.get(name)
      if (existing !== undefined) {
        if (existing === size) return { outcome: 'sent', message: '', already: true }
        name = freeName(name, new Set(names.keys()))
      }
      try {
        await client.uploadLocalFile(info.uri, folder, name)
        names.set(name, size)
        return { outcome: 'sent', message: '' }
      } catch (err) {
        // The name was taken after we looked: look again, once.
        if (!(err instanceof ApiError && err.status === 409) || attempt === 1) throw err
        listings.delete(folder)
      }
    }
    return { outcome: 'file-problem', message: 'nom déjà pris sur le serveur' }
  } catch (err) {
    return classify(err)
  }
}

/** One place photos are read from on the phone and backed up to: the camera, or one of the other albums. */
interface Source {
  key: string
  title: string
  journalKey: string
  /** The album on the phone, or null when there is none (no camera album yet). */
  open: () => Promise<Album | null>
  /** The server folder whose year/month folders this source's files go into. */
  folder: (client: FileBrowserClient) => string
}

const CAMERA: Source = {
  key: 'camera',
  title: 'Appareil photo',
  journalKey: JOURNAL_KEY,
  open: () => Album.get('Camera'),
  folder: (client) => backupRoot(client)
}

function albumSource(album: BackupAlbum): Source {
  return {
    key: `album:${album.id}`,
    title: album.title,
    journalKey: `${JOURNAL_KEY}.album.${album.id}`,
    open: async () => new Album(album.id),
    folder: (client) => `${backupRoot(client)}/${albumFolderName(album.title)}`
  }
}

/** The camera, then the albums the user picked. */
function sourcesOf(albums: BackupAlbum[]): Source[] {
  return [CAMERA, ...albums.map(albumSource)]
}

/** What a source has to do in this run, worked out from its journal and what is on the phone. */
interface Plan {
  source: Source
  journal: Journal
  order: Item[]
  todo: Item[]
  /** Files given up on that are tried again because the user asked. */
  retried: Set<string>
  advanceCursor: () => void
}

/** What the screen shows is the sum over the sources; each one reports its own part here. */
interface RunContext {
  views: Map<string, { uploaded: number; lastSuccessAt: number | null; gaveUp: number; pending: number }>
  /** Files handled by the sources before this one, and all the files of the run, for the progress bar. */
  done: number
  total: number
  sent: number
  alreadyThere: number
}

function publish(ctx: RunContext, extra: Partial<ReturnType<typeof useCameraBackupStore.getState>> = {}): void {
  let uploadedTotal = 0
  let gaveUp = 0
  let pending = 0
  let lastSuccessAt: number | null = null
  for (const view of ctx.views.values()) {
    uploadedTotal += view.uploaded
    gaveUp += view.gaveUp
    pending += view.pending
    if (view.lastSuccessAt !== null) lastSuccessAt = Math.max(lastSuccessAt ?? 0, view.lastSuccessAt)
  }
  useCameraBackupStore.setState({ uploadedTotal, lastSuccessAt, gaveUp, pending, ...extra })
}

/** Reads the source's journal and the phone, and says what is left to send. */
async function planSource(source: Source, retryFailed: boolean): Promise<Plan> {
  const journal = await loadJournal(source.journalKey)
  let all: Item[] = []
  try {
    const album = await source.open()
    if (album) {
      const from = Math.max(journal.floor, journal.cursor - LOOKBACK_MS)
      all = (
        await new Query()
          .album(album)
          .gte(AssetField.CREATION_TIME, from)
          .orderBy({ key: AssetField.CREATION_TIME, ascending: true })
          .exeForMetadata()
      ).filter(
        (a): a is AssetMetadata & { creationTime: number } =>
          a.creationTime !== null && (a.mediaType === MediaType.IMAGE || a.mediaType === MediaType.VIDEO)
      )
    }
  } catch (err) {
    // An album that was deleted since, or can't be read, has nothing to send; the camera's failure is the run's.
    if (source === CAMERA) throw err
    logEvent('backup', `Album « ${source.title} » illisible : ${describeError(err)}`, 'warn')
  }

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
  return { source, journal, order, todo, retried, advanceCursor }
}

interface SendSummary {
  stopMessage: string | null
  lastFileError: string | null
}

/** Sends a plan's files, one at a time, and keeps its journal. Stops early when the run must (see Outcome). */
async function sendPlan(plan: Plan, client: FileBrowserClient, ctx: RunContext): Promise<SendSummary> {
  const store = useCameraBackupStore
  const { source, journal, order, retried, advanceCursor } = plan
  const folders = new Set<string>()
  const listings: Listings = new Map()
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
  const report = (pending: number): void => {
    ctx.views.set(source.key, {
      uploaded: journal.uploadedTotal,
      lastSuccessAt: journal.lastSuccessAt,
      gaveUp: Object.keys(journal.gaveUp).length,
      pending
    })
    publish(ctx)
  }

  /** The server won't take this file again: remembered, so the app can offer to try once more. */
  const giveUp = (item: Item, message: string): void => {
    journal.gaveUp[item.id] = { name: nameOf(item), time: item.creationTime, message }
    logEvent('backup', `Abandon de ${nameOf(item)} : ${message}`, 'warn')
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
  const sent = (item: Item, already = false): void => {
    // A file older than the look-back is not in the cursor's range, so there is nothing to remember it by.
    if (!retried.has(item.id) || item.creationTime >= journal.cursor - LOOKBACK_MS) journal.recent[item.id] = item.creationTime
    delete journal.failures[item.id]
    delete journal.gaveUp[item.id]
    finished.add(item.id)
    // A file the server already had is backed up, but nothing was sent: it is not an upload to count.
    if (already) {
      ctx.alreadyThere++
      return
    }
    ctx.sent++
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
    store.setState({ progress: { done: ctx.done + index, total: ctx.total, filename: nameOf(item) } })

    let result = await sendOne(client, item, source, folders, listings)
    // FileBrowser sessions expire: sign in again once per run (as the file screen does) and retry.
    if (result.outcome === 'signed-out' && !signedInAgain) {
      signedInAgain = true
      try {
        await client.login()
        result = await sendOne(client, item, source, folders, listings)
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
    if (result.outcome === 'sent') sent(item, result.already === true)
    else fail(item, result.message, result.local === true)
    advanceCursor()
    if (Date.now() - savedAt > JOURNAL_SAVE_GAP_MS) {
      await saveJournal(journal, source.journalKey)
      savedAt = Date.now()
    }
    report(order.length - index - 1 + retryLater + suspects.length)
  }
  // Nothing was sent after them, but the server answered each time: they were the files' own failures.
  if (!stopMessage) {
    settleSuspects()
    advanceCursor()
  }
  await saveJournal(journal, source.journalKey)
  ctx.done += order.length
  report(order.filter((item) => !retried.has(item.id) && !finished.has(item.id)).length)
  return { stopMessage, lastFileError }
}

async function run(): Promise<void> {
  const store = useCameraBackupStore
  await store.getState().load()
  const { settings } = store.getState()
  if (!settings.enabled) return
  cancelRequested = false
  // "Send anyway" and "try again" are for this run only.
  const anyway = anywayNext
  const retryFailed = retryFailedNext
  anywayNext = false
  retryFailedNext = false

  const permission = await MediaLibrary.getPermissionsAsync(false, MEDIA_PERMISSIONS)
  if (!permission.granted) {
    store.setState({ phase: 'no-permission', lastCheckAt: Date.now() })
    noteState('no-permission', "Accès aux photos refusé : rien ne peut être sauvegardé", 'warn')
    return
  }
  store.setState({ limitedAccess: permission.accessPrivileges === 'limited' })

  if (settings.wifiOnly && !anyway) {
    const network = await Network.getNetworkStateAsync()
    if (network.type !== Network.NetworkStateType.WIFI && network.type !== Network.NetworkStateType.ETHERNET) {
      store.setState({ phase: 'waiting-wifi', lastCheckAt: Date.now() })
      noteState('waiting-wifi', 'En attente du Wi-Fi (réglage « Wi-Fi uniquement »)')
      return
    }
  }
  if (settings.chargingOnly && !anyway && !isCharging()) {
    store.setState({ phase: 'waiting-charger', lastCheckAt: Date.now() })
    noteState('waiting-charger', 'En attente du chargeur (réglage « Seulement en charge »)')
    return
  }

  // Everything to send is worked out first, so the screen's totals are right from the start of the run.
  const plans: Plan[] = []
  for (const source of sourcesOf(settings.albums)) plans.push(await planSource(source, retryFailed))
  const ctx: RunContext = { views: new Map(), done: 0, total: 0, sent: 0, alreadyThere: 0 }
  for (const plan of plans) {
    ctx.views.set(plan.source.key, {
      uploaded: plan.journal.uploadedTotal,
      lastSuccessAt: plan.journal.lastSuccessAt,
      gaveUp: Object.keys(plan.journal.gaveUp).length,
      pending: plan.order.length
    })
    ctx.total += plan.order.length
  }
  publish(ctx, { lastCheckAt: Date.now() })
  if (ctx.total === 0) {
    for (const plan of plans) await saveJournal(plan.journal, plan.source.journalKey)
    store.setState({ phase: 'idle', error: null })
    return
  }

  let client: FileBrowserClient | null
  try {
    client = await getClient()
  } catch (err) {
    store.setState({ phase: 'no-server', error: errorMessage(err) })
    noteState('no-server', `FileBrowser injoignable : ${errorMessage(err)}`, 'warn')
    return
  }
  if (!client) {
    store.setState({ phase: 'no-server', error: null })
    noteState('no-server', 'Pas de compte FileBrowser enregistré')
    return
  }

  store.setState({ phase: 'running', error: null })
  lastLogged = null
  const todoCount = plans.reduce((sum, plan) => sum + plan.todo.length, 0)
  const againCount = plans.reduce((sum, plan) => sum + plan.retried.size, 0)
  logEvent('backup', `Envoi de ${ctx.total} fichier${ctx.total > 1 ? 's' : ''} (${todoCount} nouveau${todoCount > 1 ? 'x' : ''}${againCount > 0 ? `, ${againCount} à renvoyer` : ''}${plans.length > 1 ? `, ${plans.length} sources` : ''})`)

  let stopMessage: string | null = null
  let lastFileError: string | null = null
  for (const plan of plans) {
    const summary = await sendPlan(plan, client, ctx)
    lastFileError = summary.lastFileError ?? lastFileError
    if (summary.stopMessage) {
      stopMessage = summary.stopMessage
      break
    }
    if (cancelRequested || Date.now() > deadline) break
  }

  const error = stopMessage ?? lastFileError
  let left = 0
  for (const view of ctx.views.values()) left += view.pending
  logEvent(
    'backup',
    `Terminé : ${ctx.sent} envoyé${ctx.sent > 1 ? 's' : ''}${ctx.alreadyThere > 0 ? `, ${ctx.alreadyThere} déjà sur le serveur` : ''}, ${left} en attente${stopMessage ? ` — interrompu : ${stopMessage}` : lastFileError ? ` — ${lastFileError}` : ''}`,
    stopMessage ? 'warn' : 'info'
  )
  publish(ctx, { phase: stopMessage ? 'error' : 'idle', progress: null, error })
}

/** Checks for new photos and backs them up. Runs one at a time; calls during a run share it. */
export function runCameraBackup(budgetMs = Number.POSITIVE_INFINITY): Promise<void> {
  const until = Date.now() + budgetMs
  if (!running) {
    deadline = until
    running = run()
      .catch((err) => {
        useCameraBackupStore.setState({ phase: 'error', progress: null, error: errorMessage(err) })
        logEvent('backup', `Erreur inattendue : ${describeError(err)}`, 'error')
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

/** What the journal says, for the Diagnostic screen. */
export async function backupJournalSummary(): Promise<{
  cursor: number
  rememberedSent: number
  failing: number
  gaveUp: { name: string; message: string }[]
}> {
  await useCameraBackupStore.getState().load()
  const sources = sourcesOf(useCameraBackupStore.getState().settings.albums)
  const journals = await Promise.all(sources.map((source) => loadJournal(source.journalKey)))
  return {
    cursor: journals[0].cursor,
    rememberedSent: journals.reduce((sum, journal) => sum + Object.keys(journal.recent).length, 0),
    failing: journals.reduce((sum, journal) => sum + Object.keys(journal.failures).length, 0),
    gaveUp: journals.flatMap((journal, i) =>
      Object.values(journal.gaveUp).map((entry) => ({ name: i === 0 ? entry.name : `${sources[i].title}/${entry.name}`, message: entry.message }))
    )
  }
}

export interface BackupEnvironment {
  permission: 'accordé' | 'limité' | 'refusé' | 'inconnu'
  network: 'Wi-Fi' | 'Ethernet' | 'données mobiles' | 'aucun' | 'inconnu'
  /** Null when this build can't tell (it predates the native check). */
  charging: boolean | null
}

/** What the phone allows the backup right now, for the Diagnostic screen. Never throws. */
export async function backupEnvironment(): Promise<BackupEnvironment> {
  let permission: BackupEnvironment['permission'] = 'inconnu'
  try {
    const status = await MediaLibrary.getPermissionsAsync(false, MEDIA_PERMISSIONS)
    permission = !status.granted ? 'refusé' : status.accessPrivileges === 'limited' ? 'limité' : 'accordé'
  } catch {
    // Left as unknown.
  }
  let network: BackupEnvironment['network'] = 'inconnu'
  try {
    const state = await Network.getNetworkStateAsync()
    if (state.isConnected === false) network = 'aucun'
    else if (state.type === Network.NetworkStateType.WIFI) network = 'Wi-Fi'
    else if (state.type === Network.NetworkStateType.ETHERNET) network = 'Ethernet'
    else if (state.type === Network.NetworkStateType.CELLULAR) network = 'données mobiles'
  } catch {
    // Left as unknown.
  }
  let charging: boolean | null = null
  try {
    const value = SelfHostNative?.isCharging?.()
    charging = typeof value === 'boolean' ? value : null
  } catch {
    // Left as unknown.
  }
  return { permission, network, charging }
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
async function runOnceWith(flag: 'anyway' | 'retryFailed'): Promise<void> {
  await running
  if (flag === 'anyway') anywayNext = true
  else retryFailedNext = true
  try {
    await runCameraBackup()
  } finally {
    anywayNext = false
    retryFailedNext = false
  }
}

/** Backs up once even though "Wi-Fi only" or "charging only" is on and the phone isn't meeting it; the settings themselves stay. */
export function backupOverMobileData(): Promise<void> {
  return runOnceWith('anyway')
}

/** Tries again the files that were given up on (too big for the server, refused), along with anything new. */
export function retryFailedBackups(): Promise<void> {
  return runOnceWith('retryFailed')
}

/** A source's journal starting afresh: from the beginning of the roll, or from `now`. */
async function startJournal(source: Source, includeExisting: boolean, now: number): Promise<void> {
  const journal = await loadJournal(source.journalKey)
  await saveJournal(
    { ...journal, floor: includeExisting ? 0 : now, cursor: includeExisting ? 0 : now, recent: {}, failures: {}, gaveUp: {} },
    source.journalKey
  )
}

/** Runs a backup that starts from the settings as they are now: a run already going has made its plans from the old ones, so it finishes first. */
async function runAfterCurrent(): Promise<void> {
  await running
  await runCameraBackup()
}

/** The phone's albums other than the camera's, by name. */
export async function listDeviceAlbums(): Promise<BackupAlbum[]> {
  const albums = await Album.getAll()
  const named = await Promise.all(
    albums.map(async (album) => ({ id: album.id, title: (await album.getTitle().catch(() => '')).trim() }))
  )
  return named.filter((album) => album.title !== '' && album.title !== 'Camera').sort((a, b) => a.title.localeCompare(b.title, 'fr'))
}

/** How many photos and videos an album holds. */
export async function countAlbumItems(id: string): Promise<number> {
  const all = await new Query().album(new Album(id)).exeForMetadata()
  return all.filter((a) => a.mediaType === MediaType.IMAGE || a.mediaType === MediaType.VIDEO).length
}

/** Adds an album to the backup. `includeExisting`: what it already holds too, not only what comes next. */
export async function addBackupAlbum(album: BackupAlbum, includeExisting: boolean): Promise<void> {
  const store = useCameraBackupStore.getState()
  await store.load()
  if (store.settings.albums.some((known) => known.id === album.id)) return
  await startJournal(albumSource(album), includeExisting, Date.now())
  await store.saveSettings({ albums: [...store.settings.albums, album] })
  await runAfterCurrent()
}

/** Stops backing up an album. What was already sent stays on the server. */
export async function removeBackupAlbum(id: string): Promise<void> {
  const store = useCameraBackupStore.getState()
  await store.load()
  await store.saveSettings({ albums: store.settings.albums.filter((album) => album.id !== id) })
  await storage.savePref(albumSource({ id, title: '' }).journalKey, null)
  await runAfterCurrent()
}

/** Turns backup on. `includeExisting`: the photos already on the phone too, not only the next ones. */
export async function enableCameraBackup(includeExisting: boolean): Promise<void> {
  await useCameraBackupStore.getState().load()
  const now = Date.now()
  for (const source of sourcesOf(useCameraBackupStore.getState().settings.albums)) await startJournal(source, includeExisting, now)
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
  } finally {
    // Android may freeze this process as soon as the task returns: what the run did is written down now.
    await flushDiagnostics()
  }
})
