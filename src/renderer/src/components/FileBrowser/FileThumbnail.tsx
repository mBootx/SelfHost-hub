import { useMemo, useState } from 'react'
import { FileBrowserClient } from '@renderer/services/filebrowser'

interface Props {
  client: FileBrowserClient
  path: string
  className?: string
}

/**
 * Loads the server's small preview instead of the full-size original: at the route this FileBrowser version
 * uses, then the other one, then the original if the server can't make a thumbnail at all.
 */
export default function FileThumbnail({ client, path, className }: Props): JSX.Element {
  const candidates = useMemo(() => [...client.previewUrls(path), client.rawUrl(path)], [client, path])
  const [stage, setStage] = useState(0)

  return (
    <img
      src={candidates[Math.min(stage, candidates.length - 1)]}
      alt=""
      loading="lazy"
      decoding="async"
      className={className}
      onLoad={() => {
        if (stage < candidates.length - 1) client.notePreviewWorked(candidates[stage])
      }}
      onError={() => setStage((current) => Math.min(current + 1, candidates.length - 1))}
    />
  )
}
