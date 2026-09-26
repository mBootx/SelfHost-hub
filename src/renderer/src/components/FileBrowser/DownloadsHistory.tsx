import { Download, FolderOpen, X } from 'lucide-react'
import { useDownloadStore } from '@renderer/store/downloadStore'

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export default function DownloadsHistory(): JSX.Element {
  const files = useDownloadStore((s) => s.files)
  const forget = useDownloadStore((s) => s.forget)
  const clear = useDownloadStore((s) => s.clear)

  if (files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-hover">
          <Download className="h-6 w-6 text-gray-500" />
        </div>
        <p className="text-sm font-medium text-gray-400">Aucun telechargement</p>
        <p className="max-w-xs text-xs text-gray-500">
          Les fichiers recuperes depuis le serveur apparaitront ici, avec l&apos;endroit ou vous les avez enregistres.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-1 p-4">
      <div className="flex justify-end">
        <button onClick={() => clear()} className="pb-2 text-xs text-gray-500 hover:text-white">
          Vider l&apos;historique
        </button>
      </div>
      {files.map((file) => (
        <div
          key={file.path}
          className="group flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-surface-hover"
        >
          <Download className="h-4 w-4 shrink-0 text-gray-500" />
          <button
            onClick={() => window.api.shell.openPath(file.path)}
            className="min-w-0 flex-1 text-left"
            title="Ouvrir le fichier"
          >
            <p className="truncate text-sm font-medium group-hover:text-accent">{file.name}</p>
            <p className="truncate text-xs text-gray-500">
              {formatDate(file.downloadedAt)} - {file.path}
            </p>
          </button>
          <button
            onClick={() => window.api.shell.showItemInFolder(file.path)}
            title="Afficher dans le dossier"
            className="rounded p-1.5 text-gray-500 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
          >
            <FolderOpen className="h-4 w-4" />
          </button>
          <button
            onClick={() => forget(file.path)}
            title="Retirer de l'historique (ne supprime pas le fichier)"
            className="rounded p-1.5 text-gray-500 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
