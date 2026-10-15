import { describeError, logEvent } from '@/services/diagnostics'
import type { DowntifyClient, DowntifySong } from '@/services/downtify'

/**
 * Downtify for the watch. The watch has no address or login for Downtify: it asks this phone, over the Wear OS data layer
 * (the same link as the rest, see watchLink.ts), to search and to download.
 *
 * - `search` {v, id, query}  ->  `results` {v, id, ok, songs[] | error}
 * - `download` {v, id, songId}  ->  `queued` {v, id, songId, ok, message?}   (answered as soon as Downtify is being asked:
 *   the download itself takes a minute, and goes on with the watch long gone; its progress is in the phone's queue)
 *
 * The watch only knows a song by the id it was sent, so the songs of the latest searches are remembered here (the
 * download needs the address Downtify gave). wear/core/.../DowntifyProtocol.kt reads these messages; the sample files in
 * wear/core/src/test/resources are what both sides' tests check against.
 */
export const DOWNTIFY_VERSION = 1
export const DOWNTIFY_PREFIX = '/selfhost/downtify'
export const DOWNTIFY_PATHS = {
  search: '/selfhost/downtify/search',
  results: '/selfhost/downtify/results',
  download: '/selfhost/downtify/download',
  queued: '/selfhost/downtify/queued'
} as const

/** A small screen has no use for more than this, and a message is small. */
export const MAX_RESULTS = 12
/** The songs remembered between a search and the download it leads to. */
const REMEMBERED = 60

export type DowntifyWatchRequest = { kind: 'search'; id: string; query: string } | { kind: 'download'; id: string; songId: string }

export function parseDowntifyRequest(path: string, json: string): DowntifyWatchRequest | null {
  let body: unknown
  try {
    body = JSON.parse(json)
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  if (o.v !== DOWNTIFY_VERSION || typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 64) return null
  if (path === DOWNTIFY_PATHS.search) {
    const query = typeof o.query === 'string' ? o.query.trim().slice(0, 120) : ''
    return query ? { kind: 'search', id: o.id, query } : null
  }
  if (path === DOWNTIFY_PATHS.download) {
    return typeof o.songId === 'string' && o.songId.length > 0 && o.songId.length <= 200 ? { kind: 'download', id: o.id, songId: o.songId } : null
  }
  return null
}

const clip = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

export function resultsMessage(id: string, songs: DowntifySong[]): string {
  return JSON.stringify({
    v: DOWNTIFY_VERSION,
    id,
    ok: true,
    songs: songs.slice(0, MAX_RESULTS).map((song) => {
      const out: Record<string, unknown> = {
        id: song.song_id,
        title: clip(song.name, 120),
        artist: clip(Array.isArray(song.artists) ? song.artists.join(', ') : '', 120),
        duration: Number.isFinite(song.duration) && song.duration > 0 ? Math.round(song.duration) : 0
      }
      const album = clip(song.album_name, 120)
      if (album) out.album = album
      return out
    })
  })
}

export function failureMessage(id: string, error: string): string {
  return JSON.stringify({ v: DOWNTIFY_VERSION, id, ok: false, error: clip(error, 200) })
}

export function queuedMessage(id: string, songId: string, ok: boolean, message?: string): string {
  const out: Record<string, unknown> = { v: DOWNTIFY_VERSION, id, songId, ok }
  if (message) out.message = clip(message, 200)
  return JSON.stringify(out)
}

// --- What was last found ---

const remembered = new Map<string, DowntifySong>()

export function rememberResults(songs: DowntifySong[]): void {
  for (const song of songs.slice(0, MAX_RESULTS)) {
    remembered.delete(song.song_id)
    remembered.set(song.song_id, song)
  }
  while (remembered.size > REMEMBERED) {
    const oldest = remembered.keys().next().value
    if (oldest === undefined) break
    remembered.delete(oldest)
  }
}

export function recall(songId: string): DowntifySong | undefined {
  return remembered.get(songId)
}

export function forgetResults(): void {
  remembered.clear()
}

// --- Answering the watch ---

export interface DowntifyDeps {
  /** Null when Downtify is not connected on this phone. */
  client: () => DowntifyClient | null
  /** Asks Downtify for a song: resolves when it has been downloaded, so it is not waited for here. */
  queueDownload: (song: DowntifySong) => Promise<void>
}

export const NOT_CONNECTED = 'Downtify n’est pas connecté sur le téléphone'
export const SEARCH_FAILED = 'Downtify ne répond pas'
export const FORGOTTEN = 'Relancez la recherche'

/**
 * One request from the watch, answered through `reply(path, json)`. A request that is not ours or not well formed gets
 * no answer (the watch gives up by itself after its timeout).
 */
export async function handleDowntifyMessage(
  path: string,
  json: string,
  reply: (path: string, json: string) => Promise<unknown>,
  deps: DowntifyDeps
): Promise<void> {
  const request = parseDowntifyRequest(path, json)
  if (!request) {
    logEvent('watch', 'Demande Downtify de la montre illisible', 'warn')
    return
  }
  if (request.kind === 'search') {
    const client = deps.client()
    if (!client) {
      await reply(DOWNTIFY_PATHS.results, failureMessage(request.id, NOT_CONNECTED))
      return
    }
    try {
      const songs = (await client.searchSongs(request.query)).slice(0, MAX_RESULTS)
      rememberResults(songs)
      await reply(DOWNTIFY_PATHS.results, resultsMessage(request.id, songs))
    } catch (err) {
      logEvent('watch', `Recherche Downtify de la montre impossible : ${describeError(err)}`, 'warn')
      await reply(DOWNTIFY_PATHS.results, failureMessage(request.id, SEARCH_FAILED))
    }
    return
  }
  const song = recall(request.songId)
  if (!deps.client()) {
    await reply(DOWNTIFY_PATHS.queued, queuedMessage(request.id, request.songId, false, NOT_CONNECTED))
    return
  }
  if (!song) {
    await reply(DOWNTIFY_PATHS.queued, queuedMessage(request.id, request.songId, false, FORGOTTEN))
    return
  }
  // Not awaited: Downtify answers once the song is downloaded and converted, a minute or more later. The watch is told
  // now that it was asked; how it goes is in the phone's download queue (and its journal when it fails).
  deps.queueDownload(song).catch((err) => logEvent('watch', `Téléchargement Downtify demandé par la montre échoué : ${describeError(err)}`, 'warn'))
  logEvent('watch', `Téléchargement Downtify demandé par la montre : ${song.name}`)
  await reply(DOWNTIFY_PATHS.queued, queuedMessage(request.id, request.songId, true))
}
