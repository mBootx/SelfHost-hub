import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'

/** Shown once a newer build has finished downloading in the background. */
export default function UpdateBanner(): JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    window.api.updater.downloadedVersion().then((v) => {
      if (v) setVersion(v)
    })
    return window.api.updater.onDownloaded((info) => {
      setVersion(info.version)
      setDismissed(false)
    })
  }, [])

  if (!version || dismissed) return null

  return (
    <div className="fixed right-4 top-4 z-40 flex w-80 animate-slide-up items-start gap-3 rounded-lg border border-surface-border bg-surface-elevated p-4 shadow-2xl">
      <Download className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Mise à jour {version} prête</p>
        <p className="mt-0.5 text-xs text-gray-400">Elle s'installera à la fermeture de l'application.</p>
        <button
          onClick={() => window.api.updater.installNow()}
          className="mt-3 rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-accent-hover"
        >
          Redémarrer maintenant
        </button>
      </div>
      <button onClick={() => setDismissed(true)} aria-label="Plus tard" className="rounded p-1 text-gray-400 hover:text-white">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
