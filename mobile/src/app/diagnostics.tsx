import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from 'expo-router'
import * as Application from 'expo-application'
import * as Clipboard from 'expo-clipboard'
import * as Device from 'expo-device'
import { Copy, Trash2 } from 'lucide-react-native'
import { SectionTitle } from '@/components/Screen'
import { installedVersion } from '@/services/appUpdate'
import { BackupEnvironment, backupEnvironment, backupJournalSummary, retryFailedBackups, runCameraBackup } from '@/services/cameraBackup'
import { describeError, logEvent, LogLevel, useDiagnosticsStore } from '@/services/diagnostics'
import {
  ago,
  describePhase,
  findProblems,
  formatDateTime,
  formatStamp,
  hostOf,
  SCOPE_LABELS,
  ServerLine,
  ServiceIdentity,
  shareableReport,
  Snapshot
} from '@/services/diagnosticsReport'
import { vaultRootFor } from '@/services/photoVault'
import { SavedConnection, storage } from '@/services/storage'
import { useAppLockStore } from '@/store/appLockStore'
import { useCameraBackupStore } from '@/store/cameraBackupStore'
import { useDowntifyStore } from '@/store/downtifyStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useRemoteStore } from '@/store/remoteStore'
import { useToastStore } from '@/store/toastStore'
import { ConnectionStatus } from '@/types'
import { colors, layout, radius, spacing } from '@/constants/theme'

type ServiceId = 'navidrome' | 'filebrowser' | 'downtify'

const SERVICES: ServiceId[] = ['navidrome', 'filebrowser', 'downtify']
const SERVICE_NAMES: Record<ServiceId, string> = { navidrome: 'Navidrome', filebrowser: 'FileBrowser', downtify: 'Downtify' }
/** How many lines of the activity log the screen lists (the copied report has more). */
const LOG_LINES_SHOWN = 60

/** The result of testing one service. */
interface Check {
  /** How long the server took to answer; null when it didn't. */
  latencyMs: number | null
  /** What was wrong, when something was. */
  detail: string | null
}

type Tone = 'ok' | 'warn' | 'bad' | 'plain'

function toneColor(tone: Tone): string {
  if (tone === 'ok') return colors.accent
  if (tone === 'warn') return colors.warning
  if (tone === 'bad') return colors.danger
  return colors.text
}

function levelColor(level: LogLevel): string {
  if (level === 'error') return colors.danger
  if (level === 'warn') return colors.warning
  return colors.textSecondary
}

function statusWord(status: ConnectionStatus, configured: boolean): string {
  if (status === 'connected') return 'connecté'
  if (status === 'connecting') return 'connexion en cours'
  if (status === 'error') return 'erreur de connexion'
  if (status === 'unavailable') return 'injoignable'
  return configured ? 'déconnecté' : 'non configuré'
}

/** A server that answered with an error did answer: only a missing answer has no delay. */
function answered(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' && status > 0
}

export default function DiagnosticsScreen() {
  const navigation = useNavigation()
  const showToast = useToastStore((s) => s.show)

  const entries = useDiagnosticsStore((s) => s.entries)
  const clearLog = useDiagnosticsStore((s) => s.clear)

  const navidromeClient = useNavidromeStore((s) => s.client)
  const navidromeStatus = useNavidromeStore((s) => s.status)
  const navidromeError = useNavidromeStore((s) => s.error)
  const navidromeUser = useNavidromeStore((s) => s.username)
  const fileBrowserClient = useFileBrowserStore((s) => s.client)
  const fileBrowserStatus = useFileBrowserStore((s) => s.status)
  const fileBrowserError = useFileBrowserStore((s) => s.error)
  const downtifyClient = useDowntifyStore((s) => s.client)
  const downtifyStatus = useDowntifyStore((s) => s.status)
  const downtifyError = useDowntifyStore((s) => s.error)

  const backup = useCameraBackupStore()
  const lockMethod = useAppLockStore((s) => s.config.method)
  const remoteEnabled = useRemoteStore((s) => s.enabled)
  const remoteStatus = useRemoteStore((s) => s.status)
  const remoteError = useRemoteStore((s) => s.error)
  const remotePaired = useRemoteStore((s) => s.pairing !== null)

  const [connections, setConnections] = useState<Record<ServiceId, SavedConnection | null>>({ navidrome: null, filebrowser: null, downtify: null })
  const [environment, setEnvironment] = useState<BackupEnvironment | null>(null)
  const [journal, setJournal] = useState<Awaited<ReturnType<typeof backupJournalSummary>> | null>(null)
  const [checks, setChecks] = useState<Partial<Record<ServiceId, Check>>>({})
  const [testing, setTesting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    navigation.setOptions({ title: 'Diagnostic' })
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const [navidrome, filebrowser, downtify, env, summary] = await Promise.all([
        storage.loadConnection('navidrome').catch(() => null),
        storage.loadConnection('filebrowser').catch(() => null),
        storage.loadConnection('downtify').catch(() => null),
        backupEnvironment(),
        backupJournalSummary().catch(() => null)
      ])
      setConnections({ navidrome, filebrowser, downtify })
      setEnvironment(env)
      setJournal(summary)
      // The background task writes into the same record from its own copy of the app.
      await useDiagnosticsStore.getState().load()
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // What the screen knows about each service, whether or not it was tested.
  const live: Record<ServiceId, { configured: boolean; status: ConnectionStatus; error: string | null; account: string | null }> = {
    navidrome: { configured: connections.navidrome !== null, status: navidromeStatus, error: navidromeError, account: navidromeUser ?? connections.navidrome?.username ?? null },
    filebrowser: {
      configured: connections.filebrowser !== null,
      status: fileBrowserStatus,
      error: fileBrowserError,
      account: fileBrowserClient?.getAccountName() ?? connections.filebrowser?.username ?? null
    },
    downtify: { configured: connections.downtify !== null, status: downtifyStatus, error: downtifyError, account: null }
  }

  const now = Date.now()
  const remoteStatusWord = !remoteEnabled ? 'désactivé' : remoteStatus === 'connected' ? 'connecté au PC' : remoteStatus === 'connecting' ? 'recherche du PC' : remoteStatus === 'error' ? 'erreur' : 'non connecté'

  const rows = SERVICES.map((id) => {
    const info = live[id]
    const check = checks[id]
    const state = info.status === 'connected' ? 'ok' : info.configured || info.status === 'error' ? 'down' : 'off'
    const line: ServerLine = {
      name: SERVICE_NAMES[id],
      state,
      status: statusWord(info.status, info.configured),
      account: info.account ?? undefined,
      host: connections[id] ? hostOf(connections[id]!.url) : undefined
    }
    if (check) {
      line.latencyMs = check.latencyMs
      if (check.detail) line.detail = check.detail
    } else if (state === 'down' && info.error) {
      line.detail = info.error
    }
    return { id, line, check }
  })
  const servers: ServerLine[] = rows.map((row) => row.line)

  let destination: string | null = null
  if (fileBrowserClient) {
    try {
      destination = `${vaultRootFor(backup.settings.folder, fileBrowserClient.getAccountName())}/AAAA/MM`
    } catch {
      destination = null
    }
  }

  const snapshot: Snapshot = {
    now,
    app: {
      version: installedVersion(),
      build: Application.nativeBuildVersion ?? '?',
      device: [Device.manufacturer, Device.modelName, Device.osName && Device.osVersion ? `${Device.osName} ${Device.osVersion}` : null].filter(Boolean).join(' ') || 'inconnu',
      lock: lockMethod !== 'none'
    },
    servers,
    backup: {
      enabled: backup.settings.enabled,
      phase: backup.phase,
      destination,
      pending: backup.pending,
      uploaded: backup.uploadedTotal,
      gaveUp: backup.gaveUp,
      lastSuccessAt: backup.lastSuccessAt,
      lastCheckAt: backup.lastCheckAt,
      error: backup.error,
      cursor: journal?.cursor ?? null,
      rememberedSent: journal?.rememberedSent ?? null,
      failing: journal?.failing ?? null,
      permission: environment?.permission ?? 'inconnu',
      network: environment?.network ?? 'inconnu',
      charging: environment?.charging ?? null,
      wifiOnly: backup.settings.wifiOnly
    },
    remote: { enabled: remoteEnabled, status: remoteStatusWord, failed: remoteStatus === 'error', paired: remotePaired, error: remoteError },
    entries
  }
  const problems = findProblems(snapshot)

  async function probe(id: ServiceId): Promise<Check> {
    const started = Date.now()
    try {
      if (id === 'navidrome') await navidromeClient!.testConnection()
      else if (id === 'downtify') await downtifyClient!.testConnection()
      else {
        const status = await fileBrowserClient!.probe()
        if (status === 0) return { latencyMs: null, detail: 'le serveur ne répond pas' }
        if (status === 401 || status === 403) return { latencyMs: Date.now() - started, detail: "la session n'est plus valide : reconnectez-vous" }
        if (status >= 500) return { latencyMs: Date.now() - started, detail: `erreur du serveur (${status})` }
      }
      return { latencyMs: Date.now() - started, detail: null }
    } catch (err) {
      return { latencyMs: answered(err) ? Date.now() - started : null, detail: describeError(err) }
    }
  }

  async function testAll(): Promise<void> {
    const tested = SERVICES.filter((id) => (id === 'navidrome' ? navidromeClient : id === 'filebrowser' ? fileBrowserClient : downtifyClient))
    if (tested.length === 0) {
      showToast("Aucun service n'est connecté")
      return
    }
    setTesting(true)
    try {
      const results = await Promise.all(tested.map(async (id) => [id, await probe(id)] as const))
      setChecks((previous) => {
        const next = { ...previous }
        for (const [id, check] of results) next[id] = check
        return next
      })
      for (const [id, check] of results) {
        const outcome = check.latencyMs === null ? 'ne répond pas' : `${check.latencyMs} ms`
        logEvent('connection', `Test ${SERVICE_NAMES[id]} : ${outcome}${check.detail ? ` (${check.detail})` : ''}`, check.latencyMs === null || check.detail ? 'warn' : 'info')
      }
    } finally {
      setTesting(false)
    }
  }

  const identities: ServiceIdentity[] = SERVICES.map((id) => ({
    label: SERVICE_NAMES[id],
    url: connections[id]?.url,
    accounts: [live[id].account, connections[id]?.username]
  }))

  async function copyReport(): Promise<void> {
    await Clipboard.setStringAsync(shareableReport(snapshot, identities))
    showToast('Rapport copié : adresses et noms de compte masqués')
  }

  function confirmClear(): void {
    Alert.alert("Effacer le journal d'activité ?", 'Le rapport ne contiendra plus les événements passés.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Effacer', style: 'destructive', onPress: clearLog }
    ])
  }

  const shown = entries.slice(-LOG_LINES_SHOWN).reverse()
  const backupTone: Tone = !backup.settings.enabled ? 'plain' : backup.phase === 'error' || backup.phase === 'no-server' || backup.phase === 'no-permission' ? 'bad' : backup.gaveUp > 0 ? 'warn' : 'ok'

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.scroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} colors={[colors.accent]} />}
    >
      <View style={styles.card}>
        {problems.length === 0 ? (
          <View style={styles.summaryRow}>
            <View style={[styles.dot, { backgroundColor: colors.accent }]} />
            <Text style={styles.summaryText}>Aucun problème détecté</Text>
          </View>
        ) : (
          <>
            <Text style={styles.summaryTitle}>
              {problems.length} point{problems.length > 1 ? 's' : ''} à regarder
            </Text>
            {problems.map((problem, index) => (
              <View key={index} style={styles.summaryRow}>
                <View style={[styles.dot, { backgroundColor: colors.warning }]} />
                <Text style={styles.summaryText}>{problem}</Text>
              </View>
            ))}
          </>
        )}
      </View>

      <SectionTitle>Application</SectionTitle>
      <View style={styles.card}>
        <Line label="Version" value={`${snapshot.app.version} (build ${snapshot.app.build})`} />
        <Line label="Appareil" value={snapshot.app.device} />
        <Line label="Verrouillage" value={snapshot.app.lock ? 'activé' : 'désactivé'} />
      </View>

      <View style={styles.gap}>
        <SectionTitle>Serveurs</SectionTitle>
      </View>
      {rows.map(({ line: server, check }) => {
        const tone: Tone = server.state === 'ok' ? (check && (check.latencyMs === null || check.detail) ? 'warn' : 'ok') : server.state === 'down' ? 'bad' : 'plain'
        return (
          <View key={server.name} style={styles.card}>
            <View style={styles.serverHead}>
              <View style={[styles.dot, { backgroundColor: tone === 'plain' ? colors.textMuted : toneColor(tone) }]} />
              <Text style={styles.serverName}>{server.name}</Text>
              <Text style={styles.serverStatus}>{server.status}</Text>
            </View>
            {server.host ? <Line label="Adresse" value={server.host} /> : null}
            {server.account ? <Line label="Compte" value={server.account} /> : null}
            {check ? (
              <Line
                label="Test"
                tone={tone}
                value={check.latencyMs === null ? 'ne répond pas' : `répond en ${check.latencyMs} ms`}
                extra={check.detail}
              />
            ) : server.detail ? (
              <Line label="Dernière erreur" tone="bad" value={server.detail} />
            ) : null}
          </View>
        )
      })}
      <Pressable
        style={({ pressed }) => [styles.button, (pressed || testing) && styles.pressed]}
        onPress={() => void testAll()}
        disabled={testing}
        accessibilityRole="button"
        accessibilityLabel="Tester les connexions"
      >
        {testing ? <ActivityIndicator color={colors.text} /> : <Text style={styles.buttonText}>Tester les connexions</Text>}
      </Pressable>

      <View style={styles.gap}>
        <SectionTitle>Sauvegarde des photos</SectionTitle>
      </View>
      <View style={styles.card}>
        <Line label="État" tone={backupTone} value={backup.settings.enabled ? describePhase(backup.phase) : 'désactivée'} extra={backup.settings.enabled ? backup.error : null} />
        {backup.settings.enabled ? (
          <>
            <Line label="Destination" value={destination ?? '—'} />
            <Line
              label="Fichiers"
              value={`${backup.pending ?? '?'} en attente · ${backup.uploadedTotal} envoyés${backup.gaveUp > 0 ? ` · ${backup.gaveUp} refusés` : ''}`}
            />
            <Line label="Dernier envoi" value={ago(backup.lastSuccessAt, now)} />
            <Line label="Dernière vérification" value={ago(backup.lastCheckAt, now)} />
            <Line
              label="Téléphone"
              tone={environment?.permission === 'refusé' ? 'bad' : environment?.permission === 'limité' ? 'warn' : 'plain'}
              value={`photos : ${environment?.permission ?? '…'} · réseau : ${environment?.network ?? '…'}${backup.settings.wifiOnly ? ' (Wi-Fi uniquement)' : ''} · chargeur : ${
                environment?.charging == null ? '?' : environment.charging ? 'branché' : 'non'
              }`}
            />
            {journal ? (
              <Line
                label="Journal"
                value={`${journal.rememberedSent} fichiers retenus · ${journal.failing} en échec${journal.cursor > 0 ? ` · à jour jusqu'au ${formatDateTime(journal.cursor)}` : ''}`}
              />
            ) : null}
            {journal && journal.gaveUp.length > 0 ? (
              <View style={styles.gaveUpList}>
                {journal.gaveUp.slice(0, 6).map((file) => (
                  <Text key={file.name} style={styles.gaveUpItem} numberOfLines={2}>
                    {file.name} : {file.message}
                  </Text>
                ))}
                {journal.gaveUp.length > 6 ? <Text style={styles.gaveUpItem}>… et {journal.gaveUp.length - 6} autres</Text> : null}
              </View>
            ) : null}
            <View style={styles.buttonRow}>
              <Pressable
                style={({ pressed }) => [styles.pill, (pressed || backup.phase === 'running') && styles.pressed]}
                onPress={() => runCameraBackup()}
                disabled={backup.phase === 'running'}
                accessibilityRole="button"
                accessibilityLabel="Sauvegarder maintenant"
              >
                <Text style={styles.pillText}>Sauvegarder maintenant</Text>
              </Pressable>
              {backup.gaveUp > 0 ? (
                <Pressable
                  style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
                  onPress={() => retryFailedBackups()}
                  accessibilityRole="button"
                  accessibilityLabel="Réessayer les fichiers refusés"
                >
                  <Text style={styles.pillText}>Réessayer les refusés</Text>
                </Pressable>
              ) : null}
            </View>
          </>
        ) : null}
      </View>

      <View style={styles.gap}>
        <SectionTitle>Contrôle à distance</SectionTitle>
      </View>
      <View style={styles.card}>
        <Line
          label="État"
          tone={remoteEnabled && remoteStatus === 'error' ? 'bad' : 'plain'}
          value={!remoteEnabled ? 'désactivé' : remoteStatus === 'connected' ? 'connecté au PC' : remoteStatus === 'connecting' ? 'recherche du PC' : remoteStatus === 'error' ? 'erreur' : 'non connecté'}
          extra={remoteEnabled ? remoteError : null}
        />
        <Line label="Appairage" value={remotePaired ? 'ce téléphone est appairé' : 'pas appairé'} />
      </View>

      <View style={styles.gap}>
        <SectionTitle>Journal d&apos;activité</SectionTitle>
      </View>
      <View style={styles.card}>
        {shown.length === 0 ? (
          <Text style={styles.empty}>Rien à signaler pour le moment.</Text>
        ) : (
          shown.map((entry, index) => (
            <View key={`${entry.t}-${index}`} style={styles.logRow}>
              <Text style={styles.logTime}>{formatStamp(entry.t, now)}</Text>
              <Text style={[styles.logText, { color: levelColor(entry.level) }]} selectable>
                <Text style={styles.logScope}>{SCOPE_LABELS[entry.scope] ?? entry.scope} </Text>
                {entry.message}
              </Text>
            </View>
          ))
        )}
      </View>

      <Pressable
        style={({ pressed }) => [styles.button, styles.primary, pressed && styles.pressed]}
        onPress={() => void copyReport()}
        accessibilityRole="button"
        accessibilityLabel="Copier le rapport"
      >
        <Copy size={16} color="#000" />
        <Text style={[styles.buttonText, styles.primaryText]}>Copier le rapport</Text>
      </Pressable>
      <Text style={styles.note}>
        Le rapport reprend cet écran et le journal. Les adresses des serveurs et les noms de compte y sont remplacés par des repères : il peut
        être envoyé tel quel.
      </Text>
      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        onPress={confirmClear}
        disabled={entries.length === 0}
        accessibilityRole="button"
        accessibilityLabel="Effacer le journal"
      >
        <Trash2 size={16} color={colors.danger} />
        <Text style={[styles.buttonText, { color: colors.danger }]}>Effacer le journal</Text>
      </Pressable>
    </ScrollView>
  )
}

/** One fact: a label, its value, and under it - when there is one - what went wrong. */
function Line({ label, value, tone = 'plain', extra }: { label: string; value: string; tone?: Tone; extra?: string | null }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <View style={styles.lineBody}>
        <Text style={[styles.lineValue, { color: toneColor(tone) }]} selectable>
          {value}
        </Text>
        {extra ? (
          <Text style={styles.lineExtra} selectable>
            {extra}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.base },
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  gap: { marginTop: spacing.lg },
  card: { backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, gap: spacing.sm },
  summaryTitle: { color: colors.warning, fontSize: 14, fontWeight: '700' },
  summaryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  summaryText: { flex: 1, color: colors.text, fontSize: 13, lineHeight: 18 },
  dot: { width: 8, height: 8, borderRadius: radius.full, marginTop: 5 },
  serverHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  serverName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  serverStatus: { flex: 1, textAlign: 'right', color: colors.textSecondary, fontSize: 12 },
  line: { flexDirection: 'row', gap: spacing.md },
  lineLabel: { width: 112, color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  lineBody: { flex: 1, minWidth: 0 },
  lineValue: { fontSize: 13, lineHeight: 18 },
  lineExtra: { color: colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 2 },
  gaveUpList: { gap: 2, paddingLeft: 112 + spacing.md },
  gaveUpItem: { color: colors.textSecondary, fontSize: 11, lineHeight: 16 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  pill: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border },
  pillText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 44,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.sm
  },
  buttonText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent, marginTop: spacing.lg },
  primaryText: { color: '#000', fontWeight: '700' },
  pressed: { opacity: 0.6 },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: spacing.sm, textAlign: 'center' },
  empty: { color: colors.textMuted, fontSize: 12 },
  logRow: { flexDirection: 'row', gap: spacing.sm },
  logTime: { width: 72, color: colors.textMuted, fontSize: 11, lineHeight: 16, fontVariant: ['tabular-nums'] },
  logText: { flex: 1, fontSize: 12, lineHeight: 16 },
  logScope: { color: colors.textMuted, fontWeight: '700' }
})
