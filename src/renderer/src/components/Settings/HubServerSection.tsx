import { useEffect, useState } from 'react'
import { Server } from 'lucide-react'
import { useRemoteStore } from '@renderer/store/remoteStore'
import { Card, PillButton, Row } from './kit'

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

  return (
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
      </div>
    </Card>
  )
}
