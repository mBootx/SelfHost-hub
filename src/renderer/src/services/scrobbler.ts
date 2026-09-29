import { ApiError } from '@renderer/services/navidrome'
import { useNavidromeStore } from '@renderer/store/navidromeStore'

/**
 * Reports plays to Navidrome, so play counts and "recently played" follow you from one device to the
 * other (and on to Last.fm/ListenBrainz if the server forwards them). Like Last.fm, a song counts once
 * it has been heard for half its length or 4 minutes, whichever comes first. Plays that can't be sent
 * (offline tracks, server down) wait in localStorage and go out with the next one.
 */
const PENDING_KEY = 'shub.scrobbles.pending'
const MIN_DURATION_S = 30
const MAX_REQUIRED_S = 240
const MAX_PENDING = 500
/** A bigger jump between two progress ticks is a seek, not listening. */
const MAX_TICK_S = 3
/** "Recently played" is refreshed this long after a play is recorded, once for a burst of plays. */
const RECENT_REFRESH_MS = 5000

interface PendingPlay {
  id: string
  /** When the song started, in ms: the server records the play at that time. */
  time: number
}

interface CurrentPlay {
  id: string
  startedAt: number
  listened: number
  nowPlayingSent: boolean
  submitted: boolean
}

let started = false
let current: CurrentPlay | null = null
let chain: Promise<void> = Promise.resolve()
let refreshTimer: ReturnType<typeof setTimeout> | null = null

function readPending(): PendingPlay[] {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]') as PendingPlay[]
  } catch {
    return []
  }
}

function writePending(plays: PendingPlay[]): void {
  try {
    if (plays.length === 0) localStorage.removeItem(PENDING_KEY)
    else localStorage.setItem(PENDING_KEY, JSON.stringify(plays.slice(-MAX_PENDING)))
  } catch {
    // Storage full: losing a play count is not worth failing playback over.
  }
}

/** Unreachable server or a proxy in front of a stopped one: worth another try later. */
function isTransient(err: unknown): boolean {
  const status = err instanceof ApiError ? err.status : 0
  return status === 0 || status === 502 || status === 503 || status === 504
}

/** Sends the given play (if any) after the ones still waiting, oldest first. Runs one at a time. */
function flush(play?: PendingPlay): void {
  chain = chain.then(async () => {
    const plays = [...readPending(), ...(play ? [play] : [])]
    const client = useNavidromeStore.getState().client
    if (plays.length === 0) return
    if (!client) {
      writePending(plays)
      return
    }
    const remaining: PendingPlay[] = []
    let sent = 0
    for (const [i, p] of plays.entries()) {
      try {
        await client.scrobble(p.id, true, p.time)
        sent++
      } catch (err) {
        // A song the server rejects (deleted since) is dropped; an outage keeps the rest for later.
        if (isTransient(err)) {
          remaining.push(...plays.slice(i))
          break
        }
      }
    }
    writePending(remaining)
    if (sent > 0) scheduleRecentRefresh()
  })
}

function scheduleRecentRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    useNavidromeStore.getState().refreshRecentlyPlayed()
  }, RECENT_REFRESH_MS)
}

export function startScrobbler(): void {
  if (started) return
  started = true
  flush()

  useNavidromeStore.subscribe((s, prev) => {
    // Plays recorded while disconnected go out as soon as Navidrome is back.
    if (s.client && s.client !== prev.client) flush()

    const song = s.queue[s.queueIndex]
    if (song?.id !== current?.id) {
      current = song ? { id: song.id, startedAt: 0, listened: 0, nowPlayingSent: false, submitted: false } : null
    }
    if (!song || !current) return
    const play = current

    // Repeat-one, or "previous" restarting a song already counted: a new play.
    if (play.submitted && s.currentTime < 2 && prev.currentTime > s.currentTime + 10) {
      current = { id: song.id, startedAt: 0, listened: 0, nowPlayingSent: false, submitted: false }
      return
    }

    if (s.isPlaying && !play.nowPlayingSent) {
      play.nowPlayingSent = true
      play.startedAt = Date.now()
      s.client?.scrobble(song.id, false).catch(() => {})
    }

    const sameSong = prev.queue[prev.queueIndex]?.id === song.id
    const delta = s.currentTime - prev.currentTime
    if (s.isPlaying && sameSong && delta > 0 && delta <= MAX_TICK_S) play.listened += delta

    const duration = song.duration || s.duration
    if (!play.submitted && duration >= MIN_DURATION_S && play.listened >= Math.min(duration / 2, MAX_REQUIRED_S)) {
      play.submitted = true
      flush({ id: song.id, time: play.startedAt || Date.now() })
    }
  })
}
