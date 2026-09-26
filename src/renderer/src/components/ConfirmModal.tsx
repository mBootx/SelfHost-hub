import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}

export default function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = 'Supprimer',
  onCancel,
  onConfirm
}: Props): JSX.Element | null {
  const [loading, setLoading] = useState(false)

  if (!open) return null

  async function handleConfirm(): Promise<void> {
    setLoading(true)
    try {
      await onConfirm()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm animate-slide-up space-y-4 rounded-xl bg-surface-elevated p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-full bg-red-500/10 p-2">
            <AlertTriangle className="h-5 w-5 text-red-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-1 text-xs text-gray-400">{description}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-full px-4 py-2 text-xs text-gray-300 hover:text-white">
            Annuler
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="rounded-full bg-red-500 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-600 disabled:opacity-60"
          >
            {loading ? 'Suppression...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
