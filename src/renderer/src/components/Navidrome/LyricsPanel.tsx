import { memo, useEffect, useRef } from 'react'
import { Sparkles } from 'lucide-react'
import { LyricLine, activeLineIndex } from '@renderer/services/lyrics'
import { useNavidromeStore } from '@renderer/store/navidromeStore'

interface Props {
  lines: LyricLine[] | null
  plain: string | null
  loading: boolean
  searching: boolean
  onSeek: (seconds: number) => void
  onAutoSearch: () => void
}

type LineState = 'past' | 'active' | 'upcoming'

/**
 * Memoised per line: the playhead ticks several times a second, but only the two
 * lines whose state actually flips need to redraw, not the whole lyric sheet.
 */
const Line = memo(function Line({
  text,
  state,
  onPress,
  innerRef
}: {
  text: string
  state: LineState
  onPress: () => void
  innerRef: React.Ref<HTMLButtonElement>
}): JSX.Element {
  return (
    <button
      ref={innerRef}
      onClick={onPress}
      title="Aller a ce passage"
      className={`block w-full text-left text-sm leading-snug transition-colors ${
        state === 'active'
          ? 'font-semibold text-accent'
          : state === 'past'
            ? 'text-gray-400 hover:text-white'
            : 'text-gray-600 hover:text-white'
      }`}
    >
      {text || '♪'}
    </button>
  )
})

export default function LyricsPanel({ lines, plain, loading, searching, onSeek, onAutoSearch }: Props): JSX.Element {
  // Subscribed here rather than in MainPlayer: that component renders the whole
  // library view, and having it follow the playhead redrew every album grid and
  // search result several times a second during playback.
  const currentTime = useNavidromeStore((s) => s.currentTime)
  const activeRef = useRef<HTMLButtonElement>(null)
  const index = lines ? activeLineIndex(lines, currentTime) : -1

  // Keep the sung line centred. scrollIntoView on the element itself avoids
  // assuming a fixed row height, which breaks as soon as a line wraps.
  useEffect(() => {
    if (index < 0 || !activeRef.current) return
    activeRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [index])

  if (loading) {
    return <p className="text-sm text-gray-500">Recherche des paroles...</p>
  }

  if (!lines && !plain) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-500">Paroles non disponibles pour ce titre.</p>
        <button
          onClick={onAutoSearch}
          disabled={searching}
          className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-xs font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {searching ? 'Recherche...' : 'Recherche auto'}
        </button>
      </div>
    )
  }

  if (!lines) {
    return <p className="whitespace-pre-line text-sm text-gray-300">{plain}</p>
  }

  return (
    <div className="max-h-[42vh] space-y-2 overflow-y-auto pr-1">
      {lines.map((line, i) => (
        <Line
          key={`${line.time}-${i}`}
          text={line.text}
          state={i === index ? 'active' : i < index ? 'past' : 'upcoming'}
          onPress={() => onSeek(line.time)}
          innerRef={i === index ? activeRef : null}
        />
      ))}
    </div>
  )
}
