import { HardDriveDownload, Loader2, CircleCheck } from 'lucide-react'
import { NavidromeClient, NDSong } from '@renderer/services/navidrome'
import { useOfflineStore } from '@renderer/store/offlineStore'

interface Props {
  song: NDSong
  client: NavidromeClient
}

export default function OfflineButton({ song, client }: Props): JSX.Element {
  const isOffline = useOfflineStore((s) => !!s.tracks[song.id])
  const progress = useOfflineStore((s) => s.downloading[song.id])
  const error = useOfflineStore((s) => s.errors[song.id])
  const downloadTrack = useOfflineStore((s) => s.downloadTrack)
  const removeOffline = useOfflineStore((s) => s.removeOffline)

  if (progress) {
    const percent = progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0
    return (
      <button disabled title={`Telechargement hors-ligne... ${percent}%`} className="text-accent">
        <Loader2 className="h-4 w-4 animate-spin" />
      </button>
    )
  }

  if (isOffline) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation()
          removeOffline(song.id)
        }}
        title="Disponible hors-ligne - cliquer pour retirer"
        className="text-accent hover:text-white"
      >
        <CircleCheck className="h-4 w-4" />
      </button>
    )
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        downloadTrack(song, client)
      }}
      title={error || 'Telecharger pour ecoute hors-ligne'}
      className={`transition-colors ${error ? 'text-red-400' : 'text-gray-500 hover:text-white'}`}
    >
      <HardDriveDownload className="h-4 w-4" />
    </button>
  )
}
