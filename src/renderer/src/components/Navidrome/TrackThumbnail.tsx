import { Play } from 'lucide-react'

interface Props {
  coverUrl: string | null
  isCurrent: boolean
  isPlaying: boolean
  onPlay: () => void
  size?: string
}

export default function TrackThumbnail({ coverUrl, isCurrent, isPlaying, onPlay, size = 'h-10 w-10' }: Props): JSX.Element {
  return (
    <button onClick={onPlay} className={`group/thumb relative block shrink-0 overflow-hidden rounded ${size}`}>
      {coverUrl ? (
        <img src={coverUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full bg-surface-hover" />
      )}
      <span
        className={`absolute inset-0 flex items-center justify-center bg-black/50 transition-opacity duration-150 ${
          isCurrent ? 'opacity-100' : 'opacity-0 group-hover/thumb:opacity-100'
        }`}
      >
        {isCurrent && isPlaying ? (
          <span className="flex h-3 items-end gap-[2px]">
            <span className="eq-bar h-full w-[2.5px] rounded-sm bg-accent" style={{ animationDelay: '0ms' }} />
            <span className="eq-bar h-full w-[2.5px] rounded-sm bg-accent" style={{ animationDelay: '180ms' }} />
            <span className="eq-bar h-full w-[2.5px] rounded-sm bg-accent" style={{ animationDelay: '360ms' }} />
          </span>
        ) : (
          <Play className="h-4 w-4 scale-90 fill-white text-white transition-transform duration-150 group-hover/thumb:scale-110" />
        )}
      </span>
    </button>
  )
}
