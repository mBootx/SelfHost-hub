import { useState } from 'react'
import { Download, Loader2, Check } from 'lucide-react'
import { useDowntifyStore } from '@renderer/store/downtifyStore'
import { DowntifySong } from '@renderer/services/downtify'
import CoverImage from './CoverImage'

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

interface Props {
  songs: DowntifySong[]
  compact?: boolean
}

export default function SearchResultsList({ songs, compact }: Props): JSX.Element {
  const client = useDowntifyStore((s) => s.client)
  const queueDownload = useDowntifyStore((s) => s.queueDownload)
  const queue = useDowntifyStore((s) => s.queue)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  async function handleDownload(song: DowntifySong): Promise<void> {
    if (!client) return
    setDownloadingId(song.song_id)
    setError(null)
    // queueDownload bootstraps the queue poll immediately rather than waiting on
    // the request itself, which only resolves once the server has finished
    // downloading and transcoding the whole track.
    try {
      await queueDownload(song)
      setDownloadedIds((prev) => new Set(prev).add(song.song_id))
    } catch (err: any) {
      setError(err?.message || 'Telechargement impossible')
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <div className="space-y-1">
      {error && <p className="px-1 text-xs text-red-400">{error}</p>}
      {songs.map((song) => {
        const isDownloading = downloadingId === song.song_id
        const isDone = downloadedIds.has(song.song_id)
        const queued = queue.find((q) => q.song.song_id === song.song_id)
        const progress = queued?.status === 'downloading' ? Math.min(100, Math.max(0, queued.progress)) : null
        return (
          <div
            key={song.song_id}
            className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-surface-hover"
          >
            <CoverImage url={song.cover_url} className={compact ? 'h-9 w-9' : 'h-12 w-12'} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{song.name}</p>
              <p className="truncate text-xs text-gray-400">
                {song.artists.join(', ')}
                {song.album_name ? ` - ${song.album_name}` : ''}
              </p>
              {progress !== null && (
                <div className="mt-1 h-1 w-full max-w-[160px] overflow-hidden rounded-full bg-surface-hover">
                  <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
                </div>
              )}
            </div>
            {!compact && <span className="shrink-0 text-xs text-gray-500">{formatDuration(song.duration)}</span>}
            <button
              onClick={() => handleDownload(song)}
              disabled={isDownloading || isDone}
              title={isDone ? 'Ajoute a la file Downtify' : 'Telecharger via Downtify'}
              className="shrink-0 rounded-full border border-surface-border p-2 text-gray-300 transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
            >
              {isDownloading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isDone ? (
                <Check className="h-4 w-4 text-accent" />
              ) : (
                <Download className="h-4 w-4" />
              )}
            </button>
          </div>
        )
      })}
    </div>
  )
}
