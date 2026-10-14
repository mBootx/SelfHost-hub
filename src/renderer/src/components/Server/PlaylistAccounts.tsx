import { useCallback, useEffect, useMemo, useState } from 'react'
import { Lock, LockOpen, Pencil, RotateCw, Trash2 } from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useToastStore } from '@renderer/store/toastStore'
import { AdminPlaylist, AdminUser, NavidromeAdmin, PlaylistChanges, tracksEditable } from '@renderer/services/navidromeAdmin'
import { plural } from '@renderer/services/plural'
import ConfirmModal from '@renderer/components/ConfirmModal'
import PromptModal from '@renderer/components/PromptModal'
import Switch from '@renderer/components/Switch'

/**
 * Every account's playlists, for the server's owner: each account sees only its own in the apps, so this is where a
 * playlist is given to the account it belongs to (it then becomes private, and editable if it still followed the M3U
 * file it was imported from), unlocked, renamed, made public or private, or deleted.
 */
export default function PlaylistAccounts(): JSX.Element {
  const client = useNavidromeStore((s) => s.client)
  const status = useNavidromeStore((s) => s.status)
  const loadLibrary = useNavidromeStore((s) => s.loadLibrary)
  const showToast = useToastStore((s) => s.show)

  const [playlists, setPlaylists] = useState<AdminPlaylist[] | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<AdminPlaylist | null>(null)
  const [deleting, setDeleting] = useState<AdminPlaylist | null>(null)

  // One sign-in to Navidrome's own API for as long as the page is open.
  const admin = useMemo<NavidromeAdmin | null>(() => (client && status === 'connected' ? client.admin() : null), [client, status])

  const load = useCallback(async () => {
    if (!admin) return
    try {
      const [all, accounts] = await Promise.all([admin.playlists(), admin.users()])
      setPlaylists(all)
      setUsers(accounts)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible')
    }
  }, [admin])

  useEffect(() => {
    void load()
  }, [load])

  async function change(playlist: AdminPlaylist, changes: PlaylistChanges, done: string): Promise<void> {
    if (!admin) return
    setBusy(playlist.id)
    try {
      await admin.update(playlist.id, changes)
      showToast(`« ${playlist.name} » ${done}`)
      await load()
      // This computer's own list follows (a playlist given away leaves it, one received joins it).
      void loadLibrary()
    } catch (err) {
      showToast(`Modification impossible : ${err instanceof Error ? err.message : 'erreur inconnue'}`)
    } finally {
      setBusy(null)
    }
  }

  function assign(playlist: AdminPlaylist, userId: string): void {
    const user = users.find((u) => u.id === userId)
    if (!user || userId === playlist.ownerId) return
    // Given to an account, a playlist is that account's alone, and its songs can be changed: it stops following the
    // M3U file it came from, which would otherwise put its songs back at every scan.
    const changes: PlaylistChanges = { ownerId: user.id, public: false }
    if (playlist.sync) changes.sync = false
    void change(playlist, changes, `attribuée à ${user.name || user.userName}`)
  }

  async function remove(playlist: AdminPlaylist): Promise<void> {
    if (!admin) return
    setBusy(playlist.id)
    try {
      await admin.remove(playlist.id)
      showToast(`Playlist « ${playlist.name} » supprimée`)
      await load()
      void loadLibrary()
    } catch (err) {
      showToast(`Suppression impossible : ${err instanceof Error ? err.message : 'erreur inconnue'}`)
    } finally {
      setBusy(null)
    }
  }

  if (!admin) return <p className="text-sm text-gray-400">Connectez-vous à Navidrome pour gérer les playlists.</p>
  if (playlists === null) {
    return error ? (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-red-400">Playlists indisponibles : {error}</span>
        <button onClick={() => void load()} className="flex items-center gap-1.5 text-gray-300 hover:text-white">
          <RotateCw className="h-3.5 w-3.5" /> Réessayer
        </button>
      </div>
    ) : (
      <p className="text-sm text-gray-400">Chargement…</p>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-400">
        Chaque compte ne voit que ses propres playlists. Choisissez le compte de chaque playlist : elle devient privée, et
        modifiable si elle suivait encore son fichier M3U.
      </p>
      {playlists.length === 0 && <p className="text-sm text-gray-500">Aucune playlist sur le serveur.</p>}
      {playlists.map((p) => (
        <div key={p.id} className={`flex items-center gap-3 rounded-lg border border-surface-border bg-surface-elevated px-4 py-2.5 ${busy === p.id ? 'opacity-60' : ''}`}>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{p.name}</p>
            <p className="truncate text-xs text-gray-400">
              {plural(p.songCount ?? 0, 'titre', 'titres')}
              {tracksEditable(p) ? '' : p.sync ? ' · suit son fichier M3U (non modifiable)' : ' · intelligente'}
            </p>
          </div>
          <select
            value={p.ownerId}
            disabled={busy !== null}
            onChange={(e) => assign(p, e.target.value)}
            title="Compte de la playlist"
            className="max-w-[11rem] rounded border border-surface-border bg-surface-base px-2 py-1 text-xs text-white"
          >
            {!users.some((u) => u.id === p.ownerId) && <option value={p.ownerId}>{p.ownerName || 'compte inconnu'}</option>}
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.userName}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1.5 text-xs text-gray-400" title={p.public ? 'Visible par tous les comptes' : 'Visible par son compte seulement'}>
            <span>{p.public ? 'Publique' : 'Privée'}</span>
            <Switch
              checked={p.public}
              onChange={(on) => void change(p, { public: on }, on ? 'est publique' : 'est privée')}
              label={p.public ? 'Rendre privée' : 'Rendre publique'}
            />
          </div>
          {p.sync ? (
            <button
              disabled={busy !== null}
              onClick={() => void change(p, { sync: false }, 'est modifiable')}
              title="Rendre modifiable : la playlist ne suit plus son fichier M3U"
              className="rounded-full p-1.5 text-yellow-400 transition-colors hover:bg-surface-hover"
            >
              <Lock className="h-4 w-4" />
            </button>
          ) : (
            <span className="p-1.5 text-gray-600" title="Modifiable">
              <LockOpen className="h-4 w-4" />
            </span>
          )}
          <button disabled={busy !== null} onClick={() => setRenaming(p)} title="Renommer" className="rounded-full p-1.5 text-gray-400 transition-colors hover:bg-surface-hover hover:text-white">
            <Pencil className="h-4 w-4" />
          </button>
          <button disabled={busy !== null} onClick={() => setDeleting(p)} title="Supprimer" className="rounded-full p-1.5 text-gray-400 transition-colors hover:bg-surface-hover hover:text-red-400">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}

      <PromptModal
        open={!!renaming}
        title="Renommer la playlist"
        initialValue={renaming?.name ?? ''}
        confirmLabel="Renommer"
        onCancel={() => setRenaming(null)}
        onConfirm={async (value) => {
          const target = renaming
          setRenaming(null)
          if (!target) return
          const name = value.trim()
          if (name && name !== target.name) await change(target, { name }, `renommée en « ${name} »`)
        }}
      />
      <ConfirmModal
        open={!!deleting}
        title="Supprimer la playlist ?"
        description={deleting ? `« ${deleting.name} » (${deleting.ownerName || 'compte inconnu'}) sera définitivement supprimée.` : ''}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const target = deleting
          setDeleting(null)
          if (target) await remove(target)
        }}
      />
    </div>
  )
}
