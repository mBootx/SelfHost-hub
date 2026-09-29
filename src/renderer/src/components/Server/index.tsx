import { useCallback, useEffect, useState } from 'react'
import { Music, FolderOpen, Download, RefreshCw, Power, HardDrive, ScanLine, Radio } from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useFileBrowserStore } from '@renderer/store/filebrowserStore'
import { useDowntifyStore } from '@renderer/store/downtifyStore'
import { useToastStore } from '@renderer/store/toastStore'
import { scanLibrary } from '@renderer/services/libraryScan'
import { storage } from '@renderer/services/storage'
import type { NowPlayingEntry, ScanStatus } from '@renderer/services/navidrome'
import type { SourceUsage } from '@renderer/services/filebrowser'
import type { ConnectionStatus } from '@renderer/types'

type IconComponent = typeof Music

const REFRESH_MS = 30_000
/** After a wake-up call the page checks this often, for this long, so it notices the server coming back. */
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
  const started = performance.now()
  try {
    await run()
    return { state: 'up', latencyMs: Math.round(performance.now() - started) }
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

function ServiceCard({ icon: Icon, accent, name, health }: { icon: IconComponent; accent: string; name: string; health: Health }): JSX.Element {
  const dot =
    health.state === 'up'
      ? 'bg-accent'
      : health.state === 'down'
        ? 'bg-red-500'
        : health.state === 'checking'
          ? 'bg-yellow-500'
          : 'bg-gray-600'
  const label =
    health.state === 'up'
      ? `En ligne - ${health.latencyMs} ms`
      : health.state === 'down'
        ? 'Injoignable'
        : health.state === 'checking'
          ? 'Vérification...'
          : 'Non connecté'
  return (
    <div className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface-elevated p-4">
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${accent}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{name}</p>
        <p className="flex items-center gap-1.5 text-xs text-gray-400">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
          {label}
        </p>
        {health.state === 'up' && health.version && <p className="truncate text-xs text-gray-500">Version {health.version}</p>}
        {health.state === 'down' && health.error && (
          <p className="truncate text-xs text-red-400" title={health.error}>
            {health.error}
          </p>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-surface-border bg-surface-elevated p-4">
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-xs text-gray-400">{label}</p>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">{children}</h2>
}

function WakeOnLanSection({ onSent }: { onSent: () => void }): JSX.Element {
  const [target, setTarget] = useState<WolTarget>({ mac: '', broadcast: '' })
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    storage.loadPref<WolTarget>(WOL_PREF).then((saved) => saved && setTarget(saved))
  }, [])

  const macValid = /^[0-9a-f]{12}$/i.test(target.mac.replace(/[\s:.-]/g, ''))

  async function wake(): Promise<void> {
    const next = { mac: target.mac.trim(), broadcast: target.broadcast.trim() }
    setSending(true)
    setResult(null)
    await storage.savePref(WOL_PREF, next)
    const res = await window.api.wol.wake(next.mac, next.broadcast)
    setSending(false)
    if (res.ok) {
      setResult({ ok: true, text: "Signal envoyé. Un serveur qui dormait répond en général en moins d'une minute." })
      onSent()
    } else {
      setResult({ ok: false, text: `Échec : ${res.error || 'erreur inconnue'}` })
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-surface-border bg-surface-elevated p-4">
      <div className="flex items-center gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-hover">
          <Power className="h-5 w-5 text-gray-300" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Réveiller le serveur</p>
          <p className="text-xs text-gray-400">
            Wake-on-LAN : fonctionne depuis le même réseau local, si la carte réseau du serveur l&apos;autorise.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={target.mac}
          onChange={(e) => setTarget((t) => ({ ...t, mac: e.target.value }))}
          placeholder="Adresse MAC (AA:BB:CC:DD:EE:FF)"
          spellCheck={false}
          className="min-w-[200px] flex-1 rounded border border-surface-border bg-surface-base px-3 py-1.5 font-mono text-sm text-white placeholder:font-sans placeholder:text-gray-500"
        />
        <input
          type="text"
          value={target.broadcast}
          onChange={(e) => setTarget((t) => ({ ...t, broadcast: e.target.value }))}
          placeholder="Diffusion (ex. 192.168.1.255)"
          spellCheck={false}
          className="w-52 rounded border border-surface-border bg-surface-base px-3 py-1.5 font-mono text-sm text-white placeholder:font-sans placeholder:text-gray-500"
        />
        <button
          onClick={wake}
          disabled={!macValid || sending}
          className="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {sending ? 'Envoi...' : 'Réveiller'}
        </button>
      </div>
      {result && <p className={`text-xs ${result.ok ? 'text-gray-300' : 'text-red-400'}`}>{result.text}</p>}
    </div>
  )
}

export default function ServerDashboard(): JSX.Element {
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
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [wakingUntil, setWakingUntil] = useState(0)

  /** `reconnect` retries services that failed to connect; never on a status change, or a down server loops. */
  const refresh = useCallback(async (reconnect = false) => {
    setRefreshing(true)
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
    setCheckedAt(Date.now())
    setRefreshing(false)
  }, [])

  // Also re-runs when a service connects or drops, so the cards never lag behind the sidebar.
  useEffect(() => {
    refresh()
  }, [refresh, navidromeClient, navidromeStatus, filebrowserClient, filebrowserStatus, downtifyClient, downtifyStatus])

  const waking = wakingUntil > Date.now()
  useEffect(() => {
    const id = setInterval(() => refresh(true), waking ? WAKE_REFRESH_MS : REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh, waking])

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

  // Follows a running scan, whoever started it (this page, a finished download, the server's schedule).
  useEffect(() => {
    if (!scanBusy && !scan?.scanning) return
    const id = setInterval(() => {
      useNavidromeStore
        .getState()
        .client?.getScanStatus()
        .then(setScan, () => {})
    }, SCAN_REFRESH_MS)
    return () => clearInterval(id)
  }, [scanBusy, scan?.scanning])

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

  const albumCount = artists.reduce((sum, a) => sum + (a.albumCount || 0), 0)
  const scanning = scanBusy || !!scan?.scanning
  const queueCounts = {
    downloading: downtifyQueue.filter((q) => q.status === 'downloading').length,
    queued: downtifyQueue.filter((q) => q.status === 'queued').length,
    done: downtifyQueue.filter((q) => q.status === 'done').length,
    failed: downtifyQueue.filter((q) => q.status === 'error').length
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-8 p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Serveur</h1>
            <p className="text-xs text-gray-400">
              {waking
                ? 'En attente du réveil du serveur...'
                : checkedAt
                  ? `Vérifié à ${new Date(checkedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                  : 'Vérification...'}
            </p>
          </div>
          <button
            onClick={() => refresh(true)}
            disabled={refreshing}
            className="flex items-center gap-2 rounded-full border border-surface-border px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Actualiser
          </button>
        </div>

        <section className="space-y-3">
          <SectionTitle>Services</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-3">
            <ServiceCard icon={Music} accent="bg-accent text-black" name="Navidrome" health={navidromeHealth} />
            <ServiceCard icon={FolderOpen} accent="bg-blue-500 text-white" name="FileBrowser" health={filebrowserHealth} />
            <ServiceCard icon={Download} accent="bg-orange-500 text-white" name="Downtify" health={downtifyHealth} />
          </div>
        </section>

        <section className="space-y-3">
          <SectionTitle>Bibliothèque musicale</SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Titres" value={scan ? formatCount(scan.count) : '-'} />
            <Stat label="Albums" value={artists.length ? formatCount(albumCount) : '-'} />
            <Stat label="Artistes" value={artists.length ? formatCount(artists.length) : '-'} />
            <Stat label="Dossiers" value={scan ? formatCount(scan.folderCount) : '-'} />
          </div>
          <div className="flex items-center gap-4 rounded-lg border border-surface-border bg-surface-elevated p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-hover">
              <ScanLine className={`h-5 w-5 text-gray-300 ${scanning ? 'animate-pulse' : ''}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{scanning ? 'Scan en cours...' : scan ? `Dernier scan ${timeAgo(scan.lastScan)}` : 'Scan de la bibliothèque'}</p>
              <p className="text-xs text-gray-400">
                Cherche les fichiers ajoutés ou modifiés. Les téléchargements Downtify en lancent un automatiquement.
              </p>
            </div>
            <button
              onClick={startScan}
              disabled={scanning || !navidromeClient}
              className="rounded-full border border-surface-border px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
            >
              Scanner
            </button>
          </div>
        </section>

        {nowPlaying.length > 0 && navidromeClient && (
          <section className="space-y-3">
            <SectionTitle>En écoute en ce moment</SectionTitle>
            <div className="divide-y divide-surface-border rounded-lg border border-surface-border bg-surface-elevated">
              {nowPlaying.map((entry) => (
                <div key={`${entry.username}-${entry.playerName}-${entry.id}`} className="flex items-center gap-3 p-3">
                  {entry.coverArt ? (
                    <img src={navidromeClient.coverArtUrl(entry.coverArt, 80)} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                  ) : (
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-hover">
                      <Radio className="h-4 w-4 text-gray-400" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {entry.title} <span className="text-gray-400">- {entry.artist}</span>
                    </p>
                    <p className="truncate text-xs text-gray-400">
                      {entry.username}
                      {entry.playerName ? ` sur ${entry.playerName}` : ''}
                      {entry.minutesAgo > 0 ? `, il y a ${entry.minutesAgo} min` : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {sources.length > 0 && (
          <section className="space-y-3">
            <SectionTitle>Stockage</SectionTitle>
            {sources.map((source) => {
              const bar =
                source.usedPercentage >= 90 ? 'bg-red-500' : source.usedPercentage >= 75 ? 'bg-yellow-500' : 'bg-accent'
              return (
                <div key={source.name} className="space-y-2 rounded-lg border border-surface-border bg-surface-elevated p-4">
                  <div className="flex items-center gap-3">
                    <HardDrive className="h-4 w-4 shrink-0 text-gray-400" />
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold">{source.name}</p>
                    <p className="shrink-0 text-xs text-gray-300">
                      {source.total ? `${formatBytes(source.used)} / ${formatBytes(source.total)}` : formatBytes(source.used)}
                    </p>
                  </div>
                  {source.total > 0 && (
                    <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
                      <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, source.usedPercentage)}%` }} />
                    </div>
                  )}
                  <p className="text-xs text-gray-500">
                    {source.total ? `${source.usedPercentage} % utilisés - ${formatBytes(source.total - source.used)} libres - ` : ''}
                    {formatCount(source.numFiles)} fichiers, {formatCount(source.numDirs)} dossiers
                  </p>
                </div>
              )
            })}
          </section>
        )}

        {downtifyClient && (
          <section className="space-y-3">
            <SectionTitle>Téléchargements Downtify</SectionTitle>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="En cours" value={formatCount(queueCounts.downloading)} />
              <Stat label="En attente" value={formatCount(queueCounts.queued)} />
              <Stat label="Terminés" value={formatCount(queueCounts.done)} />
              <Stat label="Échecs" value={formatCount(queueCounts.failed)} />
            </div>
          </section>
        )}

        <section className="space-y-3">
          <SectionTitle>Réveil à distance</SectionTitle>
          <WakeOnLanSection onSent={() => setWakingUntil(Date.now() + WAKE_WATCH_MS)} />
        </section>
      </div>
    </div>
  )
}
