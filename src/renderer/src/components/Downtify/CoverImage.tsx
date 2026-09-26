import { Music } from 'lucide-react'
import { useProxiedImage } from '@renderer/hooks/useProxiedImage'

interface Props {
  url: string | undefined
  className?: string
}

export default function CoverImage({ url, className }: Props): JSX.Element {
  const blobUrl = useProxiedImage(url)

  if (!blobUrl) {
    return (
      <div className={`flex shrink-0 items-center justify-center rounded bg-surface-hover ${className || ''}`}>
        <Music className="h-1/2 w-1/2 text-gray-500" />
      </div>
    )
  }

  return <img src={blobUrl} alt="" className={`shrink-0 rounded object-cover ${className || ''}`} />
}
