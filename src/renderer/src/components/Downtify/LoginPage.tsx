import { FormEvent, useState } from 'react'
import { Download } from 'lucide-react'
import { useDowntifyStore } from '@renderer/store/downtifyStore'

export default function DowntifyLoginPage(): JSX.Element {
  const connect = useDowntifyStore((s) => s.connect)
  const [url, setUrl] = useState('http://localhost:9090')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await connect(url, remember)
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
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-500">
            <Download className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-xl font-bold">Connexion a Downtify</h1>
          <p className="text-center text-sm text-gray-400">Gestionnaire de telechargements</p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">URL du service</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:9090"
              className="w-full rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-orange-500"
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
          className="w-full rounded-full bg-orange-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-400 disabled:opacity-60"
        >
          {loading ? 'Connexion...' : 'Se connecter'}
        </button>
      </form>
    </div>
  )
}
