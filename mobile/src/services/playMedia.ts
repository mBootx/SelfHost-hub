/**
 * "Play this album / playlist / song", asked of this phone by the watch (services/watchLink.ts). The request names
 * something in the library, not a stream: the phone looks it up in its own Navidrome and plays it, so a request
 * carries nothing that could point it at another server.
 */

export type PlayMediaKind = 'song' | 'album' | 'playlist'
export type PlayMediaMode = 'now' | 'next' | 'last'

export interface PlayMediaRequest {
  kind: PlayMediaKind
  id: string
  /** For an album or a playlist: where in it to start (or to start adding from). */
  index?: number
  /** Same, but by song, which survives a list that was re-sorted since the sender looked at it. */
  songId?: string
  mode: PlayMediaMode
}

const KINDS: readonly string[] = ['song', 'album', 'playlist']
const MODES: readonly string[] = ['now', 'next', 'last']
const MAX_ID = 200
const MAX_INDEX = 100_000

/** The request in a command's payload, or null when it is anything else: the payload comes off the network. */
export function parsePlayMedia(payload: unknown): PlayMediaRequest | null {
  if (!payload || typeof payload !== 'object') return null
  const raw = payload as Record<string, unknown>
  if (typeof raw.kind !== 'string' || !KINDS.includes(raw.kind)) return null
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > MAX_ID) return null
  const mode = raw.mode === undefined ? 'now' : raw.mode
  if (typeof mode !== 'string' || !MODES.includes(mode)) return null

  const request: PlayMediaRequest = { kind: raw.kind as PlayMediaKind, id: raw.id, mode: mode as PlayMediaMode }
  if (raw.index !== undefined) {
    if (typeof raw.index !== 'number' || !Number.isInteger(raw.index) || raw.index < 0 || raw.index > MAX_INDEX) return null
    request.index = raw.index
  }
  if (raw.songId !== undefined) {
    if (typeof raw.songId !== 'string' || raw.songId.length === 0 || raw.songId.length > MAX_ID) return null
    request.songId = raw.songId
  }
  return request
}

/** What the player needs from the library client. */
export interface MediaLibrary<S extends { id: string }> {
  getSong(id: string): Promise<S>
  getAlbum(id: string): Promise<{ songs: S[] }>
  getPlaylist(id: string): Promise<{ songs: S[] }>
}

/** What the player can do with a queue. */
export interface QueueActions<S> {
  playQueue(songs: S[], startIndex: number): void
  playNext(song: S): void
  addToQueue(songs: S[]): void
}

/** Looks the request up and queues it. Returns false when there was nothing to play. */
export async function runPlayMedia<S extends { id: string }>(request: PlayMediaRequest, library: MediaLibrary<S>, queue: QueueActions<S>): Promise<boolean> {
  let songs: S[]
  if (request.kind === 'song') songs = [await library.getSong(request.id)]
  else if (request.kind === 'album') songs = (await library.getAlbum(request.id)).songs
  else songs = (await library.getPlaylist(request.id)).songs
  if (!songs || songs.length === 0) return false

  let start = 0
  if (request.songId !== undefined) {
    const found = songs.findIndex((song) => song.id === request.songId)
    if (found >= 0) start = found
  } else if (request.index !== undefined && request.index < songs.length) {
    start = request.index
  }

  if (request.mode === 'now') {
    queue.playQueue(songs, start)
  } else if (request.mode === 'last') {
    queue.addToQueue(songs.slice(start))
  } else {
    // Each one goes right after the song playing, so the last is put in first to end up in order.
    for (const song of songs.slice(start).reverse()) queue.playNext(song)
  }
  return true
}
