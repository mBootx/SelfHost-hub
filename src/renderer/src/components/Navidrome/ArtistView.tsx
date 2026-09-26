import { useEffect, useState } from 'react'
import { NavidromeClient, NDAlbum, NDArtist } from '@renderer/services/navidrome'
import { prefetchCoverArt } from '@renderer/services/imagePrefetch'

interface Props {
  client: NavidromeClient
  artistId: string
  onSelectAlbum: (albumId: string) => void
}

export default function ArtistView({ client, artistId, onSelectAlbum }: Props): JSX.Element {
  const [artist, setArtist] = useState<NDArtist | null>(null)
  const [albums, setAlbums] = useState<NDAlbum[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    client.getArtist(artistId).then((res) => {
      if (cancelled) return
      setArtist(res.artist)
      setAlbums(res.albums)
      setLoading(false)
      prefetchCoverArt(client, res.albums.map((a) => a.coverArt), 300)
    })
    return () => {
      cancelled = true
    }
  }, [artistId])

  if (loading) return <div className="p-6 text-sm text-gray-400">Chargement...</div>

  return (
    <div className="animate-fade-in p-6">
      <div className="mb-6 flex items-center gap-5">
        {artist?.coverArt ? (
          <img
            src={client.coverArtUrl(artist.coverArt, 160)}
            alt=""
            className="h-32 w-32 rounded-full object-cover shadow-lg"
          />
        ) : (
          <div className="h-32 w-32 rounded-full bg-surface-hover" />
        )}
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-400">Artiste</p>
          <h1 className="text-3xl font-bold">{artist?.name}</h1>
          <p className="mt-1 text-sm text-gray-400">{albums.length} albums</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {albums.map((album) => (
          <button
            key={album.id}
            onClick={() => onSelectAlbum(album.id)}
            className="group rounded-md p-3 text-left transition-colors hover:bg-surface-hover"
          >
            {album.coverArt ? (
              <img
                src={client.coverArtUrl(album.coverArt, 300)}
                alt=""
                loading="lazy"
                className="mb-3 aspect-square w-full rounded object-cover shadow"
              />
            ) : (
              <div className="mb-3 aspect-square w-full rounded bg-surface-hover" />
            )}
            <p className="truncate text-sm font-medium group-hover:text-accent">{album.name}</p>
            <p className="truncate text-xs text-gray-400">{album.year || ''}</p>
          </button>
        ))}
      </div>
    </div>
  )
}
