import { useState } from 'react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useOfflineStore } from '@renderer/store/offlineStore'
import ServiceUnavailable from '@renderer/components/ServiceUnavailable'
import LoginPage from './LoginPage'
import MainPlayer from './MainPlayer'

export default function NavidromeModule(): JSX.Element {
  const status = useNavidromeStore((s) => s.status)
  const error = useNavidromeStore((s) => s.error)
  const savedSession = useNavidromeStore((s) => s.savedSession)
  const restoreSession = useNavidromeStore((s) => s.restoreSession)
  const playlistsCount = useNavidromeStore((s) => s.playlists.length)
  const downloadedCount = useOfflineStore((s) => Object.keys(s.tracks).length)
  const cachedPlaylistsCount = useOfflineStore((s) => Object.keys(s.playlistCache).length)
  const [switching, setSwitching] = useState(false)
  const [forceOffline, setForceOffline] = useState(false)

  if (status === 'connected') return <MainPlayer />

  // Connecting, or just started and not yet looked for a saved login: no login form flashes by.
  if (status === 'connecting' || (status === 'disconnected' && savedSession === null)) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-400">Reconnexion en cours…</div>
    )
  }

  // A saved login whose server is out of reach: if offline songs or playlists are available, open MainPlayer in offline mode.
  if (status === 'error' && savedSession && !switching) {
    if (downloadedCount > 0 || cachedPlaylistsCount > 0 || playlistsCount > 0 || forceOffline) {
      return <MainPlayer />
    }
    return (
      <ServiceUnavailable
        serviceName="Navidrome"
        message={error ?? undefined}
        onRetry={() => restoreSession()}
        onSwitch={() => setSwitching(true)}
        onOffline={() => setForceOffline(true)}
      />
    )
  }

  return <LoginPage />
}
