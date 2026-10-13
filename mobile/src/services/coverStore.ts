import { Directory, File, Paths } from 'expo-file-system'
import { create } from 'zustand'
import { storage } from '@/services/storage'

/**
 * Covers kept on the phone for good, in the app's own documents, not in an image cache the system may empty: every cover
 * the app shows is saved the first time, the covers of downloaded songs are saved with them and never dropped, and
 * "Enregistrer toutes les pochettes" saves the whole library's. A stored cover is shown from the phone, with or without
 * a network. Past MAX_BYTES the covers not seen for longest go first (never a downloaded song's).
 *
 * Covers are known by what NavidromeClient.coverArtUrl puts in its address: the cover's id and its size bucket.
 */

const MAX_BYTES = 300 * 1024 * 1024
/** Downloads at once: enough to fill a screen of covers quickly, few enough not to choke a slow connection. */
const CONCURRENCY = 4
const INDEX_PREF = 'covers.index'

interface Entry {
  bytes: number
  /** When the cover was last shown (ms), for the eviction order. */
  usedAt: number
}

interface CoverState {
  /** Which covers are on the phone, by key ("<id>@<size>"). */
  stored: Record<string, true>
  count: number
  bytes: number
}

export const useCoverStore = create<CoverState>(() => ({ stored: {}, count: 0, bytes: 0 }))

const dir = new Directory(Paths.document, 'covers')
const index = new Map<string, Entry>()
const inFlight = new Map<string, Promise<boolean>>()
const waiting: { key: string; url: string; resolve: (ok: boolean) => void }[] = []
let running = 0
let loaded = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let isPinned: (coverId: string) => boolean = () => false

/** The key of a cover address built by NavidromeClient.coverArtUrl ("<id>@<size>"), or null for anything else. */
export function coverKey(url: string): string | null {
  if (!url || !url.includes('/rest/getCoverArt')) return null
  const id = /[?&]id=([^&#]+)/.exec(url)
  const size = /[?&]size=(\d+)/.exec(url)
  if (!id || !size) return null
  return `${decodeURIComponent(id[1])}@${size[1]}`
}

/** A file name for a key that is safe anywhere: anything but letters, digits, "-" and "_" is written as its code. */
export function fileNameFor(key: string): string {
  const [id, size] = [key.slice(0, key.lastIndexOf('@')), key.slice(key.lastIndexOf('@') + 1)]
  const safe = id.replace(/[^A-Za-z0-9_-]/g, (c) => `~${c.charCodeAt(0).toString(16)}~`)
  return `${safe}@${size}.jpg`
}

function keyOfFile(name: string): string | null {
  const m = /^(.*)@(\d+)\.jpg$/.exec(name)
  if (!m) return null
  return `${m[1].replace(/~([0-9a-f]+)~/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))}@${m[2]}`
}

const idOf = (key: string): string => key.slice(0, key.lastIndexOf('@'))

/** Tells the store which covers belong to downloaded songs (never dropped). Set once at startup. */
export function setCoverPinning(pinned: (coverId: string) => boolean): void {
  isPinned = pinned
}

function publish(): void {
  let bytes = 0
  const stored: Record<string, true> = {}
  for (const [key, entry] of index) {
    stored[key] = true
    bytes += entry.bytes
  }
  useCoverStore.setState({ stored, count: index.size, bytes })
}

function saveSoon(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const used: Record<string, number> = {}
    for (const [key, entry] of index) used[key] = entry.usedAt
    void storage.savePref(INDEX_PREF, used)
  }, 5_000)
}

/** Reads what is on the phone: the files themselves, and when each was last shown. */
export async function loadCoverStore(): Promise<void> {
  if (loaded) return
  loaded = true
  const used = (await storage.loadPref<Record<string, number>>(INDEX_PREF)) ?? {}
  try {
    if (!dir.exists) dir.create({ intermediates: true })
    for (const item of dir.list()) {
      if (!(item instanceof File)) continue
      const key = keyOfFile(item.name)
      if (!key) {
        // A download that never finished.
        if (item.name.endsWith('.part')) item.delete()
        continue
      }
      index.set(key, { bytes: item.size ?? 0, usedAt: used[key] ?? 0 })
    }
  } catch {
    // An unreadable folder: covers are fetched again as they are shown.
  }
  publish()
}

/** The phone's copy of the cover at `url` (a file:// address), or null when it has none yet. */
export function storedCoverUri(url: string): string | null {
  const key = coverKey(url)
  const entry = key ? index.get(key) : undefined
  if (!key || !entry) return null
  const now = Date.now()
  // Remembered to the minute: enough for the eviction order, without a save at every render.
  if (now - entry.usedAt > 60_000) {
    entry.usedAt = now
    saveSoon()
  }
  return new File(dir, fileNameFor(key)).uri
}

/** Saves the cover at `url` on the phone. Resolves true once it is there (at once when it already was). */
export function storeCover(url: string): Promise<boolean> {
  const key = coverKey(url)
  if (!key) return Promise.resolve(false)
  if (index.has(key)) return Promise.resolve(true)
  const pending = inFlight.get(key)
  if (pending) return pending
  const promise = new Promise<boolean>((resolve) => {
    waiting.push({ key, url, resolve })
    pump()
  }).finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

function pump(): void {
  while (running < CONCURRENCY && waiting.length > 0) {
    const job = waiting.shift()!
    running++
    download(job.key, job.url)
      .then(job.resolve)
      .finally(() => {
        running--
        pump()
      })
  }
}

async function download(key: string, url: string): Promise<boolean> {
  const name = fileNameFor(key)
  // Written under another name and renamed when complete: a download cut half way leaves no broken cover.
  const part = new File(dir, `${name}.part`)
  try {
    if (!dir.exists) dir.create({ intermediates: true })
    if (part.exists) part.delete()
    const file = await File.downloadFileAsync(url, part, { idempotent: true })
    const bytes = file.size ?? 0
    if (bytes <= 0) {
      file.delete()
      return false
    }
    const target = new File(dir, name)
    if (target.exists) target.delete()
    file.rename(name)
    index.set(key, { bytes, usedAt: Date.now() })
    evictIfNeeded()
    publish()
    saveSoon()
    return true
  } catch {
    try {
      if (part.exists) part.delete()
    } catch {
      // Gone already.
    }
    return false
  }
}

function evictIfNeeded(): void {
  let total = 0
  for (const entry of index.values()) total += entry.bytes
  if (total <= MAX_BYTES) return
  const target = MAX_BYTES * 0.9
  const oldestFirst = [...index.entries()].filter(([key]) => !isPinned(idOf(key))).sort((a, b) => a[1].usedAt - b[1].usedAt)
  for (const [key, entry] of oldestFirst) {
    if (total <= target) break
    try {
      new File(dir, fileNameFor(key)).delete()
    } catch {
      // Already gone.
    }
    index.delete(key)
    total -= entry.bytes
  }
}

/** Deletes the stored covers, except those of downloaded songs. */
export function clearCovers(): void {
  for (const key of [...index.keys()]) {
    if (isPinned(idOf(key))) continue
    try {
      new File(dir, fileNameFor(key)).delete()
    } catch {
      // Already gone.
    }
    index.delete(key)
  }
  publish()
  saveSoon()
}

/** The covers worth keeping for a song on the phone: the sizes the lists, the mini player and the player show. */
export const SONG_COVER_SIZES = [160, 320, 640]

export interface LibraryProgress {
  done: number
  /** Null until the last page of albums has been read. */
  total: number | null
  failed: number
}

/**
 * Saves the cover of every album of the library, at the size the lists show: pages of albums are read with `fetchPage`
 * (offset, size) and `urlFor` builds each cover's address. Covers already on the phone cost nothing. `shouldStop` is
 * asked between covers.
 */
export async function storeLibraryCovers(
  fetchPage: (offset: number, size: number) => Promise<{ coverArt?: string; id: string }[]>,
  urlFor: (coverId: string) => string,
  onProgress: (progress: LibraryProgress) => void,
  shouldStop: () => boolean = () => false
): Promise<LibraryProgress> {
  const PAGE = 500
  const ids: string[] = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await fetchPage(offset, PAGE)
    for (const album of page) ids.push(album.coverArt || album.id)
    if (page.length < PAGE || shouldStop()) break
  }
  const unique = [...new Set(ids)]
  const progress: LibraryProgress = { done: 0, total: unique.length, failed: 0 }
  onProgress({ ...progress })
  // A few at a time through the same queue as the rest, so what is on screen still gets its turn.
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < unique.length && !shouldStop()) {
      const ok = await storeCover(urlFor(unique[cursor++]))
      progress.done++
      if (!ok) progress.failed++
      onProgress({ ...progress })
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return progress
}
