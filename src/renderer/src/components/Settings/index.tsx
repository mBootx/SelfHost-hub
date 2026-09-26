import { useEffect, useState } from 'react'
import { Music, FolderOpen, Download, HardDriveDownload, Cast } from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useFileBrowserStore } from '@renderer/store/filebrowserStore'
import { useDowntifyStore } from '@renderer/store/downtifyStore'
import { useOfflineStore } from '@renderer/store/offlineStore'
import { useRemoteStore } from '@renderer/store/remoteStore'
import DowntifyLoginPage from '@renderer/components/Downtify/LoginPage'
import DowntifySettingsForm from '@renderer/components/Downtify/SettingsForm'
import DownloadQueue from '@renderer/components/Downtify/DownloadQueue'

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
          Se deconnecter
        </button>
      )}
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
        <h1 className="text-2xl font-bold tracking-tight">Reglages</h1>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Services</h2>
          <ServiceRow
            icon={Music}
            accent="bg-accent text-black"
            name="Navidrome"
            connected={navidromeStatus === 'connected'}
            subtitle={navidromeStatus === 'connected' ? `Connecte en tant que ${navidromeUsername}` : 'Non connecte'}
            onLogout={navidromeLogout}
          />
          <ServiceRow
            icon={FolderOpen}
            accent="bg-blue-500 text-white"
            name="FileBrowser"
            connected={filebrowserStatus === 'connected'}
            subtitle={filebrowserStatus === 'connected' ? 'Connecte' : 'Non connecte'}
            onLogout={filebrowserLogout}
          />
          <ServiceRow
            icon={Download}
            accent="bg-orange-500 text-white"
            name="Downtify"
            connected={downtifyConnected}
            subtitle={downtifyConnected ? 'Resultats integres a la recherche Navidrome' : 'Non connecte'}
            onLogout={downtifyLogout}
          />
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Controle a distance</h2>
          <div className="flex items-center gap-4 rounded-lg border border-surface-border bg-surface-elevated p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-purple-500 text-white">
              <Cast className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Piloter cet ordinateur depuis le telephone</p>
              <p className="text-xs text-gray-400">
                {remoteRunning
                  ? `En ecoute sur ${remoteAddress || '?'}${
                      remoteDeviceCount > 0
                        ? ` - ${remoteDeviceCount} appareil${remoteDeviceCount > 1 ? 's' : ''} connecte${remoteDeviceCount > 1 ? 's' : ''}`
                        : ''
                    }`
                  : remoteEnabled
                    ? 'En attente de connexion a Navidrome...'
                    : 'Desactive - meme reseau Wi-Fi requis'}
              </p>
            </div>
            <button
              onClick={() => setRemoteEnabled(!remoteEnabled)}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${remoteEnabled ? 'bg-accent' : 'bg-surface-hover'}`}
              role="switch"
              aria-checked={remoteEnabled}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                  remoteEnabled ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
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
                File de telechargement{activeDownloads > 0 ? ` (${activeDownloads} en cours)` : ''}
              </h2>
              <DownloadQueue />
            </section>

            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Options de telechargement</h2>
              <DowntifySettingsForm />
            </section>
          </>
        ) : (
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Connexion a Downtify</h2>
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
                {offlineIds.length === 0 ? 'Aucun titre telecharge' : `${offlineIds.length} titres sur cet ordinateur`}
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
      </div>
    </div>
  )
}
