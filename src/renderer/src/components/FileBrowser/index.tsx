import { useState } from 'react'
import { useFileBrowserStore } from '@renderer/store/filebrowserStore'
import { useDownloadStore } from '@renderer/store/downloadStore'
import LoginPage from './LoginPage'
import ServiceUnavailable from '@renderer/components/ServiceUnavailable'
import FileExplorer from './FileExplorer'
import DownloadsHistory from './DownloadsHistory'

type Pane = 'server' | 'downloads'

export default function FileBrowserModule(): JSX.Element {
  const status = useFileBrowserStore((s) => s.status)
  const error = useFileBrowserStore((s) => s.error)
  const savedSession = useFileBrowserStore((s) => s.savedSession)
  const restoreSession = useFileBrowserStore((s) => s.restoreSession)
  const downloadCount = useDownloadStore((s) => s.files.length)
  const [pane, setPane] = useState<Pane>('server')
  const [switching, setSwitching] = useState(false)

  if (status === 'connecting' || (status === 'disconnected' && savedSession === null)) {
    return <div className="flex h-full items-center justify-center text-sm text-gray-400">Reconnexion en cours…</div>
  }

  // The history is local, so it stays reachable when the server isn't.
  if (status !== 'connected' && pane === 'server') {
    return (
      <div className="flex h-full flex-col">
        {downloadCount > 0 && (
          <button
            onClick={() => setPane('downloads')}
            className="border-b border-surface-border py-2 text-center text-xs text-accent hover:underline"
          >
            Voir {downloadCount > 1 ? `mes ${downloadCount} téléchargements` : 'mon téléchargement'}
          </button>
        )}
        <div className="min-h-0 flex-1">
          {status === 'error' && savedSession && !switching ? (
            <ServiceUnavailable serviceName="FileBrowser" message={error ?? undefined} onRetry={() => restoreSession()} onSwitch={() => setSwitching(true)} />
          ) : (
            <LoginPage />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-surface-border px-6 py-2">
        {(
          [
            ['server', 'Serveur'],
            ['downloads', downloadCount > 0 ? `Téléchargements (${downloadCount})` : 'Téléchargements']
          ] as [Pane, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setPane(key)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              pane === key ? 'bg-surface-hover text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {pane === 'downloads' ? <DownloadsHistory /> : <FileExplorer />}
      </div>
    </div>
  )
}
