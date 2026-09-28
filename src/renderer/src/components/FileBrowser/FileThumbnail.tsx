import { useState } from 'react'
import { FileBrowserClient } from '@renderer/services/filebrowser'

interface Props {
  client: FileBrowserClient
  path: string
  className?: string
}

/** Loads the server's small preview instead of the full-size original, falling back to the original if that fails. */
export default function FileThumbnail({ client, path, className }: Props): JSX.Element {
  const [useOriginal, setUseOriginal] = useState(false)

  return (
    <img
      src={useOriginal ? client.rawUrl(path) : client.thumbnailUrl(path)}
      alt=""
      loading="lazy"
      decoding="async"
      className={className}
      onError={() => setUseOriginal(true)}
    />
  )
}
