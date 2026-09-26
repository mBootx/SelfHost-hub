import { FormEvent, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useFileBrowserStore } from '@renderer/store/filebrowserStore'

export default function FileBrowserLoginPage(): JSX.Element {
  const connect = useFileBrowserStore((s) => s.connect)
  const [url, setUrl] = useState('http://localhost:8080')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await connect(url, username, password, remember)
    } catch (err: any) {
      setError(err?.message || 'Connexion impossible')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-b from-surface-raised to-surface-base">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm animate-slide-up space-y-5 rounded-xl bg-surface-elevated p-8 shadow-2xl"
      >
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500">
            <FolderOpen className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-xl font-bold">Connexion a FileBrowser</h1>
          <p className="text-center text-sm text-gray-400">Interface OpenMediaVault</p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">URL du serveur</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:8080"
              className="w-full rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-blue-500"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">Nom d'utilisateur</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-blue-500"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">Mot de passe</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-blue-500"
              required
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Se souvenir de moi (chiffre localement)
        </label>

        {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-full bg-blue-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-400 disabled:opacity-60"
        >
          {loading ? 'Connexion...' : 'Se connecter'}
        </button>
      </form>
    </div>
  )
}
