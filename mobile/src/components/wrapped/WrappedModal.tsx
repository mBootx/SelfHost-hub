import { useEffect, useMemo, useState } from 'react'
import { Modal, View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, ChevronRight, Headphones, MicVocal, Play, X } from 'lucide-react-native'
import CoverImage from '@/components/CoverImage'
import Backdrop from '@/components/nowplaying/Backdrop'
import { useCoverPalette } from '@/hooks/useCoverPalette'
import { lookFor, type Look } from '@/services/coverColor'
import { useListeningStore } from '@/services/listeningLog'
import type { NavidromeClient } from '@/services/navidrome'
import {
  changeLabel,
  DAY_LETTERS,
  DAY_NAMES,
  durationLabel,
  shiftWeek,
  songOf,
  summarize,
  weekKey,
  weekLabel,
  weekRange,
  type ArtistStat,
  type SongStat,
  type WeeklyWrapped
} from '@/services/wrapped'
import { useAppLockStore } from '@/store/appLockStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useWhatsNewStore } from '@/store/whatsNewStore'
import { useWrappedStore } from '@/store/wrappedStore'
import { radius, spacing } from '@/constants/theme'

const COUNT_UP_MS = 900
const CHART_HEIGHT = 72
const SOFT = 'rgba(255,255,255,0.08)'
const TEXT_SECONDARY = 'rgba(255,255,255,0.72)'
const TEXT_MUTED = 'rgba(255,255,255,0.5)'

function coverUrl(client: NavidromeClient | null, item: { coverArt?: string; albumId?: string; id?: string }, size: number): string | null {
  const id = item.coverArt || item.albumId || item.id
  return client && id ? client.coverArtUrl(id, size) : null
}

/** Counts up to `target` when it first shows (and for every other week): the big number of the page. */
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

function DayChart({ summary, look }: { summary: WeeklyWrapped; look: Look }) {
  const most = Math.max(1, ...summary.days)
  return (
    <View style={styles.section}>
      <View style={styles.chart} accessibilityRole="image" accessibilityLabel={summary.days.map((m, i) => `${DAY_NAMES[i]} ${m} ${m > 1 ? 'minutes' : 'minute'}`).join(', ')}>
        {summary.days.map((minutes, day) => (
          <View key={day} style={styles.chartColumn}>
            <View style={styles.chartTrack}>
              <View
                style={[
                  styles.chartBar,
                  {
                    height: Math.max(minutes > 0 ? 6 : 3, (minutes / most) * CHART_HEIGHT),
                    backgroundColor: day === summary.busiestDay ? look.accent : 'rgba(255,255,255,0.28)'
                  }
                ]}
              />
            </View>
            <Text style={[styles.chartLetter, day === summary.busiestDay && { color: look.accent }]}>{DAY_LETTERS[day]}</Text>
          </View>
        ))}
      </View>
      {summary.busiestDay !== null && (
        <Text style={styles.caption}>
          Votre grand jour : <Text style={styles.captionStrong}>{DAY_NAMES[summary.busiestDay]}</Text>, {durationLabel(summary.days[summary.busiestDay])}
        </Text>
      )}
    </View>
  )
}

function TopSong({ song, client, look, onPress }: { song: SongStat; client: NavidromeClient | null; look: Look; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.feature, { backgroundColor: look.card }, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Titre numéro un : ${song.title}, ${song.artist}. ${songMeta(song)}. Écouter`}
    >
      <CoverImage uri={coverUrl(client, song, 400)} style={styles.featureCover} iconSize={40} />
      <View style={styles.featureText}>
        <Text style={[styles.kicker, { color: look.accent }]}>N° 1 de la semaine</Text>
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

/**
 * The weekly Wrapped: minutes listened, the days, the top songs and artists of a week on this phone, in the colours
 * of the week's favourite song. It pops up by itself every Monday from 10:00 for the week just ended
 * (store/wrappedStore), and opens from Settings at any time; the arrows go back through the weeks kept.
 */
export default function WrappedModal() {
  const week = useWrappedStore((s) => s.week)
  const close = useWrappedStore((s) => s.close)
  const show = useWrappedStore((s) => s.show)
  const weeks = useListeningStore((s) => s.weeks)
  const client = useNavidromeStore((s) => s.client)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  // Waits for the app to be unlocked, and for the "Nouveautés" window to be closed: one window at a time.
  const unlocked = useAppLockStore((s) => s.status === 'unlocked')
  const whatsNewOpen = useWhatsNewStore((s) => !!s.notes && s.notes.length > 0)
  const insets = useSafeAreaInsets()

  const summary = useMemo(() => (week ? summarize(weeks, week) : null), [weeks, week])
  const now = Date.now()
  const range = useMemo(() => weekRange(weeks, now), [weeks, week])
  const current = week === weekKey(now)
  const hero = summary?.topSongs[0] ?? null
  const palette = useCoverPalette(hero ? coverUrl(client, hero, 300) : summary?.topArtists[0] ? coverUrl(client, summary.topArtists[0], 300) : null)
  const look = useMemo(() => lookFor(palette), [palette])
  const minutes = useCountUp(summary?.minutes ?? 0, week ?? '')
  // A week under way against a whole one would always look like a drop: compared only once it is over.
  const change = summary && !current ? changeLabel(summary.minutes, summary.previousMinutes) : null

  if (!week) return null

  const playFrom = (index: number): void => {
    if (!summary || summary.topSongs.length === 0) return
    playQueue(summary.topSongs.map(songOf), index)
    close()
  }

  const canGoBack = week > range.first
  const canGoForward = week < range.last

  return (
    <Modal visible={unlocked && !whatsNewOpen} animationType="slide" statusBarTranslucent onRequestClose={close}>
      <View style={styles.root}>
        <Backdrop look={look} />
        <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
          <Pressable
            style={({ pressed }) => [styles.iconButton, !canGoBack && styles.disabled, pressed && styles.pressed]}
            onPress={() => show(shiftWeek(week, -1))}
            disabled={!canGoBack}
            accessibilityRole="button"
            accessibilityLabel="Semaine précédente"
            hitSlop={8}
          >
            <ChevronLeft size={22} color="#fff" />
          </Pressable>
          <View style={styles.topTitle}>
            <Text style={styles.overline}>{current ? 'Cette semaine · en cours' : 'Votre récap de la semaine'}</Text>
            <Text style={styles.weekLabel}>{weekLabel(week)}</Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.iconButton, !canGoForward && styles.disabled, pressed && styles.pressed]}
            onPress={() => show(shiftWeek(week, 1))}
            disabled={!canGoForward}
            accessibilityRole="button"
            accessibilityLabel="Semaine suivante"
            hitSlop={8}
          >
            <ChevronRight size={22} color="#fff" />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.iconButton, styles.closeButton, pressed && styles.pressed]}
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Fermer le récap"
            hitSlop={8}
          >
            <X size={20} color="#fff" />
          </Pressable>
        </View>

        {!summary || (summary.minutes === 0 && summary.topSongs.length === 0) ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Headphones size={28} color="#fff" />
            </View>
            <Text style={styles.emptyTitle}>{current ? "Rien écouté pour l'instant cette semaine" : 'Rien écouté cette semaine-là'}</Text>
            <Text style={styles.emptyHint}>Le récap compte ce qui est écouté sur ce téléphone, du lundi au dimanche.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing.xxl }]} showsVerticalScrollIndicator={false}>
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

            <DayChart summary={summary} look={look} />

            {summary.topSongs.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Top titres</Text>
                <TopSong song={summary.topSongs[0]} client={client} look={look} onPress={() => playFrom(0)} />
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

            <View style={styles.stats}>
              <View style={styles.stat}>
                <Text style={styles.statNumber}>{summary.songCount.toLocaleString('fr-FR')}</Text>
                <Text style={styles.statLabel}>{summary.songCount > 1 ? 'titres' : 'titre'}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statNumber}>{summary.artistCount.toLocaleString('fr-FR')}</Text>
                <Text style={styles.statLabel}>{summary.artistCount > 1 ? 'artistes' : 'artiste'}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statNumber}>{summary.plays.toLocaleString('fr-FR')}</Text>
                <Text style={styles.statLabel}>{summary.plays > 1 ? 'écoutes' : 'écoute'}</Text>
              </View>
            </View>

            {summary.topSongs.length > 0 && (
              <Pressable
                style={({ pressed }) => [styles.playButton, { backgroundColor: look.accent }, pressed && styles.pressed]}
                onPress={() => playFrom(0)}
                accessibilityRole="button"
                accessibilityLabel="Écouter le top de la semaine"
              >
                <Play size={18} color={look.onAccent} fill={look.onAccent} />
                <Text style={[styles.playText, { color: look.onAccent }]}>Écouter le top de la semaine</Text>
              </Pressable>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingBottom: spacing.sm, gap: spacing.xs },
  iconButton: { width: 40, height: 40, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: SOFT },
  closeButton: { marginLeft: spacing.xs },
  disabled: { opacity: 0.3 },
  pressed: { opacity: 0.6 },
  topTitle: { flex: 1, minWidth: 0, alignItems: 'center' },
  overline: { color: TEXT_SECONDARY, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  weekLabel: { color: '#fff', fontSize: 15, fontWeight: '700', marginTop: 2 },
  scroll: { paddingHorizontal: spacing.lg },
  heroBlock: { alignItems: 'center', paddingTop: spacing.xl, paddingBottom: spacing.lg },
  heroNumber: { color: '#fff', fontSize: 76, fontWeight: '900', letterSpacing: -2, fontVariant: ['tabular-nums'] },
  heroUnit: { color: '#fff', fontSize: 18, fontWeight: '700', marginTop: -spacing.xs },
  heroSub: { color: TEXT_SECONDARY, fontSize: 14, marginTop: spacing.xs },
  chip: { marginTop: spacing.md, borderWidth: 1, borderRadius: radius.full, paddingHorizontal: spacing.md, paddingVertical: 6 },
  chipText: { fontSize: 12, fontWeight: '700' },
  section: { marginTop: spacing.xl },
  sectionTitle: { color: '#fff', fontSize: 20, fontWeight: '800', letterSpacing: -0.3, marginBottom: spacing.md },
  chart: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.sm },
  chartColumn: { flex: 1, alignItems: 'center', gap: spacing.xs },
  chartTrack: { height: CHART_HEIGHT, width: '100%', justifyContent: 'flex-end', alignItems: 'center' },
  chartBar: { width: '70%', maxWidth: 28, borderRadius: radius.sm },
  chartLetter: { color: TEXT_MUTED, fontSize: 12, fontWeight: '700' },
  caption: { color: TEXT_SECONDARY, fontSize: 13, textAlign: 'center', marginTop: spacing.md },
  captionStrong: { color: '#fff', fontWeight: '700' },
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
  stat: { flex: 1, alignItems: 'center', backgroundColor: SOFT, borderRadius: radius.md, paddingVertical: spacing.md },
  statNumber: { color: '#fff', fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.md },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: SOFT, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: '#fff', fontSize: 17, fontWeight: '700', textAlign: 'center' },
  emptyHint: { color: TEXT_SECONDARY, fontSize: 13, textAlign: 'center', lineHeight: 19 }
})
