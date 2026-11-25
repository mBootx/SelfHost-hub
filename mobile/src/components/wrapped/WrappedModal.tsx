import { useEffect, useMemo, useState } from 'react'
import { Modal, View, Text, Pressable, ScrollView, Share, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowLeft, CalendarRange, ChevronLeft, ChevronRight, Disc3, Flame, Headphones, Info, MicVocal, Play, Share2, X } from 'lucide-react-native'
import CoverImage from '@/components/CoverImage'
import Backdrop from '@/components/nowplaying/Backdrop'
import { useCoverPalette } from '@/hooks/useCoverPalette'
import { lookFor, type Look } from '@/services/coverColor'
import { useListeningStore } from '@/services/listeningLog'
import type { NavidromeClient } from '@/services/navidrome'
import {
  addDays,
  changeLabel,
  customPeriod,
  DAY_LETTERS,
  dayKey,
  dayRange,
  daySeconds,
  dayStart,
  durationLabel,
  formatWrappedShare,
  periodCurrent,
  periodKey,
  periodLabel,
  periodNoun,
  periodOf,
  shiftPeriod,
  songOf,
  summarize,
  summarizePeriod,
  type AlbumStat,
  type ArtistStat,
  type Ledger,
  type Period,
  type PeriodKind,
  type PeriodSummary,
  type SongStat
} from '@/services/wrapped'
import { useAppLockStore } from '@/store/appLockStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useWhatsNewStore } from '@/store/whatsNewStore'
import { useWrappedStore } from '@/store/wrappedStore'
import { radius, spacing } from '@/constants/theme'

const COUNT_UP_MS = 900
const CHART_HEIGHT = 120
const SOFT = 'rgba(255,255,255,0.08)'
const SOFTER = 'rgba(255,255,255,0.14)'
const TEXT_SECONDARY = 'rgba(255,255,255,0.72)'
const TEXT_MUTED = 'rgba(255,255,255,0.5)'
const BAR = 'rgba(255,255,255,0.28)'
const BAR_FUTURE = 'rgba(255,255,255,0.08)'

const TABS: { kind: PeriodKind; label: string }[] = [
  { kind: 'day', label: 'Jour' },
  { kind: 'week', label: 'Semaine' },
  { kind: 'month', label: 'Mois' },
  { kind: 'year', label: 'Année' },
  { kind: 'custom', label: 'Période' }
]

const MONTH_NAMES = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

function coverUrl(client: NavidromeClient | null, item: { coverArt?: string; albumId?: string; id?: string }, size: number): string | null {
  const id = item.coverArt || item.albumId || item.id
  return client && id ? client.coverArtUrl(id, size) : null
}

/** Counts up to `target` when it first shows (and for every other period): the big number of the page. */
function useCountUp(target: number, key: string): number {
  const [value, setValue] = useState(target)
  useEffect(() => {
    const start = Date.now()
    let frame = 0
    const step = (): void => {
      const t = Math.min(1, (Date.now() - start) / COUNT_UP_MS)
      setValue(Math.round(target * (1 - Math.pow(1 - t, 3))))
      if (t < 1) frame = requestAnimationFrame(step)
    }
    setValue(0)
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target, key])
  return value
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('fr-FR')} ${count > 1 ? many : one}`
}

function songMeta(song: SongStat): string {
  return `${plural(song.plays, 'écoute', 'écoutes')} · ${durationLabel(Math.round(song.seconds / 60))}`
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** "1 h 12 min", or "12 s" for the little bits an hour of a day can hold. */
function secondsLabel(seconds: number): string {
  if (seconds > 0 && seconds < 60) return `${Math.round(seconds)} s`
  return durationLabel(Math.round(seconds / 60))
}

/** Day, week, month, year, span: switching keeps the day being looked at (today while the period is under way). */
function PeriodTabs({ period, onPick, look }: { period: Period; onPick: (kind: PeriodKind) => void; look: Look }) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {TABS.map((tab) => {
        const on = tab.kind === period.kind
        return (
          <Pressable
            key={tab.kind}
            style={({ pressed }) => [styles.tab, on && { backgroundColor: look.accent }, pressed && styles.pressed]}
            onPress={() => onPick(tab.kind)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.tabText, on && { color: look.onAccent }]} numberOfLines={1}>
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/**
 * The chart of the period: hours of a day, days of a week or month, months of a year. Tapping a day or a month opens
 * it; tapping an hour shows what it holds.
 */
function Chart({ summary, look, onDrill }: { summary: PeriodSummary; look: Look; onDrill: (period: Period) => void }) {
  const [selected, setSelected] = useState<number | null>(null)
  const key = periodKey(summary.period)
  useEffect(() => setSelected(null), [key])

  const { buckets, busiest } = summary
  const most = Math.max(1, ...buckets.map((b) => b.seconds))
  const dense = buckets.length > 14
  const drillable = buckets.some((b) => b.drill)
  const shown = selected ?? busiest

  let caption: string
  if (shown === null) caption = drillable ? 'Rien écouté sur cette période' : 'Rien écouté ce jour-là'
  else if (shown === selected) caption = `${buckets[shown].label} : ${secondsLabel(buckets[shown].seconds)}`
  else caption = `Le plus écouté : ${buckets[shown].label}, ${secondsLabel(buckets[shown].seconds)}`

  return (
    <View style={styles.section}>
      <Text style={styles.chartCaption} numberOfLines={1}>
        {caption}
      </Text>
      <View style={[styles.chart, { gap: dense ? 2 : spacing.sm }]}>
        {buckets.map((bucket, i) => {
          const highlighted = i === shown
          const height = bucket.seconds > 0 ? Math.max(6, (bucket.seconds / most) * CHART_HEIGHT) : 3
          return (
            <Pressable
              key={bucket.key}
              style={styles.chartColumn}
              onPress={() => (bucket.drill ? onDrill(bucket.drill) : setSelected(i === selected ? null : i))}
              onLongPress={() => setSelected(i)}
              disabled={bucket.future && !bucket.drill}
              hitSlop={{ top: 12, bottom: 4 }}
              accessibilityRole={bucket.drill ? 'button' : 'text'}
              accessibilityLabel={`${bucket.label} : ${secondsLabel(bucket.seconds)}${bucket.drill ? '. Ouvrir' : ''}`}
            >
              <View style={styles.chartTrack}>
                <View
                  style={[
                    styles.chartBar,
                    dense && styles.chartBarDense,
                    { height, backgroundColor: bucket.future ? BAR_FUTURE : highlighted ? look.accent : BAR }
                  ]}
                />
              </View>
              <Text style={[styles.chartLetter, dense && styles.chartLetterDense, highlighted && { color: look.accent }]} numberOfLines={1}>
                {bucket.short || ' '}
              </Text>
            </Pressable>
          )
        })}
      </View>
      {drillable && <Text style={styles.chartHint}>Touchez une barre pour l'ouvrir · appui long pour sa durée</Text>}
      {summary.partialHours && <Text style={styles.chartHint}>Les heures ne sont enregistrées que depuis la mise à jour : une partie de ce jour n'y figure pas.</Text>}
    </View>
  )
}

/** A month of days to pick a span from: the first tap is one end, the second the other. */
function RangePicker({ initial, ledger, today, look, onDone, onCancel }: { initial: Period; ledger: Ledger; today: string; look: Look; onDone: (period: Period) => void; onCancel: () => void }) {
  const lastOfInitial = addDays(initial.end, -1) > today ? today : addDays(initial.end, -1)
  const [month, setMonth] = useState(() => {
    const d = dayStart(lastOfInitial)
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [from, setFrom] = useState<string | null>(initial.start)
  const [to, setTo] = useState<string | null>(lastOfInitial)

  const cells = useMemo(() => {
    const first = new Date(month)
    const lead = (first.getDay() + 6) % 7
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead)
    const list: { key: string; day: number; inMonth: boolean }[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      if (i >= 35 && d.getMonth() !== month.getMonth()) break
      list.push({ key: dayKey(d.getTime()), day: d.getDate(), inMonth: d.getMonth() === month.getMonth() })
    }
    return list
  }, [month])

  const pick = (day: string): void => {
    if (!from || to) {
      setFrom(day)
      setTo(null)
    } else {
      setTo(day)
    }
  }
  const lo = from && to ? (from < to ? from : to) : from
  const hi = from && to ? (from < to ? to : from) : from
  const preset = (days: number): void => onDone(customPeriod(addDays(today, -(days - 1)), today))
  const thisMonth = new Date(dayStart(today).getFullYear(), dayStart(today).getMonth(), 1)
  const canNext = month < thisMonth

  return (
    <View style={styles.picker}>
      <View style={styles.presets}>
        {[7, 30, 90].map((days) => (
          <Pressable key={days} style={({ pressed }) => [styles.preset, pressed && styles.pressed]} onPress={() => preset(days)} accessibilityRole="button">
            <Text style={styles.presetText}>{days} derniers jours</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.pickerHead}>
        <Pressable style={({ pressed }) => [styles.iconButtonSmall, pressed && styles.pressed]} onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} accessibilityLabel="Mois précédent" hitSlop={8}>
          <ChevronLeft size={18} color="#fff" />
        </Pressable>
        <Text style={styles.pickerMonth}>
          {MONTH_NAMES[month.getMonth()]} {month.getFullYear()}
        </Text>
        <Pressable
          style={({ pressed }) => [styles.iconButtonSmall, !canNext && styles.disabled, pressed && styles.pressed]}
          onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          disabled={!canNext}
          accessibilityLabel="Mois suivant"
          hitSlop={8}
        >
          <ChevronRight size={18} color="#fff" />
        </Pressable>
      </View>
      <View style={styles.grid}>
        {DAY_LETTERS.map((letter, i) => (
          <Text key={i} style={styles.gridHead}>
            {letter}
          </Text>
        ))}
        {cells.map((cell) => {
          const future = cell.key > today
          const inRange = !!lo && !!hi && cell.key >= lo && cell.key <= hi
          const end = cell.key === lo || cell.key === hi
          const heard = !future && daySeconds(ledger, cell.key) > 0
          return (
            <Pressable key={cell.key} style={styles.cell} onPress={() => pick(cell.key)} disabled={future} accessibilityLabel={cell.key} accessibilityState={{ selected: inRange, disabled: future }}>
              <View style={[styles.cellInner, inRange && { backgroundColor: SOFTER }, end && { backgroundColor: look.accent }]}>
                <Text style={[styles.cellText, !cell.inMonth && styles.cellOut, future && styles.cellFuture, end && { color: look.onAccent }]}>{cell.day}</Text>
                {heard && <View style={[styles.cellDot, { backgroundColor: end ? look.onAccent : look.accent }]} />}
              </View>
            </Pressable>
          )
        })}
      </View>
      <Text style={styles.pickerHint}>{!from ? 'Touchez le premier jour' : !to ? 'Puis le dernier jour (ou Afficher pour ce seul jour)' : `${periodLabel(customPeriod(from, to))}`}</Text>
      <View style={styles.pickerActions}>
        <Pressable style={({ pressed }) => [styles.pickerButton, pressed && styles.pressed]} onPress={onCancel} accessibilityRole="button">
          <Text style={styles.pickerButtonText}>Annuler</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.pickerButton, { backgroundColor: look.accent }, !from && styles.disabled, pressed && styles.pressed]}
          onPress={() => from && onDone(customPeriod(from, to ?? from))}
          disabled={!from}
          accessibilityRole="button"
        >
          <Text style={[styles.pickerButtonText, { color: look.onAccent }]}>Afficher</Text>
        </Pressable>
      </View>
    </View>
  )
}

function TopSong({ song, client, look, kicker, onPress }: { song: SongStat; client: NavidromeClient | null; look: Look; kicker: string; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.feature, { backgroundColor: look.card }, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${kicker} : ${song.title}, ${song.artist}. ${songMeta(song)}. Écouter`}
    >
      <CoverImage uri={coverUrl(client, song, 400)} style={styles.featureCover} iconSize={40} />
      <View style={styles.featureText}>
        <Text style={[styles.kicker, { color: look.accent }]}>{kicker}</Text>
        <Text style={styles.featureTitle} numberOfLines={2}>
          {song.title}
        </Text>
        <Text style={styles.featureArtist} numberOfLines={1}>
          {song.artist}
        </Text>
        <Text style={styles.featureMeta}>{songMeta(song)}</Text>
      </View>
    </Pressable>
  )
}

function SongRow({ song, rank, client, onPress }: { song: SongStat; rank: number; client: NavidromeClient | null; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Numéro ${rank} : ${song.title}, ${song.artist}. ${songMeta(song)}. Écouter`}
    >
      <Text style={styles.rank}>{rank}</Text>
      <CoverImage uri={coverUrl(client, song, 160)} style={styles.rowCover} iconSize={18} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {song.title}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {song.artist} · {plural(song.plays, 'écoute', 'écoutes')}
        </Text>
      </View>
    </Pressable>
  )
}

function ArtistRow({ artist, rank, client, look }: { artist: ArtistStat; rank: number; client: NavidromeClient | null; look: Look }) {
  const minutes = Math.round(artist.seconds / 60)
  return (
    <View style={styles.row} accessible accessibilityLabel={`Artiste numéro ${rank} : ${artist.name}, ${durationLabel(minutes)}`}>
      <Text style={[styles.rank, rank === 1 && { color: look.accent }]}>{rank}</Text>
      <CoverImage uri={coverUrl(client, artist, 160)} style={styles.artistCover} icon={MicVocal} iconSize={18} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {artist.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {durationLabel(minutes)} · {plural(artist.plays, 'écoute', 'écoutes')}
        </Text>
      </View>
    </View>
  )
}

function AlbumRow({ album, rank, client, look }: { album: AlbumStat; rank: number; client: NavidromeClient | null; look: Look }) {
  const minutes = Math.round(album.seconds / 60)
  return (
    <View style={styles.row} accessible accessibilityLabel={`Album numéro ${rank} : ${album.name}, ${album.artist}, ${durationLabel(minutes)}`}>
      <Text style={[styles.rank, rank === 1 && { color: look.accent }]}>{rank}</Text>
      <CoverImage uri={coverUrl(client, album, 160)} style={styles.rowCover} icon={Disc3} iconSize={18} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {album.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {album.artist} · {durationLabel(minutes)}
        </Text>
      </View>
    </View>
  )
}

/**
 * The Wrapped: minutes listened, the chart, the top songs and artists of a day, a week, a month, a year or any span
 * of days on this phone, in the colours of the period's favourite song. It pops up by itself every Monday from 10:00
 * for the week just ended (store/wrappedStore), and opens from Settings at any time. The tabs pick the kind of period,
 * the arrows move through them, a bar of the chart opens its day (or month), and the arrow at the top goes back.
 */
export default function WrappedModal() {
  const period = useWrappedStore((s) => s.period)
  const trail = useWrappedStore((s) => s.trail)
  const close = useWrappedStore((s) => s.close)
  const showPeriod = useWrappedStore((s) => s.showPeriod)
  const drill = useWrappedStore((s) => s.drill)
  const back = useWrappedStore((s) => s.back)
  const weeks = useListeningStore((s) => s.weeks)
  const client = useNavidromeStore((s) => s.client)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  // Waits for the app to be unlocked, and for the "Nouveautés" window to be closed: one window at a time.
  const unlocked = useAppLockStore((s) => s.status === 'unlocked')
  const whatsNewOpen = useWhatsNewStore((s) => !!s.notes && s.notes.length > 0)
  const insets = useSafeAreaInsets()
  const [picking, setPicking] = useState(false)

  const now = Date.now()
  const today = dayKey(now)
  const summary = useMemo(() => (period ? summarizePeriod(weeks, period, Date.now()) : null), [weeks, period])
  const range = useMemo(() => dayRange(weeks, Date.now()), [weeks, period])
  // The streak of weeks only means something for a week.
  const weekly = useMemo(() => (period?.kind === 'week' ? summarize(weeks, period.start) : null), [weeks, period])
  const hero = summary?.topSongs[0] ?? null
  const palette = useCoverPalette(hero ? coverUrl(client, hero, 300) : summary?.topArtists[0] ? coverUrl(client, summary.topArtists[0], 300) : null)
  const look = useMemo(() => lookFor(palette), [palette])
  const minutes = useCountUp(summary?.minutes ?? 0, period ? periodKey(period) : '')

  useEffect(() => {
    if (!period) setPicking(false)
  }, [period])

  if (!period || !summary) return null

  const current = periodCurrent(period, now)
  const noun = periodNoun(period)
  // A period under way against a whole one would always look like a drop: compared only once it is over.
  const change = !current ? changeLabel(summary.minutes, summary.previousMinutes, noun.before) : null
  const earlier = shiftPeriod(period, -1)
  const later = shiftPeriod(period, 1)
  const canGoBack = earlier.end > range.first
  const canGoForward = later.start <= today
  const parent = trail[trail.length - 1]
  const empty = summary.minutes === 0 && summary.topSongs.length === 0

  const pickKind = (kind: PeriodKind): void => {
    if (kind === 'custom') {
      setPicking(true)
      return
    }
    setPicking(false)
    // The day looked at: today while the period runs, else its last day.
    const anchor = current ? today : addDays(period.end, -1)
    showPeriod(periodOf(kind, anchor > today ? today : anchor))
  }

  const playFrom = (index: number): void => {
    if (summary.topSongs.length === 0) return
    playQueue(summary.topSongs.map(songOf), index)
    close()
  }

  return (
    <Modal visible={unlocked && !whatsNewOpen} animationType="slide" statusBarTranslucent onRequestClose={parent ? back : close}>
      <View style={styles.root}>
        <Backdrop look={look} />
        <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
          {parent ? (
            <Pressable style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]} onPress={back} accessibilityRole="button" accessibilityLabel={`Retour : ${periodLabel(parent, now)}`} hitSlop={8}>
              <ArrowLeft size={20} color="#fff" />
            </Pressable>
          ) : (
            <View style={styles.iconSpacer} />
          )}
          <View style={styles.topTitle}>
            <Text style={styles.overline}>{current ? `${noun.name} en cours` : `Votre récap ${noun.of}`}</Text>
            {parent && (
              <Text style={styles.backHint} numberOfLines={1}>
                depuis {periodLabel(parent, now)}
              </Text>
            )}
          </View>
          <Pressable style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]} onPress={close} accessibilityRole="button" accessibilityLabel="Fermer le récap" hitSlop={8}>
            <X size={20} color="#fff" />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing.xxl }]} showsVerticalScrollIndicator={false}>
          <PeriodTabs period={picking ? { ...period, kind: 'custom' } : period} onPick={pickKind} look={look} />

          <View style={styles.nav}>
            <Pressable
              style={({ pressed }) => [styles.iconButton, !canGoBack && styles.disabled, pressed && styles.pressed]}
              onPress={() => showPeriod(earlier)}
              disabled={!canGoBack}
              accessibilityRole="button"
              accessibilityLabel={`${noun.name} précédent${period.kind === 'week' || period.kind === 'year' || period.kind === 'custom' ? 'e' : ''}`}
              hitSlop={8}
            >
              <ChevronLeft size={22} color="#fff" />
            </Pressable>
            <Pressable style={({ pressed }) => [styles.navLabel, pressed && styles.pressed]} onPress={() => setPicking((was) => !was)} accessibilityRole="button" accessibilityLabel={`${periodLabel(period, now)}. Choisir des dates`}>
              <Text style={styles.periodLabel} numberOfLines={1}>
                {capitalize(periodLabel(period, now))}
              </Text>
              <CalendarRange size={16} color={TEXT_SECONDARY} />
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.iconButton, !canGoForward && styles.disabled, pressed && styles.pressed]}
              onPress={() => showPeriod(later)}
              disabled={!canGoForward}
              accessibilityRole="button"
              accessibilityLabel={`${noun.name} suivant${period.kind === 'week' || period.kind === 'year' || period.kind === 'custom' ? 'e' : ''}`}
              hitSlop={8}
            >
              <ChevronRight size={22} color="#fff" />
            </Pressable>
          </View>

          {picking && (
            <RangePicker
              initial={period}
              ledger={weeks}
              today={today}
              look={look}
              onCancel={() => setPicking(false)}
              onDone={(picked) => {
                setPicking(false)
                showPeriod(picked)
              }}
            />
          )}

          {empty ? (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Headphones size={28} color="#fff" />
              </View>
              <Text style={styles.emptyTitle}>{current ? "Rien écouté pour l'instant" : 'Rien écouté sur cette période'}</Text>
              <Text style={styles.emptyHint}>Le récap compte ce qui est écouté sur ce téléphone. Changez de période avec les onglets ou les flèches.</Text>
            </View>
          ) : (
            <>
              <View style={styles.heroBlock} accessible accessibilityLabel={`${summary.minutes} ${summary.minutes > 1 ? 'minutes' : 'minute'} d'écoute${change ? `, ${change}` : ''}`}>
                <Text style={styles.heroNumber}>{minutes.toLocaleString('fr-FR')}</Text>
                <Text style={styles.heroUnit}>{summary.minutes > 1 ? "minutes d'écoute" : "minute d'écoute"}</Text>
                {summary.minutes >= 60 && <Text style={styles.heroSub}>soit {durationLabel(summary.minutes)}</Text>}
                {change && (
                  <View style={[styles.chip, { borderColor: look.accent }]}>
                    <Text style={[styles.chipText, { color: look.accent }]}>{change}</Text>
                  </View>
                )}
              </View>

              <Chart summary={summary} look={look} onDrill={(next) => { setPicking(false); drill(next) }} />

              <View style={styles.stats}>
                {summary.dailyAverage !== null && (
                  <View style={styles.stat}>
                    <Text style={styles.statNumber}>{durationLabel(summary.dailyAverage)}</Text>
                    <Text style={styles.statLabel}>par jour</Text>
                  </View>
                )}
                <View style={styles.stat}>
                  <Text style={styles.statNumber}>{summary.songCount.toLocaleString('fr-FR')}</Text>
                  <Text style={styles.statLabel}>{summary.songCount > 1 ? 'titres' : 'titre'}</Text>
                </View>
                <View style={styles.stat}>
                  <Text style={styles.statNumber}>{summary.artistCount.toLocaleString('fr-FR')}</Text>
                  <Text style={styles.statLabel}>{summary.artistCount > 1 ? 'artistes' : 'artiste'}</Text>
                </View>
                {summary.albumCount > 0 && (
                  <View style={styles.stat}>
                    <Text style={styles.statNumber}>{summary.albumCount.toLocaleString('fr-FR')}</Text>
                    <Text style={styles.statLabel}>{summary.albumCount > 1 ? 'albums' : 'album'}</Text>
                  </View>
                )}
                <View style={styles.stat}>
                  <Text style={styles.statNumber}>{summary.plays.toLocaleString('fr-FR')}</Text>
                  <Text style={styles.statLabel}>{summary.plays > 1 ? 'écoutes' : 'écoute'}</Text>
                </View>
              </View>

              {summary.partial && (
                <View style={styles.notice}>
                  <Info size={16} color={TEXT_SECONDARY} />
                  <Text style={styles.noticeText}>
                    Avant la mise à jour, les titres n'étaient comptés que semaine par semaine : ceux de certains jours de cette période n'apparaissent pas ci-dessous. Les minutes, elles, sont justes.
                  </Text>
                </View>
              )}
              {weekly && weekly.streakWeeks > 1 && (
                <View style={styles.streakBadge}>
                  <Flame size={14} color={look.accent} />
                  <Text style={styles.streakText}>
                    {weekly.streakWeeks} semaines d&apos;écoute de suite · {weekly.activeDays}/7 jours actifs
                  </Text>
                </View>
              )}

              {summary.topSongs.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Top titres</Text>
                  <TopSong song={summary.topSongs[0]} client={client} look={look} kicker={`N° 1 ${noun.of}`} onPress={() => playFrom(0)} />
                  {summary.topSongs.slice(1).map((song, i) => (
                    <SongRow key={song.id} song={song} rank={i + 2} client={client} onPress={() => playFrom(i + 1)} />
                  ))}
                </View>
              )}

              {summary.topArtists.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Top artistes</Text>
                  {summary.topArtists.map((artist, i) => (
                    <ArtistRow key={artist.artistId || artist.name} artist={artist} rank={i + 1} client={client} look={look} />
                  ))}
                </View>
              )}

              {summary.topAlbums.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Top albums</Text>
                  {summary.topAlbums.map((album, i) => (
                    <AlbumRow key={album.albumId || `${album.name}-${album.artist}`} album={album} rank={i + 1} client={client} look={look} />
                  ))}
                </View>
              )}

              {summary.topSongs.length > 0 && (
                <Pressable
                  style={({ pressed }) => [styles.playButton, { backgroundColor: look.accent }, pressed && styles.pressed]}
                  onPress={() => playFrom(0)}
                  accessibilityRole="button"
                  accessibilityLabel={`Écouter le top ${noun.of}`}
                >
                  <Play size={18} color={look.onAccent} fill={look.onAccent} />
                  <Text style={[styles.playText, { color: look.onAccent }]}>Écouter le top {noun.of}</Text>
                </Pressable>
              )}

              <Pressable
                style={({ pressed }) => [styles.shareButton, pressed && styles.pressed]}
                onPress={() => {
                  const message = formatWrappedShare({ ...summary, streakWeeks: weekly?.streakWeeks }, periodLabel(period, now))
                  void Share.share({ message }).catch(() => {})
                }}
                accessibilityRole="button"
                accessibilityLabel="Partager ce récap"
              >
                <Share2 size={17} color="#fff" />
                <Text style={styles.shareText}>Partager ce récap</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingBottom: spacing.sm, gap: spacing.sm },
  iconButton: { width: 40, height: 40, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: SOFT },
  iconButtonSmall: { width: 32, height: 32, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: SOFT },
  iconSpacer: { width: 40, height: 40 },
  disabled: { opacity: 0.3 },
  pressed: { opacity: 0.6 },
  topTitle: { flex: 1, minWidth: 0, alignItems: 'center' },
  overline: { color: TEXT_SECONDARY, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  backHint: { color: TEXT_MUTED, fontSize: 12, marginTop: 2 },
  scroll: { paddingHorizontal: spacing.lg },
  tabs: { flexDirection: 'row', backgroundColor: SOFT, borderRadius: radius.full, padding: 4, gap: 2, marginTop: spacing.xs },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.sm, borderRadius: radius.full },
  tabText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  nav: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  navLabel: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
  periodLabel: { color: '#fff', fontSize: 16, fontWeight: '800', flexShrink: 1 },
  picker: { marginTop: spacing.md, backgroundColor: SOFT, borderRadius: radius.lg, padding: spacing.md },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.md },
  preset: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full, backgroundColor: SOFTER },
  presetText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  pickerHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  pickerMonth: { color: '#fff', fontSize: 15, fontWeight: '800', textTransform: 'capitalize' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  gridHead: { width: `${100 / 7}%`, textAlign: 'center', color: TEXT_MUTED, fontSize: 11, fontWeight: '700', paddingVertical: spacing.xs },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, padding: 2 },
  cellInner: { flex: 1, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  cellText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  cellOut: { color: TEXT_MUTED },
  cellFuture: { color: 'rgba(255,255,255,0.2)' },
  cellDot: { position: 'absolute', bottom: 4, width: 4, height: 4, borderRadius: 2 },
  pickerHint: { color: TEXT_SECONDARY, fontSize: 12, textAlign: 'center', marginTop: spacing.sm },
  pickerActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  pickerButton: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm + 2, borderRadius: radius.full, backgroundColor: SOFTER },
  pickerButtonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  heroBlock: { alignItems: 'center', paddingTop: spacing.xl, paddingBottom: spacing.sm },
  heroNumber: { color: '#fff', fontSize: 76, fontWeight: '900', letterSpacing: -2, fontVariant: ['tabular-nums'] },
  heroUnit: { color: '#fff', fontSize: 18, fontWeight: '700', marginTop: -spacing.xs },
  heroSub: { color: TEXT_SECONDARY, fontSize: 14, marginTop: spacing.xs },
  chip: { marginTop: spacing.md, borderWidth: 1, borderRadius: radius.full, paddingHorizontal: spacing.md, paddingVertical: 6 },
  chipText: { fontSize: 12, fontWeight: '700' },
  streakBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.sm,
    backgroundColor: SOFT,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 6
  },
  streakText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  section: { marginTop: spacing.xl },
  sectionTitle: { color: '#fff', fontSize: 20, fontWeight: '800', letterSpacing: -0.3, marginBottom: spacing.md },
  chartCaption: { color: '#fff', fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: spacing.md, textTransform: 'none' },
  chart: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  chartColumn: { flex: 1, alignItems: 'center', gap: spacing.xs },
  chartTrack: { height: CHART_HEIGHT, width: '100%', justifyContent: 'flex-end', alignItems: 'center' },
  chartBar: { width: '70%', maxWidth: 28, borderRadius: radius.sm },
  chartBarDense: { width: '100%', borderRadius: 2 },
  chartLetter: { color: TEXT_MUTED, fontSize: 10, fontWeight: '700' },
  // Wider than its thin bar: "30" or "18" overflows onto the bare neighbours, which have no label.
  chartLetterDense: { width: 28, textAlign: 'center' },
  chartHint: { color: TEXT_MUTED, fontSize: 11, textAlign: 'center', marginTop: spacing.sm },
  notice: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', backgroundColor: SOFT, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md },
  noticeText: { flex: 1, color: TEXT_SECONDARY, fontSize: 12, lineHeight: 17 },
  feature: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.sm },
  featureCover: { width: 112, height: 112, borderRadius: radius.md },
  featureText: { flex: 1, minWidth: 0 },
  kicker: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8 },
  featureTitle: { color: '#fff', fontSize: 19, fontWeight: '800', marginTop: spacing.xs, letterSpacing: -0.2 },
  featureArtist: { color: TEXT_SECONDARY, fontSize: 14, marginTop: 2 },
  featureMeta: { color: TEXT_MUTED, fontSize: 12, marginTop: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  rank: { width: 22, color: TEXT_MUTED, fontSize: 16, fontWeight: '800', textAlign: 'center', fontVariant: ['tabular-nums'] },
  rowCover: { width: 48, height: 48, borderRadius: radius.sm },
  artistCover: { width: 48, height: 48, borderRadius: radius.full },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  rowMeta: { color: TEXT_SECONDARY, fontSize: 12, marginTop: 2 },
  stats: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl },
  stat: { flex: 1, alignItems: 'center', backgroundColor: SOFT, borderRadius: radius.md, paddingVertical: spacing.md, paddingHorizontal: spacing.xs },
  statNumber: { color: '#fff', fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'], textAlign: 'center' },
  statLabel: { color: TEXT_SECONDARY, fontSize: 12, marginTop: 2 },
  playButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    marginTop: spacing.xl
  },
  playText: { fontSize: 15, fontWeight: '800' },
  shareButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: SOFT,
    paddingVertical: spacing.md,
    marginTop: spacing.md
  },
  shareText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  empty: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.xxl, gap: spacing.md },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: SOFT, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: '#fff', fontSize: 17, fontWeight: '700', textAlign: 'center' },
  emptyHint: { color: TEXT_SECONDARY, fontSize: 13, textAlign: 'center', lineHeight: 19 }
})
