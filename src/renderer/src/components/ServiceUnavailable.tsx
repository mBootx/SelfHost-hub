import { WifiOff, RotateCw } from 'lucide-react'

interface Props {
  serviceName: string
  message?: string
  onRetry: () => void
  retrying?: boolean
}

export default function ServiceUnavailable({ serviceName, message, onRetry, retrying }: Props): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center animate-fade-in">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-hover">
        <WifiOff className="h-8 w-8 text-gray-400" />
      </div>
      <div>
        <p className="text-lg font-semibold">{serviceName} est indisponible</p>
        <p className="mt-1 max-w-sm text-sm text-gray-400">
          {message || "Impossible de joindre le service. Vérifiez qu'il est démarré et que l'URL est correcte."}
        </p>
      </div>
      <button
        onClick={onRetry}
        disabled={retrying}
        className="flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-60"
      >
        <RotateCw className={`h-4 w-4 ${retrying ? 'animate-spin' : ''}`} />
        Réessayer
      </button>
    </div>
  )
}
