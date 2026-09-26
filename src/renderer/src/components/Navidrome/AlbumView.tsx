import { useEffect, useState } from 'react'
import { Play, Star, Download, HardDriveDownload } from 'lucide-react'
import { NavidromeClient, NDAlbum, NDSong } from '@renderer/services/navidrome'
import { prefetchCoverArt } from '@renderer/services/imagePrefetch'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useDowntifyStore } from '@renderer/store/downtifyStore'
import { useOfflineStore } from '@renderer/store/offlineStore'
import TrackThumbnail from './TrackThumbnail'
import OfflineButton from './OfflineButton'
import { useTrackMenu } from './useTrackMenu'

interface Props {
  client: NavidromeClient
  albumId: string
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function AlbumView({ client, albumId }: Props): JSX.Element {
  const [album, setAlbum] = useState<NDAlbum | null>(null)
  const [songs, setSongs] = useState<NDSong[]>([])
  const [loading, setLoading] = useState(true)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const trackMenu = useTrackMenu()
  const currentSongId = useNavidromeStore((s) => s.queue[s.queueIndex]?.id)
  const isPlaying = useNavidromeStore((s) => s.isPlaying)
  const downtifyStatus = useDowntifyStore((s) => s.status)
  const requestDownload = useDowntifyStore((s) => s.requestDownload)
  const downloadTracks = useOfflineStore((s) => s.downloadTracks)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    client.getAlbum(albumId).then((res) => {
      if (cancelled) return
      setAlbum(res.album)
      setSongs(res.songs)
      setLoading(false)
      // Each row falls back to the album's own art when a track has none - see
      // the same fallback in the table below.
      prefetchCoverArt(client, res.songs.map((s) => s.coverArt || res.album?.coverArt), 80)
    })
    return () => {
      cancelled = true
    }
  }, [albumId])

  async function toggleStar(song: NDSong): Promise<void> {
    if (song.starred) await client.unstar(song.id)
    else await client.star(song.id)
    setSongs((prev) => prev.map((s) => (s.id === song.id ? { ...s, starred: s.starred ? '' : 'true' } : s)))
  }

  if (loading) return <div className="p-6 text-sm text-gray-400">Chargement...</div>

  return (
    <div className="animate-fade-in p-6">
      <div className="mb-6 flex items-end gap-5">
        {album?.coverArt ? (
          <img src={client.coverArtUrl(album.coverArt, 300)} alt="" className="h-40 w-40 rounded object-cover shadow-2xl" />
        ) : (
          <div className="h-40 w-40 rounded bg-surface-hover" />
        )}
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-400">Album</p>
          <h1 className="text-3xl font-bold">{album?.name}</h1>
          <p className="mt-1 text-sm text-gray-400">
            {album?.artist} - {album?.year} - {songs.length} titres
          </p>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => playQueue(songs, 0)}
              className="flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover"
            >
              <Play className="h-4 w-4" /> Lecture
            </button>
            <button
              onClick={() => downloadTracks(songs, client)}
              title="Telecharger l'album pour ecoute hors-ligne"
              className="flex items-center gap-2 rounded-full border border-surface-border px-4 py-2 text-sm text-gray-300 transition-colors hover:border-accent hover:text-accent"
            >
              <HardDriveDownload className="h-4 w-4" /> Hors-ligne
            </button>
            {downtifyStatus === 'connected' && (
              <button
                onClick={() => requestDownload(`${album?.artist} - ${album?.name}`, 'album')}
                className="flex items-center gap-2 rounded-full border border-surface-border px-4 py-2 text-sm text-gray-300 transition-colors hover:border-accent hover:text-accent"
              >
                <Download className="h-4 w-4" /> Telecharger l'album
              </button>
            )}
          </div>
        </div>
      </div>

      <table className="w-full text-sm">
        <tbody>
          {songs.map((song, i) => (
            <tr
              key={song.id}
              onDoubleClick={() => playQueue(songs, i)}
              onContextMenu={(e) => trackMenu.onContextMenu(e, song)}
              className="group cursor-default rounded transition-colors hover:bg-surface-hover"
            >
              <td className="w-12 py-1.5 pl-2">
                <TrackThumbnail
                  coverUrl={
                    song.coverArt || album?.coverArt
                      ? client.coverArtUrl(song.coverArt || album!.coverArt!, 80)
                      : null
                  }
                  isCurrent={song.id === currentSongId}
                  isPlaying={isPlaying}
                  onPlay={() => playQueue(songs, i)}
                />
              </td>
              <td className="py-2 font-medium">{song.title}</td>
              <td className="py-2 text-right text-gray-400">{formatDuration(song.duration)}</td>
              <td className="w-8 py-2 text-right">
                <OfflineButton song={song} client={client} />
              </td>
              <td className="w-10 py-2 pr-2 text-right">
                <button onClick={() => toggleStar(song)}>
                  <Star className={`h-4 w-4 ${song.starred ? 'fill-accent text-accent' : 'text-gray-500'}`} />
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
