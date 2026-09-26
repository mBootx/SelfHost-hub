import { useToastStore } from '@renderer/store/toastStore'

/** Mounted once at the app root, alongside the other global overlays. */
export default function ToastHost(): JSX.Element | null {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[100] flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className="pointer-events-auto animate-fade-in rounded-full bg-surface-elevated px-4 py-2 text-sm text-white shadow-2xl"
        >
          {t.message}
        </button>
      ))}
    </div>
  )
}
