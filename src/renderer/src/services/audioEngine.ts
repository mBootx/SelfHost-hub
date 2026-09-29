import { EQ_FREQUENCIES } from '@renderer/store/audioSettingsStore'

type DeckIndex = 0 | 1

interface Deck {
  el: HTMLAudioElement
  gain: GainNode
  trackId: string | null
  ready: boolean
}

export interface NextTrack {
  id: string
  src: string
}

export interface EngineHandlers {
  onProgress: (currentTime: number, duration: number) => void
  /** The current track finished and nothing preloaded took over. */
  onTrackEnd: () => void
  /** The preloaded next track took over (crossfade or gapless): the queue should advance. */
  onAutoAdvance: () => void
}

/** How long before the fade window the next track starts buffering. */
const PRELOAD_LEAD_S = 20
/** How fast volume and equalizer changes glide, so dragging a slider doesn't crackle. */
const SMOOTHING_S = 0.02

function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/** Equal-power curves keep the perceived loudness flat through the middle of a crossfade. */
function fadeCurve(fadeIn: boolean): Float32Array {
  const steps = 64
  const curve = new Float32Array(steps)
  for (let i = 0; i < steps; i++) {
    const x = (i / (steps - 1)) * (Math.PI / 2)
    curve[i] = fadeIn ? Math.sin(x) : Math.cos(x)
  }
  return curve
}

/**
 * Two <audio> "decks" routed through Web Audio: each has its own fade gain, then both share the
 * equalizer and the master volume. One deck plays the current track; the other preloads the
 * next one so it can crossfade in, or start the instant the current one ends (gapless).
 */
export class AudioEngine {
  private ctx = new AudioContext()
  private master = this.ctx.createGain()
  private preamp = this.ctx.createGain()
  private filters: BiquadFilterNode[]
  private decks: [Deck, Deck]
  private active: DeckIndex = 0
  private next: NextTrack | null = null
  private fadingFrom: DeckIndex | null = null
  private fadeTimer: ReturnType<typeof setTimeout> | null = null
  private crossfadeSeconds = 0
  private gapless = true
  private rate = 1
  private handlers: EngineHandlers | null = null

  constructor() {
    this.filters = EQ_FREQUENCIES.map((frequency, i) => {
      const filter = this.ctx.createBiquadFilter()
      filter.type = i === 0 ? 'lowshelf' : i === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking'
      filter.frequency.value = frequency
      filter.Q.value = 1.41
      filter.gain.value = 0
      return filter
    })
    let tail: AudioNode = this.preamp
    for (const filter of this.filters) {
      tail.connect(filter)
      tail = filter
    }
    tail.connect(this.master)
    this.master.connect(this.ctx.destination)
    this.decks = [this.createDeck(0), this.createDeck(1)]
  }

  private createDeck(index: DeckIndex): Deck {
    const el = new Audio()
    // Web Audio only processes CORS-clean media; the main process adds the header (see src/main/index.ts).
    el.crossOrigin = 'anonymous'
    el.preload = 'auto'
    const gain = this.ctx.createGain()
    this.ctx.createMediaElementSource(el).connect(gain)
    gain.connect(this.preamp)
    const deck: Deck = { el, gain, trackId: null, ready: false }
    el.addEventListener('canplay', () => {
      deck.ready = true
    })
    el.addEventListener('loadedmetadata', () => {
      if (index === this.active) this.handlers?.onProgress(el.currentTime, el.duration || 0)
    })
    el.addEventListener('timeupdate', () => this.onTimeUpdate(index))
    el.addEventListener('ended', () => this.onEnded(index))
    return deck
  }

  setHandlers(handlers: EngineHandlers | null): void {
    this.handlers = handlers
  }

  /**
   * Makes `id` current: keeps it if a transition already started it, switches instantly if it was
   * preloaded, else loads it. `startAt` (seconds) resumes a track part-way through.
   */
  load(id: string, src: string, autoplay: boolean, startAt = 0): void {
    const current = this.decks[this.active]
    if (current.trackId === id) {
      if (autoplay) this.play()
      return
    }
    this.finishFade()
    const otherIndex = (1 - this.active) as DeckIndex
    const other = this.decks[otherIndex]
    if (other.trackId === id && other.ready) {
      this.stopDeck(current)
      this.active = otherIndex
      other.el.currentTime = startAt
      this.setGain(other, 1)
    } else {
      current.trackId = id
      current.ready = false
      current.el.src = src
      // Before metadata arrives this only records the start position; the element seeks there as
      // soon as it can, and reports it as currentTime meanwhile.
      if (startAt > 0) current.el.currentTime = startAt
      this.applyRate(current)
      this.setGain(current, 1)
    }
    if (autoplay) this.play()
  }

  /** The track that should follow the current one, or null (end of queue, repeat-one). */
  setNext(next: NextTrack | null): void {
    this.next = next
    const otherIndex = 1 - this.active
    if (this.fadingFrom === otherIndex) return
    const other = this.decks[otherIndex]
    if (other.trackId && other.trackId !== next?.id) this.stopDeck(other)
  }

  play(): void {
    void this.ctx.resume()
    this.decks[this.active].el.play().catch(() => {})
  }

  pause(): void {
    this.finishFade()
    this.decks[this.active].el.pause()
  }

  seek(seconds: number): void {
    this.finishFade()
    this.decks[this.active].el.currentTime = seconds
  }

  restart(): void {
    this.seek(0)
    this.play()
  }

  stop(): void {
    this.finishFade()
    this.stopDeck(this.decks[0])
    this.stopDeck(this.decks[1])
    this.next = null
  }

  setVolume(volume: number): void {
    this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, SMOOTHING_S)
  }

  setRate(rate: number): void {
    this.rate = rate
    this.decks.forEach((deck) => this.applyRate(deck))
  }

  setTransitions(crossfadeSeconds: number, gapless: boolean): void {
    this.crossfadeSeconds = crossfadeSeconds
    this.gapless = gapless
  }

  setEqualizer(enabled: boolean, gains: number[]): void {
    const now = this.ctx.currentTime
    this.filters.forEach((filter, i) => filter.gain.setTargetAtTime(enabled ? (gains[i] ?? 0) : 0, now, SMOOTHING_S))
    // Boosting a band would clip loud passages, so the whole signal is lowered by the largest boost.
    const headroom = enabled ? Math.max(0, ...gains) : 0
    this.preamp.gain.setTargetAtTime(dbToGain(-headroom), now, SMOOTHING_S)
  }

  private applyRate(deck: Deck): void {
    // Loading a new src resets playbackRate to defaultPlaybackRate, so both are kept in sync.
    deck.el.defaultPlaybackRate = this.rate
    deck.el.playbackRate = this.rate
  }

  private onTimeUpdate(index: DeckIndex): void {
    if (index !== this.active) return
    const el = this.decks[index].el
    const duration = el.duration || 0
    this.handlers?.onProgress(el.currentTime, duration)
    if (!this.next || !duration || el.paused || this.fadingFrom !== null) return
    if (this.crossfadeSeconds <= 0 && !this.gapless) return
    const remaining = (duration - el.currentTime) / (el.playbackRate || 1)
    if (remaining <= this.crossfadeSeconds + PRELOAD_LEAD_S) this.preloadNext()
    if (this.crossfadeSeconds > 0 && remaining <= this.crossfadeSeconds) this.startCrossfade(remaining)
  }

  private preloadNext(): void {
    const next = this.next
    const other = this.decks[1 - this.active]
    if (!next || other.trackId === next.id) return
    other.trackId = next.id
    other.ready = false
    other.el.src = next.src
    this.applyRate(other)
    this.setGain(other, 0)
  }

  private startCrossfade(remaining: number): void {
    const toIndex = (1 - this.active) as DeckIndex
    const to = this.decks[toIndex]
    if (!this.next || to.trackId !== this.next.id || !to.ready) return
    const fromIndex = this.active
    const duration = Math.max(0.5, Math.min(this.crossfadeSeconds, remaining))
    const now = this.ctx.currentTime
    this.rampGain(this.decks[fromIndex], fadeCurve(false), now, duration)
    this.rampGain(to, fadeCurve(true), now, duration)
    to.el.currentTime = 0
    this.active = toIndex
    this.fadingFrom = fromIndex
    this.fadeTimer = setTimeout(() => this.finishFade(), duration * 1000 + 250)
    this.play()
    this.handlers?.onAutoAdvance()
  }

  private onEnded(index: DeckIndex): void {
    if (index === this.fadingFrom) {
      this.finishFade()
      return
    }
    if (index !== this.active) return
    const next = this.next
    const otherIndex = (1 - index) as DeckIndex
    const other = this.decks[otherIndex]
    // Gapless handoff - also the fallback when a crossfade window was missed (seek, slow preload).
    if (next && (this.gapless || this.crossfadeSeconds > 0) && other.trackId === next.id && other.ready) {
      this.stopDeck(this.decks[index])
      this.active = otherIndex
      other.el.currentTime = 0
      this.setGain(other, 1)
      this.play()
      this.handlers?.onAutoAdvance()
      return
    }
    this.handlers?.onTrackEnd()
  }

  /** Ends a crossfade in progress at once: the outgoing track stops and the new one plays at full level. */
  private finishFade(): void {
    if (this.fadingFrom === null) return
    if (this.fadeTimer) clearTimeout(this.fadeTimer)
    this.fadeTimer = null
    this.stopDeck(this.decks[this.fadingFrom])
    this.fadingFrom = null
    this.setGain(this.decks[this.active], 1)
  }

  private stopDeck(deck: Deck): void {
    deck.el.pause()
    deck.el.removeAttribute('src')
    deck.el.load()
    deck.trackId = null
    deck.ready = false
  }

  private setGain(deck: Deck, value: number): void {
    const param = deck.gain.gain
    param.cancelScheduledValues(this.ctx.currentTime)
    param.setValueAtTime(value, this.ctx.currentTime)
  }

  private rampGain(deck: Deck, curve: Float32Array, start: number, duration: number): void {
    const param = deck.gain.gain
    param.cancelScheduledValues(start)
    param.setValueCurveAtTime(curve, start, duration)
  }
}
