import { ApiError } from '@/services/navidrome'
import { describeError, logEvent } from '@/services/diagnostics'
import { storage } from '@/services/storage'
import { useNavidromeStore } from '@/store/navidromeStore'

/**
 * Reports plays to Navidrome, so play counts and "recently played" follow you from one device to the
 * other (and on to Last.fm/ListenBrainz if the server forwards them). Like Last.fm, a song counts once
 * it has been heard for half its length or 4 minutes, whichever comes first. Plays that can't be sent
 * (offline tracks, server down) are saved and go out with the next one.
 */
const PENDING_KEY = 'scrobbles.pending'
const MIN_DURATION_S = 30
const MAX_REQUIRED_S = 240
const MAX_PENDING = 500
/** A play the server fails on without saying why is tried this many times in all, then given up on. */
const MAX_TRIES = 5
/** A bigger jump between two progress ticks is a seek, not listening. */
const MAX_TICK_S = 3
/** "Recently played" is refreshed this long after a play is recorded, once for a burst of plays. */
const RECENT_REFRESH_MS = 5000

interface PendingPlay {
  id: string
  /** When the song started, in ms: the server records the play at that time. */
  time: number
  /** How many times the server has failed on it without a reason. */
  tries?: number
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
let pending: PendingPlay[] = []
let chain: Promise<void> = Promise.resolve()
let refreshTimer: ReturnType<typeof setTimeout> | null = null

function savePending(): void {
  pending = pending.slice(-MAX_PENDING)
  storage.savePref(PENDING_KEY, pending).catch(() => {})
}

export type Failure = 'outage' | 'rejected' | 'unexplained'

/**
 * What a failed scrobble says. 'outage': the server can't be reached, or a proxy in front of it is down, or the
 * login is no good right now: keep every waiting play and try again later. 'rejected': the server answered and
 * refuses this play for good (the song was deleted since): drop it. 'unexplained': it failed without saying why
 * (Navidrome puts most errors in a 200 answer, which the client reports as a 500): a few more tries.
 */
export function classifyFailure(err: unknown): Failure {
  if (!(err instanceof ApiError)) return 'outage'
  const { status, code } = err
  if (status === 0 || status === 401 || status === 408 || status === 429 || status === 502 || status === 503 || status === 504) return 'outage'
  if (code !== undefined) {
    if (code >= 40 && code <= 44) return 'outage'
    return code === 0 ? 'unexplained' : 'rejected'
  }
  return status >= 500 ? 'unexplained' : 'rejected'
}

/** Sends the given play (if any) after the ones still waiting, oldest first. Runs one at a time. */
function flush(play?: PendingPlay): void {
  chain = chain.then(async () => {
    if (play) {
      pending.push(play)
      savePending()
    }
    const client = useNavidromeStore.getState().client
    if (!client || pending.length === 0) return
    let sent = 0
    let offline = false
    const keep: PendingPlay[] = []
    // Each waiting play gets one try per round, so one the server chokes on never holds the others back.
    for (const waiting of pending) {
      if (offline) {
        keep.push(waiting)
        continue
      }
      try {
        await client.scrobble(waiting.id, true, waiting.time)
        sent++
      } catch (err) {
        const failure = classifyFailure(err)
        if (failure === 'outage') {
          if (!offline) logEvent('scrobbler', `Navidrome injoignable : les écoutes attendent (${describeError(err)})`, 'warn')
          offline = true
          keep.push(waiting)
        } else if (failure === 'unexplained') {
          const tries = (waiting.tries ?? 0) + 1
          if (tries < MAX_TRIES) keep.push({ ...waiting, tries })
          else logEvent('scrobbler', `Écoute abandonnée après ${MAX_TRIES} essais : ${describeError(err)}`, 'warn')
        } else {
          logEvent('scrobbler', `Écoute refusée par le serveur et abandonnée : ${describeError(err)}`, 'info')
        }
      }
    }
    pending = keep
    savePending()
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
  chain = storage
    .loadPref<PendingPlay[]>(PENDING_KEY)
    .then((saved) => {
      pending = [...(saved ?? []), ...pending]
    })
    .catch(() => {})
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
