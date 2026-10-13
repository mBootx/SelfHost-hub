/**
 * When the network is too slow to stream, or gone, the songs already on the phone come first: this module says how good
 * the network is from what playback and the server show, and how to reorder the queue. No React Native in here, so it
 * is checked in Node (tests/offline.test.js); services/offlineMode.ts wires it to the player.
 */

export type NetworkQuality = 'good' | 'slow' | 'offline'

/** A stall this long, while a streamed song should be playing, says on its own that the network can't keep up. */
const LONG_STALL_MS = 4_000
/** Shorter stalls count when there are this many within the window. */
const STALLS_FOR_SLOW = 2
const MIN_STALL_MS = 1_000
const STALL_WINDOW_MS = 2 * 60_000
/** The server answering a ping this slowly is a slow network too. */
const SLOW_PING_MS = 1_500
/** Back to good only after this long without a stall and a ping under GOOD_PING_MS: no flapping. */
const CALM_MS = 2 * 60_000
const GOOD_PING_MS = 800
/** This many failed pings in a row with the phone saying it is connected: the server can't be reached. */
const FAILED_PINGS_FOR_OFFLINE = 2

export interface NetworkSnapshot {
  quality: NetworkQuality
  /** Why, in a few words, for the diagnostics. */
  reason: string
}

/**
 * Judges the network from three kinds of evidence: what the phone says about its connection, the stalls of a streamed
 * song while it should be playing, and pings to the server. Feed it as things happen; `quality()` is the verdict.
 */
export class NetworkMonitor {
  private connected = true
  private reachable: boolean | null = null
  private stalls: { start: number; end: number | null }[] = []
  private failedPings = 0
  private lastPingMs: number | null = null
  private slowSince: number | null = null
  private lastTrouble = -Infinity

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * What the phone says: a network or none, and whether it reaches the internet (null: it doesn't know). A network that
   * came back clears the failed pings: the next ones decide again.
   */
  noteConnectivity(connected: boolean, reachable: boolean | null): void {
    if (connected && !this.connected) this.failedPings = 0
    this.connected = connected
    this.reachable = reachable
  }

  /** Whether the phone says the internet is out of reach (worth a ping to see if the server still answers). */
  get internetDoubtful(): boolean {
    return this.reachable === false
  }

  /** A streamed song started or stopped waiting for data while it should have been playing. */
  noteBuffering(buffering: boolean): void {
    const t = this.now()
    const open = this.stalls.length > 0 ? this.stalls[this.stalls.length - 1] : null
    if (buffering) {
      if (!open || open.end !== null) this.stalls.push({ start: t, end: null })
    } else if (open && open.end === null) {
      open.end = t
    }
    this.stalls = this.stalls.filter((s) => (s.end ?? t) >= t - STALL_WINDOW_MS)
  }

  /** How long the server took to answer a ping, or null when it did not. */
  notePing(latencyMs: number | null): void {
    if (latencyMs === null) {
      this.failedPings++
      this.lastPingMs = null
    } else {
      this.failedPings = 0
      this.lastPingMs = latencyMs
    }
  }

  quality(): NetworkQuality {
    return this.snapshot().quality
  }

  snapshot(): NetworkSnapshot {
    const t = this.now()
    if (!this.connected) return { quality: 'offline', reason: 'pas de réseau' }
    // No internet is not offline: a server on the home network still answers. Only the server failing to does.
    if (this.failedPings >= FAILED_PINGS_FOR_OFFLINE) return { quality: 'offline', reason: 'serveur injoignable' }

    const recent = this.stalls.filter((s) => (s.end ?? t) >= t - STALL_WINDOW_MS)
    const length = (s: { start: number; end: number | null }): number => (s.end ?? t) - s.start
    const longStall = recent.some((s) => length(s) >= LONG_STALL_MS)
    const manyStalls = recent.filter((s) => length(s) >= MIN_STALL_MS).length >= STALLS_FOR_SLOW
    const slowPing = this.lastPingMs !== null && this.lastPingMs >= SLOW_PING_MS
    if (longStall || manyStalls || slowPing) {
      this.lastTrouble = t
      if (this.slowSince === null) this.slowSince = t
      return { quality: 'slow', reason: longStall ? 'lecture bloquée' : manyStalls ? 'lecture saccadée' : 'serveur lent' }
    }
    if (this.slowSince !== null) {
      // Calm again only after a while without trouble, and a quick ping to prove it.
      const calm = t - this.lastTrouble >= CALM_MS && this.lastPingMs !== null && this.lastPingMs < GOOD_PING_MS
      if (!calm) return { quality: 'slow', reason: 'en observation' }
      this.slowSince = null
    }
    return { quality: 'good', reason: 'ok' }
  }
}

// --- The queue ---

/**
 * The queue with what is still to come reordered: the songs on the phone first, then the others, each group in the
 * order it had. What was already played and the song playing stay where they are, so "previous" still walks back
 * through what was heard. Returns the same array when nothing moves.
 */
export function prioritizeLocal<T extends { id: string }>(queue: T[], index: number, isLocal: (id: string) => boolean): T[] {
  const head = queue.slice(0, Math.max(0, index + 1))
  const rest = queue.slice(Math.max(0, index + 1))
  const local = rest.filter((song) => isLocal(song.id))
  const remote = rest.filter((song) => !isLocal(song.id))
  const reordered = [...head, ...local, ...remote]
  return reordered.every((song, i) => song === queue[i]) ? queue : reordered
}

/**
 * Where to go when the song at `index` cannot be streamed: the first song on the phone from `index` on (wrapping round
 * to the start when the whole queue repeats). -1 when the queue has none.
 */
export function nextLocalIndex<T extends { id: string }>(queue: T[], index: number, isLocal: (id: string) => boolean, wrap: boolean): number {
  for (let i = Math.max(0, index); i < queue.length; i++) if (isLocal(queue[i].id)) return i
  if (wrap) for (let i = 0; i < Math.min(index, queue.length); i++) if (isLocal(queue[i].id)) return i
  return -1
}

/** The bitrate to ask the server for when streaming (kbit/s), or null for the original file. */
export function streamBitrate(quality: NetworkQuality, reduceWhenSlow: boolean): number | null {
  return reduceWhenSlow && quality !== 'good' ? SLOW_BITRATE : null
}

export const SLOW_BITRATE = 128
