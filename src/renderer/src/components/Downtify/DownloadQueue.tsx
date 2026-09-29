import { X } from 'lucide-react'
import { useDowntifyStore } from '@renderer/store/downtifyStore'
import { QueueStatus } from '@renderer/services/downtify'
import CoverImage from './CoverImage'

function StatusBadge({ status }: { status: QueueStatus }): JSX.Element {
  const styles: Record<string, string> = {
    queued: 'bg-gray-500/20 text-gray-300',
    downloading: 'bg-accent/20 text-accent',
    done: 'bg-blue-500/20 text-blue-400',
    error: 'bg-red-500/20 text-red-400'
  }
  const labels: Record<string, string> = {
    queued: 'En attente',
    downloading: 'Téléchargement',
    done: 'Terminé',
    error: 'Erreur'
  }
  const style = styles[status] || 'bg-gray-500/20 text-gray-300'
  const label = labels[status] || status
  return <span className={`rounded-full px-2 py-0.5 text-xs ${style}`}>{label}</span>
}

export default function DownloadQueue(): JSX.Element {
  const queue = useDowntifyStore((s) => s.queue)
  const cancelQueueItem = useDowntifyStore((s) => s.cancelQueueItem)
  const clearQueue = useDowntifyStore((s) => s.clearQueue)

  if (queue.length === 0) {
    return <p className="py-8 text-center text-sm text-gray-500">Aucun téléchargement en cours.</p>
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => clearQueue()} className="text-xs text-gray-400 hover:text-red-400">
          Tout effacer
        </button>
      </div>
      {queue.map((item) => (
        <div key={item.song.song_id} className="rounded-lg bg-surface-elevated p-4">
          <div className="mb-2 flex items-center gap-3">
            <CoverImage url={item.song.cover_url} className="h-10 w-10" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{item.song.name}</p>
              <p className="truncate text-xs text-gray-400">{item.song.artists.join(', ')}</p>
            </div>
            <StatusBadge status={item.status} />
            <button onClick={() => cancelQueueItem(item.song.song_id)} className="text-gray-400 hover:text-red-400">
              <X className="h-4 w-4" />
            </button>
          </div>
          {item.status === 'downloading' && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
              <div
                className="h-full bg-orange-500 transition-all"
                style={{ width: `${Math.min(100, Math.max(0, item.progress))}%` }}
              />
            </div>
          )}
          {item.message && item.status === 'error' && (
            <p className="mt-1.5 text-[11px] text-red-400">{item.message}</p>
          )}
        </div>
      ))}
    </div>
  )
}
