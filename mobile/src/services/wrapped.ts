import type { NDSong } from '@/services/navidrome'

/**
 * The weekly "Wrapped": what was listened to on this phone, week by week (Monday to Sunday, local time), and the
 * summary shown every Monday from 10:00 for the week just ended. Kept free of React and of the phone so it can be
 * checked in Node (tests/wrapped.test.js); services/listeningLog.ts feeds it and saves it.
 */

/** One song's listening in one week. */
export interface SongStat {
  id: string
  title: string
  artist: string
  artistId?: string
  album?: string
  albumId?: string
  coverArt?: string
  duration: number
  /** Seconds actually heard: pauses and seeks are left out. */
  seconds: number
  /** Times it was heard long enough to count: half its length or 4 minutes, the rule Navidrome's plays follow. */
  plays: number
}

export interface WeekLog {
  /** The week's Monday, yyyy-mm-dd, in local time. */
  week: string
  /** Seconds heard on each day of the week, Monday first. */
  days: number[]
  songs: Record<string, SongStat>
}

/** Every week kept, by its Monday (yyyy-mm-dd). */
export type Ledger = Record<string, WeekLog>

export interface ArtistStat {
  name: string
  artistId?: string
  seconds: number
  plays: number
  /** The cover of the artist's most heard song this week, for the picture. */
  coverArt?: string
  albumId?: string
}

export interface WeeklyWrapped {
  week: string
  /** Monday 00:00 and the next Monday 00:00, local time. */
  start: Date
  end: Date
  minutes: number
  /** The week before's minutes, when it was recorded. */
  previousMinutes: number | null
  /** Minutes on each day, Monday first. */
  days: number[]
  /** The day with the most listening (0 = Monday), null for an empty week. */
  busiestDay: number | null
  topSongs: SongStat[]
  topArtists: ArtistStat[]
  songCount: number
  artistCount: number
  plays: number
}

/** The Wrapped of the week before pops up from this hour on Mondays. */
export const WRAPPED_HOUR = 10
/** Weeks kept on the phone: enough to look back a season. */
export const KEEP_WEEKS = 26
/** Below this much listening a week has nothing worth popping up for. */
export const MIN_WRAPPED_SECONDS = 5 * 60
const TOP = 5
/** An artist heard for less than this in a week (a skipped song) is not one of its top artists. */
const MIN_ARTIST_SECONDS = 30

export const DAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
export const DAY_LETTERS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

// --- Weeks ---

const pad = (n: number): string => String(n).padStart(2, '0')

function keyOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Midnight of the Monday of the week `time` falls in, local time. */
export function mondayOf(time: number): Date {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return date
}

/** The key of the week `time` falls in. */
export function weekKey(time: number): string {
  return keyOf(mondayOf(time))
}

/** Midnight of a week's Monday, from its key. */
export function weekStart(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** The key of the week `weeks` after (or before, if negative) this one. Days are counted, so a clock change doesn't matter. */
export function shiftWeek(key: string, weeks: number): string {
  const date = weekStart(key)
  date.setDate(date.getDate() + weeks * 7)
  return keyOf(date)
}

/** 0 for Monday to 6 for Sunday. */
export function dayIndex(time: number): number {
  return (new Date(time).getDay() + 6) % 7
}

/** "6 – 12 octobre", "29 septembre – 5 octobre", "29 décembre 2025 – 4 janvier 2026". */
export function weekLabel(key: string): string {
  const start = weekStart(key)
  const end = weekStart(key)
  end.setDate(end.getDate() + 6)
  const sameMonth = start.getMonth() === end.getMonth()
  const sameYear = start.getFullYear() === end.getFullYear()
  const first = sameMonth ? `${start.getDate()}` : `${start.getDate()} ${MONTHS[start.getMonth()]}${sameYear ? '' : ` ${start.getFullYear()}`}`
  const last = `${end.getDate()} ${MONTHS[end.getMonth()]}${sameYear ? '' : ` ${end.getFullYear()}`}`
  return `${first} – ${last}`
}

/** "12 h 22 min", "45 min", "moins d'une minute". */
export function durationLabel(minutes: number): string {
  if (minutes < 1) return "moins d'une minute"
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${pad(rest)} min`
}

// --- Recording ---

function weekFor(ledger: Ledger, time: number): WeekLog {
  const key = weekKey(time)
  let week = ledger[key]
  if (!week) {
    week = { week: key, days: [0, 0, 0, 0, 0, 0, 0], songs: {} }
    ledger[key] = week
  }
  return week
}

function statFor(week: WeekLog, song: NDSong): SongStat {
  const known = week.songs[song.id]
  const details = {
    id: song.id,
    title: song.title,
    artist: song.artist,
    artistId: song.artistId,
    album: song.album,
    albumId: song.albumId,
    coverArt: song.coverArt,
    duration: song.duration
  }
  if (known) {
    // The song's details as last seen (a tag fixed on the server since).
    Object.assign(known, details)
    return known
  }
  const stat: SongStat = { ...details, seconds: 0, plays: 0 }
  week.songs[song.id] = stat
  return stat
}

/** `seconds` of `song` heard just now (at `time`): counted in that day, that week. */
export function addListening(ledger: Ledger, song: NDSong, seconds: number, time: number): void {
  if (!(seconds > 0)) return
  const week = weekFor(ledger, time)
  week.days[dayIndex(time)] += seconds
  statFor(week, song).seconds += seconds
}

/** `song` was heard long enough to count as a play (at `time`). */
export function addPlay(ledger: Ledger, song: NDSong, time: number): void {
  statFor(weekFor(ledger, time), song).plays += 1
}

/** Forgets the weeks older than the `keep` most recent ones (counting the week of `now`); returns the ones forgotten. */
export function prune(ledger: Ledger, now: number, keep = KEEP_WEEKS): string[] {
  const oldest = shiftWeek(weekKey(now), -(keep - 1))
  const removed = Object.keys(ledger).filter((key) => key < oldest)
  for (const key of removed) delete ledger[key]
  return removed
}

/** Adds what `extra` holds to `into` (the weeks loaded from disk, and what was heard before they were loaded). */
export function mergeLedgers(into: Ledger, extra: Ledger): Ledger {
  for (const [key, week] of Object.entries(extra)) {
    const target = into[key]
    if (!target) {
      into[key] = week
      continue
    }
    week.days.forEach((seconds, day) => (target.days[day] += seconds))
    for (const [id, song] of Object.entries(week.songs)) {
      const known = target.songs[id]
      if (known) {
        known.seconds += song.seconds
        known.plays += song.plays
      } else {
        target.songs[id] = song
      }
    }
  }
  return into
}

/** A ledger as read back from storage, with anything malformed left out. */
export function sanitizeLedger(saved: unknown): Ledger {
  const ledger: Ledger = {}
  if (!saved || typeof saved !== 'object') return ledger
  for (const [key, value] of Object.entries(saved as Record<string, unknown>)) {
    const week = value as WeekLog
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !week || !Array.isArray(week.days) || week.days.length !== 7) continue
    if (!week.songs || typeof week.songs !== 'object') continue
    const songs: Record<string, SongStat> = {}
    for (const [id, song] of Object.entries(week.songs)) {
      if (song && typeof song.title === 'string' && Number.isFinite(song.seconds) && Number.isFinite(song.plays)) songs[id] = song
    }
    ledger[key] = { week: key, days: week.days.map((d) => (Number.isFinite(d) ? d : 0)), songs }
  }
  return ledger
}

// --- The summary ---

export function totalSeconds(week: WeekLog | undefined): number {
  return week ? week.days.reduce((sum, seconds) => sum + seconds, 0) : 0
}

const byTitle = (a: { title?: string; name?: string }, b: { title?: string; name?: string }): number =>
  (a.title ?? a.name ?? '').localeCompare(b.title ?? b.name ?? '', 'fr')

function artistKey(song: SongStat): string {
  return song.artistId || song.artist.trim().toLowerCase()
}

/** The Wrapped of `week`, or null when nothing was recorded that week. */
export function summarize(ledger: Ledger, week: string): WeeklyWrapped | null {
  const log = ledger[week]
  if (!log) return null
  const songs = Object.values(log.songs)
  const start = weekStart(week)
  const end = weekStart(shiftWeek(week, 1))
  const previous = ledger[shiftWeek(week, -1)]

  // Songs: the most played first, then the most heard. A song only skipped through was not one of the week's.
  const topSongs = songs
    .filter((song) => song.plays > 0)
    .sort((a, b) => b.plays - a.plays || b.seconds - a.seconds || byTitle(a, b))
    .slice(0, TOP)

  // Artists: by time heard, which says more than a count of songs of very different lengths.
  const artists = new Map<string, ArtistStat & { best: number }>()
  for (const song of songs) {
    const key = artistKey(song)
    const artist = artists.get(key)
    if (!artist) {
      artists.set(key, { name: song.artist, artistId: song.artistId, seconds: song.seconds, plays: song.plays, coverArt: song.coverArt, albumId: song.albumId, best: song.seconds })
      continue
    }
    artist.seconds += song.seconds
    artist.plays += song.plays
    if (song.seconds > artist.best) {
      artist.best = song.seconds
      artist.coverArt = song.coverArt
      artist.albumId = song.albumId
    }
  }
  const topArtists = [...artists.values()]
    .filter((artist) => artist.seconds >= MIN_ARTIST_SECONDS)
    .sort((a, b) => b.seconds - a.seconds || b.plays - a.plays || byTitle(a, b))
    .slice(0, TOP)
    .map(({ best: _best, ...artist }) => artist)

  const days = log.days.map((seconds) => Math.round(seconds / 60))
  const most = Math.max(...log.days)
  return {
    week,
    start,
    end,
    minutes: Math.round(totalSeconds(log) / 60),
    previousMinutes: previous ? Math.round(totalSeconds(previous) / 60) : null,
    days,
    busiestDay: most > 0 ? log.days.indexOf(most) : null,
    topSongs,
    topArtists,
    songCount: songs.filter((song) => song.seconds >= MIN_ARTIST_SECONDS || song.plays > 0).length,
    artistCount: [...artists.values()].filter((artist) => artist.seconds >= MIN_ARTIST_SECONDS).length,
    plays: songs.reduce((sum, song) => sum + song.plays, 0)
  }
}

/** "+18 %", "−40 %", or null when there is nothing to compare with. */
export function changeLabel(minutes: number, previousMinutes: number | null): string | null {
  if (previousMinutes === null || previousMinutes <= 0) return null
  const change = Math.round(((minutes - previousMinutes) / previousMinutes) * 100)
  if (change === 0) return "autant que la semaine d'avant"
  return `${change > 0 ? '+' : '−'}${Math.abs(change)} % par rapport à la semaine d'avant`
}

// --- When it pops up ---

/**
 * The week whose Wrapped should pop up at `now`: from Monday 10:00, the week that just ended, until it has been shown
 * (on Tuesday too, then, if the app wasn't opened on Monday). Null when it was already shown, or when that week had
 * too little listening to be worth it.
 */
export function dueWeek(ledger: Ledger, now: number, lastShown: string | null): string | null {
  const monday = mondayOf(now)
  const release = new Date(monday)
  release.setHours(WRAPPED_HOUR, 0, 0, 0)
  if (now < release.getTime()) return null
  const ended = shiftWeek(keyOf(monday), -1)
  if (lastShown && lastShown >= ended) return null
  if (totalSeconds(ledger[ended]) < MIN_WRAPPED_SECONDS) return null
  return ended
}

/** The week to open from Settings: the last one that ended, if it was listened to, else the one under way. */
export function latestWeek(ledger: Ledger, now: number): string {
  const current = weekKey(now)
  const ended = shiftWeek(current, -1)
  return totalSeconds(ledger[ended]) > 0 ? ended : current
}

/** The weeks one can go back and forth between: the oldest recorded up to the current one. */
export function weekRange(ledger: Ledger, now: number): { first: string; last: string } {
  const last = weekKey(now)
  const recorded = Object.keys(ledger).filter((key) => key <= last).sort()
  return { first: recorded[0] && recorded[0] < last ? recorded[0] : last, last }
}

/** The song a SongStat came from, enough to play it again. */
export function songOf(stat: SongStat): NDSong {
  return {
    id: stat.id,
    title: stat.title,
    artist: stat.artist,
    artistId: stat.artistId,
    album: stat.album,
    albumId: stat.albumId,
    coverArt: stat.coverArt,
    duration: stat.duration
  }
}
