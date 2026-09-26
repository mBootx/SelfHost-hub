import { useEffect, useMemo, useState } from 'react'
import { Play, ListMusic, HardDriveDownload, X } from 'lucide-react'
import { NavidromeClient, NDPlaylist, NDSong } from '@renderer/services/navidrome'
import { prefetchCoverArt } from '@renderer/services/imagePrefetch'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useOfflineStore } from '@renderer/store/offlineStore'
import { useToastStore } from '@renderer/store/toastStore'
import TrackThumbnail from './TrackThumbnail'
import { useTrackMenu } from './useTrackMenu'
import OfflineButton from './OfflineButton'

interface Props {
  client: NavidromeClient
  playlistId: string
}

type SortMode = 'default' | 'title' | 'artist' | 'duration'

const SORT_LABELS: Record<SortMode, string> = {
  default: 'Ordre de la playlist',
  title: 'Titre (A-Z)',
  artist: 'Artiste (A-Z)',
  duration: 'Duree (croissante)'
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function PlaylistView({ client, playlistId }: Props): JSX.Element {
  const [playlist, setPlaylist] = useState<NDPlaylist | null>(null)
  const [songs, setSongs] = useState<NDSong[]>([])
  const [loading, setLoading] = useState(true)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const trackMenu = useTrackMenu()
  const currentSongId = useNavidromeStore((s) => s.queue[s.queueIndex]?.id)
  const isPlaying = useNavidromeStore((s) => s.isPlaying)
  const downloadTracks = useOfflineStore((s) => s.downloadTracks)
  const removeFromPlaylist = useNavidromeStore((s) => s.removeFromPlaylist)
  const showToast = useToastStore((s) => s.show)
  const [removingIndex, setRemovingIndex] = useState<number | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>('default')

  // Sorting only changes what's displayed - removal still has to address the
  // song by its real position in the server's playlist, so each row keeps its
  // original index alongside wherever the sort puts it on screen.
  const displaySongs = useMemo(() => {
    const withIndex = songs.map((song, originalIndex) => ({ song, originalIndex }))
    if (sortMode === 'title') withIndex.sort((a, b) => a.song.title.localeCompare(b.song.title))
    else if (sortMode === 'artist') withIndex.sort((a, b) => a.song.artist.localeCompare(b.song.artist))
    else if (sortMode === 'duration') withIndex.sort((a, b) => a.song.duration - b.song.duration)
    return withIndex
  }, [songs, sortMode])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    client.getPlaylist(playlistId).then((res) => {
      if (cancelled) return
      setPlaylist(res.playlist)
      setSongs(res.songs)
      setLoading(false)
      prefetchCoverArt(client, res.songs.map((s) => s.coverArt), 80)
    })
    return () => {
      cancelled = true
    }
  }, [playlistId])

  async function handleRemove(index: number): Promise<void> {
    setRemovingIndex(index)
    try {
      await removeFromPlaylist(playlistId, index)
      setSongs((prev) => prev.filter((_, i) => i !== index))
      showToast('Retire de la playlist')
    } catch {
      showToast("Impossible de retirer ce titre")
    } finally {
      setRemovingIndex(null)
    }
  }

  if (loading) return <div className="p-6 text-sm text-gray-400">Chargement...</div>

  return (
    <div className="animate-fade-in p-6">
      <div className="mb-6 flex items-end gap-5">
        {playlist?.coverArt ? (
          <img src={client.coverArtUrl(playlist.coverArt, 300)} alt="" className="h-40 w-40 rounded object-cover shadow-2xl" />
        ) : (
          <div className="flex h-40 w-40 items-center justify-center rounded bg-surface-hover">
            <ListMusic className="h-12 w-12 text-gray-500" />
          </div>
        )}
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-400">Playlist</p>
          <h1 className="text-3xl font-bold">{playlist?.name}</h1>
          <p className="mt-1 text-sm text-gray-400">{songs.length} titres</p>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => playQueue(songs, 0)}
              className="flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover"
            >
              <Play className="h-4 w-4" /> Lecture
            </button>
            <button
              onClick={() => downloadTracks(songs, client)}
              title="Telecharger la playlist pour ecoute hors-ligne"
              className="flex items-center gap-2 rounded-full border border-surface-border px-4 py-2 text-sm text-gray-300 transition-colors hover:border-accent hover:text-accent"
            >
              <HardDriveDownload className="h-4 w-4" /> Hors-ligne
            </button>
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="rounded-full border border-surface-border bg-surface-elevated px-3 py-2 text-xs text-gray-300 outline-none"
            >
              {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {SORT_LABELS[mode]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <table className="w-full text-sm">
        <tbody>
          {displaySongs.map(({ song, originalIndex }, i) => (
            <tr
              key={`${song.id}-${originalIndex}`}
              onDoubleClick={() => playQueue(displaySongs.map((d) => d.song), i)}
              onContextMenu={(e) => trackMenu.onContextMenu(e, song)}
              className="group cursor-default rounded transition-colors hover:bg-surface-hover"
            >
              <td className="w-12 py-1.5 pl-2">
                <TrackThumbnail
                  coverUrl={song.coverArt ? client.coverArtUrl(song.coverArt, 80) : null}
                  isCurrent={song.id === currentSongId}
                  isPlaying={isPlaying}
                  onPlay={() => playQueue(displaySongs.map((d) => d.song), i)}
                />
              </td>
              <td className="py-2">
                <p className="font-medium">{song.title}</p>
                <p className="text-xs text-gray-400">{song.artist}</p>
              </td>
              <td className="py-2 text-right text-gray-400">{formatDuration(song.duration)}</td>
              <td className="w-8 py-2 text-right">
                <OfflineButton song={song} client={client} />
              </td>
              <td className="w-8 py-2 pr-2 text-right">
                <button
                  onClick={() => handleRemove(originalIndex)}
                  disabled={removingIndex === originalIndex}
                  title="Retirer de la playlist"
                  className="rounded p-1 text-gray-500 opacity-0 transition-opacity hover:text-red-400 disabled:opacity-60 group-hover:opacity-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {trackMenu.menu}
    </div>
  )
}
