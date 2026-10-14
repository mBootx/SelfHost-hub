import { FormEvent, useMemo, useState } from 'react'
import { Plus, Check, ListMusic, Search } from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useToastStore } from '@renderer/store/toastStore'
import { NDSong } from '@renderer/services/navidrome'
import { plural } from '@renderer/services/plural'
import ModalShell from '@renderer/components/ModalShell'

interface Props {
  songs: NDSong[]
  onClose: () => void
}

/** The search box shows from this many playlists on. */
const SEARCH_FROM = 7

export default function AddToPlaylistModal({ songs, onClose }: Props): JSX.Element {
  const client = useNavidromeStore((s) => s.client)
  const playlists = useNavidromeStore((s) => s.playlists)
  const addSongsToPlaylist = useNavidromeStore((s) => s.addSongsToPlaylist)
  const createPlaylist = useNavidromeStore((s) => s.createPlaylist)
  const showToast = useToastStore((s) => s.show)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [addedTo, setAddedTo] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const first = songs[0]
  const coverId = first?.coverArt || first?.albumId
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? playlists.filter((p) => p.name.toLowerCase().includes(needle)) : playlists
  }, [playlists, query])

  async function handleAdd(playlistId: string): Promise<void> {
    setError(null)
    try {
      await addSongsToPlaylist(
        playlistId,
        songs.map((s) => s.id)
      )
      setAddedTo((prev) => new Set(prev).add(playlistId))
      const name = playlists.find((p) => p.id === playlistId)?.name
      showToast(name ? `Ajouté à « ${name} »` : 'Ajouté à la playlist')
    } catch (err: any) {
      setError(err?.message || "Impossible d'ajouter à la playlist")
    }
  }

  async function handleCreate(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating(true)
    setError(null)
    try {
      const playlist = await createPlaylist(
        newName.trim(),
        songs.map((s) => s.id)
      )
      setAddedTo((prev) => new Set(prev).add(playlist.id))
      showToast(`Playlist « ${playlist.name} » créée`)
      setNewName('')
    } catch (err: any) {
      setError(err?.message || 'Impossible de créer la playlist')
    } finally {
      setCreating(false)
    }
  }

  return (
    <ModalShell
      title="Ajouter à une playlist"
      subtitle={songs.length > 1 ? plural(songs.length, 'titre', 'titres') : [first?.title, first?.artist].filter(Boolean).join(' · ')}
      leading={
        coverId && client ? (
          <img src={client.coverArtUrl(coverId, 96)} alt="" className="h-12 w-12 shrink-0 rounded-lg bg-surface-hover object-cover" />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-gray-400">
            <ListMusic className="h-5 w-5" />
          </div>
        )
      }
      onClose={onClose}
    >
      <form onSubmit={handleCreate} className="mx-5 mb-3 flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 p-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-black">
          <Plus className="h-5 w-5" strokeWidth={2.6} />
        </span>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nouvelle playlist…"
          aria-label="Nom de la nouvelle playlist"
          className="min-w-0 flex-1 bg-transparent px-1 text-sm text-white outline-none placeholder:text-accent/70"
        />
        <button
          type="submit"
          disabled={creating || !newName.trim()}
          className="shrink-0 rounded-full bg-accent px-4 py-1.5 text-xs font-bold text-black transition-colors hover:bg-accent-hover disabled:opacity-40"
        >
          Créer
        </button>
      </form>

      {playlists.length >= SEARCH_FROM && (
        <div className="mx-5 mb-2 flex items-center gap-2 rounded-full border border-surface-border bg-surface-raised px-3">
          <Search className="h-4 w-4 shrink-0 text-gray-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Chercher une playlist"
            aria-label="Chercher une playlist"
            className="w-full bg-transparent py-2 text-sm text-white outline-none placeholder:text-gray-500"
          />
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
        {shown.length === 0 && <p className="px-2 py-4 text-center text-xs text-gray-500">{query ? 'Aucune playlist ne correspond.' : 'Aucune playlist pour le moment.'}</p>}
        {shown.map((p) => {
          const added = addedTo.has(p.id)
          return (
            <button
              key={p.id}
              onClick={() => handleAdd(p.id)}
              disabled={added}
              className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors ${added ? 'bg-accent/10' : 'hover:bg-surface-hover'}`}
            >
              {p.coverArt && client ? (
                <img src={client.coverArtUrl(p.coverArt, 80)} alt="" className="h-11 w-11 shrink-0 rounded-lg bg-surface-hover object-cover" />
              ) : (
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-gray-400">
                  <ListMusic className="h-5 w-5" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{p.name}</span>
                <span className="block text-xs text-gray-400">{plural(p.songCount, 'titre', 'titres')}</span>
              </span>
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${added ? 'bg-accent text-black' : 'bg-surface-hover text-gray-300'}`}>
                {added ? <Check className="h-4 w-4" strokeWidth={3} /> : <Plus className="h-4 w-4" />}
              </span>
            </button>
          )
        })}
        {error && <p className="px-2 pt-2 text-xs text-red-400">{error}</p>}
      </div>
    </ModalShell>
  )
}
