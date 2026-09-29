import { useEffect, useState } from 'react'
import { Music, FolderOpen, Download, HardDriveDownload, Cast, RefreshCw } from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useFileBrowserStore } from '@renderer/store/filebrowserStore'
import { useDowntifyStore } from '@renderer/store/downtifyStore'
import { useOfflineStore } from '@renderer/store/offlineStore'
import { useRemoteStore } from '@renderer/store/remoteStore'
import { useWhatsNewStore } from '@renderer/store/whatsNewStore'
import DowntifyLoginPage from '@renderer/components/Downtify/LoginPage'
import DowntifySettingsForm from '@renderer/components/Downtify/SettingsForm'
import DownloadQueue from '@renderer/components/Downtify/DownloadQueue'
import Switch from '@renderer/components/Switch'
import AppearanceSection from './AppearanceSection'
import PlaybackSection from './PlaybackSection'

type IconComponent = typeof Music

function ServiceRow({
  icon: Icon,
  accent,
  name,
  connected,
  subtitle,
  onLogout
}: {
  icon: IconComponent
  accent: string
  name: string
  connected: boolean
  subtitle: string
  onLogout?: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-surface-border bg-surface-elevated p-4">
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${accent}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{name}</p>
        <p className="flex items-center gap-1.5 text-xs text-gray-400">
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-accent' : 'bg-gray-600'}`} />
          {subtitle}
        </p>
      </div>
      {connected && onLogout && (
        <button
          onClick={onLogout}
          className="rounded-full border border-surface-border px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-red-500 hover:text-red-400"
        >
          Se déconnecter
        </button>
      )}
    </div>
  )
}

type UpdateState = 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'dev' | 'error'

function UpdatesRow(): JSX.Element {
  const [currentVersion, setCurrentVersion] = useState('')
  const [state, setState] = useState<UpdateState>('idle')
  const [latestVersion, setLatestVersion] = useState('')
  const showWhatsNew = useWhatsNewStore((s) => s.showAll)

  useEffect(() => {
    window.api.updater.currentVersion().then(setCurrentVersion)
  }, [])

  async function check(): Promise<void> {
    setState('checking')
    try {
      const outcome = await window.api.updater.check()
      if ('version' in outcome) setLatestVersion(outcome.version)
      setState(outcome.status)
    } catch {
      setState('error')
    }
  }

  const messages: Record<UpdateState, string> = {
    idle: 'Les mises à jour sont vérifiées au démarrage puis toutes les 6 heures.',
    checking: 'Recherche...',
    current: 'Vous avez la dernière version.',
    downloading: `Version ${latestVersion} en cours de téléchargement.`,
    ready: `Version ${latestVersion} prête : elle s'installera à la fermeture.`,
    dev: 'Indisponible en mode développement.',
    error: 'Vérification impossible (hors ligne ?).'
  }

  return (
    <div className="flex items-center gap-4 rounded-lg border border-surface-border bg-surface-elevated p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-hover">
        <RefreshCw className={`h-5 w-5 text-gray-300 ${state === 'checking' ? 'animate-spin' : ''}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">SelfHost Hub {currentVersion && `v${currentVersion}`}</p>
        <p className="text-xs text-gray-400">{messages[state]}</p>
      </div>
      <button
        onClick={showWhatsNew}
        className="rounded-full border border-surface-border px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-accent hover:text-accent"
      >
        Nouveautés
      </button>
      <button
        onClick={check}
        disabled={state === 'checking'}
        className="rounded-full border border-surface-border px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
      >
        Rechercher
      </button>
    </div>
  )
}

export default function SettingsModule(): JSX.Element {
  const navidromeStatus = useNavidromeStore((s) => s.status)
  const navidromeUsername = useNavidromeStore((s) => s.username)
  const navidromeLogout = useNavidromeStore((s) => s.logout)
  const filebrowserStatus = useFileBrowserStore((s) => s.status)
  const filebrowserLogout = useFileBrowserStore((s) => s.logout)
  const downtifyStatus = useDowntifyStore((s) => s.status)
  const downtifyLogout = useDowntifyStore((s) => s.logout)
  const downtifyQueue = useDowntifyStore((s) => s.queue)

  const offlineTracks = useOfflineStore((s) => s.tracks)
  const removeOffline = useOfflineStore((s) => s.removeOffline)
  const offlineIds = Object.keys(offlineTracks)

  const remoteEnabled = useRemoteStore((s) => s.enabled)
  const remoteRunning = useRemoteStore((s) => s.running)
  const remoteAddress = useRemoteStore((s) => s.address)
  const remoteDeviceName = useRemoteStore((s) => s.deviceName)
  const remoteDeviceCount = useRemoteStore((s) => s.deviceList.length - 1)
  const setRemoteEnabled = useRemoteStore((s) => s.setEnabled)
  const setRemoteDeviceName = useRemoteStore((s) => s.setDeviceName)
  const [deviceNameDraft, setDeviceNameDraft] = useState(remoteDeviceName)
  useEffect(() => setDeviceNameDraft(remoteDeviceName), [remoteDeviceName])

  const downtifyConnected = downtifyStatus === 'connected'
  const activeDownloads = downtifyQueue.filter((q) => q.status === 'downloading' || q.status === 'queued').length

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-8 p-6">
        <h1 className="text-2xl font-bold tracking-tight">Réglages</h1>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Services</h2>
          <ServiceRow
            icon={Music}
            accent="bg-accent text-black"
            name="Navidrome"
            connected={navidromeStatus === 'connected'}
            subtitle={navidromeStatus === 'connected' ? `Connecté en tant que ${navidromeUsername}` : 'Non connecté'}
            onLogout={navidromeLogout}
          />
          <ServiceRow
            icon={FolderOpen}
            accent="bg-blue-500 text-white"
            name="FileBrowser"
            connected={filebrowserStatus === 'connected'}
            subtitle={filebrowserStatus === 'connected' ? 'Connecté' : 'Non connecté'}
            onLogout={filebrowserLogout}
          />
          <ServiceRow
            icon={Download}
            accent="bg-orange-500 text-white"
            name="Downtify"
            connected={downtifyConnected}
            subtitle={downtifyConnected ? 'Résultats intégrés à la recherche Navidrome' : 'Non connecté'}
            onLogout={downtifyLogout}
          />
        </section>

        <AppearanceSection />
        <PlaybackSection />

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Contrôle à distance</h2>
          <div className="flex items-center gap-4 rounded-lg border border-surface-border bg-surface-elevated p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-purple-500 text-white">
              <Cast className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Piloter cet ordinateur depuis le téléphone</p>
              <p className="text-xs text-gray-400">
                {remoteRunning
                  ? `En écoute sur ${remoteAddress || '?'}${
                      remoteDeviceCount > 0
                        ? ` - ${remoteDeviceCount} appareil${remoteDeviceCount > 1 ? 's' : ''} connecté${remoteDeviceCount > 1 ? 's' : ''}`
                        : ''
                    }`
                  : remoteEnabled
                    ? 'En attente de connexion à Navidrome...'
                    : 'Désactivé - même réseau Wi-Fi requis'}
              </p>
            </div>
            <Switch checked={remoteEnabled} onChange={setRemoteEnabled} label="Contrôle à distance" />
          </div>
          {remoteEnabled && (
            <div className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface-elevated p-4">
              <label className="text-xs text-gray-400" htmlFor="remote-device-name">
                Nom de cet appareil
              </label>
              <input
                id="remote-device-name"
                type="text"
                value={deviceNameDraft}
                onChange={(e) => setDeviceNameDraft(e.target.value)}
                onBlur={() => deviceNameDraft.trim() && setRemoteDeviceName(deviceNameDraft.trim())}
                className="flex-1 rounded border border-surface-border bg-surface-base px-3 py-1.5 text-sm text-white"
              />
            </div>
          )}
        </section>

        {/* Downtify has no tab of its own any more: connecting, the queue and the
            download options all live here, and its search results surface inside
            the Navidrome search. */}
        {downtifyConnected ? (
          <>
            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                File de téléchargement{activeDownloads > 0 ? ` (${activeDownloads} en cours)` : ''}
              </h2>
              <DownloadQueue />
            </section>

            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Options de téléchargement</h2>
              <DowntifySettingsForm />
            </section>
          </>
        ) : (
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Connexion à Downtify</h2>
            <div className="overflow-hidden rounded-lg border border-surface-border">
              <DowntifyLoginPage />
            </div>
          </section>
        )}

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Stockage</h2>
          <div className="flex items-center gap-4 rounded-lg border border-surface-border bg-surface-elevated p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-hover">
              <HardDriveDownload className="h-5 w-5 text-gray-300" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Titres hors-ligne</p>
              <p className="text-xs text-gray-400">
                {offlineIds.length === 0 ? 'Aucun titre téléchargé' : `${offlineIds.length} titres sur cet ordinateur`}
              </p>
            </div>
            {offlineIds.length > 0 && (
              <button
                onClick={() => offlineIds.forEach((id) => removeOffline(id))}
                className="rounded-full border border-surface-border px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-red-500 hover:text-red-400"
              >
                Vider
              </button>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Application</h2>
          <UpdatesRow />
        </section>
      </div>
    </div>
  )
}
