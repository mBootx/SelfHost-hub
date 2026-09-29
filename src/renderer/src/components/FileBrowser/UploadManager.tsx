import { useEffect, useRef, useState } from 'react'
import { Upload, X, CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { useUploadStore } from '@renderer/store/uploadStore'

function formatSpeed(bps: number): string {
  const mbps = bps / (1024 * 1024)
  return `${mbps.toFixed(2)} Mo/s`
}

export default function UploadManager(): JSX.Element | null {
  const tasks = useUploadStore((s) => s.tasks)
  const dismiss = useUploadStore((s) => s.dismiss)
  const clearFinished = useUploadStore((s) => s.clearFinished)
  const [collapsed, setCollapsed] = useState(false)
  const autoDismissed = useRef<Set<string>>(new Set())

  useEffect(() => {
    tasks.forEach((t) => {
      if (t.status === 'done' && !autoDismissed.current.has(t.id)) {
        autoDismissed.current.add(t.id)
        setTimeout(() => dismiss(t.id), 4000)
      }
    })
  }, [tasks, dismiss])

  if (tasks.length === 0) return null

  const activeCount = tasks.filter((t) => t.status === 'uploading').length
  const errorCount = tasks.filter((t) => t.status === 'error').length

  let headline = 'Téléversements terminés'
  if (activeCount > 0) headline = `Téléversement de ${activeCount} fichier${activeCount > 1 ? 's' : ''}...`
  else if (errorCount > 0) headline = `Terminé avec ${errorCount} erreur${errorCount > 1 ? 's' : ''}`

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 overflow-hidden rounded-lg border border-surface-border bg-surface-elevated shadow-2xl animate-slide-up">
      <div className="flex items-center justify-between border-b border-surface-border px-3 py-2.5">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left text-sm font-medium text-gray-100"
        >
          {activeCount > 0 ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
          ) : errorCount > 0 ? (
            <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
          ) : (
            <Upload className="h-4 w-4 shrink-0 text-accent" />
          )}
          <span className="truncate">{headline}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? 'Déplier' : 'Réduire'}
            className="rounded p-1 text-gray-400 hover:bg-surface-hover hover:text-white"
          >
            {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          <button
            onClick={clearFinished}
            title="Effacer les terminés"
            className="rounded p-1 text-gray-400 hover:bg-surface-hover hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="max-h-80 overflow-y-auto">
          {tasks.map((t) => {
            const percent = t.sizeBytes ? Math.min(100, Math.round((t.loaded / t.sizeBytes) * 100)) : 0
            return (
              <div key={t.id} className="border-b border-surface-border/50 px-3 py-2.5 last:border-0">
                <div className="mb-1.5 flex items-center gap-2">
                  {t.status === 'uploading' && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />}
                  {t.status === 'done' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent" />}
                  {t.status === 'error' && <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />}
                  <span className="min-w-0 flex-1 truncate text-xs text-gray-200" title={t.filename}>
                    {t.filename}
                  </span>
                  <button onClick={() => dismiss(t.id)} className="shrink-0 text-gray-500 hover:text-white">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {t.status === 'error' ? (
                  <p className="truncate text-[11px] text-red-400" title={t.error}>
                    {t.error || 'Échec du téléversement'}
                  </p>
                ) : (
                  <>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
                      <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{ width: `${t.status === 'done' ? 100 : percent}%` }}
                      />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-gray-500">
                      <span>{t.status === 'done' ? 'Terminé' : `${percent}%`}</span>
                      {t.status === 'uploading' && t.speedBps > 0 && <span>{formatSpeed(t.speedBps)}</span>}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
