import { FileWarning } from 'lucide-react'
import type { ConflictChoice } from '@renderer/services/uploadNames'

interface Props {
  /** How many of the picked files already exist in the folder, and the name of the first. */
  count: number
  first: string
  onChoose: (choice: ConflictChoice) => void
  onCancel: () => void
}

/** Asked before anything is sent when a picked file has the name of one already in the folder. */
export default function UploadConflictModal({ count, first, onChoose, onCancel }: Props): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md animate-slide-up space-y-4 rounded-xl bg-surface-elevated p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-full bg-yellow-500/10 p-2">
            <FileWarning className="h-5 w-5 text-yellow-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{count === 1 ? 'Ce fichier existe déjà' : `${count} fichiers existent déjà`}</h2>
            <p className="mt-1 break-words text-xs text-gray-400">
              {count === 1
                ? `« ${first} » est déjà dans ce dossier.`
                : `« ${first} » et ${count - 1} autre${count > 2 ? 's' : ''} sont déjà dans ce dossier.`}{' '}
              Que faire ?
            </p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button onClick={onCancel} className="rounded-full px-4 py-2 text-xs text-gray-300 hover:text-white">
            Annuler
          </button>
          <button onClick={() => onChoose('skip')} className="rounded-full border border-surface-border px-4 py-2 text-xs text-gray-200 hover:bg-surface-hover">
            Ignorer
          </button>
          <button onClick={() => onChoose('keep-both')} className="rounded-full border border-surface-border px-4 py-2 text-xs text-gray-200 hover:bg-surface-hover">
            Garder les deux
          </button>
          <button onClick={() => onChoose('replace')} className="rounded-full bg-red-500 px-4 py-2 text-xs font-semibold text-white hover:bg-red-600">
            Remplacer
          </button>
        </div>
      </div>
    </div>
  )
}
