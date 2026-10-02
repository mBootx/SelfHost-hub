import { freeName } from '@/services/fileNames'
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

/** Backups nest at most root / album / year / month (the camera's own photos skip the album level). */
const MAX_DEPTH = 4
/**
 * Photos deleted from the gallery wait here, inside the account's backup folder, for TRASH_DAYS days. It is a
 * visible folder, not a dot-folder: FileBrowser hides those from accounts that don't show hidden files.
 */
export const TRASH_FOLDER = 'Corbeille'
export const TRASH_DAYS = 30
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
  return sanitizeSegment(username, 'Nom de compte vide', 'Nom de compte trop long pour un dossier')
}

function sanitizeSegment(raw: string, emptyMessage: string, tooLongMessage: string): string {
  const chars = [...String(raw ?? '').normalize('NFC').trim()]
  if (chars.length === 0) throw forbidden(emptyMessage)
  const last = chars.length - 1
  const name = chars
    .map((ch, i) => {
      if (SAFE_CHAR.test(ch)) return ch
      if ((ch === '.' || ch === ' ') && i > 0 && i < last) return ch
      return `~${ch.codePointAt(0)!.toString(16)}~`
    })
    .join('')
  if (name.length > MAX_SEGMENT_LENGTH) throw forbidden(tooLongMessage)
  return name
}

/**
 * The folder a phone album ("Screenshots", "WhatsApp Images") is backed up into, inside the account's folder.
 * Named like accounts are, so nothing in an album's name can lead out of it; a name that would be taken for a
 * year folder or for the bin gets a suffix.
 */
export function albumFolderName(title: string): string {
  const name = sanitizeSegment(title, "Nom d'album vide", "Nom d'album trop long pour un dossier")
  return /^[0-9]{4}$/.test(name) || name.toLowerCase() === TRASH_FOLDER.toLowerCase() ? `${name} (album)` : name
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

export type MediaKind = 'photo' | 'video'

export interface Photo {
  path: string
  name: string
  /** Photos and videos are backed up side by side; the gallery shows both. */
  kind: MediaKind
  size: number
  /** When the server last saw the file change (ms); 0 when unknown. */
  modified: number
  /** From the year/month folders the backup files it under. */
  year: number | null
  month: number | null
  /** The phone album it was backed up from ("Screenshots"); null for the camera's own, which sit directly in year/month folders. */
  album: string | null
  /** Where it sits inside the backup folder it was found in ([album/]year/month/name). */
  relative: string
  /** The server can make a thumbnail of it; undefined when the server did not say. */
  hasPreview?: boolean
}

export interface VaultListing {
  photos: Photo[]
  /** Some folder couldn't be read, so the list may be missing photos. */
  incomplete: boolean
}

const isYearFolder = (segment: string | undefined): boolean => /^[0-9]{4}$/.test(segment ?? '')

/** The album, year and month a file's folders say, from its path below the backup folder (file name last). */
function placeOf(relative: string[]): { album: string | null; year: number | null; month: number | null } {
  const folders = relative.slice(0, -1)
  const album = folders.length > 0 && !isYearFolder(folders[0]) ? folders[0] : null
  const dated = album === null ? folders : folders.slice(1)
  const year = isYearFolder(dated[0]) ? Number(dated[0]) : null
  const monthNumber = /^[0-9]{2}$/.test(dated[1] ?? '') ? Number(dated[1]) : 0
  const month = year !== null && monthNumber >= 1 && monthNumber <= 12 ? monthNumber : null
  return { album, year, month }
}

function toPhoto(path: string, item: FBItem, root: string): Photo {
  const relative = segmentsOf(path).slice(segmentsOf(root).length)
  return {
    path,
    name: item.name,
    kind: isVideoName(item.name) ? 'video' : 'photo',
    size: item.size || 0,
    modified: Date.parse(item.modified) || 0,
    ...placeOf(relative),
    relative: relative.join('/'),
    hasPreview: item.hasPreview
  }
}

interface Scan {
  photos: Photo[]
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
        // The bin sits right under the backup folder and is not part of the gallery.
        if (depth < MAX_DEPTH && !(depth === 1 && item.name === TRASH_FOLDER)) folders.push(path)
      } else if (isPhotoName(item.name) || isVideoName(item.name)) {
        scan.photos.push(toPhoto(path, item, top))
        added = true
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
  const scans: Scan[] = tops.map(() => ({ photos: [], incomplete: false, failure: null }))
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

// ---- the bin ----

const DAY_FOLDER = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

function joinPath(segments: string[]): string {
  return `/${segments.join('/')}`
}

/** "2026-10-02": the day in the phone's own calendar, as the bin names its day folders. */
export function dayStamp(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

/** Whole days from a bin day folder's date to `today` (0 for today); null when the name is not a day. */
export function daysInBin(day: string, today: Date): number | null {
  if (!DAY_FOLDER.test(day)) return null
  const [year, month, date] = day.split('-').map(Number)
  return Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(year, month - 1, date)) / DAY_MS)
}

export interface TrashedPhoto {
  /** Where it is now, inside the bin. */
  path: string
  name: string
  kind: MediaKind
  size: number
  modified: number
  hasPreview?: boolean
  /** The day it went in the bin ("2026-10-02"); it is deleted for good TRASH_DAYS days later. */
  trashedOn: string
  /** Where it was: restoring puts it back there. */
  originalPath: string
}

export interface TrashListing {
  items: TrashedPhoto[]
  incomplete: boolean
}

export interface TrashReport {
  /** Each file moved, from where the caller named it to where it is now. */
  moved: { from: string; to: string }[]
  failed: { path: string; message: string }[]
}

/** Moves a file to `dir` under a free name; `names` (what the folder holds) is read once per folder and kept up to date. */
async function moveInto(client: VaultClient, from: string, dir: string, name: string, made: Set<string>, present: Map<string, Set<string>>): Promise<string> {
  await ensureFolders(client, dir, made)
  let names = present.get(dir)
  if (!names) {
    names = new Set((await client.list(dir).catch(() => [] as FBItem[])).map((item) => item.name))
    present.set(dir, names)
  }
  const target = freeName(name, names)
  const destination = `${dir}/${target}`
  await client.rename(from, destination)
  names.add(target)
  return destination
}

/**
 * "Deletes" photos by moving them into the bin, a folder of the account's backup folder with one sub-folder per
 * day (Corbeille/2026-10-02/2026/09/photo.jpg), so restoring is moving back. Files from older backup folders go
 * into the account's bin too. Only photos and videos can be moved, never the bin's own content or a folder.
 */
export async function trashPhotos(
  client: VaultClient,
  roots: string | string[],
  paths: string[],
  options: { today?: Date; onEach?: (done: number, total: number) => void } = {}
): Promise<TrashReport> {
  const tops = (Array.isArray(roots) ? roots : [roots]).map((root) => resolveInside(root, root))
  const binDay = [...segmentsOf(tops[0]), TRASH_FOLDER, dayStamp(options.today ?? new Date())]
  const report: TrashReport = { moved: [], failed: [] }
  const made = new Set<string>()
  const present = new Map<string, Set<string>>()
  let stopped: VaultError | null = null
  for (const [index, path] of paths.entries()) {
    if (stopped) {
      report.failed.push({ path, message: stopped.message })
      continue
    }
    try {
      const safe = resolveInsideAny(tops, path)
      const top = tops.find((candidate) => isInside(candidate, safe))!
      const relative = segmentsOf(safe).slice(segmentsOf(top).length)
      const name = relative[relative.length - 1] ?? ''
      if (relative.length === 0 || !(isPhotoName(name) || isVideoName(name))) throw forbidden('Seules les photos peuvent être supprimées ici')
      if (top === tops[0] && relative[0] === TRASH_FOLDER) throw forbidden('Ce fichier est déjà dans la corbeille')
      const destination = await moveInto(client, safe, joinPath([...binDay, ...relative.slice(0, -1)]), name, made, present)
      report.moved.push({ from: path, to: destination })
    } catch (err) {
      const error = toVaultError(err, 'Suppression impossible')
      report.failed.push({ path, message: error.message })
      if (isFatal(error)) stopped = error
    }
    options.onEach?.(index + 1, paths.length)
  }
  return report
}

/** What is in the account's bin, newest day first. A bin that doesn't exist yet is an empty one. */
export async function loadTrash(client: VaultClient, root: string, options: { isCancelled?: () => boolean } = {}): Promise<TrashListing> {
  const top = resolveInside(root, root)
  const binSegments = [...segmentsOf(top), TRASH_FOLDER]
  const bin = joinPath(binSegments)
  const gate = limiter(LIST_CONCURRENCY)
  const items: TrashedPhoto[] = []
  let incomplete = false
  let days: FBItem[]
  try {
    days = await gate(() => client.list(bin))
  } catch (err) {
    const error = toVaultError(err, 'Impossible de lire la corbeille')
    if (error.code === 'not-found') return { items, incomplete }
    throw error
  }

  async function walk(dir: string, day: string, below: string[], depth: number): Promise<void> {
    if (options.isCancelled?.()) return
    let listed: FBItem[]
    try {
      listed = await gate(() => client.list(dir))
    } catch {
      incomplete = true
      return
    }
    const folders: { path: string; below: string[] }[] = []
    for (const item of listed) {
      let path: string
      try {
        path = resolveInside(bin, childPath(dir, item.name))
      } catch {
        continue
      }
      if (item.isDir) {
        if (depth < MAX_DEPTH) folders.push({ path, below: [...below, item.name] })
      } else if (isPhotoName(item.name) || isVideoName(item.name)) {
        items.push({
          path,
          name: item.name,
          kind: isVideoName(item.name) ? 'video' : 'photo',
          size: item.size || 0,
          modified: Date.parse(item.modified) || 0,
          hasPreview: item.hasPreview,
          trashedOn: day,
          originalPath: joinPath([...segmentsOf(top), ...below, item.name])
        })
      }
    }
    await Promise.all(folders.map((folder) => walk(folder.path, day, folder.below, depth + 1)))
  }

  const dayFolders = days.filter((entry) => entry.isDir && DAY_FOLDER.test(entry.name) && validName(entry.name))
  await Promise.all(dayFolders.map((entry) => walk(joinPath([...binSegments, entry.name]), entry.name, [], 1)))
  items.sort((a, b) => (a.trashedOn < b.trashedOn ? 1 : a.trashedOn > b.trashedOn ? -1 : 0) || (a.originalPath < b.originalPath ? -1 : 1))
  return { items, incomplete }
}

export interface RestoreReport {
  restored: { from: string; to: string }[]
  failed: { path: string; message: string }[]
}

/**
 * Puts files of the bin back where they came from (their folders are made again if need be). A name that has
 * been taken meanwhile is not overwritten: the file comes back under a numbered name.
 */
export async function restoreTrashed(
  client: VaultClient,
  root: string,
  paths: string[],
  options: { onEach?: (done: number, total: number) => void } = {}
): Promise<RestoreReport> {
  const top = resolveInside(root, root)
  const binSegments = [...segmentsOf(top), TRASH_FOLDER]
  const bin = joinPath(binSegments)
  const report: RestoreReport = { restored: [], failed: [] }
  const made = new Set<string>()
  const present = new Map<string, Set<string>>()
  let stopped: VaultError | null = null
  for (const [index, path] of paths.entries()) {
    if (stopped) {
      report.failed.push({ path, message: stopped.message })
      continue
    }
    try {
      const safe = resolveInside(bin, path)
      const below = segmentsOf(safe).slice(binSegments.length)
      const name = below[below.length - 1] ?? ''
      if (below.length < 2 || !DAY_FOLDER.test(below[0]) || !(isPhotoName(name) || isVideoName(name))) throw forbidden("Ce fichier n'est pas dans la corbeille")
      const destination = await moveInto(client, safe, joinPath([...segmentsOf(top), ...below.slice(1, -1)]), name, made, present)
      report.restored.push({ from: path, to: destination })
    } catch (err) {
      const error = toVaultError(err, 'Restauration impossible')
      report.failed.push({ path, message: error.message })
      if (isFatal(error)) stopped = error
    }
    options.onEach?.(index + 1, paths.length)
  }
  return report
}

/**
 * Deletes bin days for good: all of them, or only those older than `olderThanDays`. Only the day folders the
 * app made are touched; anything else somebody put in the bin folder is left alone.
 */
export async function emptyTrash(
  client: VaultClient,
  root: string,
  options: { olderThanDays?: number; today?: Date } = {}
): Promise<{ removed: number; failed: number }> {
  const top = resolveInside(root, root)
  const binSegments = [...segmentsOf(top), TRASH_FOLDER]
  let days: FBItem[]
  try {
    days = await client.list(joinPath(binSegments))
  } catch (err) {
    const error = toVaultError(err, 'Impossible de lire la corbeille')
    if (error.code === 'not-found') return { removed: 0, failed: 0 }
    throw error
  }
  const today = options.today ?? new Date()
  let removed = 0
  let failed = 0
  for (const entry of days) {
    if (!entry.isDir || !DAY_FOLDER.test(entry.name) || !validName(entry.name)) continue
    if (options.olderThanDays !== undefined) {
      const age = daysInBin(entry.name, today)
      if (age === null || age < options.olderThanDays) continue
    }
    try {
      await client.remove(joinPath([...binSegments, entry.name]))
      removed++
    } catch (err) {
      failed++
      if (isFatal(toVaultError(err, ''))) break
    }
  }
  return { removed, failed }
}

/** Deletes what has been in the bin for TRASH_DAYS days or more. */
export function purgeExpiredTrash(client: VaultClient, root: string, today: Date = new Date()): Promise<{ removed: number; failed: number }> {
  return emptyTrash(client, root, { olderThanDays: TRASH_DAYS, today })
}

/** Creates a folder and its parents, remembering in `made` which it has done; "already exists" is the usual answer and is ignored. */
async function ensureFolders(client: VaultClient, dir: string, made: Set<string>): Promise<void> {
  const segments = segmentsOf(dir)
  for (let i = 1; i <= segments.length; i++) {
    const partial = `/${segments.slice(0, i).join('/')}`
    if (made.has(partial)) continue
    await client.createFolder(partial).catch(() => {})
    made.add(partial)
  }
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
      await ensureFolders(client, dir, made)
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
