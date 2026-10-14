import { ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'

interface Props {
  title: string
  subtitle?: string
  /** Something left of the title: a cover, an icon tile. */
  leading?: ReactNode
  onClose: () => void
  /** Tailwind max-width of the card. */
  width?: string
  children: ReactNode
}

/**
 * The window every dialog of the app is drawn in: a dimmed, blurred backdrop, a rounded card that slides in, a title
 * with an optional line under it, and a close button. Escape or a click outside closes it. Surfaces and the accent come
 * from the theme's CSS variables, so a colour change in Settings reaches it.
 */
export default function ModalShell({ title, subtitle, leading, onClose, width = 'max-w-md', children }: Props): JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[85vh] w-full ${width} animate-slide-up flex-col overflow-hidden rounded-2xl border border-surface-border bg-surface-elevated shadow-2xl shadow-black/60`}
      >
        <div className="flex items-center gap-3 px-5 pb-3 pt-5">
          {leading}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold tracking-tight">{title}</h2>
            {subtitle && <p className="truncate text-xs text-gray-400">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-gray-300 transition-colors hover:bg-surface-border hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
