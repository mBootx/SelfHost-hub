import { FormEvent, useEffect, useState } from 'react'
import ModalShell from '@renderer/components/ModalShell'

interface Props {
  open: boolean
  title: string
  initialValue?: string
  placeholder?: string
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
  placeholder,
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
    <ModalShell title={title} onClose={onCancel} width="max-w-sm">
      <form onSubmit={handleSubmit} className="space-y-4 px-5 pb-5 pt-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          placeholder={placeholder}
          aria-label={title}
          className="w-full rounded-xl border-2 border-surface-border bg-surface-raised px-4 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-gray-500 focus:border-accent"
        />
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:text-white">
            Annuler
          </button>
          <button
            type="submit"
            disabled={loading || !value.trim()}
            className="rounded-full bg-accent px-5 py-2 text-sm font-bold text-black transition-colors hover:bg-accent-hover disabled:bg-surface-hover disabled:text-gray-500"
          >
            {loading ? 'Patientez…' : confirmLabel}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
