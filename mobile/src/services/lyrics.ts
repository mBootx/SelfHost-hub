import { fetchWithTimeout } from './http'
import { storage } from './storage'

export interface LyricLine {
  /** Seconds from the start of the track. */
  time: number
  text: string
}

export interface LyricsResult {
  /** Timestamped lines, when the provider had a synced version. */
  synced: LyricLine[] | null
  plain: string | null
  source: 'lrclib' | 'navidrome'
}

/**
 * LRCLIB is a free, open source (and key-less) lyrics database that serves
 * LRC-format synced lyrics - the same format Spotify-style scrolling needs.
 * It asks callers to identify themselves via User-Agent.
 * https://lrclib.net/docs
 */
const LRCLIB = 'https://lrclib.net/api'
const HEADERS = { 'User-Agent': 'SelfHostHub/1.0.0 (self-hosted music client)' }

interface LrclibRecord {
  syncedLyrics?: string | null
  plainLyrics?: string | null
  instrumental?: boolean
}

/**
 * Parses LRC timestamps. A single line can carry several stamps (`[00:12.34][01:40.00] text`)
 * when a phrase repeats, and blank lines are kept so the highlight still advances
 * through instrumental gaps.
 */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const raw of lrc.split('\n')) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (stamps.length === 0) continue
    const text = raw.replace(/\[[^\]]*\]/g, '').trim()
    for (const stamp of stamps) {
      const minutes = Number(stamp[1])
      const seconds = Number(stamp[2])
      const fraction = stamp[3] ? Number(stamp[3].padEnd(3, '0')) / 1000 : 0
      lines.push({ time: minutes * 60 + seconds + fraction, text })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}

function toResult(record: LrclibRecord): LyricsResult | null {
  if (record.instrumental) return { synced: null, plain: '♪ Instrumental ♪', source: 'lrclib' }
  const synced = record.syncedLyrics ? parseLrc(record.syncedLyrics) : null
  const plain = record.plainLyrics?.trim() || null
  if ((!synced || synced.length === 0) && !plain) return null
  return { synced: synced && synced.length > 0 ? synced : null, plain, source: 'lrclib' }
}

/** Exact match: artist + track + album + duration. Highest quality hit, 404s easily. */
async function lrclibGet(artist: string, title: string, album: string, duration: number): Promise<LyricsResult | null> {
  const params = new URLSearchParams({
    artist_name: artist,
    track_name: title,
    album_name: album,
    duration: String(Math.round(duration))
  })
  const res = await fetchWithTimeout(`${LRCLIB}/get?${params}`, { headers: HEADERS })
  if (!res.ok) return null
  return toResult((await res.json()) as LrclibRecord)
}

/** Looser fallback: no album, no duration. Used by the manual "auto search". */
async function lrclibSearch(artist: string, title: string): Promise<LyricsResult | null> {
  const params = new URLSearchParams({ track_name: title, artist_name: artist })
  const res = await fetchWithTimeout(`${LRCLIB}/search?${params}`, { headers: HEADERS })
  if (!res.ok) return null
  const records = (await res.json()) as LrclibRecord[]
  if (!Array.isArray(records)) return null
  // Prefer whichever match actually carries synced lyrics over the first hit.
  const best = records.find((r) => r.syncedLyrics) || records[0]
  return best ? toResult(best) : null
}

const cacheKey = (songId: string): string => `lyrics.${songId}`

export async function loadCachedLyrics(songId: string): Promise<LyricsResult | null> {
  return storage.loadPref<LyricsResult>(cacheKey(songId))
}

/**
 * Looks up lyrics for a track and caches the hit on device. `wide` drops the
 * album/duration constraints and lets the Navidrome server have a go too, which
 * is what the "auto search" button uses after a normal lookup came up empty.
 */
export async function fetchLyrics(
  song: { id: string; title: string; artist: string; album?: string; duration: number },
  options: { wide?: boolean; navidromeLookup?: (artist: string, title: string) => Promise<string | null> } = {}
): Promise<LyricsResult | null> {
  const cached = await loadCachedLyrics(song.id)
  if (cached) return cached

  let result: LyricsResult | null = null
  try {
    result = await lrclibGet(song.artist, song.title, song.album || '', song.duration)
  } catch {
    // network hiccup or the service is down; fall through to the wider attempts
  }

  if (!result && options.wide) {
    try {
      result = await lrclibSearch(song.artist, song.title)
    } catch {
      // ignore
    }
    if (!result && options.navidromeLookup) {
      try {
        const plain = await options.navidromeLookup(song.artist, song.title)
        if (plain?.trim()) result = { synced: null, plain: plain.trim(), source: 'navidrome' }
      } catch {
        // ignore
      }
    }
  }

  if (result) await storage.savePref(cacheKey(song.id), result)
  return result
}

/** Index of the line that should be highlighted at `time`, or -1 before the first. */
export function activeLineIndex(lines: LyricLine[], time: number): number {
  let index = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= time) index = i
    else break
  }
  return index
}
