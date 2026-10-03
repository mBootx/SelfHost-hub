import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react'
import { CSSProperties } from 'react'
import { formatClock } from '@renderer/services/bigPicture'
import { usePlayhead } from '@renderer/hooks/usePlayhead'
import { PlaybackView } from '@renderer/hooks/usePlaybackView'

/** Buttons here never keep the focus: Space and the arrow keys stay the player's own shortcuts. */
const noFocus = {
  tabIndex: -1,
  onMouseDown: (e: React.MouseEvent) => e.preventDefault()
}

/** The slider that was just used lets go of the keyboard, for the same reason. */
const letGo = (e: React.SyntheticEvent<HTMLInputElement>): void => e.currentTarget.blur()

/** The song's progress, as a slider with the times either side. Follows the playhead itself. */
export function SeekBar({ view }: { view: PlaybackView }): JSX.Element {
  const { time, duration } = usePlayhead(12)
  const percent = duration > 0 ? Math.min(100, (time / duration) * 100) : 0
  return (
    <div className="flex w-full items-center gap-4 text-[clamp(0.8rem,1vw,1.1rem)] tabular-nums text-white/70">
      <span className="w-14 text-right">{formatClock(time)}</span>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.5}
        value={Math.min(time, duration || 0)}
        onChange={(e) => view.seek(Number(e.target.value))}
        onPointerUp={letGo}
        disabled={!view.song}
        aria-label="Position dans le titre"
        className="range-accent w-full disabled:cursor-default disabled:opacity-50"
        style={{ '--range-progress': `${percent}%`, height: 6 } as CSSProperties}
      />
      <span className="w-14">{formatClock(duration)}</span>
    </div>
  )
}

/** A line along the bottom edge that stays when everything else has faded: how far the song is. */
export function EdgeProgress(): JSX.Element {
  const { time, duration } = usePlayhead(6)
  const percent = duration > 0 ? Math.min(100, (time / duration) * 100) : 0
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[3px] bg-white/10">
      <div className="h-full bg-white/70 transition-[width] duration-200 ease-linear" style={{ width: `${percent}%` }} />
    </div>
  )
}

export function Transport({ view }: { view: PlaybackView }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-[clamp(1rem,2.4vw,2.8rem)]">
      <button
        {...noFocus}
        onClick={view.toggleShuffle}
        title="Aléatoire (S)"
        aria-label="Lecture aléatoire"
        aria-pressed={view.shuffle}
        className={`transition-colors ${view.shuffle ? 'text-[rgb(var(--bp))]' : 'text-white/60 hover:text-white'}`}
      >
        <Shuffle className="h-[clamp(1.2rem,1.6vw,1.8rem)] w-[clamp(1.2rem,1.6vw,1.8rem)]" />
      </button>
      <button {...noFocus} onClick={view.prev} title="Précédent" aria-label="Titre précédent" className="text-white/85 transition-transform hover:scale-110 hover:text-white">
        <SkipBack className="h-[clamp(1.6rem,2.3vw,2.6rem)] w-[clamp(1.6rem,2.3vw,2.6rem)]" fill="currentColor" />
      </button>
      <button
        {...noFocus}
        onClick={view.toggle}
        title={view.isPlaying ? 'Pause (Espace)' : 'Lecture (Espace)'}
        aria-label={view.isPlaying ? 'Pause' : 'Lecture'}
        className="flex h-[clamp(3.4rem,5vw,5.6rem)] w-[clamp(3.4rem,5vw,5.6rem)] items-center justify-center rounded-full bg-white text-black shadow-[0_8px_40px_rgb(var(--bp)/0.55)] transition-transform hover:scale-105"
      >
        {view.isPlaying ? (
          <Pause className="h-[45%] w-[45%]" fill="currentColor" />
        ) : (
          <Play className="h-[45%] w-[45%] translate-x-[6%]" fill="currentColor" />
        )}
      </button>
      <button {...noFocus} onClick={view.next} title="Suivant" aria-label="Titre suivant" className="text-white/85 transition-transform hover:scale-110 hover:text-white">
        <SkipForward className="h-[clamp(1.6rem,2.3vw,2.6rem)] w-[clamp(1.6rem,2.3vw,2.6rem)]" fill="currentColor" />
      </button>
      <button
        {...noFocus}
        onClick={view.cycleRepeat}
        title="Répéter (R)"
        aria-label="Répétition"
        aria-pressed={view.repeatMode !== 'off'}
        className={`transition-colors ${view.repeatMode !== 'off' ? 'text-[rgb(var(--bp))]' : 'text-white/60 hover:text-white'}`}
      >
        {view.repeatMode === 'one' ? (
          <Repeat1 className="h-[clamp(1.2rem,1.6vw,1.8rem)] w-[clamp(1.2rem,1.6vw,1.8rem)]" />
        ) : (
          <Repeat className="h-[clamp(1.2rem,1.6vw,1.8rem)] w-[clamp(1.2rem,1.6vw,1.8rem)]" />
        )}
      </button>
    </div>
  )
}

export function VolumeControl({ view }: { view: PlaybackView }): JSX.Element {
  const Icon = view.volume === 0 ? VolumeX : view.volume < 0.5 ? Volume1 : Volume2
  return (
    <div className="flex items-center gap-3">
      <button
        {...noFocus}
        onClick={() => view.setVolume(view.volume > 0 ? 0 : 0.8)}
        title={view.volume > 0 ? 'Muet' : 'Rétablir le son'}
        aria-label="Muet"
        className="text-white/70 transition-colors hover:text-white"
      >
        <Icon className="h-[clamp(1.2rem,1.5vw,1.7rem)] w-[clamp(1.2rem,1.5vw,1.7rem)]" />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={view.volume}
        onChange={(e) => view.setVolume(Number(e.target.value))}
        onPointerUp={letGo}
        aria-label="Volume"
        className="range-accent w-[clamp(6rem,10vw,12rem)]"
        style={{ '--range-progress': `${view.volume * 100}%` } as CSSProperties}
      />
    </div>
  )
}
