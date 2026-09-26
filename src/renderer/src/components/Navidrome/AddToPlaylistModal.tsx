import { FormEvent, useState } from 'react'
import { X, Plus, Check, ListMusic } from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useToastStore } from '@renderer/store/toastStore'
import { NDSong } from '@renderer/services/navidrome'

interface Props {
  songs: NDSong[]
  onClose: () => void
}

export default function AddToPlaylistModal({ songs, onClose }: Props): JSX.Element {
  const playlists = useNavidromeStore((s) => s.playlists)
  const addSongsToPlaylist = useNavidromeStore((s) => s.addSongsToPlaylist)
  const createPlaylist = useNavidromeStore((s) => s.createPlaylist)
  const showToast = useToastStore((s) => s.show)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [addedTo, setAddedTo] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  async function handleAdd(playlistId: string): Promise<void> {
    setError(null)
    try {
      await addSongsToPlaylist(
        playlistId,
        songs.map((s) => s.id)
      )
      setAddedTo((prev) => new Set(prev).add(playlistId))
      const name = playlists.find((p) => p.id === playlistId)?.name
      showToast(name ? `Ajoute a "${name}"` : 'Ajoute a la playlist')
    } catch (err: any) {
      setError(err?.message || "Impossible d'ajouter a la playlist")
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
      showToast(`Playlist "${playlist.name}" creee`)
      setNewName('')
    } catch (err: any) {
      setError(err?.message || 'Impossible de creer la playlist')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-sm animate-slide-up space-y-3 rounded-xl bg-surface-elevated p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Ajouter {songs.length > 1 ? `${songs.length} titres` : `"${songs[0]?.title}"`} a une playlist
          </h2>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:text-white" aria-label="Fermer">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-64 space-y-1 overflow-y-auto">
          {playlists.length === 0 && <p className="py-2 text-xs text-gray-500">Aucune playlist pour le moment.</p>}
          {playlists.map((p) => (
            <button
              key={p.id}
              onClick={() => handleAdd(p.id)}
              disabled={addedTo.has(p.id)}
              className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-surface-hover disabled:opacity-60"
            >
              <ListMusic className="h-4 w-4 shrink-0 text-gray-400" />
              <span className="flex-1 truncate">{p.name}</span>
              {addedTo.has(p.id) && <Check className="h-4 w-4 shrink-0 text-accent" />}
            </button>
          ))}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <form onSubmit={handleCreate} className="flex items-center gap-2 border-t border-surface-border pt-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Nouvelle playlist..."
            className="flex-1 rounded-md border border-surface-border bg-surface-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={creating || !newName.trim()}
            className="flex shrink-0 items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            <Plus className="h-3.5 w-3.5" /> Creer
          </button>
        </form>
      </div>
    </div>
  )
}
