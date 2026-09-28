import { useEffect, useState } from 'react'
import {
  Folder,
  File as FileIcon,
  Image as ImageIcon,
  Video,
  Music,
  FileText,
  FileType,
  List,
  LayoutGrid,
  Upload,
  FolderPlus,
  LogOut,
  ChevronRight,
  ArrowLeft,
  ArrowRight,
  X,
  Search,
  Download as DownloadIcon,
  FolderOpen,
  Pencil,
  Link2,
  Trash2,
  RefreshCw,
  Eye
} from 'lucide-react'
import { useFileBrowserStore } from '@renderer/store/filebrowserStore'
import { useUploadStore } from '@renderer/store/uploadStore'
import { useToastStore } from '@renderer/store/toastStore'
import { downloadAndRecord } from '@renderer/store/downloadStore'
import { FBItem } from '@renderer/services/filebrowser'
import FileActions from './FileActions'
import UsageMeter from './UsageMeter'
import FolderThumbnail from './FolderThumbnail'
import FileThumbnail from './FileThumbnail'
import ContextMenu, { ContextMenuItem } from '@renderer/components/ContextMenu'
import PromptModal from '@renderer/components/PromptModal'
import ConfirmModal from '@renderer/components/ConfirmModal'
import ServiceUnavailable from '@renderer/components/ServiceUnavailable'

const DRAG_MIME = 'application/x-fb-item-path'

function formatSize(bytes: number): string {
  if (!bytes) return '-'
  const units = ['o', 'Ko', 'Mo', 'Go', 'To']
  let i = 0
  let value = bytes
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

function isPdf(item: FBItem): boolean {
  return (item.type || '').includes('pdf') || item.name.toLowerCase().endsWith('.pdf')
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}

function iconFor(item: FBItem): JSX.Element {
  if (item.isDir) return <Folder className="h-5 w-5 shrink-0 text-blue-400" />
  if (isPdf(item)) return <FileType className="h-5 w-5 shrink-0 text-red-400" />
  const type = item.type || ''
  if (type.includes('image')) return <ImageIcon className="h-5 w-5 shrink-0 text-purple-400" />
  if (type.includes('video')) return <Video className="h-5 w-5 shrink-0 text-pink-400" />
  if (type.includes('audio')) return <Music className="h-5 w-5 shrink-0 text-green-400" />
  if (type.includes('text')) return <FileText className="h-5 w-5 shrink-0 text-gray-400" />
  return <FileIcon className="h-5 w-5 shrink-0 text-gray-400" />
}

function PreviewModal({ item, onClose }: { item: FBItem; onClose: () => void }): JSX.Element {
  const client = useFileBrowserStore((s) => s.client)!
  const [text, setText] = useState<string | null>(null)
  const type = item.type || ''
  const pdf = isPdf(item)

  useEffect(() => {
    if (type.includes('text')) client.getTextPreview(item.path).then(setText)
  }, [item.path])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8 animate-fade-in" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-surface-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-6 border-b border-surface-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {iconFor(item)}
            <p className="truncate text-sm font-medium">{item.name}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              onClick={() => downloadAndRecord(client, item)}
              title="Telecharger"
              className="text-gray-400 hover:text-white"
            >
              <DownloadIcon className="h-4 w-4" />
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/20 p-4">
          {type.includes('image') && (
            <img src={client.rawUrl(item.path)} alt="" className="max-h-[75vh] max-w-full rounded object-contain" />
          )}
          {type.includes('video') && (
            <video
              src={client.rawUrl(item.path)}
              controls
              autoPlay
              className="max-h-[75vh] max-w-full rounded shadow-lg"
            />
          )}
          {type.includes('audio') && (
            <div className="flex w-full max-w-md flex-col items-center gap-4 p-6">
              <div className="flex h-32 w-32 items-center justify-center rounded-full bg-surface-hover">
                <Music className="h-12 w-12 text-green-400" />
              </div>
              <p className="truncate text-sm text-gray-300">{item.name}</p>
              <audio src={client.rawUrl(item.path)} controls autoPlay className="w-full" />
            </div>
          )}
          {pdf && (
            <iframe title={item.name} src={client.rawUrl(item.path)} className="h-[75vh] w-full rounded bg-white" />
          )}
          {type.includes('text') && (
            <pre className="h-[70vh] w-full max-w-3xl overflow-auto whitespace-pre-wrap rounded bg-surface-raised p-4 text-xs text-gray-300">
              {text ?? 'Chargement...'}
            </pre>
          )}
          {!type.includes('image') && !type.includes('video') && !type.includes('audio') && !pdf && !type.includes('text') && (
            <div className="flex flex-col items-center gap-3 py-12 text-gray-500">
              <FileIcon className="h-12 w-12" />
              <p className="text-sm">Aucun apercu disponible pour ce type de fichier.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function FileExplorer(): JSX.Element {
  const { status, currentPath, items, viewMode, loading } = useFileBrowserStore()
  const navigate = useFileBrowserStore((s) => s.navigate)
  const goBack = useFileBrowserStore((s) => s.goBack)
  const goForward = useFileBrowserStore((s) => s.goForward)
  const canGoBack = useFileBrowserStore((s) => s.canGoBack)
  const canGoForward = useFileBrowserStore((s) => s.canGoForward)
  const refresh = useFileBrowserStore((s) => s.refresh)
  const setViewMode = useFileBrowserStore((s) => s.setViewMode)
  const client = useFileBrowserStore((s) => s.client)
  const logout = useFileBrowserStore((s) => s.logout)
  const restoreSession = useFileBrowserStore((s) => s.restoreSession)

  const [filter, setFilter] = useState('')
  const [preview, setPreview] = useState<FBItem | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null)
  const [draggingPath, setDraggingPath] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FBItem | null } | null>(null)
  const [prompt, setPrompt] = useState<{ mode: 'newFolder' } | { mode: 'rename'; item: FBItem } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FBItem | null>(null)
  const uploadTasks = useUploadStore((s) => s.tasks)
  const addUploadTask = useUploadStore((s) => s.addTask)
  const markUploadDone = useUploadStore((s) => s.markDone)
  const markUploadError = useUploadStore((s) => s.markError)
  const showToast = useToastStore((s) => s.show)
  const uploading = uploadTasks.some((t) => t.status === 'uploading')

  if (status === 'unavailable' || status === 'error') {
    return <ServiceUnavailable serviceName="FileBrowser" onRetry={() => restoreSession()} />
  }

  const crumbs = currentPath.split('/').filter(Boolean)
  const filtered = items.filter((i) => i.name.toLowerCase().includes(filter.toLowerCase()))
  const folderCount = filtered.filter((i) => i.isDir).length
  const fileCount = filtered.length - folderCount

  async function uploadFilesTo(fileList: { path: string; name: string; size: number }[], destDir: string): Promise<void> {
    if (!client) return
    await Promise.all(
      fileList.map(async (f) => {
        const id = crypto.randomUUID()
        addUploadTask({ id, filename: f.name, destPath: destDir, sizeBytes: f.size })
        try {
          await client.uploadLocalFile(f.path, destDir, f.name, id)
          markUploadDone(id)
        } catch (err: any) {
          markUploadError(id, err?.message || 'Echec du televersement')
        }
      })
    )
    await refresh()
  }

  async function handleDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.types.includes(DRAG_MIME)) return
    const files = Array.from(e.dataTransfer.files)
    await uploadFilesTo(
      files
        .map((f) => ({ path: window.api.fb.getPathForFile(f), name: f.name, size: f.size }))
        .filter((f) => f.path),
      currentPath
    )
  }

  async function handleDropOnFolder(e: React.DragEvent, folder: FBItem): Promise<void> {
    e.preventDefault()
    e.stopPropagation()
    setDragOverFolder(null)
    setDragOver(false)
    if (!client) return

    const draggedItemPath = e.dataTransfer.getData(DRAG_MIME)
    if (draggedItemPath) {
      if (draggedItemPath === folder.path || folder.path.startsWith(`${draggedItemPath}/`)) return
      const newPath = `${folder.path}/${basename(draggedItemPath)}`
      try {
        await client.rename(draggedItemPath, newPath)
        await refresh()
        showToast(`Deplace vers "${folder.name}"`)
      } catch (err: any) {
        showToast(err?.message || 'Impossible de deplacer cet element')
      }
      return
    }

    const files = Array.from(e.dataTransfer.files)
    await uploadFilesTo(
      files
        .map((f) => ({ path: window.api.fb.getPathForFile(f), name: f.name, size: f.size }))
        .filter((f) => f.path),
      folder.path
    )
  }

  async function handlePickUpload(): Promise<void> {
    if (!client) return
    const picked = await client.pickFiles()
    const files = picked.map((p) => ({ path: p.path, name: p.path.split(/[\\/]/).pop() || 'fichier', size: p.size }))
    await uploadFilesTo(files, currentPath)
  }

  async function handleNewFolder(name: string): Promise<void> {
    if (!client) return
    try {
      await client.createFolder(`${currentPath}/${name}`)
      await refresh()
      showToast(`Dossier "${name}" cree`)
    } catch (err: any) {
      showToast(err?.message || 'Impossible de creer le dossier')
    } finally {
      setPrompt(null)
    }
  }

  function handleItemClick(item: FBItem): void {
    if (item.isDir) navigate(item.path)
    else setPreview(item)
  }

  async function handleRename(item: FBItem, name: string): Promise<void> {
    if (!client || name === item.name) {
      setPrompt(null)
      return
    }
    const parent = item.path.split('/').slice(0, -1).join('/')
    try {
      await client.rename(item.path, `${parent}/${name}`)
      await refresh()
      showToast(`Renomme en "${name}"`)
    } catch (err: any) {
      showToast(err?.message || 'Impossible de renommer')
    } finally {
      setPrompt(null)
    }
  }

  async function handleDeleteItem(item: FBItem): Promise<void> {
    if (!client) return
    try {
      await client.remove(item.path)
      await refresh()
      showToast(`"${item.name}" supprime`)
    } catch (err: any) {
      showToast(err?.message || 'Impossible de supprimer')
    } finally {
      setDeleteTarget(null)
    }
  }

  function handleCopyLinkItem(item: FBItem): void {
    if (!client) return
    navigator.clipboard.writeText(client.rawUrl(item.path))
    showToast('Lien copie')
  }

  function buildContextMenuItems(item: FBItem | null): ContextMenuItem[] {
    if (!item) {
      return [
        { label: 'Nouveau dossier', icon: FolderPlus, onClick: () => setPrompt({ mode: 'newFolder' }) },
        { label: 'Uploader des fichiers', icon: Upload, onClick: handlePickUpload },
        { label: 'Actualiser', icon: RefreshCw, onClick: () => refresh(), separatorBefore: true }
      ]
    }
    const openItem: ContextMenuItem = item.isDir
      ? { label: 'Ouvrir', icon: FolderOpen, onClick: () => navigate(item.path) }
      : { label: 'Apercu', icon: Eye, onClick: () => setPreview(item) }
    const items: ContextMenuItem[] = [openItem]
    if (!item.isDir) {
      items.push({
        label: 'Telecharger',
        icon: DownloadIcon,
        onClick: () => {
          if (client) downloadAndRecord(client, item)
        }
      })
    }
    items.push(
      { label: 'Copier le lien', icon: Link2, onClick: () => handleCopyLinkItem(item) },
      { label: 'Renommer', icon: Pencil, onClick: () => setPrompt({ mode: 'rename', item }) },
      { label: 'Supprimer', icon: Trash2, onClick: () => setDeleteTarget(item), danger: true, separatorBefore: true }
    )
    return items
  }

  function dragHandlers(item: FBItem): {
    draggable: boolean
    onDragStart: (e: React.DragEvent) => void
    onDragEnd: () => void
    onDragOver?: (e: React.DragEvent) => void
    onDragLeave?: () => void
    onDrop?: (e: React.DragEvent) => void
  } {
    const base = {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(DRAG_MIME, item.path)
        e.dataTransfer.effectAllowed = 'move'
        setDraggingPath(item.path)
      },
      onDragEnd: () => setDraggingPath(null)
    }
    if (!item.isDir) return base
    return {
      ...base,
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (draggingPath && draggingPath !== item.path) setDragOverFolder(item.path)
      },
      onDragLeave: () => setDragOverFolder((p) => (p === item.path ? null : p)),
      onDrop: (e: React.DragEvent) => handleDropOnFolder(e, item)
    }
  }

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        if (!e.dataTransfer.types.includes(DRAG_MIME)) setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onContextMenu={(e) => {
        e.preventDefault()
        setContextMenu({ x: e.clientX, y: e.clientY, item: null })
      }}
    >
      <div className="flex items-center justify-between border-b border-surface-border px-6 py-3">
        <div className="flex items-center gap-1 text-sm text-gray-300">
          <button
            onClick={() => goBack()}
            disabled={!canGoBack}
            title="Precedent"
            className="rounded-full p-1.5 text-gray-400 transition-colors hover:bg-surface-hover hover:text-white disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => goForward()}
            disabled={!canGoForward}
            title="Suivant"
            className="mr-2 rounded-full p-1.5 text-gray-400 transition-colors hover:bg-surface-hover hover:text-white disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ArrowRight className="h-4 w-4" />
          </button>
          <button onClick={() => navigate('/')} className="hover:text-white">
            Racine
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 text-gray-600" />
              <button onClick={() => navigate('/' + crumbs.slice(0, i + 1).join('/'))} className="hover:text-white">
                {c}
              </button>
            </span>
          ))}
        </div>
        <button
          onClick={() => logout()}
          className="flex items-center gap-1.5 rounded-full border border-surface-border px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-red-500 hover:text-red-400"
        >
          <LogOut className="h-3.5 w-3.5" /> Se deconnecter
        </button>
      </div>

      <div className="px-6 pt-3">
        <UsageMeter />
      </div>

      <div className="flex items-center justify-between gap-3 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex w-64 items-center gap-2 rounded-full bg-surface-hover px-4 py-2">
            <Search className="h-4 w-4 text-gray-400" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Rechercher dans ce dossier..."
              className="w-full bg-transparent text-sm outline-none placeholder:text-gray-500"
            />
          </div>
          {!loading && (
            <span className="hidden text-xs text-gray-500 sm:inline">
              {folderCount} dossier{folderCount !== 1 ? 's' : ''}, {fileCount} fichier{fileCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPrompt({ mode: 'newFolder' })}
            className="flex items-center gap-1.5 rounded-full border border-surface-border px-3 py-1.5 text-xs text-gray-300 hover:border-accent hover:text-accent"
          >
            <FolderPlus className="h-3.5 w-3.5" /> Nouveau dossier
          </button>
          <button
            onClick={handlePickUpload}
            disabled={uploading}
            className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-accent-hover disabled:opacity-60"
          >
            <Upload className="h-3.5 w-3.5" /> {uploading ? 'Envoi...' : 'Uploader'}
          </button>
          <div className="ml-2 flex rounded-full border border-surface-border p-0.5">
            <button
              onClick={() => setViewMode('list')}
              className={`rounded-full p-1.5 transition-colors ${viewMode === 'list' ? 'bg-surface-hover text-white' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              className={`rounded-full p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-surface-hover text-white' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {dragOver && (
          <div className="pointer-events-none absolute inset-4 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10 text-sm font-medium text-accent">
            Deposez les fichiers pour les uploader dans {currentPath === '/' ? 'la racine' : basename(currentPath)}
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center gap-3 py-16 text-gray-500">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-surface-hover border-t-accent" />
            <p className="text-sm">Chargement...</p>
          </div>
        )}

        {!loading && viewMode === 'list' && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="py-2 font-medium">Nom</th>
                <th className="py-2 font-medium">Taille</th>
                <th className="py-2 font-medium">Modifie</th>
                <th className="py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr
                  key={item.path}
                  onClick={() => handleItemClick(item)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setContextMenu({ x: e.clientX, y: e.clientY, item })
                  }}
                  className={`group cursor-pointer border-b border-surface-border/50 transition-colors hover:bg-surface-hover ${
                    dragOverFolder === item.path ? 'bg-accent/10 ring-1 ring-inset ring-accent' : ''
                  } ${draggingPath === item.path ? 'opacity-40' : ''}`}
                  {...dragHandlers(item)}
                >
                  <td className="flex items-center gap-2 py-2.5">
                    {iconFor(item)}
                    <span className="truncate">{item.name}</span>
                  </td>
                  <td className="py-2.5 text-gray-400">{item.isDir ? '-' : formatSize(item.size)}</td>
                  <td className="py-2.5 text-gray-400">{new Date(item.modified).toLocaleString('fr-FR')}</td>
                  <td className="py-2.5">
                    <FileActions
                      item={item}
                      onRequestRename={() => setPrompt({ mode: 'rename', item })}
                      onRequestDelete={() => setDeleteTarget(item)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && viewMode === 'grid' && (
          <div className="grid grid-cols-3 gap-3 pt-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {filtered.map((item) => (
              <div
                key={item.path}
                onClick={() => handleItemClick(item)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setContextMenu({ x: e.clientX, y: e.clientY, item })
                }}
                className={`group flex cursor-pointer flex-col items-center gap-2 rounded-md p-3 text-center transition-all hover:scale-[1.03] hover:bg-surface-hover ${
                  dragOverFolder === item.path ? 'bg-accent/10 ring-1 ring-accent' : ''
                } ${draggingPath === item.path ? 'opacity-40' : ''}`}
                {...dragHandlers(item)}
              >
                {item.isDir && client ? (
                  <FolderThumbnail client={client} folder={item} className="h-16 w-16" />
                ) : item.type?.includes('image') && client ? (
                  <FileThumbnail client={client} path={item.path} className="h-16 w-16 rounded object-cover" />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded bg-surface-hover">
                    {iconFor(item)}
                  </div>
                )}
                <span className="w-full truncate text-xs">{item.name}</span>
                <FileActions
                  item={item}
                  onRequestRename={() => setPrompt({ mode: 'rename', item })}
                  onRequestDelete={() => setDeleteTarget(item)}
                />
              </div>
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-gray-500">
            <FolderOpen className="h-10 w-10" />
            <p className="text-sm">{filter ? 'Aucun resultat pour cette recherche.' : 'Ce dossier est vide.'}</p>
          </div>
        )}
      </div>

      {preview && <PreviewModal item={preview} onClose={() => setPreview(null)} />}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextMenuItems(contextMenu.item)}
          onClose={() => setContextMenu(null)}
        />
      )}

      <PromptModal
        open={!!prompt}
        title={prompt?.mode === 'rename' ? 'Renommer' : 'Nouveau dossier'}
        initialValue={prompt?.mode === 'rename' ? prompt.item.name : ''}
        confirmLabel={prompt?.mode === 'rename' ? 'Renommer' : 'Creer'}
        onCancel={() => setPrompt(null)}
        onConfirm={(name) => (prompt?.mode === 'rename' ? handleRename(prompt.item, name) : handleNewFolder(name))}
      />
      <ConfirmModal
        open={!!deleteTarget}
        title="Supprimer ?"
        description={deleteTarget ? `"${deleteTarget.name}" sera definitivement supprime.` : ''}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => (deleteTarget ? handleDeleteItem(deleteTarget) : undefined)}
      />
    </div>
  )
}
