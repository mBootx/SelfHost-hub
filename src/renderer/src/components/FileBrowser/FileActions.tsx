import { useState } from 'react'
import { Download, Trash2, Pencil, Link2, Check } from 'lucide-react'
import { FBItem } from '@renderer/services/filebrowser'
import { useFileBrowserStore } from '@renderer/store/filebrowserStore'
import { downloadAndRecord } from '@renderer/store/downloadStore'

interface Props {
  item: FBItem
  onRequestRename: () => void
  onRequestDelete: () => void
}

export default function FileActions({ item, onRequestRename, onRequestDelete }: Props): JSX.Element {
  const client = useFileBrowserStore((s) => s.client)
  const [copied, setCopied] = useState(false)

  if (!client) return <></>

  function handleCopyLink(): void {
    navigator.clipboard.writeText(client!.rawUrl(item.path))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
      {!item.isDir && (
        <button
          onClick={() => downloadAndRecord(client!, item)}
          title="Télécharger"
          className="text-gray-400 hover:text-white"
        >
          <Download className="h-4 w-4" />
        </button>
      )}
      <button onClick={handleCopyLink} title="Copier le lien" className="text-gray-400 hover:text-white">
        {copied ? <Check className="h-4 w-4 text-accent" /> : <Link2 className="h-4 w-4" />}
      </button>
      <button onClick={onRequestRename} title="Renommer" className="text-gray-400 hover:text-white">
        <Pencil className="h-4 w-4" />
      </button>
      <button onClick={onRequestDelete} title="Supprimer" className="text-gray-400 hover:text-red-400">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  )
}
