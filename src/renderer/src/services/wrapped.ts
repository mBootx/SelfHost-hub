import type { NDSong } from '@renderer/services/navidrome'

/**
 * The recording side of the weekly listening ledger, ported from mobile/src/services/wrapped.ts: weeks keyed by
 * their Monday (yyyy-mm-dd, local time) with seconds per day, per song, per hour and per song per day. The PC only
 * records and uploads it (no Wrapped screen), so none of the summary code is here. The shape must stay the one the
 * phone and the server use.
 */

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
  /** Times it was heard long enough to count (see countsAsPlay). */
  plays: number
}

export interface DaySong {
  s: number
  p: number
}

export interface WeekLog {
  /** The week's Monday, yyyy-mm-dd, in local time. */
  week: string
  /** Seconds heard on each day of the week, Monday first. */
  days: number[]
  songs: Record<string, SongStat>
  /** Seconds heard in each hour of each day (7 x 24, Monday first, local hours). */
  hours?: number[][]
  daySongs?: Record<string, DaySong>[]
}

export type Ledger = Record<string, WeekLog>

/** Weeks kept: a whole year and a bit, like the phone. */
export const KEEP_WEEKS = 54

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

export function weekKey(time: number): string {
  return keyOf(mondayOf(time))
}

function weekStart(key: string): Date {
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
    album: song.album,
    albumId: song.albumId,
    coverArt: song.coverArt,
    duration: song.duration
  }
  if (known) {
    Object.assign(known, details)
    return known
  }
  const stat: SongStat = { ...details, seconds: 0, plays: 0 }
  week.songs[song.id] = stat
  return stat
}

const emptyHours = (): number[][] => Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
const emptyDaySongs = (): Record<string, DaySong>[] => Array.from({ length: 7 }, () => ({}))

function daySongFor(week: WeekLog, day: number, id: string): DaySong {
  if (!week.daySongs) week.daySongs = emptyDaySongs()
  const songs = week.daySongs[day]
  return (songs[id] ??= { s: 0, p: 0 })
}

/** `seconds` of `song` heard just now (at `time`): counted in that hour, that day, that week. */
export function addListening(ledger: Ledger, song: NDSong, seconds: number, time: number): void {
  if (!(seconds > 0)) return
  const week = weekFor(ledger, time)
  const day = dayIndex(time)
  week.days[day] += seconds
  statFor(week, song).seconds += seconds
  if (!week.hours) week.hours = emptyHours()
  week.hours[day][new Date(time).getHours()] += seconds
  daySongFor(week, day, song.id).s += seconds
}

/** `song` was heard long enough to count as a play (at `time`). */
export function addPlay(ledger: Ledger, song: NDSong, time: number): void {
  const week = weekFor(ledger, time)
  statFor(week, song).plays += 1
  daySongFor(week, dayIndex(time), song.id).p += 1
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
    if (week.hours) {
      const hours = (target.hours ??= emptyHours())
      week.hours.forEach((day, d) => day.forEach((seconds, h) => (hours[d][h] += seconds)))
    }
    if (week.daySongs) {
      const daySongs = (target.daySongs ??= emptyDaySongs())
      week.daySongs.forEach((songs, d) => {
        for (const [id, song] of Object.entries(songs)) {
          const known = (daySongs[d][id] ??= { s: 0, p: 0 })
          known.s += song.s
          known.p += song.p
        }
      })
    }
  }
  return into
}

const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

function sanitizeHours(saved: unknown): number[][] | undefined {
  if (!Array.isArray(saved) || saved.length !== 7) return undefined
  if (!saved.every((day) => Array.isArray(day) && day.length === 24)) return undefined
  return saved.map((day: unknown[]) => day.map(finite))
}

function sanitizeDaySongs(saved: unknown): Record<string, DaySong>[] | undefined {
  if (!Array.isArray(saved) || saved.length !== 7) return undefined
  return saved.map((day) => {
    const songs: Record<string, DaySong> = {}
    if (day && typeof day === 'object') {
      for (const [id, song] of Object.entries(day as Record<string, DaySong>)) {
        if (song && Number.isFinite(song.s) && Number.isFinite(song.p)) songs[id] = { s: song.s, p: song.p }
      }
    }
    return songs
  })
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
    const log: WeekLog = { week: key, days: week.days.map((d) => (Number.isFinite(d) ? d : 0)), songs }
    const hours = sanitizeHours(week.hours)
    const daySongs = sanitizeDaySongs(week.daySongs)
    if (hours) log.hours = hours
    if (daySongs) log.daySongs = daySongs
    ledger[key] = log
  }
  return ledger
}
