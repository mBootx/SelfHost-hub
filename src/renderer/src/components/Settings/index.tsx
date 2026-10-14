import { useEffect, useState } from 'react'
import { Music, FolderOpen, Download, HardDriveDownload, Cast, RefreshCw, Copy, KeyRound, Palette, SlidersHorizontal, PanelBottomClose, Rocket, Sparkles } from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useFileBrowserStore } from '@renderer/store/filebrowserStore'
import { useDowntifyStore } from '@renderer/store/downtifyStore'
import { useOfflineStore } from '@renderer/store/offlineStore'
import { useRemoteStore } from '@renderer/store/remoteStore'
import { useToastStore } from '@renderer/store/toastStore'
import { useWhatsNewStore } from '@renderer/store/whatsNewStore'
import { ACCENT_PRESETS, BACKGROUNDS, useAppearanceStore } from '@renderer/store/appearanceStore'
import DowntifyLoginPage from '@renderer/components/Downtify/LoginPage'
import DowntifySettingsForm from '@renderer/components/Downtify/SettingsForm'
import DownloadQueue from '@renderer/components/Downtify/DownloadQueue'
import Switch from '@renderer/components/Switch'
import AppearanceSection from './AppearanceSection'
import ConfirmModal from '@renderer/components/ConfirmModal'
import { plural } from '@renderer/services/plural'
import PlaybackSection from './PlaybackSection'
import { Card, Fold, GroupLabel, Hero, PillButton, Row } from './kit'

type UpdateState = 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'dev' | 'error'

function UpdatesRow({ version }: { version: string }): JSX.Element {
  const [state, setState] = useState<UpdateState>('idle')
  const [latestVersion, setLatestVersion] = useState('')
  const showWhatsNew = useWhatsNewStore((s) => s.showAll)

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
    checking: 'Recherche…',
    current: 'Vous avez la dernière version.',
    downloading: `Version ${latestVersion} en cours de téléchargement.`,
    ready: `Version ${latestVersion} prête : elle s'installera à la fermeture.`,
    dev: 'Indisponible en mode développement.',
    error: 'Vérification impossible (hors ligne ?).'
  }

  return (
    <>
      <Row
        icon={RefreshCw}
        title={`SelfHost Hub${version ? ` v${version}` : ''}`}
        meta={messages[state]}
        right={
          <PillButton onClick={check} disabled={state === 'checking'}>
            Rechercher
          </PillButton>
        }
      />
      <Row icon={Sparkles} title="Nouveautés" meta="Ce qui a changé dans les dernières versions." onClick={showWhatsNew} />
    </>
  )
}

type TraySettings = Awaited<ReturnType<typeof window.api.tray.getSettings>>

function DesktopRows(): JSX.Element | null {
  const [settings, setSettings] = useState<TraySettings | null>(null)

  useEffect(() => {
    window.api.tray.getSettings().then(setSettings)
  }, [])

  async function update(next: Partial<TraySettings>): Promise<void> {
    setSettings(await window.api.tray.setSettings(next))
  }

  if (!settings) return null
  return (
    <>
      <Row
        icon={PanelBottomClose}
        title="Garder en arrière-plan"
        meta="Fermer la fenêtre laisse la musique jouer. L'icône près de l'horloge permet de la rouvrir ou de quitter."
        right={<Switch checked={settings.closeToTray} onChange={(on) => update({ closeToTray: on })} label="Garder en arrière-plan" />}
      />
      <Row
        icon={Rocket}
        title="Lancer au démarrage de Windows"
        meta="Démarre discrètement, dans la zone de notification."
        right={<Switch checked={settings.openAtLogin} onChange={(on) => update({ openAtLogin: on })} label="Lancer au démarrage de Windows" />}
      />
    </>
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

  const accent = useAppearanceStore((s) => s.accent)
  const background = useAppearanceStore((s) => s.background)

  const remoteEnabled = useRemoteStore((s) => s.enabled)
  const remoteRunning = useRemoteStore((s) => s.running)
  const remoteAddress = useRemoteStore((s) => s.address)
  const remoteDeviceName = useRemoteStore((s) => s.deviceName)
  const remoteDeviceCount = useRemoteStore((s) => s.deviceList.length - 1)
  const setRemoteEnabled = useRemoteStore((s) => s.setEnabled)
  const setRemoteDeviceName = useRemoteStore((s) => s.setDeviceName)
  const remotePairingCode = useRemoteStore((s) => s.pairingCode)
  const newRemotePairingCode = useRemoteStore((s) => s.newPairingCode)
  const remoteError = useRemoteStore((s) => s.error)
  const [confirmClearOffline, setConfirmClearOffline] = useState(false)
  const [deviceNameDraft, setDeviceNameDraft] = useState(remoteDeviceName)
  useEffect(() => setDeviceNameDraft(remoteDeviceName), [remoteDeviceName])
  const [version, setVersion] = useState('')
  useEffect(() => {
    window.api.updater.currentVersion().then(setVersion)
  }, [])

  const downtifyConnected = downtifyStatus === 'connected'
  const activeDownloads = downtifyQueue.filter((q) => q.status === 'downloading' || q.status === 'queued').length
  const accentName = ACCENT_PRESETS.find((p) => p.hex.toLowerCase() === accent.toLowerCase())?.label ?? 'Perso'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-8 p-6 pb-12">
        <Hero
          version={version}
          chips={[
            { label: 'Navidrome', on: navidromeStatus === 'connected' },
            { label: 'FileBrowser', on: filebrowserStatus === 'connected' },
            { label: 'Downtify', on: downtifyConnected },
            { label: 'Téléphone', on: remoteRunning && remoteDeviceCount > 0 }
          ]}
        />

        <section>
          <GroupLabel>Services</GroupLabel>
          <Card>
            <Row
              icon={Music}
              title="Navidrome"
              meta={navidromeStatus === 'connected' ? `Connecté en tant que ${navidromeUsername}` : 'Non connecté'}
              right={navidromeStatus === 'connected' ? <PillButton onClick={navidromeLogout}>Se déconnecter</PillButton> : undefined}
            />
            <Row
              icon={FolderOpen}
              tone="bg-blue-500/15 text-blue-400"
              title="FileBrowser"
              meta={filebrowserStatus === 'connected' ? 'Connecté' : 'Non connecté'}
              right={filebrowserStatus === 'connected' ? <PillButton onClick={filebrowserLogout}>Se déconnecter</PillButton> : undefined}
            />
            <Row
              icon={Download}
              tone="bg-orange-500/15 text-orange-400"
              title="Downtify"
              meta={downtifyConnected ? 'Résultats intégrés à la recherche Navidrome' : 'Non connecté'}
              right={downtifyConnected ? <PillButton onClick={downtifyLogout}>Se déconnecter</PillButton> : undefined}
            />
          </Card>
        </section>

        <section>
          <GroupLabel>Contrôle à distance</GroupLabel>
          <Card>
            <Row
              icon={Cast}
              tone="bg-purple-500/15 text-purple-400"
              title="Piloter cet ordinateur depuis le téléphone"
              meta={
                remoteRunning
                  ? `En écoute sur ${remoteAddress || '?'}${
                      remoteDeviceCount > 0
                        ? ` · ${remoteDeviceCount} appareil${remoteDeviceCount > 1 ? 's' : ''} connecté${remoteDeviceCount > 1 ? 's' : ''}`
                        : ''
                    }`
                  : remoteEnabled
                    ? remoteError
                      ? `Impossible de démarrer : ${remoteError}`
                      : 'En attente de connexion à Navidrome…'
                    : 'Désactivé (même réseau Wi-Fi requis)'
              }
              right={<Switch checked={remoteEnabled} onChange={setRemoteEnabled} label="Contrôle à distance" />}
            />
            {remoteEnabled && remotePairingCode && (
              <Row
                icon={KeyRound}
                title="Code d'appairage"
                meta={
                  <>
                    <span className="block">À saisir une fois sur chaque téléphone</span>
                    <span className="select-all font-mono text-lg font-semibold tracking-widest text-white" aria-label="Code d'appairage">
                      {remotePairingCode}
                    </span>
                  </>
                }
                right={
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(remotePairingCode)
                        useToastStore.getState().show('Code copié')
                      }}
                      className="flex items-center gap-1.5 rounded-full bg-surface-hover px-3.5 py-1.5 text-xs font-bold text-gray-200 transition-colors hover:bg-surface-border hover:text-white"
                    >
                      <Copy className="h-3.5 w-3.5" /> Copier
                    </button>
                    <PillButton
                      onClick={() => {
                        if (window.confirm("Un nouveau code déconnecte les téléphones déjà appairés : ils devront le saisir de nouveau. Continuer ?")) void newRemotePairingCode()
                      }}
                    >
                      Nouveau code
                    </PillButton>
                  </div>
                }
              />
            )}
            {remoteEnabled && (
              <div className="flex items-center gap-3 px-4 py-3.5">
                <label className="text-xs font-medium text-gray-400" htmlFor="remote-device-name">
                  Nom de cet appareil
                </label>
                <input
                  id="remote-device-name"
                  type="text"
                  value={deviceNameDraft}
                  onChange={(e) => setDeviceNameDraft(e.target.value)}
                  onBlur={() => deviceNameDraft.trim() && setRemoteDeviceName(deviceNameDraft.trim())}
                  className="flex-1 rounded-xl border-2 border-surface-border bg-surface-raised px-3 py-1.5 text-sm text-white outline-none transition-colors focus:border-accent"
                />
              </div>
            )}
          </Card>
        </section>

        {/* Downtify has no tab of its own any more: connecting, the queue and the
            download options all live here, and its search results surface inside
            the Navidrome search. */}
        {downtifyConnected ? (
          <>
            <section>
              <GroupLabel>File de téléchargement{activeDownloads > 0 ? ` (${activeDownloads} en cours)` : ''}</GroupLabel>
              <DownloadQueue />
            </section>

            <section>
              <GroupLabel>Options de téléchargement</GroupLabel>
              <DowntifySettingsForm />
            </section>
          </>
        ) : (
          <section>
            <GroupLabel>Connexion à Downtify</GroupLabel>
            <div className="overflow-hidden rounded-2xl border border-surface-border">
              <DowntifyLoginPage />
            </div>
          </section>
        )}

        <section>
          <GroupLabel>Personnaliser</GroupLabel>
          <div className="space-y-2.5">
            <Fold icon={Palette} title="Apparence" summary={`${accentName} · ${BACKGROUNDS[background].label}`}>
              <AppearanceSection />
            </Fold>
            <Fold icon={SlidersHorizontal} title="Lecture et égaliseur" summary="Fondu enchaîné, lecture sans blanc, égaliseur">
              <PlaybackSection />
            </Fold>
          </div>
        </section>

        <section>
          <GroupLabel>Stockage</GroupLabel>
          <Card>
            <Row
              icon={HardDriveDownload}
              title="Titres hors ligne"
              meta={offlineIds.length === 0 ? 'Aucun titre téléchargé' : `${plural(offlineIds.length, 'titre', 'titres')} sur cet ordinateur`}
              right={offlineIds.length > 0 ? <PillButton danger onClick={() => setConfirmClearOffline(true)}>Vider</PillButton> : undefined}
            />
          </Card>
        </section>

        <ConfirmModal
          open={confirmClearOffline}
          title="Vider les titres hors ligne ?"
          description={
            offlineIds.length > 1
              ? `Les ${offlineIds.length} titres téléchargés seront supprimés de cet ordinateur. Ils restent sur le serveur.`
              : 'Le titre téléchargé sera supprimé de cet ordinateur. Il reste sur le serveur.'
          }
          confirmLabel="Vider"
          onCancel={() => setConfirmClearOffline(false)}
          onConfirm={() => {
            offlineIds.forEach((id) => removeOffline(id))
            setConfirmClearOffline(false)
          }}
        />

        <section>
          <GroupLabel>Application</GroupLabel>
          <Card>
            <DesktopRows />
            <UpdatesRow version={version} />
          </Card>
        </section>
      </div>
    </div>
  )
}
