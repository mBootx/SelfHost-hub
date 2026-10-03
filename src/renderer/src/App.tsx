import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Sidebar from '@renderer/components/Sidebar'
import ErrorBoundary from '@renderer/components/ErrorBoundary'
import NavidromeModule from '@renderer/components/Navidrome'
import FileBrowserModule from '@renderer/components/FileBrowser'
import SettingsModule from '@renderer/components/Settings'
import ServerDashboard from '@renderer/components/Server'
import Player from '@renderer/components/Navidrome/Player'
import BigPicture from '@renderer/components/Navidrome/BigPicture'
import UploadManager from '@renderer/components/FileBrowser/UploadManager'
import ToastHost from '@renderer/components/Toast'
import UpdateBanner from '@renderer/components/UpdateBanner'
import WhatsNewModal from '@renderer/components/WhatsNewModal'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useFileBrowserStore } from '@renderer/store/filebrowserStore'
import { useDowntifyStore } from '@renderer/store/downtifyStore'
import { useOfflineStore } from '@renderer/store/offlineStore'
import { useDownloadStore } from '@renderer/store/downloadStore'
import { useRemoteStore } from '@renderer/store/remoteStore'
import { useHistoryStore } from '@renderer/store/historyStore'
import { useWhatsNewStore } from '@renderer/store/whatsNewStore'
import { startPlaybackMemory } from '@renderer/services/playbackMemory'
import { startScrobbler } from '@renderer/services/scrobbler'
import { startDownloadWatcher } from '@renderer/services/downloadWatcher'
import { useIsOwner } from '@renderer/hooks/useIsOwner'

/** Only the server's owner gets the dashboard; anyone else landing here goes back to the music. */
function ServerRoute(): JSX.Element | null {
  const isOwner = useIsOwner()
  if (isOwner === null) return null
  if (!isOwner) return <Navigate to="/navidrome" replace />
  return (
    <ErrorBoundary label="Serveur">
      <ServerDashboard />
    </ErrorBoundary>
  )
}

export default function App(): JSX.Element {
  const restoreNavidrome = useNavidromeStore((s) => s.restoreSession)
  const loadPlaybackPrefs = useNavidromeStore((s) => s.loadPlaybackPrefs)
  const restoreFileBrowser = useFileBrowserStore((s) => s.restoreSession)
  const restoreDowntify = useDowntifyStore((s) => s.restoreSession)
  const loadOfflineTracks = useOfflineStore((s) => s.loadFromDisk)
  const loadDownloads = useDownloadStore((s) => s.loadFromDisk)
  const loadHistory = useHistoryStore((s) => s.loadFromDisk)
  const initRemote = useRemoteStore((s) => s.init)
  const checkWhatsNew = useWhatsNewStore((s) => s.check)
  const navidromeConnected = useNavidromeStore((s) => s.status === 'connected')

  useEffect(() => {
    // Reconnect all three services as soon as the app launches, not only
    // when the user first navigates to each tab, so switching tabs feels
    // instant instead of showing a fresh "reconnecting..." each time.
    restoreNavidrome()
    restoreFileBrowser()
    restoreDowntify()
    loadOfflineTracks()
    loadDownloads()
    loadHistory()
    loadPlaybackPrefs()
    // Before the player mounts (it waits for Navidrome), so it opens on the restored track.
    startPlaybackMemory()
    startScrobbler()
    startDownloadWatcher()
    checkWhatsNew()
  }, [])

  useEffect(() => {
    // The remote-control hub scopes pairing to the current Navidrome account,
    // so it can only (re)start once that account is known - retried whenever
    // the connection state changes rather than once at boot.
    initRemote()
  }, [navidromeConnected])

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface-base text-white">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <Routes>
            <Route path="/" element={<Navigate to="/navidrome" replace />} />
            <Route
              path="/navidrome/*"
              element={
                <ErrorBoundary label="Navidrome">
                  <NavidromeModule />
                </ErrorBoundary>
              }
            />
            <Route
              path="/filebrowser/*"
              element={
                <ErrorBoundary label="FileBrowser">
                  <FileBrowserModule />
                </ErrorBoundary>
              }
            />
            <Route path="/server" element={<ServerRoute />} />
            <Route
              path="/settings"
              element={
                <ErrorBoundary label="Réglages">
                  <SettingsModule />
                </ErrorBoundary>
              }
            />
            {/* Downtify lost its own screen; keep old links working. */}
            <Route path="/downtify/*" element={<Navigate to="/settings" replace />} />
            <Route path="*" element={<Navigate to="/navidrome" replace />} />
          </Routes>
        </main>
      </div>
      {/* Rendered outside the routed <main> so playback survives switching tabs. */}
      {navidromeConnected && (
        <ErrorBoundary label="Lecteur Navidrome">
          <Player />
        </ErrorBoundary>
      )}
      {/* The full-screen player covers everything while it is open; the player bar underneath keeps playing. */}
      {navidromeConnected && (
        <ErrorBoundary label="Plein écran">
          <BigPicture />
        </ErrorBoundary>
      )}
      {/* Global so an upload keeps reporting progress even after leaving the FileBrowser tab. */}
      <ErrorBoundary label="Téléversements">
        <UploadManager />
      </ErrorBoundary>
      <ToastHost />
      <UpdateBanner />
      <WhatsNewModal />
    </div>
  )
}
