import { RotateCw } from 'lucide-react'

/** An album, artist or playlist that could not be loaded: why, and a way to try again (it used to say "Chargement…" for ever). */
export default function LoadFailed({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 p-12 text-center animate-fade-in">
      <p className="text-lg font-semibold">{what}</p>
      <p className="max-w-sm text-sm text-gray-400">{error}</p>
      <button
        onClick={onRetry}
        className="flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover"
      >
        <RotateCw className="h-4 w-4" />
        Réessayer
      </button>
    </div>
  )
}
