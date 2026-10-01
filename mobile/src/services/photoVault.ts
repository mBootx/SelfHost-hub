import type { FBItem } from '@/services/filebrowser'

/**
 * Where an account's backed-up photos live on the server, and the only way the app reaches them.
 *
 * The app has no server of its own: FileBrowser is the file server and decides, account by account, what a
 * login may touch (its per-account "scope"). What the app can do - and does here - is make sure it never asks
 * for anything but the signed-in account's own backup folder: the folder name comes only from the account's
 * name, and every path goes through resolveInside() before it reaches the server.
 */

/** Stands for the account's name in the backup folder setting. */
export const USER_TOKEN = '{user}'
/** One central folder, one sub-folder per account, then year/month. */
export const DEFAULT_BACKUP_FOLDER = `/backups/photos/${USER_TOKEN}`
/** Where backups went before they were organised by account. */
export const LEGACY_BACKUP_FOLDER = '/Appareil photo'

/** Backups nest at most root / year / month. */
const MAX_DEPTH = 3
/** FileBrowser is asked for at most this many folders at once. */
const LIST_CONCURRENCY = 4
const MAX_NAME_LENGTH = 255
const MAX_SEGMENT_LENGTH = 120

const PHOTO_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', '3gp', 'webm', 'mkv', 'avi'])
const SAFE_CHAR = /^[\p{L}\p{N}_@+-]$/u
const BACKSLASH = String.fromCharCode(92)

export type VaultErrorCode = 'forbidden-path' | 'unauthorized' | 'denied' | 'not-found' | 'offline' | 'failed'

export class VaultError extends Error {
  code: VaultErrorCode
  constructor(code: VaultErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function forbidden(message: string): VaultError {
  return new VaultError('forbidden-path', message)
}

/** What the vault needs from the FileBrowser client; the real client has all of it. */
export interface VaultClient {
  list(path: string): Promise<FBItem[]>
  remove(path: string): Promise<void>
  rename(path: string, newPath: string): Promise<void>
  createFolder(path: string): Promise<void>
}

function hasControlCharacter(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

/**
 * The account's name as a folder name. Letters and digits (any script) and _ @ + - pass through, dots and
 * spaces only inside the name; everything else - a slash, a leading dot, even "~" itself - becomes ~hex~.
 * Nothing can turn into "." or "..", and two different accounts can never end up with the same folder.
 */
export function sanitizeUsername(username: string): string {
  const chars = [...String(username ?? '').normalize('NFC').trim()]
  if (chars.length === 0) throw forbidden('Nom de compte vide')
  const last = chars.length - 1
  const name = chars
    .map((ch, i) => {
      if (SAFE_CHAR.test(ch)) return ch
      if ((ch === '.' || ch === ' ') && i > 0 && i < last) return ch
      return `~${ch.codePointAt(0)!.toString(16)}~`
    })
    .join('')
  if (name.length > MAX_SEGMENT_LENGTH) throw forbidden('Nom de compte trop long pour un dossier')
  return name
}

/**
 * The clean segments of a path. Anything that could be part of an escape is refused rather than "fixed":
 * "..", backslashes, control characters, and a segment that only becomes ".." or contains a slash once
 * percent-decoded (something further along might decode it).
 */
function segmentsOf(path: string): string[] {
  if (typeof path !== 'string') throw forbidden('Chemin invalide')
  if (hasControlCharacter(path) || path.includes(BACKSLASH)) throw forbidden('Caractère interdit dans le chemin')
  const segments: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw forbidden('Chemin hors du dossier')
    if (part.length > MAX_NAME_LENGTH) throw forbidden('Nom trop long')
    let decoded = part
    try {
      decoded = decodeURIComponent(part)
    } catch {
      // not valid percent-encoding: an ordinary name
    }
    if (decoded !== part && (decoded === '..' || decoded === '.' || decoded.includes('/') || decoded.includes(BACKSLASH))) {
      throw forbidden('Chemin encodé hors du dossier')
    }
    segments.push(part)
  }
  return segments
}

/** The backup folder for one account: the setting with the account's name in place of {user}. */
export function vaultRootFor(template: string, username: string): string {
  const filled = template.split(USER_TOKEN).join(sanitizeUsername(username))
  return `/${segmentsOf(filled).join('/')}`
}

/** The central folder that holds one sub-folder per account, or null when the setting isn't organised by account. */
export function centralFolderOf(template: string): string | null {
  const segments = segmentsOf(template)
  if (segments.length < 2 || segments[segments.length - 1] !== USER_TOKEN) return null
  return `/${segments.slice(0, -1).join('/')}`
}

/** `path` made absolute and clean, provided it is `root` or lies inside it; throws otherwise. */
export function resolveInside(root: string, path: string): string {
  const rootSegments = segmentsOf(root)
  const segments = segmentsOf(path)
  if (!rootSegments.every((segment, i) => segments[i] === segment)) throw forbidden('Chemin hors du dossier de sauvegarde')
  return `/${segments.join('/')}`
}

export function isInside(root: string, path: string): boolean {
  try {
    resolveInside(root, path)
    return true
  } catch {
    return false
  }
}

/** A file or folder name as the server reports it: never a way out of the folder it was listed in. */
function validName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    name.length <= MAX_NAME_LENGTH &&
    !name.includes('/') &&
    !name.includes(BACKSLASH) &&
    !hasControlCharacter(name)
  )
}

function childPath(dir: string, name: string): string {
  if (!validName(name)) throw forbidden('Nom de fichier invalide')
  return `/${[...segmentsOf(dir), name].join('/')}`
}

function baseName(path: string): string {
  const segments = segmentsOf(path)
  return segments[segments.length - 1] ?? ''
}

function parentOf(path: string): string {
  return `/${segmentsOf(path).slice(0, -1).join('/')}`
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isPhotoName(name: string): boolean {
  return PHOTO_EXTENSIONS.has(extensionOf(name))
}

export function isVideoName(name: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(name))
}

function toVaultError(err: unknown, fallback: string): VaultError {
  if (err instanceof VaultError) return err
  const status = (err as { status?: number } | null)?.status
  if (status === 401) return new VaultError('unauthorized', 'Session expirée')
  if (status === 403) return new VaultError('denied', 'Accès refusé à ce dossier')
  if (status === 404) return new VaultError('not-found', 'Dossier introuvable')
  if (status === 0) return new VaultError('offline', 'Serveur injoignable')
  return new VaultError('failed', err instanceof Error && err.message ? err.message : fallback)
}

/** Errors after which carrying on is pointless: the session is gone or the server can't be reached. */
function isFatal(err: VaultError): boolean {
  return err.code === 'unauthorized' || err.code === 'offline' || err.code === 'denied'
}

/** Runs tasks with at most `max` in flight; a finished task hands its slot straight to the next one waiting. */
function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async (task) => {
    if (active < max) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

export interface Photo {
  path: string
  name: string
  size: number
  /** When the server last saw the file change (ms); 0 when unknown. */
  modified: number
  /** From the year/month folders the backup files it under. */
  year: number | null
  month: number | null
  /** Where it sits inside the backup folder it was found in (year/month/name). */
  relative: string
}

export interface VaultListing {
  photos: Photo[]
  /** Videos are backed up too, but the gallery only shows photos. */
  videos: number
  /** Some folder couldn't be read, so the list may be missing photos. */
  incomplete: boolean
}

function toPhoto(path: string, item: FBItem, root: string): Photo {
  const relative = segmentsOf(path).slice(segmentsOf(root).length)
  const year = /^[0-9]{4}$/.test(relative[0] ?? '') ? Number(relative[0]) : null
  const monthNumber = /^[0-9]{2}$/.test(relative[1] ?? '') ? Number(relative[1]) : 0
  const month = year !== null && monthNumber >= 1 && monthNumber <= 12 ? monthNumber : null
  return {
    path,
    name: item.name,
    size: item.size || 0,
    modified: Date.parse(item.modified) || 0,
    year,
    month,
    relative: relative.join('/')
  }
}

interface Scan {
  photos: Photo[]
  videos: number
  incomplete: boolean
  /** Why the top folder itself couldn't be listed, if it couldn't. */
  failure: unknown
}

/** Reads one backup folder (root / year / month) into `scan`, a few folders at a time, telling `onFound` as photos turn up. */
async function scanInto(
  scan: Scan,
  client: VaultClient,
  top: string,
  gate: <T>(task: () => Promise<T>) => Promise<T>,
  options: { isCancelled?: () => boolean; onFound?: () => void }
): Promise<void> {
  async function walk(dir: string, depth: number): Promise<void> {
    if (options.isCancelled?.()) return
    let items: FBItem[]
    try {
      items = await gate(() => client.list(dir))
    } catch (err) {
      if (dir === top) scan.failure = err
      else scan.incomplete = true
      return
    }
    const folders: string[] = []
    let added = false
    for (const item of items) {
      let path: string
      try {
        path = resolveInside(top, childPath(dir, item.name))
      } catch {
        continue // a name that would lead out of the folder is ignored
      }
      if (item.isDir) {
        if (depth < MAX_DEPTH) folders.push(path)
      } else if (isPhotoName(item.name)) {
        scan.photos.push(toPhoto(path, item, top))
        added = true
      } else if (isVideoName(item.name)) {
        scan.videos++
      }
    }
    if (added) options.onFound?.()
    folders.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    await Promise.all(folders.map((folder) => walk(folder, depth + 1)))
  }
  await walk(top, 1)
}

/** The same photo in two backup folders - same year/month/name, same size - is one photo, not two. */
function photoKey(photo: Photo): string {
  return `${photo.relative}|${photo.size}`
}

/** The first scan's photos, then those of the others that it doesn't already have. */
function mergeScans(scans: Scan[]): Photo[] {
  const merged = [...scans[0].photos]
  const known = new Set(merged.map(photoKey))
  for (const scan of scans.slice(1)) {
    const added = scan.photos.filter((photo) => !known.has(photoKey(photo)))
    for (const photo of added) known.add(photoKey(photo))
    merged.push(...added)
  }
  return merged
}

/** The older backup folders worth reading along with `top`: valid, distinct, and neither inside nor around it. */
function olderFolders(top: string, candidates: string[]): string[] {
  const folders: string[] = []
  for (const candidate of candidates) {
    let folder: string
    try {
      folder = resolveInside('/', candidate)
    } catch {
      continue
    }
    if (folder === '/' || folder === top || isInside(top, folder) || isInside(folder, top) || folders.includes(folder)) continue
    folders.push(folder)
  }
  return folders
}

export interface LoadOptions {
  onPartial?: (photos: Photo[]) => void
  isCancelled?: () => boolean
  /**
   * Older backup folders (from before backups were kept per account) read along with the account's own, so
   * photos that haven't been moved yet are in the gallery all the same. A photo present in both is shown once.
   */
  olderFolders?: string[]
}

/**
 * Every photo in the account's backup folder (root / year / month), and in its older backup folders if
 * there are any. Folders are read a few at a time, newest first, and onPartial hears about the photos found
 * so far, so the gallery fills in as it goes. A folder that doesn't exist yet is just an empty gallery.
 */
export async function loadPhotos(client: VaultClient, root: string, options: LoadOptions = {}): Promise<VaultListing> {
  const top = resolveInside(root, root)
  const tops = [top, ...olderFolders(top, options.olderFolders ?? [])]
  const gate = limiter(LIST_CONCURRENCY)
  const scans: Scan[] = tops.map(() => ({ photos: [], videos: 0, incomplete: false, failure: null }))
  const onFound = (): void => options.onPartial?.(mergeScans(scans))
  await Promise.all(tops.map((folder, i) => scanInto(scans[i], client, folder, gate, { isCancelled: options.isCancelled, onFound })))

  const [own, ...older] = scans
  if (own.failure) {
    const error = toVaultError(own.failure, 'Impossible de lister les photos')
    if (error.code !== 'not-found') throw error
  }
  // An older folder that can't be read only means some photos may be missing from the list.
  const olderUnreadable = older.some((scan) => scan.failure !== null && toVaultError(scan.failure, '').code !== 'not-found')
  return {
    photos: mergeScans(scans),
    videos: scans.reduce((total, scan) => total + scan.videos, 0),
    incomplete: olderUnreadable || scans.some((scan) => scan.incomplete)
  }
}

/** `path` made absolute and clean, provided it lies inside one of `roots`; throws otherwise. */
function resolveInsideAny(roots: string[], path: string): string {
  let first: unknown = null
  for (const root of roots) {
    try {
      return resolveInside(root, path)
    } catch (err) {
      first ??= err
    }
  }
  throw first ?? forbidden('Chemin hors du dossier de sauvegarde')
}

export interface DeleteReport {
  deleted: string[]
  failed: { path: string; message: string }[]
}

/**
 * Deletes photos from the account's backup folder, for good: FileBrowser has no bin. Anything outside the
 * folder, and anything that isn't a photo or video (a folder, say), is refused. A lost session or server
 * stops the run rather than failing every remaining file one by one.
 */
export async function deletePhotos(
  client: VaultClient,
  roots: string | string[],
  paths: string[],
  onEach?: (done: number, total: number) => void
): Promise<DeleteReport> {
  const report: DeleteReport = { deleted: [], failed: [] }
  const tops = (Array.isArray(roots) ? roots : [roots]).map((root) => resolveInside(root, root))
  let stopped: VaultError | null = null
  for (const [index, path] of paths.entries()) {
    if (stopped) {
      report.failed.push({ path, message: stopped.message })
      continue
    }
    try {
      const safe = resolveInsideAny(tops, path)
      const name = baseName(safe)
      if (tops.includes(safe) || !(isPhotoName(name) || isVideoName(name))) throw forbidden('Seules les photos peuvent être supprimées ici')
      await client.remove(safe)
      report.deleted.push(path)
    } catch (err) {
      const error = toVaultError(err, 'Suppression impossible')
      report.failed.push({ path, message: error.message })
      if (isFatal(error)) stopped = error
    }
    onEach?.(index + 1, paths.length)
  }
  return report
}

/** Whether the folder exists and has anything in it. */
export async function hasBackups(client: VaultClient, root: string): Promise<boolean> {
  try {
    return (await client.list(resolveInside('/', root))).length > 0
  } catch {
    return false
  }
}

export interface MigrationReport {
  /** Photos and videos found in the old folder. */
  total: number
  moved: number
  /** Already in the new folder under the same name: left where they are. */
  skipped: number
  failed: number
  removedFolders: number
  /** The first few failures, for the user to read. */
  errors: string[]
  cancelled: boolean
}

/**
 * Moves the photos and videos of an old backup folder into the account's folder, keeping the year/month
 * layout. It moves rather than copies, never overwrites (a file already there is left alone, and so is its
 * twin), skips anything that isn't a photo or video, and only removes old folders it has just found empty,
 * so it can be stopped and run again at any time.
 */
export async function migrateBackups(
  client: VaultClient,
  fromRoot: string,
  toRoot: string,
  options: { onProgress?: (done: number, total: number) => void; isCancelled?: () => boolean } = {}
): Promise<MigrationReport> {
  const from = resolveInside('/', fromRoot)
  const to = resolveInside('/', toRoot)
  if (from === '/' || from === to || isInside(from, to)) throw forbidden('Les dossiers source et destination se chevauchent')

  const report: MigrationReport = { total: 0, moved: 0, skipped: 0, failed: 0, removedFolders: 0, errors: [], cancelled: false }
  const gate = limiter(LIST_CONCURRENCY)
  const files: string[] = []
  const folders: string[] = []

  async function inventory(dir: string, depth: number): Promise<void> {
    const items = await gate(() => client.list(dir))
    const children: string[] = []
    for (const item of items) {
      let path: string
      try {
        path = resolveInside(from, childPath(dir, item.name))
      } catch {
        continue
      }
      if (item.isDir) {
        if (depth < MAX_DEPTH) children.push(path)
      } else if (isPhotoName(item.name) || isVideoName(item.name)) {
        files.push(path)
      }
    }
    folders.push(...children)
    await Promise.all(children.map((child) => inventory(child, depth + 1)))
  }
  try {
    await inventory(from, 1)
  } catch (err) {
    const error = toVaultError(err, 'Impossible de lire les anciennes sauvegardes')
    if (error.code === 'not-found') return report
    throw error
  }
  report.total = files.length

  const made = new Set<string>()
  const present = new Map<string, Set<string>>()
  async function ensureFolders(dir: string): Promise<void> {
    const segments = segmentsOf(dir)
    for (let i = 1; i <= segments.length; i++) {
      const partial = `/${segments.slice(0, i).join('/')}`
      if (made.has(partial)) continue
      await client.createFolder(partial).catch(() => {}) // "already exists" is the usual answer
      made.add(partial)
    }
  }

  let aborted = false
  const fromLength = segmentsOf(from).length
  for (const source of files) {
    if (options.isCancelled?.()) {
      report.cancelled = true
      break
    }
    const destination = resolveInside(to, `/${[...segmentsOf(to), ...segmentsOf(source).slice(fromLength)].join('/')}`)
    const dir = parentOf(destination)
    const name = baseName(destination)
    try {
      await ensureFolders(dir)
      let names = present.get(dir)
      if (!names) {
        names = new Set((await client.list(dir).catch(() => [] as FBItem[])).map((item) => item.name))
        present.set(dir, names)
      }
      if (names.has(name)) {
        report.skipped++
      } else {
        await client.rename(source, destination)
        names.add(name)
        report.moved++
      }
    } catch (err) {
      const error = toVaultError(err, 'Déplacement impossible')
      report.failed++
      if (report.errors.length < 5) report.errors.push(`${name} : ${error.message}`)
      if (isFatal(error)) {
        aborted = true
        break
      }
    }
    options.onProgress?.(report.moved + report.skipped + report.failed, files.length)
  }

  if (!report.cancelled && !aborted) {
    // Deepest first, so a month folder goes before its year.
    const deepestFirst = [...folders].sort((a, b) => segmentsOf(b).length - segmentsOf(a).length)
    for (const dir of deepestFirst) {
      try {
        if ((await client.list(dir)).length === 0) {
          await client.remove(dir)
          report.removedFolders++
        }
      } catch {
        // left in place
      }
    }
  }
  return report
}

/**
 * In the file browser, inside the central backup folder an account sees only its own sub-folder. This is
 * a courtesy on top of the lock, not the lock itself: the lock is the account's scope on the FileBrowser server.
 */
export function hidePeerFolders(items: FBItem[], dir: string, template: string, username: string): FBItem[] {
  try {
    const central = centralFolderOf(template)
    if (central === null || central === '/') return items
    if (resolveInside('/', dir) !== central) return items
    const own = sanitizeUsername(username)
    return items.filter((item) => !item.isDir || item.name === own)
  } catch {
    return items
  }
}
