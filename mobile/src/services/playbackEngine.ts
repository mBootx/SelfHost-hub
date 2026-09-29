import { createAudioPlayer, setAudioModeAsync, AudioPlayer, AudioStatus } from 'expo-audio'

type DeckIndex = 0 | 1

export interface NextTrack {
  id: string
  source: string
}

export interface EngineHandlers {
  onProgress: (currentTime: number, duration: number) => void
  /** The current track finished and nothing preloaded took over. */
  onTrackEnd: () => void
  /** The preloaded next track took over (crossfade or gapless): the queue should advance. */
  onAutoAdvance: () => void
  /** Play/pause changed from outside the app's buttons: lock screen, Now Bar, headset, audio focus. */
  onExternalPlayState: (playing: boolean) => void
}

/** How long before the fade window the next track starts buffering. */
const PRELOAD_LEAD_S = 20
const FADE_STEP_MS = 50

/**
 * Two expo-audio players ("decks") at module scope, so playback survives navigation. One plays the
 * current track; the other preloads the next one so it can crossfade in, or start the moment the
 * current one ends (gapless). expo-audio holds audio focus for the whole app rather than per
 * player, so both can play at once during a crossfade.
 */
class DeckEngine {
  readonly decks: [AudioPlayer, AudioPlayer]
  private trackIds: [string | null, string | null] = [null, null]
  private finished: [boolean, boolean] = [false, false]
  private active: DeckIndex = 0
  private next: NextTrack | null = null
  private fade: { from: DeckIndex; start: number; durationMs: number; timer: ReturnType<typeof setInterval> } | null = null
  private crossfadeSeconds = 0
  private gapless = true
  private volume = 1
  private rate = 1
  private wantPlaying = false
  /** A requested play() that hasn't produced playback yet: replace() reports playing:false until the source loads. */
  private pendingPlay = false
  /** A start position passed to load() that the player hasn't reported reaching yet (see reportedTime). */
  private pendingSeek: { seconds: number; retried: boolean } | null = null
  private handlers: EngineHandlers | null = null

  constructor() {
    // 250ms status updates: a smooth progress bar, and synced lyrics close enough to the beat.
    this.decks = [createAudioPlayer(null, { updateInterval: 250 }), createAudioPlayer(null, { updateInterval: 250 })]
    this.decks.forEach((deck, i) => deck.addListener('playbackStatusUpdate', (status) => this.onStatus(i as DeckIndex, status)))
  }

  /** The deck playing the current track - the one the lock screen and Now Bar should follow. */
  get activePlayer(): AudioPlayer {
    return this.decks[this.active]
  }

  setHandlers(handlers: EngineHandlers | null): void {
    this.handlers = handlers
  }

  /**
   * Makes `id` current: keeps it if a transition already started it, switches instantly if it was
   * preloaded, else loads it. `startAt` (seconds) resumes a track part-way through.
   */
  load(id: string, source: string, play: boolean, startAt = 0): void {
    if (this.trackIds[this.active] === id) {
      if (play) this.play()
      return
    }
    this.finishFade()
    const otherIndex = (1 - this.active) as DeckIndex
    const other = this.decks[otherIndex]
    if (this.trackIds[otherIndex] === id && other.isLoaded) {
      this.decks[this.active].pause()
      this.trackIds[this.active] = null
      this.active = otherIndex
      other.volume = this.volume
    } else {
      const deck = this.decks[this.active]
      this.trackIds[this.active] = id
      deck.replace(source)
      deck.shouldCorrectPitch = true
      deck.setPlaybackRate(this.rate)
      deck.volume = this.volume
    }
    this.finished[this.active] = false
    this.pendingSeek = null
    if (startAt > 0) {
      this.pendingSeek = { seconds: startAt, retried: false }
      this.decks[this.active].seekTo(startAt).catch(() => {})
    }
    if (play) this.play()
    else this.pause()
  }

  /** The track that should follow the current one, or null (end of queue, repeat-one). */
  setNext(next: NextTrack | null): void {
    this.next = next
    const otherIndex = (1 - this.active) as DeckIndex
    if (this.fade?.from === otherIndex) return
    if (this.trackIds[otherIndex] && this.trackIds[otherIndex] !== next?.id) {
      this.decks[otherIndex].pause()
      this.trackIds[otherIndex] = null
    }
  }

  play(): void {
    this.wantPlaying = true
    this.pendingPlay = true
    this.decks[this.active].play()
  }

  pause(): void {
    this.finishFade()
    this.wantPlaying = false
    this.pendingPlay = false
    this.decks[this.active].pause()
  }

  seekTo(seconds: number): void {
    this.finishFade()
    this.pendingSeek = null
    this.decks[this.active].seekTo(seconds).catch(() => {})
  }

  restart(): void {
    this.pendingSeek = null
    const deck = this.decks[this.active]
    this.wantPlaying = true
    this.pendingPlay = true
    deck
      .seekTo(0)
      .then(() => deck.play())
      .catch(() => {})
  }

  setVolume(volume: number): void {
    this.volume = volume
    if (!this.fade) this.decks[this.active].volume = volume
  }

  setRate(rate: number): void {
    this.rate = rate
    for (const deck of this.decks) {
      deck.shouldCorrectPitch = true
      deck.setPlaybackRate(rate)
    }
  }

  setTransitions(crossfadeSeconds: number, gapless: boolean): void {
    this.crossfadeSeconds = crossfadeSeconds
    this.gapless = gapless
  }

  private onStatus(index: DeckIndex, status: AudioStatus): void {
    const justFinished = status.didJustFinish && !this.finished[index]
    this.finished[index] = status.didJustFinish
    if (index !== this.active) {
      if (justFinished && this.fade?.from === index) this.finishFade()
      return
    }
    this.handlers?.onProgress(this.reportedTime(index, status), status.duration)

    // End of track must be handled before the mirroring below: the native status forces playing:false
    // on this tick, and letting that reach the store reads as "the user paused" - which is what
    // silently killed repeat-one.
    if (justFinished) {
      this.onActiveEnded()
      return
    }

    if (this.pendingPlay) {
      // Re-assert play() once the source is ready: the call made right after replace() can land
      // before loading finished and be silently dropped.
      if (status.playing) this.pendingPlay = false
      else if (status.isLoaded && this.wantPlaying) this.decks[index].play()
    } else if (!this.fade && status.playing !== this.wantPlaying) {
      this.wantPlaying = status.playing
      this.handlers?.onExternalPlayState(status.playing)
    }

    this.checkTransition(status)
  }

  /**
   * The playhead to show. While a start position from load() is pending it shows that position
   * rather than the 0 the player reports before it gets there, so the progress bar doesn't jump.
   */
  private reportedTime(index: DeckIndex, status: AudioStatus): number {
    const target = this.pendingSeek
    if (!target) return status.currentTime
    if (Math.abs(status.currentTime - target.seconds) < 1.5) {
      this.pendingSeek = null
      return status.currentTime
    }
    if (status.isLoaded) {
      // A seek issued while the source was still loading can be lost: repeat it once, then give up.
      if (target.retried) {
        this.pendingSeek = null
        return status.currentTime
      }
      target.retried = true
      this.decks[index].seekTo(target.seconds).catch(() => {})
    }
    return target.seconds
  }

  private checkTransition(status: AudioStatus): void {
    if (!this.next || this.fade || !status.playing || !status.duration) return
    if (this.crossfadeSeconds <= 0 && !this.gapless) return
    const remaining = (status.duration - status.currentTime) / (this.rate || 1)
    if (remaining <= this.crossfadeSeconds + PRELOAD_LEAD_S) this.preloadNext()
    if (this.crossfadeSeconds > 0 && remaining <= this.crossfadeSeconds) this.startCrossfade(remaining)
  }

  private preloadNext(): void {
    const next = this.next
    const otherIndex = (1 - this.active) as DeckIndex
    if (!next || this.trackIds[otherIndex] === next.id) return
    const deck = this.decks[otherIndex]
    this.trackIds[otherIndex] = next.id
    this.finished[otherIndex] = false
    deck.volume = 0
    deck.replace(next.source)
    deck.shouldCorrectPitch = true
    deck.setPlaybackRate(this.rate)
  }

  private startCrossfade(remaining: number): void {
    const toIndex = (1 - this.active) as DeckIndex
    const to = this.decks[toIndex]
    if (!this.next || this.trackIds[toIndex] !== this.next.id || !to.isLoaded) return
    const fromIndex = this.active
    const durationMs = Math.max(500, Math.min(this.crossfadeSeconds, remaining) * 1000)
    to.volume = 0
    this.active = toIndex
    this.finished[toIndex] = false
    this.pendingSeek = null
    this.play()
    this.fade = { from: fromIndex, start: Date.now(), durationMs, timer: setInterval(() => this.stepFade(), FADE_STEP_MS) }
    this.handlers?.onAutoAdvance()
  }

  /** Equal-power ramps keep the perceived loudness flat through the middle of the crossfade. */
  private stepFade(): void {
    const fade = this.fade
    if (!fade) return
    const progress = Math.min(1, (Date.now() - fade.start) / fade.durationMs)
    this.decks[this.active].volume = this.volume * Math.sin((progress * Math.PI) / 2)
    this.decks[fade.from].volume = this.volume * Math.cos((progress * Math.PI) / 2)
    if (progress >= 1) this.finishFade()
  }

  /** Ends a crossfade in progress at once: the outgoing track stops and the new one plays at full volume. */
  private finishFade(): void {
    const fade = this.fade
    if (!fade) return
    clearInterval(fade.timer)
    this.fade = null
    this.decks[fade.from].pause()
    this.trackIds[fade.from] = null
    this.decks[this.active].volume = this.volume
  }

  private onActiveEnded(): void {
    const next = this.next
    const otherIndex = (1 - this.active) as DeckIndex
    const other = this.decks[otherIndex]
    // Gapless handoff - also the fallback when a crossfade window was missed (seek, slow preload).
    if (next && (this.gapless || this.crossfadeSeconds > 0) && this.trackIds[otherIndex] === next.id && other.isLoaded) {
      this.trackIds[this.active] = null
      this.active = otherIndex
      other.volume = this.volume
      this.finished[otherIndex] = false
      this.pendingSeek = null
      this.play()
      this.handlers?.onAutoAdvance()
      return
    }
    this.handlers?.onTrackEnd()
  }
}

export const engine = new DeckEngine()

export function seekTo(seconds: number): void {
  engine.seekTo(seconds)
}

/** Skip presses coming from outside the app: Now Bar, notification, headset, Android Auto. */
export type RemoteCommand = 'next' | 'previous'

/**
 * Subscribes to the lock screen skip events. This event is added by our patch to expo-audio
 * (patches/expo-audio) - stock expo-audio strips the next/previous commands from its MediaSession
 * entirely - so it isn't in the library's public typings. It comes from whichever deck currently
 * owns the lock screen, so both are listened to.
 */
export function onRemoteCommand(handler: (command: RemoteCommand) => void): () => void {
  const subscriptions = engine.decks.map((deck) => {
    const emitter = deck as unknown as {
      addListener(event: string, listener: (payload: { command: RemoteCommand }) => void): { remove(): void }
    }
    return emitter.addListener('remoteCommand', (payload) => {
      if (payload?.command === 'next' || payload?.command === 'previous') handler(payload.command)
    })
  })
  return () => subscriptions.forEach((s) => s.remove())
}

let configured = false

export async function ensureAudioMode(): Promise<void> {
  if (configured) return
  configured = true
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    // Lock screen controls require 'doNotMix' - see expo-audio docs.
    interruptionMode: 'doNotMix'
  })
}
