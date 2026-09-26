import { FormEvent, useEffect, useState } from 'react'
import { X } from 'lucide-react'

interface Props {
  open: boolean
  title: string
  initialValue?: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: (value: string) => void | Promise<void>
}

/**
 * Electron never implements window.prompt() (unlike alert/confirm, which do
 * show a native dialog) - it silently returns without ever rendering anything.
 * Any "type a name" flow needs a real modal like this one instead.
 */
export default function PromptModal({
  open,
  title,
  initialValue = '',
  confirmLabel = 'Valider',
  onCancel,
  onConfirm
}: Props): JSX.Element | null {
  const [value, setValue] = useState(initialValue)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      setValue(initialValue)
      setLoading(false)
    }
  }, [open, initialValue])

  if (!open) return null

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed || loading) return
    setLoading(true)
    try {
      await onConfirm(trimmed)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm animate-slide-up space-y-3 rounded-xl bg-surface-elevated p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" onClick={onCancel} className="rounded p-1 text-gray-400 hover:text-white" aria-label="Fermer">
            <X className="h-4 w-4" />
          </button>
        </div>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={loading || !value.trim()}
          className="w-full rounded-full bg-accent py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {loading ? 'Patientez...' : confirmLabel}
        </button>
      </form>
    </div>
  )
}
