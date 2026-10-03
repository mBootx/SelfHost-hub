import { CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { Cast, Laptop, Minimize2, Music, Smartphone, Sparkles } from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useUIStore } from '@renderer/store/uiStore'
import { fetchLyrics, LyricsResult } from '@renderer/services/lyrics'
import { loadArtworkOverrides } from '@renderer/services/artwork'
import { controlsVisible, formatTimeOfDay, lifted, Rgb } from '@renderer/services/bigPicture'
import { usePlaybackView } from '@renderer/hooks/usePlaybackView'
import { useCoverPalette } from '@renderer/hooks/useCoverPalette'
import Backdrop from './Backdrop'
import BigLyrics from './BigLyrics'
import { EdgeProgress, SeekBar, Transport, VolumeControl } from './Controls'

/** How long the bars and the cursor stay after the last movement or key press. */
const HIDE_AFTER_MS = 3500
const GRID_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
const NEUTRAL: Rgb = [214, 218, 230]

/** The app's accent colour (Réglages → Apparence), for a cover with no colour of its own. */
function appAccent(): Rgb {
  const channels = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().split(/\s+/).map(Number)
  return channels.length === 3 && channels.every((c) => Number.isFinite(c)) ? (channels as Rgb) : [29, 185, 84]
}

/** The time of day, redrawn each time the minute changes. */
function Clock(): JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 5000)
    return () => clearInterval(timer)
  }, [])
  return <span className="tabular-nums">{formatTimeOfDay(now)}</span>
}

function Screen(): JSX.Element {
  const close = useUIStore((s) => s.closeBigPicture)
  const client = useNavidromeStore((s) => s.client)
  const view = usePlaybackView()
  const { song } = view

  const [lyrics, setLyrics] = useState<LyricsResult | null>(null)
  const [loadingLyrics, setLoadingLyrics] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchedWide, setSearchedWide] = useState(false)
  const [lyricsWanted, setLyricsWanted] = useState(true)
  // Whether the layout makes room for lyrics. It keeps its last answer while the next song's lyrics are being looked
  // up, so that the screen doesn't open and close its lyrics column on every song change.
  const [roomForLyrics, setRoomForLyrics] = useState(true)
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [coverBroken, setCoverBroken] = useState<string | null>(null)

  // --- What is shown ---

  useEffect(() => {
    loadArtworkOverrides().then(setOverrides)
  }, [])

  const coverId = song ? song.coverArt || song.albumId : undefined
  const override = song ? overrides[song.albumId || song.id] : undefined
  const coverUrl = coverId && client ? client.coverArtUrl(coverId, 1200) : override ?? null
  const backdropUrl = coverId && client ? client.coverArtUrl(coverId, 640) : override ?? null

  const [accent] = useState(appAccent)
  // The app's accent until the cover has been read; a soft white for a cover with no colour (black and white), which a
  // coloured glow would not suit.
  const palette = useCoverPalette(backdropUrl)
  const tint = lifted(palette === undefined ? accent : palette ?? NEUTRAL)
  const hasLyrics = !!(lyrics && (lyrics.synced || lyrics.plain))
  const lyricsShown = lyricsWanted && !!song && roomForLyrics

  useEffect(() => {
    if (!loadingLyrics) setRoomForLyrics(hasLyrics)
  }, [loadingLyrics, hasLyrics])

  // The lyrics follow the song (the lookup is cached, so a song heard before costs nothing).
  const songId = song?.id
  useEffect(() => {
    if (!song) {
      setLyrics(null)
      return
    }
    let cancelled = false
    setLyrics(null)
    setSearchedWide(false)
    setLoadingLyrics(true)
    fetchLyrics(song)
      .then((found) => {
        if (!cancelled) setLyrics(found)
      })
      .finally(() => {
        if (!cancelled) setLoadingLyrics(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId])

  async function searchElsewhere(): Promise<void> {
    if (!song || !client) return
    setSearching(true)
    try {
      const found = await fetchLyrics(song, { wide: true, navidromeLookup: (artist, title) => client.getLyrics(artist, title) })
      if (found) setLyrics(found)
      else setSearchedWide(true)
    } finally {
      setSearching(false)
    }
  }

  const seekRef = useRef(view.seek)
  seekRef.current = view.seek
  const seek = useCallback((seconds: number) => seekRef.current(seconds), [])

  // --- The window ---

  // Real full screen: the taskbar goes too. The screen also closes if the window leaves full screen some other way.
  useEffect(() => {
    let entered = false
    const stop = window.api.window.onFullScreenChange((on) => {
      if (on) entered = true
      else if (entered) close()
    })
    void window.api.window.setFullScreen(true)
    return () => {
      stop()
      void window.api.window.setFullScreen(false)
    }
  }, [close])

  // --- The bars and the cursor ---

  const [lastActivity, setLastActivity] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const lastMove = useRef({ x: -1, y: -1 })
  const poke = useCallback(() => setLastActivity(Date.now()), [])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      poke()
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      } else if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        setLyricsWanted((v) => !v)
      }
    }
    // In the capture phase, before anything under the screen sees Escape.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close, poke])

  // A mouse that sits still can still report tiny moves: only a real one wakes the bars.
  function onMouseMove(e: React.MouseEvent): void {
    const last = lastMove.current
    if (Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y) < 4) return
    lastMove.current = { x: e.clientX, y: e.clientY }
    poke()
  }

  const visible = controlsVisible(now, lastActivity, HIDE_AFTER_MS, !song)

  const rootStyle = {
    '--bp': tint.join(' '),
    // The sliders (.range-accent) take their colour from the app's accent: here, from the cover's.
    '--accent': tint.join(' '),
    fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif"
  } as CSSProperties

  // The bottom bar is about 17% of the height: the cover and its caption stay clear of it, shown or not.
  const coverSize = lyricsShown ? 'min(36vw, 42vh)' : 'min(50vw, 43vh)'
  const showBroken = coverBroken === coverUrl

  return (
    <div
      className={`fixed inset-0 z-[90] overflow-hidden bg-black text-white ${visible ? '' : 'cursor-none'}`}
      style={rootStyle}
      onMouseMove={onMouseMove}
      onMouseDown={poke}
      onWheel={poke}
      role="dialog"
      aria-label="Lecture en plein écran"
    >
      <Backdrop url={backdropUrl} />

      <div
        className="relative z-10 grid h-full w-full"
        style={{
          gridTemplateColumns: lyricsShown ? 'minmax(0, 5fr) minmax(0, 6fr)' : 'minmax(0, 1fr) minmax(0, 0fr)',
          transition: `grid-template-columns 800ms ${GRID_EASE}`
        }}
      >
        <section className="flex h-full min-w-0 flex-col items-center justify-center px-[4vw] pb-[19vh] pt-[7vh]">
          {song ? (
            <>
              <div
                className="shrink-0 transition-[width] duration-[800ms]"
                style={{ width: coverSize, transitionTimingFunction: GRID_EASE }}
              >
                {coverUrl && !showBroken ? (
                  <img
                    key={coverUrl}
                    src={coverUrl}
                    alt=""
                    draggable={false}
                    onError={() => setCoverBroken(coverUrl)}
                    className="bp-fade aspect-square w-full rounded-[1.2vw] object-cover"
                    style={{ boxShadow: '0 3vh 12vh rgb(var(--bp) / 0.5), 0 1vh 4vh rgb(0 0 0 / 0.6)' }}
                  />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center rounded-[1.2vw] bg-white/10 backdrop-blur">
                    <Music className="h-1/4 w-1/4 text-white/40" />
                  </div>
                )}
              </div>
              <div key={song.id} className="bp-fade mt-[3.2vh] w-full min-w-0 text-center" style={{ maxWidth: coverSize }}>
                <h1 className="line-clamp-2 text-[clamp(1.5rem,2.8vw,3.4rem)] font-extrabold leading-[1.1] tracking-tight">{song.title}</h1>
                <p className="mt-[0.8vh] truncate text-[clamp(1.05rem,1.6vw,2rem)] font-medium text-white/80">{song.artist}</p>
                {song.album && <p className="mt-[0.4vh] truncate text-[clamp(0.85rem,1.1vw,1.35rem)] text-white/45">{song.album}</p>}
                {!roomForLyrics && !loadingLyrics && (
                  <button
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={searchElsewhere}
                    disabled={searching || searchedWide}
                    className="mt-[2vh] inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-[clamp(0.75rem,0.95vw,1.1rem)] font-semibold text-white/70 backdrop-blur transition-colors hover:bg-white/20 disabled:opacity-60"
                  >
                    <Sparkles className="h-4 w-4" />
                    {searching ? 'Recherche des paroles…' : searchedWide ? 'Aucune parole trouvée' : 'Pas de paroles · chercher ailleurs'}
                  </button>
                )}
                {view.upNext && (
                  <p className="mt-[2vh] truncate text-[clamp(0.75rem,0.95vw,1.15rem)] text-white/40">
                    Ensuite · <span className="text-white/60">{view.upNext.title}</span> — {view.upNext.artist}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="text-center text-white/60">
              <Music className="mx-auto mb-4 h-16 w-16 text-white/30" />
              <p className="text-2xl font-semibold">Aucune lecture</p>
              <p className="mt-2 text-sm text-white/40">Lancez un titre, il s’affichera ici.</p>
            </div>
          )}
        </section>

        <section
          className={`min-w-0 overflow-hidden pb-[12vh] pt-[8vh] transition-opacity duration-700 ${lyricsShown ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        >
          {lyricsShown && (
            <BigLyrics
              lines={lyrics?.synced ?? null}
              plain={lyrics?.plain ?? null}
              loading={loadingLyrics}
              searching={searching}
              onSeek={seek}
              onSearch={searchElsewhere}
            />
          )}
        </section>
      </div>

      {/* The top bar: where the sound goes, the time, the way out. */}
      <div
        className={`absolute inset-x-0 top-0 z-20 flex items-center justify-between bg-gradient-to-b from-black/60 to-transparent px-[2.4vw] pb-[5vh] pt-[2.4vh] transition-opacity duration-500 ${
          visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div className="flex items-center gap-3 text-[clamp(0.8rem,1vw,1.15rem)] font-semibold text-white/75">
          <span className="flex items-center gap-2 rounded-full bg-white/10 px-3.5 py-1.5 backdrop-blur">
            {view.isRemote ? <Smartphone className="h-4 w-4" /> : <Laptop className="h-4 w-4" />}
            {view.isRemote ? view.deviceName ?? 'Appareil' : 'Cet ordinateur'}
            {view.isRemote && <Cast className="h-3.5 w-3.5 text-[rgb(var(--bp))]" />}
          </span>
        </div>
        <div className="flex items-center gap-5 text-[clamp(0.9rem,1.2vw,1.4rem)] font-semibold text-white/80">
          <Clock />
          <button
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={close}
            title="Quitter le plein écran (Échap)"
            aria-label="Quitter le plein écran"
            className="rounded-full bg-white/10 p-2.5 backdrop-blur transition-colors hover:bg-white/25"
          >
            <Minimize2 className="h-[clamp(1.1rem,1.4vw,1.6rem)] w-[clamp(1.1rem,1.4vw,1.6rem)]" />
          </button>
        </div>
      </div>

      {/* The bottom bar: progress, transport, volume. */}
      <div
        className={`absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/75 via-black/40 to-transparent px-[3vw] pb-[3.2vh] pt-[8vh] transition-opacity duration-500 ${
          visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div className="mx-auto flex max-w-[78vw] flex-col gap-[1.6vh]">
          <SeekBar view={view} />
          <div className="relative flex items-center justify-center">
            <Transport view={view} />
            <div className="absolute right-0">
              <VolumeControl view={view} />
            </div>
          </div>
        </div>
      </div>

      <EdgeProgress />
    </div>
  )
}

/** The full-screen player: the cover big, the lyrics lit as they are sung, the controls out of the way. Opened from the player bar. */
export default function BigPicture(): JSX.Element | null {
  const open = useUIStore((s) => s.bigPicture)
  return open ? <Screen /> : null
}
