import { FormEvent, useState } from 'react'
import { X } from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useToastStore } from '@renderer/store/toastStore'

interface Props {
  onClose: () => void
  onCreated?: (playlistId: string) => void
}

export default function NewPlaylistPrompt({ onClose, onCreated }: Props): JSX.Element {
  const createPlaylist = useNavidromeStore((s) => s.createPlaylist)
  const showToast = useToastStore((s) => s.show)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setError(null)
    try {
      const playlist = await createPlaylist(name.trim())
      showToast(`Playlist "${playlist.name}" créée`)
      onCreated?.(playlist.id)
      onClose()
    } catch (err: any) {
      setError(err?.message || 'Impossible de créer la playlist')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm animate-slide-up space-y-3 rounded-xl bg-surface-elevated p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Nouvelle playlist</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-400 hover:text-white" aria-label="Fermer">
            <X className="h-4 w-4" />
          </button>
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nom de la playlist"
          className="w-full rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-accent"
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={loading || !name.trim()}
          className="w-full rounded-full bg-accent py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {loading ? 'Création...' : 'Créer'}
        </button>
      </form>
    </div>
  )
}
