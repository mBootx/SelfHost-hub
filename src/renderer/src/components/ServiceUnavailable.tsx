import { useState } from 'react'
import { WifiOff, RotateCw } from 'lucide-react'

interface Props {
  serviceName: string
  message?: string
  onRetry: () => void | Promise<void>
  retrying?: boolean
  /** Shows the login form instead, to sign in to another server or account. */
  onSwitch?: () => void
  /** Opens the view in offline mode without waiting for the server. */
  onOffline?: () => void
}

export default function ServiceUnavailable({ serviceName, message, onRetry, retrying, onSwitch, onOffline }: Props): JSX.Element {
  const [busy, setBusy] = useState(false)
  const spinning = retrying || busy

  async function retry(): Promise<void> {
    setBusy(true)
    try {
      await onRetry()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center animate-fade-in">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-hover">
        <WifiOff className="h-8 w-8 text-gray-400" />
      </div>
      <div>
        <p className="text-lg font-semibold">{serviceName} injoignable</p>
        <p className="mt-1 max-w-sm text-sm text-gray-400">
          {message || "Impossible de joindre le service. Vérifiez qu'il est démarré et que l'URL est correcte."}
        </p>
      </div>
      <button
        onClick={() => void retry()}
        disabled={spinning}
        className="flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-60"
      >
        <RotateCw className={`h-4 w-4 ${spinning ? 'animate-spin' : ''}`} />
        Réessayer
      </button>
      {onOffline && (
        <button
          onClick={onOffline}
          className="rounded-full border border-surface-border bg-surface-elevated px-5 py-2 text-xs font-semibold text-gray-200 transition-colors hover:border-accent hover:text-accent"
        >
          Accéder aux playlists hors ligne
        </button>
      )}
      {onSwitch && (
        <button onClick={onSwitch} className="text-xs text-gray-400 underline hover:text-white">
          Se connecter à un autre serveur ou compte
        </button>
      )}
    </div>
  )
}
