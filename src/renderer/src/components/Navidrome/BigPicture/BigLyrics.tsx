import { CSSProperties, memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { activeLineIndex, LyricLine } from '@renderer/services/lyrics'
import { isBreak, litWords, lineProgress, rowLook, scrollOffset, wordsOf } from '@renderer/services/bigPicture'
import { usePlayhead } from '@renderer/hooks/usePlayhead'

interface Props {
  lines: LyricLine[] | null
  plain: string | null
  loading: boolean
  searching: boolean
  onSeek: (seconds: number) => void
  onSearch: () => void
}

/** Rows farther than this from the sung one look alike, so they aren't redrawn each time the sung line changes. */
const LOOK_RANGE = 8

const FADE_MASK: CSSProperties = {
  maskImage: 'linear-gradient(to bottom, transparent 0, black 16%, black 80%, transparent 100%)',
  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 16%, black 80%, transparent 100%)'
}

/** The line being sung: its words light one after the other, with a glow in the cover's colour. */
function SungLine({ text, progress, isGap }: { text: string; progress: number; isGap: boolean }): JSX.Element {
  if (isGap) {
    return (
      <span className="inline-flex items-center gap-[1.2vw] py-[1.2vh]" aria-label="Passage instrumental">
        {[0, 1, 2].map((i) => (
          <i key={i} className="bp-dot block h-[1.5vw] w-[1.5vw] rounded-full bg-white" style={{ animationDelay: `${i * 0.18}s` }} />
        ))}
      </span>
    )
  }
  const words = wordsOf(text)
  const lit = litWords(words.length, progress)
  return (
    <>
      {words.map((word, i) => (
        <span
          key={i}
          className="inline-block whitespace-pre transition-[color,text-shadow] duration-300"
          style={
            i < lit
              ? { color: '#fff', textShadow: '0 0 0.9em rgb(var(--bp) / 0.75), 0 0 0.25em rgb(var(--bp) / 0.55)' }
              : { color: 'rgb(255 255 255 / 0.42)', textShadow: 'none' }
          }
        >
          {word}
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
  )
}

const Row = memo(function Row({
  text,
  distance,
  progress,
  isGap,
  time,
  onSeek,
  innerRef
}: {
  text: string
  distance: number
  progress: number
  isGap: boolean
  time: number
  onSeek: (seconds: number) => void
  innerRef: (element: HTMLDivElement | null) => void
}): JSX.Element {
  const look = rowLook(distance)
  const active = distance === 0
  return (
    <div
      ref={innerRef}
      onClick={() => onSeek(time)}
      title="Aller à ce passage"
      className="cursor-pointer origin-left select-none py-[1.1vh] pr-[2vw] font-extrabold leading-[1.18] tracking-tight text-white transition-[opacity,filter,transform] duration-[550ms] ease-out hover:!opacity-100 hover:!blur-none"
      style={{
        fontSize: 'clamp(1.5rem, 3.15vw, 4rem)',
        opacity: look.opacity,
        filter: look.blur > 0 ? `blur(${look.blur}px)` : undefined,
        transform: `scale(${look.scale})`
      }}
    >
      {active ? <SungLine text={text} progress={progress} isGap={isGap} /> : text.trim() ? text : <span className="opacity-60">♪</span>}
    </div>
  )
})

/**
 * The lyrics of the full-screen player: big, the sung line lit word by word and kept at about 40% of the way down, the
 * others dimmer, smaller and blurrier the farther they are. Click a line to go there. Lyrics without timestamps are a
 * plain scrolling text. It follows the playhead itself, so only this part of the screen redraws as the song goes.
 */
export default function BigLyrics({ lines, plain, loading, searching, onSeek, onSearch }: Props): JSX.Element {
  const { time } = usePlayhead(24)
  const index = lines ? activeLineIndex(lines, time) : -1
  const viewport = useRef<HTMLDivElement>(null)
  const rows = useRef<Array<HTMLDivElement | null>>([])
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [offset, setOffset] = useState(0)
  // The scroll glides from one sung line to the next, but follows a change of layout (the column widening, the window
  // resized) at once: a glide that is restarted at every frame of a resize would creep.
  const [glide, setGlide] = useState(false)
  const last = useRef<{ index: number; size: typeof size } | null>(null)

  // The width matters as much as the height: when the column widens (the screen opens its lyrics, the window is resized)
  // the lines wrap differently and every row moves.
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = (): void =>
      setSize((previous) => (previous.width === element.clientWidth && previous.height === element.clientHeight ? previous : { width: element.clientWidth, height: element.clientHeight }))
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [lines, plain, loading])

  // The row to keep in view is the sung one; before the first line, the first.
  useLayoutEffect(() => {
    const row = rows.current[Math.max(index, 0)]
    if (!row || !size.height) return
    setGlide(last.current !== null && last.current.size === size && last.current.index !== index)
    last.current = { index, size }
    setOffset(scrollOffset(size.height, row.offsetTop, row.offsetHeight))
  }, [index, size, lines])

  const refs = useMemo(() => (lines ? lines.map((_, i) => (element: HTMLDivElement | null) => void (rows.current[i] = element)) : []), [lines])

  if (loading) {
    return <p className="flex h-full items-center px-[2vw] text-[clamp(1rem,1.5vw,1.6rem)] text-white/50">Recherche des paroles…</p>
  }

  if (!lines && !plain) {
    return (
      <div className="flex h-full flex-col items-start justify-center gap-4 px-[2vw]">
        <p className="text-[clamp(1.1rem,1.8vw,2rem)] font-semibold text-white/60">Pas de paroles pour ce titre.</p>
        <button
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSearch}
          disabled={searching}
          className="flex items-center gap-2 rounded-full bg-white/15 px-5 py-2.5 text-sm font-semibold text-white backdrop-blur transition-colors hover:bg-white/25 disabled:opacity-60"
        >
          <Sparkles className="h-4 w-4" />
          {searching ? 'Recherche…' : 'Chercher ailleurs'}
        </button>
      </div>
    )
  }

  if (!lines) {
    return (
      <div className="bp-scroll h-full overflow-y-auto px-[2vw] py-[10vh]" style={FADE_MASK}>
        <p className="whitespace-pre-line text-[clamp(1.2rem,2vw,2.4rem)] font-semibold leading-relaxed text-white/85">{plain}</p>
      </div>
    )
  }

  return (
    <div ref={viewport} className="relative h-full overflow-hidden" style={FADE_MASK}>
      <div
        className="relative px-[2vw] will-change-transform"
        style={{ transform: `translate3d(0, ${offset}px, 0)`, transition: glide ? 'transform 750ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none' }}
      >
        {lines.map((line, i) => {
          const distance = Math.max(-LOOK_RANGE, Math.min(LOOK_RANGE, i - index))
          return (
            <Row
              key={`${line.time}-${i}`}
              text={line.text}
              distance={distance}
              progress={i === index ? lineProgress(lines, i, time) : 0}
              isGap={i === index && isBreak(lines, i)}
              time={line.time}
              onSeek={onSeek}
              innerRef={refs[i]}
            />
          )
        })}
      </div>
    </div>
  )
}
