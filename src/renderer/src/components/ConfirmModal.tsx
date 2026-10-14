import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import ModalShell from '@renderer/components/ModalShell'

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
    <ModalShell
      title={title}
      onClose={onCancel}
      width="max-w-sm"
      leading={
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/15">
          <AlertTriangle className="h-5 w-5 text-red-400" />
        </div>
      }
    >
      <div className="space-y-5 px-5 pb-5 pt-1">
        <p className="text-sm leading-relaxed text-gray-400">{description}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-full px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:text-white">
            Annuler
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="rounded-full bg-red-500 px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-red-600 disabled:opacity-60"
          >
            {loading ? 'Suppression…' : confirmLabel}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
