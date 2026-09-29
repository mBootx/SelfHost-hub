import { Sparkles } from 'lucide-react'
import { useWhatsNewStore } from '@renderer/store/whatsNewStore'

export default function WhatsNewModal(): JSX.Element | null {
  const notes = useWhatsNewStore((s) => s.notes)
  const dismiss = useWhatsNewStore((s) => s.dismiss)

  if (!notes || notes.length === 0) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={dismiss}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-md animate-slide-up flex-col rounded-xl bg-surface-elevated p-5 shadow-2xl"
        role="dialog"
        aria-label="Nouveautés"
      >
        <div className="flex items-center gap-3">
          <div className="shrink-0 rounded-full bg-accent/10 p-2">
            <Sparkles className="h-5 w-5 text-accent" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Nouveautés</h2>
            <p className="text-xs text-gray-400">
              {notes.length === 1 ? `Version ${notes[0].version}` : 'Dernières mises à jour'}
            </p>
          </div>
        </div>
        <div className="mt-4 min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          {notes.map((note) => (
            <section key={note.version} className="space-y-3">
              {notes.length > 1 && (
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Version {note.version}</h3>
              )}
              <ul className="space-y-3">
                {note.items.map((item) => (
                  <li key={item.title} className="flex gap-2.5">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-white">{item.title}</p>
                      <p className="mt-0.5 text-xs text-gray-400">{item.text}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="mt-5 flex justify-end">
          <button
            onClick={dismiss}
            className="rounded-full bg-accent px-5 py-2 text-xs font-semibold text-black transition-colors hover:bg-accent-hover"
          >
            Continuer
          </button>
        </div>
      </div>
    </div>
  )
}
