import { useEffect, useState } from 'react'
import { Cast, Laptop, Play, Server, Smartphone, X } from 'lucide-react'
import { LOCAL_DEVICE_ID, useRemoteStore } from '@renderer/store/remoteStore'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useToastStore } from '@renderer/store/toastStore'
import { useListeningStore } from '@renderer/services/listeningLog'
import { Card, PillButton, Row } from './kit'

function formatDurationSec(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const total = Math.floor(sec)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const REASONS: Record<string, string> = {
  'bad-auth': 'identifiants Navidrome refusés par le serveur',
  'navidrome-unreachable': 'le serveur ne joint pas Navidrome',
  'update-required': 'mettez l\'application à jour',
  'too-many-attempts': 'trop de tentatives, réessayez dans 10 minutes',
  'bad-hello': 'message de connexion invalide',
  'no-credentials': 'connectez-vous d\'abord à Navidrome',
  replaced: 'cet ordinateur est déjà connecté ailleurs',
  incompatible: 'serveur incompatible'
}

/** `https://hub.example.tld/` or `192.168.1.10:51823` as a base URL without trailing slash, or null. */
function normalizeBase(input: string): string | null {
  let text = input.trim()
  if (!text) return null
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`
  try {
    const url = new URL(text)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

type TestResult = { state: 'idle' } | { state: 'testing' } | { state: 'ok'; text: string } | { state: 'error'; text: string }

export default function HubServerSection(): JSX.Element {
  const serverUrl = useRemoteStore((s) => s.serverUrl)
  const status = useRemoteStore((s) => s.serverStatus)
  const setServerUrl = useRemoteStore((s) => s.setServerUrl)
  const deviceList = useRemoteStore((s) => s.deviceList)
  const remoteDevices = useRemoteStore((s) => s.devices)
  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const resumeState = useRemoteStore((s) => s.resumeState)
  const applyResume = useRemoteStore((s) => s.applyResume)
  const dismissResume = useRemoteStore((s) => s.dismissResume)
  const switchOutput = useRemoteStore((s) => s.switchOutput)
  const handoffToHere = useRemoteStore((s) => s.handoffToHere)
  const localSong = useNavidromeStore((s) => s.queue[s.queueIndex] || null)
  const localIsPlaying = useNavidromeStore((s) => s.isPlaying)
  const syncedDevices = useListeningStore((s) => s.devices)
  const showToast = useToastStore((s) => s.show)
  const [draft, setDraft] = useState(serverUrl)
  const [test, setTest] = useState<TestResult>({ state: 'idle' })
  useEffect(() => setDraft(serverUrl), [serverUrl])

  async function runTest(): Promise<void> {
    const base = normalizeBase(draft)
    if (!base) {
      setTest({ state: 'error', text: 'Adresse invalide' })
      return
    }
    setTest({ state: 'testing' })
    const res = await window.api.net.request({ url: `${base}/api/health`, method: 'GET', timeout: 5000 })
    const data = res.data as { app?: unknown; name?: unknown; version?: unknown } | null
    if (res.ok && data && typeof data === 'object' && data.app === 'selfhost-hub-server') {
      const name = typeof data.name === 'string' ? data.name : 'SelfHost Hub'
      const version = typeof data.version === 'string' ? ` · version ${data.version}` : ''
      setTest({ state: 'ok', text: `${name}${version}` })
    } else if (res.ok) {
      setTest({ state: 'error', text: "Ce n'est pas un serveur SelfHost Hub" })
    } else {
      setTest({ state: 'error', text: res.error || (res.status ? `Le serveur a répondu ${res.status}` : 'Serveur injoignable') })
    }
  }

  function meta(): string {
    if (!serverUrl) return 'Aucun serveur : le PC et le téléphone se trouvent sur le réseau local.'
    switch (status.state) {
      case 'connected':
        return `Connecté en tant que ${status.user ?? '?'}${status.serverName ? ` · ${status.serverName}` : ''}`
      case 'connecting':
        return 'Connexion…'
      case 'refused':
        return `Refusé : ${REASONS[status.reason ?? ''] ?? status.reason ?? 'raison inconnue'}`
      case 'error':
        return 'Serveur injoignable, nouvel essai en cours…'
      default:
        return 'Non connecté'
    }
  }

  const base = normalizeBase(draft)
  const changed = (base ?? '') !== (normalizeBase(serverUrl) ?? '')
  const otherOnline = deviceList.filter((d) => d.deviceId !== 'hub')
  const playingRemote = otherOnline.find((d) => remoteDevices[d.deviceId]?.isPlaying && remoteDevices[d.deviceId]?.song)
  const activeDeviceName =
    selectedDeviceId === LOCAL_DEVICE_ID
      ? 'cet ordinateur'
      : otherOnline.find((d) => d.deviceId === selectedDeviceId)?.deviceName ?? 'un autre appareil'

  return (
    <div className="space-y-3">
      {resumeState?.state?.song && (
        <div className="flex items-center gap-3 rounded-2xl border border-accent/30 bg-surface-elevated px-4 py-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
            {resumeState.platform === 'desktop' ? <Laptop className="h-5 w-5" /> : <Smartphone className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">Reprendre depuis {resumeState.deviceName}</p>
            <p className="truncate text-xs text-gray-400">
              {resumeState.state.song.title} · {resumeState.state.song.artist}
              {resumeState.state.currentTime > 0 ? ` · ${formatDurationSec(resumeState.state.currentTime)}` : ''}
            </p>
          </div>
          <PillButton
            primary
            onClick={() => {
              if (applyResume()) showToast(`Lecture reprise depuis ${resumeState.deviceName}`)
            }}
          >
            <span className="flex items-center gap-1.5">
              <Play className="h-3.5 w-3.5 fill-current" /> Reprendre
            </span>
          </PillButton>
          <button
            type="button"
            onClick={dismissResume}
            aria-label="Ignorer"
            title="Ignorer"
            className="rounded-full p-1.5 text-gray-400 transition-colors hover:bg-surface-hover hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <Card>
        <Row icon={Server} tone="bg-emerald-500/15 text-emerald-400" title="Serveur SelfHost Hub" meta={meta()} />
        <div className="space-y-3 px-4 py-3.5">
          <input
            type="text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setTest({ state: 'idle' })
            }}
            placeholder="https://hub.mondomaine.fr ou http://192.168.1.10:51823"
            aria-label="Adresse du serveur"
            spellCheck={false}
            className="w-full rounded-xl border-2 border-surface-border bg-surface-raised px-3 py-1.5 text-sm text-white outline-none transition-colors focus:border-accent"
          />
          <div className="flex flex-wrap items-center gap-2">
            <PillButton onClick={() => void runTest()} disabled={!draft.trim() || test.state === 'testing'}>
              {test.state === 'testing' ? 'Test…' : 'Tester'}
            </PillButton>
            <PillButton primary onClick={() => void setServerUrl(base ?? '')} disabled={!base || !changed}>
              Enregistrer
            </PillButton>
            {serverUrl && (
              <PillButton danger onClick={() => void setServerUrl('')}>
                Retirer
              </PillButton>
            )}
            {test.state === 'ok' && <span className="text-xs text-emerald-400">Le serveur répond : {test.text}</span>}
            {test.state === 'error' && <span className="text-xs text-red-400">{test.text}</span>}
          </div>
          <p className="text-xs leading-relaxed text-gray-400">
            Avec un serveur, le contrôle à distance et le récap d&apos;écoute passent par votre serveur, chez vous comme à l&apos;extérieur. Sans
            serveur, le PC et le téléphone se trouvent sur le réseau local.
          </p>
          {serverUrl && status.state === 'connected' && (
            <div className="space-y-3 border-t border-surface-border pt-3">
              <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-raised px-3 py-2">
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  <Cast className="h-3.5 w-3.5 shrink-0 text-accent" />
                  <span className="truncate font-semibold text-white">Écoute sur {activeDeviceName}</span>
                </div>
                {selectedDeviceId !== LOCAL_DEVICE_ID && playingRemote && (
                  <PillButton
                    primary
                    onClick={() => {
                      if (switchOutput(LOCAL_DEVICE_ID)) showToast(`Lecture reprise depuis ${playingRemote.deviceName}`)
                    }}
                  >
                    Passer l&apos;écoute ici
                  </PillButton>
                )}
              </div>

              <p className="text-xs text-gray-400">
                Rétrospective synchronisée avec :{' '}
                <span className="text-gray-200">
                  {syncedDevices.length > 0 ? syncedDevices.map((d) => d.deviceName).join(', ') : "aucun autre appareil pour l'instant"}
                </span>
              </p>

              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Appareils en ligne</p>
                <div
                  className={`flex items-center gap-2.5 rounded-xl px-3 py-2 ${
                    selectedDeviceId === LOCAL_DEVICE_ID ? 'border border-accent/40 bg-accent/10' : 'bg-surface-raised'
                  }`}
                >
                  <Laptop className={`h-4 w-4 shrink-0 ${selectedDeviceId === LOCAL_DEVICE_ID ? 'text-accent' : 'text-gray-400'}`} />
                  <button
                    type="button"
                    onClick={() => {
                      if (switchOutput(LOCAL_DEVICE_ID) && playingRemote) {
                        showToast(`Lecture reprise depuis ${playingRemote.deviceName}`)
                      }
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-xs font-semibold text-white">Cet ordinateur</p>
                      {localIsPlaying && localSong && (
                        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">
                          En cours de lecture
                        </span>
                      )}
                      {selectedDeviceId === LOCAL_DEVICE_ID && (
                        <span className="rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-semibold text-gray-200">
                          Contrôlé
                        </span>
                      )}
                    </div>
                    {localSong && (
                      <p className="truncate text-[11px] text-gray-400">
                        {localSong.title} · {localSong.artist}
                      </p>
                    )}
                  </button>
                  {selectedDeviceId !== LOCAL_DEVICE_ID && playingRemote && (
                    <PillButton
                      onClick={() => {
                        if (switchOutput(LOCAL_DEVICE_ID)) showToast(`Lecture reprise depuis ${playingRemote.deviceName}`)
                      }}
                    >
                      Passer l&apos;écoute ici
                    </PillButton>
                  )}
                </div>

                {otherOnline.map((d) => {
                  const st = remoteDevices[d.deviceId]
                  const isSelected = selectedDeviceId === d.deviceId
                  const isPlayingHere = !!(st?.isPlaying && st?.song)
                  return (
                    <div
                      key={d.deviceId}
                      className={`flex items-center gap-2.5 rounded-xl px-3 py-2 ${
                        isSelected ? 'border border-accent/40 bg-accent/10' : 'bg-surface-raised'
                      }`}
                    >
                      {d.platform === 'desktop' ? (
                        <Laptop className={`h-4 w-4 shrink-0 ${isSelected ? 'text-accent' : 'text-gray-400'}`} />
                      ) : (
                        <Smartphone className={`h-4 w-4 shrink-0 ${isSelected ? 'text-accent' : 'text-gray-400'}`} />
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const wasLocalPlaying = localIsPlaying && !!localSong
                          if (switchOutput(d.deviceId) && wasLocalPlaying) {
                            showToast(`Lecture transférée vers ${d.deviceName}`)
                          }
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="truncate text-xs font-semibold text-white">{d.deviceName}</p>
                          {isPlayingHere && (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">
                              En cours de lecture
                            </span>
                          )}
                          {isSelected && (
                            <span className="rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-semibold text-gray-200">
                              Contrôlé
                            </span>
                          )}
                        </div>
                        {st?.song && (
                          <p className="truncate text-[11px] text-gray-400">
                            {st.song.title} · {st.song.artist}
                          </p>
                        )}
                      </button>
                      {st?.song && (
                        <PillButton
                          onClick={() => {
                            if (handoffToHere(d.deviceId)) showToast(`Lecture reprise depuis ${d.deviceName}`)
                          }}
                        >
                          Passer l&apos;écoute ici
                        </PillButton>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
