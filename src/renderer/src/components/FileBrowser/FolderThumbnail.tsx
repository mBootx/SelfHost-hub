import { useEffect, useState } from 'react'
import { Folder } from 'lucide-react'
import { FileBrowserClient, FBItem } from '@renderer/services/filebrowser'

const imageCache = new Map<string, string[]>()

interface Props {
  client: FileBrowserClient
  folder: FBItem
  className?: string
}

/** Peeks into a folder's contents once and shows a collage of the images found inside (like a music folder's covers), falling back to a plain folder icon. */
export default function FolderThumbnail({ client, folder, className }: Props): JSX.Element {
  const [images, setImages] = useState<string[] | null>(imageCache.get(folder.path) || null)

  useEffect(() => {
    if (imageCache.has(folder.path)) return
    let cancelled = false
    client
      .list(folder.path)
      .then((children) => {
        const covers = children
          .filter((c) => !c.isDir && (c.type || '').includes('image'))
          .slice(0, 4)
          .map((c) => client.rawUrl(c.path))
        imageCache.set(folder.path, covers)
        if (!cancelled) setImages(covers)
      })
      .catch(() => {
        if (!cancelled) setImages([])
      })
    return () => {
      cancelled = true
    }
  }, [folder.path])

  if (!images || images.length === 0) {
    return (
      <div className={`flex items-center justify-center rounded bg-surface-hover ${className || ''}`}>
        <Folder className="h-1/2 w-1/2 text-blue-400" />
      </div>
    )
  }

  if (images.length === 1) {
    return (
      <div className={`overflow-hidden rounded ${className || ''}`}>
        <img src={images[0]} alt="" className="h-full w-full object-cover" />
      </div>
    )
  }

  return (
    <div className={`grid grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden rounded ${className || ''}`}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="bg-surface-hover">
          {images[i] && <img src={images[i]} alt="" className="h-full w-full object-cover" />}
        </div>
      ))}
    </div>
  )
}
