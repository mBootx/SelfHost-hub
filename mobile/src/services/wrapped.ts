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

/** One song's listening in one day: seconds heard and plays, its details are in the week's `songs`. */
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
  /**
   * Seconds heard in each hour of each day (7 × 24, Monday first, local hours), and each song's listening on each day.
   * Recorded since version 3.3: weeks from before have neither, or have them for only part of a day (see dayComplete).
   */
  hours?: number[][]
  daySongs?: Record<string, DaySong>[]
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
/** Weeks kept on the phone: a whole year and a bit, for the year's recap. */
export const KEEP_WEEKS = 54
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

/** "6 – 12 octobre", "29 septembre – 5 octobre", "29 décembre 2025 – 4 janvier 2026": both days included. */
export function rangeLabel(start: Date, end: Date): string {
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()
  const sameYear = start.getFullYear() === end.getFullYear()
  if (sameMonth && start.getDate() === end.getDate()) return `${start.getDate()} ${MONTHS[start.getMonth()]}`
  const first = sameMonth ? `${start.getDate()}` : `${start.getDate()} ${MONTHS[start.getMonth()]}${sameYear ? '' : ` ${start.getFullYear()}`}`
  const last = `${end.getDate()} ${MONTHS[end.getMonth()]}${sameYear ? '' : ` ${end.getFullYear()}`}`
  return `${first} – ${last}`
}

export function weekLabel(key: string): string {
  const end = weekStart(key)
  end.setDate(end.getDate() + 6)
  return rangeLabel(weekStart(key), end)
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

/**
 * Whether a day's detail (its songs and hours) covers all of its listening: true for every day since the detail is
 * recorded, false for a day listened to before (its minutes are right, which songs they were is only known for the week).
 */
export function dayComplete(week: WeekLog | undefined, day: number): boolean {
  if (!week || week.days[day] <= 0) return true
  const songs = week.daySongs?.[day]
  if (!songs) return false
  let heard = 0
  for (const song of Object.values(songs)) heard += song.s
  return Math.abs(heard - week.days[day]) < 1
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

const copyWeek = (week: WeekLog): WeekLog => JSON.parse(JSON.stringify(week)) as WeekLog

/**
 * What the Wrapped shows when other devices share their listening: `own` and every ledger of `others` added together.
 * Nothing in the arguments is changed or shared with the result (a week held by one ledger only is still copied),
 * so the result can be kept while the ledgers go on changing.
 */
export function mergedView(own: Ledger, others: Ledger[]): Ledger {
  const result: Ledger = {}
  for (const ledger of [own, ...others]) {
    for (const [key, week] of Object.entries(ledger)) {
      const copy = copyWeek(week)
      if (result[key]) mergeLedgers({ [key]: result[key] }, { [key]: copy })
      else result[key] = copy
    }
  }
  return result
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

// --- The summary ---

export function totalSeconds(week: WeekLog | undefined): number {
  return week ? week.days.reduce((sum, seconds) => sum + seconds, 0) : 0
}

const byTitle = (a: { title?: string; name?: string }, b: { title?: string; name?: string }): number =>
  (a.title ?? a.name ?? '').localeCompare(b.title ?? b.name ?? '', 'fr')

function artistKey(song: SongStat): string {
  return song.artistId || song.artist.trim().toLowerCase()
}

interface Ranked {
  topSongs: SongStat[]
  topArtists: ArtistStat[]
  songCount: number
  artistCount: number
  plays: number
}

function rank(songs: SongStat[]): Ranked {
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

  return {
    topSongs,
    topArtists,
    songCount: songs.filter((song) => song.seconds >= MIN_ARTIST_SECONDS || song.plays > 0).length,
    artistCount: [...artists.values()].filter((artist) => artist.seconds >= MIN_ARTIST_SECONDS).length,
    plays: songs.reduce((sum, song) => sum + song.plays, 0)
  }
}

/** The Wrapped of `week`, or null when nothing was recorded that week. */
export function summarize(ledger: Ledger, week: string): WeeklyWrapped | null {
  const log = ledger[week]
  if (!log) return null
  const previous = ledger[shiftWeek(week, -1)]
  const most = Math.max(...log.days)
  return {
    week,
    start: weekStart(week),
    end: weekStart(shiftWeek(week, 1)),
    minutes: Math.round(totalSeconds(log) / 60),
    previousMinutes: previous ? Math.round(totalSeconds(previous) / 60) : null,
    days: log.days.map((seconds) => Math.round(seconds / 60)),
    busiestDay: most > 0 ? log.days.indexOf(most) : null,
    ...rank(Object.values(log.songs))
  }
}

/** "+18 %", "−40 %", or null when there is nothing to compare with. `than` names the period compared with. */
export function changeLabel(minutes: number, previousMinutes: number | null, than = "la semaine d'avant"): string | null {
  if (previousMinutes === null || previousMinutes <= 0) return null
  const change = Math.round(((minutes - previousMinutes) / previousMinutes) * 100)
  if (change === 0) return `autant que ${than}`
  return `${change > 0 ? '+' : '−'}${Math.abs(change)} % par rapport à ${than}`
}

// --- Periods: a day, a week, a month, a year, or any span of days ---

export type PeriodKind = 'day' | 'week' | 'month' | 'year' | 'custom'

/** A span of whole days, local time: from `start` (included) to `end` (excluded), both yyyy-mm-dd. */
export interface Period {
  kind: PeriodKind
  start: string
  end: string
}

const MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']
const MONTH_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']
/** A span longer than this is charted by week, one longer than CHART_MAX_WEEKS weeks by month. */
const CHART_MAX_DAYS = 31
const CHART_MAX_WEEKS = 16

/** The key of the day `time` falls in, local time. */
export function dayKey(time: number): string {
  return keyOf(new Date(time))
}

/** Midnight of a day, from its key. */
export const dayStart = weekStart

/** The day `days` after (or before) `key`. Days are counted, so a clock change doesn't matter. */
export function addDays(key: string, days: number): string {
  const date = dayStart(key)
  date.setDate(date.getDate() + days)
  return keyOf(date)
}

function addMonths(key: string, months: number): string {
  const date = dayStart(key)
  return keyOf(new Date(date.getFullYear(), date.getMonth() + months, 1))
}

/** Days from `a` to `b` (b − a), whole days whatever the clock does. */
export function daysBetween(a: string, b: string): number {
  return Math.round((dayStart(b).getTime() - dayStart(a).getTime()) / 86_400_000)
}

/** The day, week, month or year that `day` falls in. */
export function periodOf(kind: Exclude<PeriodKind, 'custom'>, day: string): Period {
  const date = dayStart(day)
  switch (kind) {
    case 'day':
      return { kind, start: day, end: addDays(day, 1) }
    case 'week': {
      const start = weekKey(date.getTime())
      return { kind, start, end: addDays(start, 7) }
    }
    case 'month': {
      const start = keyOf(new Date(date.getFullYear(), date.getMonth(), 1))
      return { kind, start, end: addMonths(start, 1) }
    }
    case 'year':
      return { kind, start: `${date.getFullYear()}-01-01`, end: `${date.getFullYear() + 1}-01-01` }
  }
}

/** The days from `first` to `last`, both included, in whichever order they were picked. */
export function customPeriod(first: string, last: string): Period {
  const [a, b] = first <= last ? [first, last] : [last, first]
  return { kind: 'custom', start: a, end: addDays(b, 1) }
}

/** The period `n` steps after (or before) this one: the next day, week, month, year, or the span of the same length. */
export function shiftPeriod(period: Period, n: number): Period {
  switch (period.kind) {
    case 'day':
    case 'week':
      return periodOf(period.kind, addDays(period.start, n * (period.kind === 'day' ? 1 : 7)))
    case 'month':
      return periodOf('month', addMonths(period.start, n))
    case 'year':
      return periodOf('year', addMonths(period.start, 12 * n))
    case 'custom': {
      const length = daysBetween(period.start, period.end)
      return { kind: 'custom', start: addDays(period.start, n * length), end: addDays(period.end, n * length) }
    }
  }
}

export function samePeriod(a: Period | null, b: Period | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.start === b.start && a.end === b.end
}

/** A string that names the period, for keys. */
export function periodKey(period: Period): string {
  return `${period.kind}:${period.start}:${period.end}`
}

/** "mardi 24 novembre", "16 – 22 novembre", "novembre 2026", "2026", "3 – 17 novembre". */
export function periodLabel(period: Period, now = Date.now()): string {
  const start = dayStart(period.start)
  const thisYear = new Date(now).getFullYear()
  switch (period.kind) {
    case 'day': {
      const today = dayKey(now)
      if (period.start === today) return "Aujourd'hui"
      if (period.start === addDays(today, -1)) return 'Hier'
      return `${DAY_NAMES[dayIndex(start.getTime())]} ${start.getDate()} ${MONTHS[start.getMonth()]}${start.getFullYear() === thisYear ? '' : ` ${start.getFullYear()}`}`
    }
    case 'week':
      return weekLabel(period.start)
    case 'month':
      return `${MONTHS[start.getMonth()]} ${start.getFullYear()}`
    case 'year':
      return String(start.getFullYear())
    case 'custom':
      return rangeLabel(start, dayStart(addDays(period.end, -1)))
  }
}

/** What the period is called in a sentence: "du jour", "de la semaine"... */
export function periodNoun(period: Period): { of: string; before: string; name: string } {
  switch (period.kind) {
    case 'day':
      return { of: 'du jour', before: 'la veille', name: 'jour' }
    case 'week':
      return { of: 'de la semaine', before: "la semaine d'avant", name: 'semaine' }
    case 'month':
      return { of: 'du mois', before: "le mois d'avant", name: 'mois' }
    case 'year':
      return { of: "de l'année", before: "l'année d'avant", name: 'année' }
    case 'custom':
      return { of: 'de la période', before: "la période d'avant", name: 'période' }
  }
}

/** The period is still under way at `now` (today is in it). */
export function periodCurrent(period: Period, now = Date.now()): boolean {
  const today = dayKey(now)
  return period.start <= today && today < period.end
}

/** The days one can look at: from the first one recorded (or today) to today. */
export function dayRange(ledger: Ledger, now = Date.now()): { first: string; last: string } {
  const last = dayKey(now)
  let first = last
  for (const [key, week] of Object.entries(ledger)) {
    const day = week.days.findIndex((seconds) => seconds > 0)
    if (day < 0) continue
    const candidate = addDays(key, day)
    if (candidate < first) first = candidate
  }
  return { first, last }
}

/** Seconds heard on `day`. */
export function daySeconds(ledger: Ledger, day: string): number {
  const week = ledger[weekKey(dayStart(day).getTime())]
  return week ? week.days[dayIndex(dayStart(day).getTime())] : 0
}

/** One bar of the chart. Tapping it opens `drill`, when it has one. */
export interface ChartBucket {
  key: string
  /** Under the bar, or '' to leave it bare (too many bars for every label). */
  short: string
  /** For the screen reader and the value shown above the chart. */
  label: string
  seconds: number
  drill: Period | null
  /** Not reached yet (later today, a day to come): drawn faint. */
  future: boolean
}

export interface PeriodSummary extends Ranked {
  period: Period
  minutes: number
  /** The period before's minutes, when anything was recorded in it. */
  previousMinutes: number | null
  /** Average minutes per day, over the days gone by (today counts): null for a single day. */
  dailyAverage: number | null
  buckets: ChartBucket[]
  /** The bar with the most listening, null when all are empty. */
  busiest: number | null
  /** Some of its days were listened to before songs were recorded day by day: their songs are left out. */
  partial: boolean
  /** The single day's hours were only partly recorded (listened to before hours were). */
  partialHours: boolean
}

function bucketsOf(ledger: Ledger, period: Period, now: number): { buckets: ChartBucket[]; partialHours: boolean } {
  const today = dayKey(now)
  if (period.kind === 'day') {
    const date = dayStart(period.start)
    const week = ledger[weekKey(date.getTime())]
    const day = dayIndex(date.getTime())
    const hours = week?.hours?.[day] ?? new Array<number>(24).fill(0)
    const heard = hours.reduce((sum, s) => sum + s, 0)
    const currentHour = period.start === today ? new Date(now).getHours() : period.start < today ? 24 : -1
    return {
      buckets: hours.map((seconds, h) => ({
        key: `${period.start}T${h}`,
        short: h % 6 === 0 ? String(h) : '',
        label: `${h} h – ${h + 1} h`,
        seconds,
        drill: null,
        future: h > currentHour
      })),
      partialHours: !!week && Math.abs(heard - week.days[day]) >= 60
    }
  }
  const length = daysBetween(period.start, period.end)
  const step: 'day' | 'week' | 'month' =
    period.kind === 'year' ? 'month' : period.kind === 'custom' && length > CHART_MAX_WEEKS * 7 ? 'month' : period.kind === 'custom' && length > CHART_MAX_DAYS ? 'week' : 'day'
  const buckets: ChartBucket[] = []
  // Weeks start on their Monday and months on their 1st, even when the period starts later in them.
  let cursor = step === 'week' ? weekKey(dayStart(period.start).getTime()) : step === 'month' ? addMonths(period.start, 0) : period.start
  while (cursor < period.end) {
    const next = step === 'day' ? addDays(cursor, 1) : step === 'week' ? addDays(cursor, 7) : addMonths(cursor, 1)
    // Only the part of the bucket inside the period counts (a span starting on a Wednesday, by week).
    const from = cursor < period.start ? period.start : cursor
    const to = next > period.end ? period.end : next
    let seconds = 0
    for (let day = from; day < to; day = addDays(day, 1)) seconds += daySeconds(ledger, day)
    const date = dayStart(cursor)
    const index = buckets.length
    let short: string
    let label: string
    let drill: Period
    if (step === 'day') {
      const weekday = dayIndex(date.getTime())
      short = period.kind === 'week' || length <= 7 ? DAY_LETTERS[weekday] : date.getDate() === 1 || index === 0 || date.getDate() % 5 === 0 ? String(date.getDate()) : ''
      label = `${DAY_NAMES[weekday]} ${date.getDate()} ${MONTHS[date.getMonth()]}`
      drill = periodOf('day', cursor)
    } else if (step === 'week') {
      short = index % 2 === 0 ? `${dayStart(from).getDate()}/${dayStart(from).getMonth() + 1}` : ''
      label = rangeLabel(dayStart(from), dayStart(addDays(to, -1)))
      drill = from === cursor && to === next ? periodOf('week', cursor) : { kind: 'custom', start: from, end: to }
    } else {
      // A year has its 12 letters; a long span of months, which may cross years, their short names.
      short = period.kind === 'year' ? MONTH_LETTERS[date.getMonth()] : MONTH_SHORT[date.getMonth()]
      label = `${MONTHS[date.getMonth()]} ${date.getFullYear()}`
      drill = periodOf('month', cursor)
    }
    buckets.push({ key: cursor, short, label, seconds, drill, future: from > today })
    cursor = next
  }
  return { buckets, partialHours: false }
}

/** What was listened to in `period`: the minutes, the chart, the top songs and artists. */
export function summarizePeriod(ledger: Ledger, period: Period, now = Date.now()): PeriodSummary {
  const songs = new Map<string, SongStat>()
  let partial = false
  let totalHeard = 0
  const add = (stat: SongStat, seconds: number, plays: number): void => {
    const known = songs.get(stat.id)
    if (known) {
      known.seconds += seconds
      known.plays += plays
    } else {
      songs.set(stat.id, { ...stat, seconds, plays })
    }
  }

  // Week by week: a week wholly inside the period counts as a whole (its songs are always known), the days of one
  // that is cut count from their own detail.
  for (let week = weekKey(dayStart(period.start).getTime()); week < period.end; week = shiftWeek(week, 1)) {
    const log = ledger[week]
    if (!log) continue
    const inside = [0, 1, 2, 3, 4, 5, 6].filter((d) => {
      const day = addDays(week, d)
      return day >= period.start && day < period.end
    })
    for (const d of inside) totalHeard += log.days[d]
    if (inside.length === 7) {
      for (const stat of Object.values(log.songs)) add(stat, stat.seconds, stat.plays)
      continue
    }
    for (const d of inside) {
      if (!dayComplete(log, d)) {
        partial = true
        continue
      }
      for (const [id, day] of Object.entries(log.daySongs?.[d] ?? {})) {
        const stat = log.songs[id]
        if (stat) add(stat, day.s, day.p)
      }
    }
  }

  const before = shiftPeriod(period, -1)
  let previousHeard = 0
  let previousKnown = false
  for (let week = weekKey(dayStart(before.start).getTime()); week < before.end; week = shiftWeek(week, 1)) {
    const log = ledger[week]
    if (!log) continue
    previousKnown = true
    for (let d = 0; d < 7; d++) {
      const day = addDays(week, d)
      if (day >= before.start && day < before.end) previousHeard += log.days[d]
    }
  }

  const { buckets, partialHours } = bucketsOf(ledger, period, now)
  let busiest: number | null = null
  buckets.forEach((bucket, i) => {
    if (bucket.seconds > 0 && (busiest === null || bucket.seconds > buckets[busiest].seconds)) busiest = i
  })
  const today = dayKey(now)
  const lastDay = period.end <= today ? period.end : addDays(today, 1)
  const daysGone = Math.max(0, daysBetween(period.start, lastDay))
  const minutes = Math.round(totalHeard / 60)

  return {
    period,
    minutes,
    previousMinutes: previousKnown ? Math.round(previousHeard / 60) : null,
    dailyAverage: period.kind === 'day' || daysGone === 0 ? null : Math.round(totalHeard / 60 / daysGone),
    buckets,
    busiest,
    partial,
    partialHours,
    ...rank([...songs.values()])
  }
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
