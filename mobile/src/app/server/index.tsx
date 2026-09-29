import { useCallback, useEffect, useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, RefreshControl, ActivityIndicator, StyleSheet } from 'react-native'
import { useFocusEffect, useNavigation } from 'expo-router'
import { Music, FolderOpen, Download, Power, HardDrive, ScanLine, ShieldAlert } from 'lucide-react-native'
import SelfHostNative from '../../../modules/selfhost-native'
import { useIsOwner } from '@/hooks/useIsOwner'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useDowntifyStore } from '@/store/downtifyStore'
import { useToastStore } from '@/store/toastStore'
import { scanLibrary } from '@/services/libraryScan'
import { storage } from '@/services/storage'
import type { NowPlayingEntry, ScanStatus } from '@/services/navidrome'
import type { SourceUsage } from '@/services/filebrowser'
import CoverImage from '@/components/CoverImage'
import { EmptyState } from '@/components/Screen'
import { colors, radius, spacing } from '@/constants/theme'
import { ConnectionStatus } from '@/types'

type IconComponent = React.ComponentType<{ size?: number; color?: string }>

const REFRESH_MS = 30_000
/** After a wake-up call the screen checks this often, for this long, so it notices the server coming back. */
const WAKE_REFRESH_MS = 5000
const WAKE_WATCH_MS = 3 * 60 * 1000
const SCAN_REFRESH_MS = 2000
const WOL_PREF = 'server.wakeOnLan'

interface Health {
  /** 'off': not signed in to this service in the app, so there is nothing to check. */
  state: 'checking' | 'up' | 'down' | 'off'
  latencyMs?: number
  version?: string | null
  error?: string
}

interface WolTarget {
  mac: string
  broadcast: string
}

const CHECKING: Health = { state: 'checking' }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatBytes(bytes: number): string {
  const units = ['o', 'Ko', 'Mo', 'Go', 'To']
  let i = 0
  let value = bytes
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: value >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`
}

function formatCount(n: number): string {
  return n.toLocaleString('fr-FR')
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'jamais'
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (!Number.isFinite(minutes)) return 'inconnu'
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  return `il y a ${Math.round(hours / 24)} j`
}

/** A service the app isn't connected to: say why instead of pinging nothing. */
function idleHealth(status: ConnectionStatus, error: string | null): Health {
  if (status === 'connecting') return CHECKING
  if (status === 'error') return { state: 'down', error: error || undefined }
  return { state: 'off' }
}

async function timed(run: () => Promise<unknown>): Promise<Health> {
  const started = Date.now()
  try {
    await run()
    return { state: 'up', latencyMs: Date.now() - started }
  } catch (err) {
    return { state: 'down', error: errorMessage(err) }
  }
}

/** Services the app failed to reach get another try, e.g. once the server has woken up. */
function reconnectDownServices(): void {
  const navidrome = useNavidromeStore.getState()
  if (navidrome.status === 'error') navidrome.restoreSession()
  const filebrowser = useFileBrowserStore.getState()
  if (filebrowser.status === 'error') filebrowser.restoreSession()
  const downtify = useDowntifyStore.getState()
  if (downtify.status === 'error') downtify.restoreSession()
}

function ServiceRow({
  icon: Icon,
  iconColor,
  accent,
  name,
  health
}: {
  icon: IconComponent
  iconColor: string
  accent: string
  name: string
  health: Health
}) {
  const dot =
    health.state === 'up'
      ? colors.accent
      : health.state === 'down'
        ? colors.danger
        : health.state === 'checking'
          ? colors.warning
          : colors.textMuted
  const label =
    health.state === 'up'
      ? `En ligne - ${health.latencyMs} ms`
      : health.state === 'down'
        ? 'Injoignable'
        : health.state === 'checking'
          ? 'Vérification...'
          : 'Non connecté'
  return (
    <View style={styles.row}>
      <View style={[styles.iconWrap, { backgroundColor: accent }]}>
        <Icon size={20} color={iconColor} />
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle}>{name}</Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: dot }]} />
          <Text style={styles.statusText} numberOfLines={1}>
            {label}
            {health.state === 'up' && health.version ? ` - version ${health.version}` : ''}
          </Text>
        </View>
        {health.state === 'down' && !!health.error && (
          <Text style={styles.errorText} numberOfLines={2}>
            {health.error}
          </Text>
        )}
      </View>
    </View>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

function WakeOnLanCard({ onSent }: { onSent: () => void }) {
  const [target, setTarget] = useState<WolTarget>({ mac: '', broadcast: '' })
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const supported = typeof SelfHostNative?.sendWakeOnLan === 'function'

  useEffect(() => {
    storage.loadPref<WolTarget>(WOL_PREF).then((saved) => saved && setTarget(saved))
  }, [])

  const macValid = /^[0-9a-f]{12}$/i.test(target.mac.replace(/[\s:.-]/g, ''))

  async function wake(): Promise<void> {
    if (!SelfHostNative?.sendWakeOnLan) return
    const next = { mac: target.mac.trim(), broadcast: target.broadcast.trim() }
    setSending(true)
    setResult(null)
    await storage.savePref(WOL_PREF, next)
    const res = await SelfHostNative.sendWakeOnLan(next.mac, next.broadcast).catch((err) => ({
      ok: false,
      error: errorMessage(err)
    }))
    setSending(false)
    if (res.ok) {
      setResult({ ok: true, text: "Signal envoyé. Un serveur qui dormait répond en général en moins d'une minute." })
      onSent()
    } else {
      setResult({ ok: false, text: `Échec : ${res.error || 'erreur inconnue'}` })
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={[styles.iconWrap, { backgroundColor: colors.hover }]}>
          <Power size={20} color={colors.textSecondary} />
        </View>
        <View style={styles.rowInfo}>
          <Text style={styles.rowTitle}>Réveiller le serveur</Text>
          <Text style={styles.rowMeta}>
            {supported
              ? "Wake-on-LAN : depuis le même Wi-Fi que le serveur, si sa carte réseau l'autorise."
              : "Disponible après la prochaine mise à jour de l'application."}
          </Text>
        </View>
      </View>
      {supported && (
        <>
          <Text style={styles.fieldLabel}>Adresse MAC du serveur</Text>
          <TextInput
            style={[styles.input, styles.mono]}
            value={target.mac}
            onChangeText={(mac) => setTarget((t) => ({ ...t, mac }))}
            placeholder="AA:BB:CC:DD:EE:FF"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            accessibilityLabel="Adresse MAC du serveur"
          />
          <Text style={styles.fieldLabel}>Adresse de diffusion (facultatif)</Text>
          <TextInput
            style={[styles.input, styles.mono]}
            value={target.broadcast}
            onChangeText={(broadcast) => setTarget((t) => ({ ...t, broadcast }))}
            placeholder="ex. 192.168.1.255"
            placeholderTextColor={colors.textMuted}
            keyboardType="numbers-and-punctuation"
            autoCorrect={false}
            accessibilityLabel="Adresse de diffusion"
          />
          <Pressable
            style={({ pressed }) => [styles.primaryButton, (!macValid || sending) && styles.disabled, pressed && styles.pressed]}
            onPress={wake}
            disabled={!macValid || sending}
            accessibilityRole="button"
            accessibilityLabel="Réveiller le serveur"
          >
            {sending ? <ActivityIndicator color="#000" /> : <Text style={styles.primaryButtonText}>Réveiller</Text>}
          </Pressable>
          {result && <Text style={[styles.resultText, !result.ok && { color: colors.danger }]}>{result.text}</Text>}
        </>
      )}
    </View>
  )
}

export default function ServerScreen() {
  const navigation = useNavigation()
  const isOwner = useIsOwner()
  const navidromeClient = useNavidromeStore((s) => s.client)
  const navidromeStatus = useNavidromeStore((s) => s.status)
  const artists = useNavidromeStore((s) => s.artists)
  const filebrowserClient = useFileBrowserStore((s) => s.client)
  const filebrowserStatus = useFileBrowserStore((s) => s.status)
  const downtifyClient = useDowntifyStore((s) => s.client)
  const downtifyStatus = useDowntifyStore((s) => s.status)
  const downtifyQueue = useDowntifyStore((s) => s.queue)
  const showToast = useToastStore((s) => s.show)

  const [navidromeHealth, setNavidromeHealth] = useState<Health>(CHECKING)
  const [filebrowserHealth, setFilebrowserHealth] = useState<Health>(CHECKING)
  const [downtifyHealth, setDowntifyHealth] = useState<Health>(CHECKING)
  const [scan, setScan] = useState<ScanStatus | null>(null)
  const [nowPlaying, setNowPlaying] = useState<NowPlayingEntry[]>([])
  const [sources, setSources] = useState<SourceUsage[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [scanBusy, setScanBusy] = useState(false)
  const [wakingUntil, setWakingUntil] = useState(0)
  const [focused, setFocused] = useState(true)

  useEffect(() => {
    navigation.setOptions({ title: 'Serveur' })
  }, [])

  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )

  /** `reconnect` retries services that failed to connect; never on a status change, or a down server loops. */
  const refresh = useCallback(async (reconnect = false) => {
    if (reconnect) reconnectDownServices()
    const navidrome = useNavidromeStore.getState()
    const filebrowser = useFileBrowserStore.getState()
    const downtify = useDowntifyStore.getState()

    const checks: Promise<unknown>[] = []
    if (navidrome.client) {
      const client = navidrome.client
      checks.push(
        client
          .ping()
          .then(({ version, latencyMs }) => setNavidromeHealth({ state: 'up', latencyMs, version }))
          .catch((err) => setNavidromeHealth({ state: 'down', error: errorMessage(err) })),
        client.getScanStatus().then(setScan, () => {}),
        client.getNowPlaying().then(setNowPlaying, () => setNowPlaying([]))
      )
    } else {
      setNavidromeHealth(idleHealth(navidrome.status, navidrome.error))
    }
    if (filebrowser.client) {
      const client = filebrowser.client
      checks.push(timed(() => client.getSourcesUsage().then(setSources)).then(setFilebrowserHealth))
    } else {
      setFilebrowserHealth(idleHealth(filebrowser.status, filebrowser.error))
    }
    if (downtify.client) {
      const client = downtify.client
      checks.push(timed(() => client.testConnection()).then(setDowntifyHealth), downtify.refreshQueue())
    } else {
      setDowntifyHealth(idleHealth(downtify.status, downtify.error))
    }
    await Promise.allSettled(checks)
  }, [])

  // Also re-runs when a service connects or drops, so the rows never lag behind.
  useEffect(() => {
    if (isOwner) refresh()
  }, [isOwner, refresh, navidromeClient, navidromeStatus, filebrowserClient, filebrowserStatus, downtifyClient, downtifyStatus])

  const waking = wakingUntil > Date.now()
  useEffect(() => {
    if (!isOwner || !focused) return
    const id = setInterval(() => refresh(true), waking ? WAKE_REFRESH_MS : REFRESH_MS)
    return () => clearInterval(id)
  }, [isOwner, focused, refresh, waking])

  // Stop the fast checks once the server answers again, or after a few minutes.
  useEffect(() => {
    if (!waking) return
    if (navidromeHealth.state === 'up') {
      setWakingUntil(0)
      return
    }
    const id = setTimeout(() => setWakingUntil(0), wakingUntil - Date.now())
    return () => clearTimeout(id)
  }, [waking, wakingUntil, navidromeHealth.state])

  // Follows a running scan, whoever started it (this screen, a finished download, the server's schedule).
  useEffect(() => {
    if (!focused || (!scanBusy && !scan?.scanning)) return
    const id = setInterval(() => {
      useNavidromeStore
        .getState()
        .client?.getScanStatus()
        .then(setScan, () => {})
    }, SCAN_REFRESH_MS)
    return () => clearInterval(id)
  }, [focused, scanBusy, scan?.scanning])

  async function handlePullRefresh(): Promise<void> {
    setRefreshing(true)
    await refresh(true)
    setRefreshing(false)
  }

  async function startScan(): Promise<void> {
    setScanBusy(true)
    try {
      await scanLibrary()
      showToast('Bibliothèque à jour')
    } catch (err) {
      showToast(`Scan impossible : ${errorMessage(err)}`)
    } finally {
      setScanBusy(false)
      refresh()
    }
  }

  if (isOwner === null) {
    return <View style={styles.container} />
  }
  if (!isOwner) {
    return (
      <View style={styles.container}>
        <EmptyState icon={ShieldAlert} title="Réservé au propriétaire du serveur" />
      </View>
    )
  }

  const albumCount = artists.reduce((sum, a) => sum + (a.albumCount || 0), 0)
  const scanning = scanBusy || !!scan?.scanning
  const queueCounts = {
    downloading: downtifyQueue.filter((q) => q.status === 'downloading').length,
    queued: downtifyQueue.filter((q) => q.status === 'queued').length,
    done: downtifyQueue.filter((q) => q.status === 'done').length,
    failed: downtifyQueue.filter((q) => q.status === 'error').length
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handlePullRefresh} tintColor={colors.accent} colors={[colors.accent]} />
      }
    >
      {waking && <Text style={styles.wakingText}>En attente du réveil du serveur...</Text>}

      <Section title="Services">
        <ServiceRow icon={Music} iconColor="#000" accent={colors.accent} name="Navidrome" health={navidromeHealth} />
        <ServiceRow icon={FolderOpen} iconColor="#fff" accent={colors.filebrowser} name="FileBrowser" health={filebrowserHealth} />
        <ServiceRow icon={Download} iconColor="#fff" accent={colors.downtify} name="Downtify" health={downtifyHealth} />
      </Section>

      <Section title="Bibliothèque musicale">
        <View style={styles.statGrid}>
          <Stat label="Titres" value={scan ? formatCount(scan.count) : '-'} />
          <Stat label="Albums" value={artists.length ? formatCount(albumCount) : '-'} />
          <Stat label="Artistes" value={artists.length ? formatCount(artists.length) : '-'} />
          <Stat label="Dossiers" value={scan ? formatCount(scan.folderCount) : '-'} />
        </View>
        <View style={styles.row}>
          <View style={[styles.iconWrap, { backgroundColor: colors.hover }]}>
            {scanning ? <ActivityIndicator color={colors.accent} /> : <ScanLine size={20} color={colors.textSecondary} />}
          </View>
          <View style={styles.rowInfo}>
            <Text style={styles.rowTitle}>{scanning ? 'Scan en cours...' : scan ? `Dernier scan ${timeAgo(scan.lastScan)}` : 'Scan de la bibliothèque'}</Text>
            <Text style={styles.rowMeta}>Les téléchargements Downtify en lancent un automatiquement.</Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.pillButton, (scanning || !navidromeClient) && styles.disabled, pressed && styles.pressed]}
            onPress={startScan}
            disabled={scanning || !navidromeClient}
            accessibilityRole="button"
            accessibilityLabel="Scanner la bibliothèque"
          >
            <Text style={styles.pillText}>Scanner</Text>
          </Pressable>
        </View>
      </Section>

      {nowPlaying.length > 0 && navidromeClient && (
        <Section title="En écoute en ce moment">
          {nowPlaying.map((entry) => (
            <View key={`${entry.username}-${entry.playerName}-${entry.id}`} style={styles.row}>
              <CoverImage
                uri={entry.coverArt ? navidromeClient.coverArtUrl(entry.coverArt, 100) : null}
                style={styles.cover}
                iconSize={18}
              />
              <View style={styles.rowInfo}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {entry.title}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {entry.artist}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {entry.username}
                  {entry.playerName ? ` sur ${entry.playerName}` : ''}
                  {entry.minutesAgo > 0 ? `, il y a ${entry.minutesAgo} min` : ''}
                </Text>
              </View>
            </View>
          ))}
        </Section>
      )}

      {sources.length > 0 && (
        <Section title="Stockage">
          {sources.map((source) => {
            const barColor =
              source.usedPercentage >= 90 ? colors.danger : source.usedPercentage >= 75 ? colors.warning : colors.accent
            return (
              <View key={source.name} style={styles.card}>
                <View style={styles.storageHeader}>
                  <HardDrive size={16} color={colors.textSecondary} />
                  <Text style={[styles.rowTitle, styles.storageName]} numberOfLines={1}>
                    {source.name}
                  </Text>
                  <Text style={styles.rowMeta}>
                    {source.total ? `${formatBytes(source.used)} / ${formatBytes(source.total)}` : formatBytes(source.used)}
                  </Text>
                </View>
                {source.total > 0 && (
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { width: `${Math.min(100, source.usedPercentage)}%`, backgroundColor: barColor }]} />
                  </View>
                )}
                <Text style={styles.rowMeta}>
                  {source.total ? `${source.usedPercentage} % utilisés - ${formatBytes(source.total - source.used)} libres\n` : ''}
                  {formatCount(source.numFiles)} fichiers, {formatCount(source.numDirs)} dossiers
                </Text>
              </View>
            )
          })}
        </Section>
      )}

      {downtifyClient && (
        <Section title="Téléchargements Downtify">
          <View style={styles.statGrid}>
            <Stat label="En cours" value={formatCount(queueCounts.downloading)} />
            <Stat label="En attente" value={formatCount(queueCounts.queued)} />
            <Stat label="Terminés" value={formatCount(queueCounts.done)} />
            <Stat label="Échecs" value={formatCount(queueCounts.failed)} />
          </View>
        </Section>
      )}

      <Section title="Réveil à distance">
        <WakeOnLanCard onSent={() => setWakingUntil(Date.now() + WAKE_WATCH_MS)} />
      </Section>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.base },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xxl },
  section: { marginBottom: spacing.lg },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: spacing.sm
  },
  wakingText: { color: colors.warning, fontSize: 13, marginBottom: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm
  },
  iconWrap: { width: 40, height: 40, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  rowInfo: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 3 },
  dot: { width: 7, height: 7, borderRadius: radius.full },
  statusText: { flex: 1, color: colors.textSecondary, fontSize: 12 },
  errorText: { color: colors.danger, fontSize: 12, marginTop: 3 },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  stat: {
    flexBasis: '48%',
    flexGrow: 1,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    padding: spacing.md
  },
  statValue: { color: colors.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  cover: { width: 44, height: 44, borderRadius: radius.sm },
  card: { backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  storageHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  storageName: { flex: 1 },
  barTrack: { height: 8, borderRadius: radius.full, backgroundColor: colors.hover, overflow: 'hidden', marginTop: spacing.sm },
  barFill: { height: '100%', borderRadius: radius.full },
  fieldLabel: { color: colors.textSecondary, fontSize: 12, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 14,
    marginBottom: spacing.md
  },
  mono: { fontFamily: 'monospace' },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center'
  },
  primaryButtonText: { color: '#000', fontWeight: '700', fontSize: 14 },
  resultText: { color: colors.textSecondary, fontSize: 12, marginTop: spacing.sm },
  pillButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border
  },
  pillText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 }
})
