import { createAudioPlayer, setAudioModeAsync, AudioPlayer, AudioStatus } from 'expo-audio'
import SelfHostNative from '../../modules/selfhost-native'

type DeckIndex = 0 | 1

/** What the lock screen, the media notification and Samsung's Now Bar show for a track. */
export interface NowPlayingInfo {
  title: string
  artist?: string
  album?: string
  artworkUrl?: string
}

export interface NextTrack {
  id: string
  source: string
  /** What its volume is multiplied by (1 = as it is): the loudness evening-out, see services/loudness. */
  gain?: number
  /** What the Now Bar shows once it takes over. */
  info?: NowPlayingInfo
}

/** Previous and next carry track skip; the +/-10 s buttons sit in the notification's overflow (see patches/expo-audio). */
const LOCK_SCREEN_OPTIONS = { showSeekForward: true, showSeekBackward: true }

function sameInfo(a: NowPlayingInfo, b: NowPlayingInfo): boolean {
  return a.title === b.title && a.artist === b.artist && a.album === b.album && a.artworkUrl === b.artworkUrl
}

export interface EngineHandlers {
  onProgress: (currentTime: number, duration: number) => void
  /** The current track finished and nothing preloaded took over. */
  onTrackEnd: () => void
  /** The preloaded next track took over (crossfade or gapless): the queue should advance. */
  onAutoAdvance: () => void
  /** Play/pause changed from outside the app's buttons: lock screen, Now Bar, headset, audio focus. */
  onExternalPlayState: (playing: boolean) => void
  /** The track "to stop after" ended: playback was stopped instead of going on to the next one. */
  onStopAfterTrack?: () => void
  /** The current track started or stopped waiting for data while it should be playing (a stall, when streaming). */
  onBuffering?: (buffering: boolean) => void
}

/** How long before the fade window the next track starts buffering. */
const PRELOAD_LEAD_S = 20
const FADE_STEP_MS = 50
/** A fade running natively ends by itself; JS only tidies up once this much time has passed after its end. */
const FADE_GRACE_MS = 400
/** The track taking over must be at its start: further in than this and its deck ran ahead of the handover. */
const START_TOLERANCE_S = 1

/**
 * Two expo-audio players ("decks") at module scope, so playback survives navigation. One plays the
 * current track; the other preloads the next one so it can crossfade in, or start the moment the
 * current one ends (gapless). expo-audio holds audio focus for the whole app rather than per
 * player, so both can play at once during a crossfade.
 *
 * Two things this relies on, both learned the hard way:
 * - Only the current deck and the one fading out may play. An ExoPlayer that reaches the end of
 *   its track keeps "play when ready" switched on, so a source loaded into it later starts by
 *   itself. A deck is therefore paused before it preloads, and one found playing on the side is
 *   paused. Without that, the next song ran silently for the 20 s of preload and then took over
 *   part-way through.
 * - The fade itself runs natively (selfhost-native). React Native stops JS timers whenever the
 *   app is off screen, so a setInterval ramp never moved with the screen off: the new song sat
 *   silent until the old one ended, then came in at full volume part-way through.
 * - The lock screen / Now Bar follows the current deck, and the engine moves it in the same step
 *   as it switches decks (crossfade, gapless, a preloaded skip). It used to be moved by a React
 *   effect after the queue advanced; whenever that ran late, or not at all (the same song twice in
 *   a row, a one-song queue on repeat), the Now Bar stayed on the deck that had stopped: the old
 *   song and time, and play/pause acting on a silent deck.
 */
class DeckEngine {
  readonly decks: [AudioPlayer, AudioPlayer]
  private trackIds: [string | null, string | null] = [null, null]
  /** What the Now Bar shows for the track on each deck. */
  private infos: [NowPlayingInfo | null, NowPlayingInfo | null] = [null, null]
  /** The deck and track the Now Bar was last given, so an unchanged one isn't sent again. */
  private shown: { deck: DeckIndex; info: NowPlayingInfo } | null = null
  private finished: [boolean, boolean] = [false, false]
  /** The deck played its track to the end and still sits there (finished above is overwritten by any later status). */
  private atEnd: [boolean, boolean] = [false, false]
  private active: DeckIndex = 0
  private next: NextTrack | null = null
  /** timer is null while the ramp runs natively. */
  private fade: { from: DeckIndex; start: number; durationMs: number; timer: ReturnType<typeof setInterval> | null } | null = null
  private crossfadeSeconds = 0
  private gapless = true
  private volume = 1
  /** Each deck's loudness factor: the track on it, whatever the volume setting is. */
  private gains: [number, number] = [1, 1]
  /** Playback stops when the current track ends, with no crossfade or gapless hop into the next. */
  private stopAfterTrack = false
  private rate = 1
  private wantPlaying = false
  /** A requested play() that hasn't produced playback yet: replace() reports playing:false until the source loads. */
  private pendingPlay = false
  /** A start position passed to load() that the player hasn't reported reaching yet (see reportedTime). */
  private pendingSeek: { seconds: number; retried: boolean } | null = null
  private handlers: EngineHandlers | null = null
  /** What onBuffering last said, so it is only told about changes. */
  private stalled = false
  /**
   * Another app has the sound for a moment (a call, a voice message): the music is paused and comes back by itself.
   * The person did not pause, so nothing the decks report meanwhile counts as their choice.
   */
  private interrupted = false

  constructor() {
    // 250ms status updates: a smooth progress bar, and synced lyrics close enough to the beat.
    this.decks = [createAudioPlayer(null, { updateInterval: 250 }), createAudioPlayer(null, { updateInterval: 250 })]
    this.decks.forEach((deck, i) => deck.addListener('playbackStatusUpdate', (status) => this.onStatus(i as DeckIndex, status)))
    try {
      SelfHostNative?.addListener?.('onAudioFocus', ({ change }) => this.onFocusChange(change))
    } catch {
      // An older build: expo-audio handles the focus (see ensureAudioMode).
    }
  }

  /** The deck playing the current track - the one the lock screen and Now Bar should follow. */
  get activePlayer(): AudioPlayer {
    return this.decks[this.active]
  }

  setHandlers(handlers: EngineHandlers | null): void {
    this.handlers = handlers
  }

  /** Takes the lock screen / Now Bar controls down, for when there is nothing left to play. */
  clearNowPlaying(): void {
    this.shown = null
    for (const deck of this.decks) deck.clearLockScreenControls()
    // Nothing left to play: the sound goes back to whoever had it before.
    this.interrupted = false
    try {
      SelfHostNative?.abandonAudioFocus?.()
    } catch {
      // An older build: nothing to give back.
    }
  }

  /**
   * Asks for the audio focus before the music plays (selfhost-native holds it for the music as a whole). False when a
   * call is on: the music waits and starts when it ends (onFocusChange 'resume'). A refusal, or an older build
   * without it, still plays.
   */
  private takeFocus(): boolean {
    let result: string | undefined
    try {
      result = SelfHostNative?.requestAudioFocus?.()
    } catch {
      result = undefined
    }
    this.interrupted = result === 'delayed'
    return !this.interrupted
  }

  /** What another app did with the sound, as Android told selfhost-native. */
  private onFocusChange(change: string): void {
    if (change === 'interrupt') {
      // A call, a voice message: the music pauses and waits. The person still wants it, so nothing else changes.
      if (!this.wantPlaying) return
      this.interrupted = true
      this.finishFade()
      this.decks[this.active].pause()
    } else if (change === 'resume') {
      if (!this.interrupted) return
      this.interrupted = false
      if (!this.wantPlaying) return
      this.pendingPlay = true
      this.rewindIfEnded()
      this.decks[this.active].play()
    } else if (change === 'lost') {
      // Another app started its own playback: the music stops, as if the person had paused it.
      this.interrupted = false
      if (!this.wantPlaying) return
      this.pause()
      this.handlers?.onExternalPlayState(false)
    }
  }

  /** New details for a track already loaded (a cover picked by hand, say): the Now Bar shows them if it is the current one. */
  setNowPlaying(id: string, info: NowPlayingInfo): void {
    for (const index of [0, 1] as const) {
      if (this.trackIds[index] === id) this.infos[index] = info
    }
    this.showNowPlaying()
  }

  /**
   * Puts the current deck and its track on the lock screen / Now Bar (the native side keeps one media session and
   * hands it to this deck). Called whenever the current deck or its track changes.
   */
  private showNowPlaying(): void {
    const info = this.infos[this.active]
    if (!info) return
    const shown = this.shown
    if (shown && shown.deck === this.active && sameInfo(shown.info, info)) return
    try {
      this.decks[this.active].setActiveForLockScreen(
        true,
        { title: info.title, artist: info.artist, albumTitle: info.album, artworkUrl: info.artworkUrl },
        LOCK_SCREEN_OPTIONS
      )
      this.shown = { deck: this.active, info }
    } catch {
      // Not there in this build: nothing to show it on.
    }
  }

  /**
   * Play or pause pressed outside the app: the Now Bar, the lock screen, a headset, a car. The native side already
   * acted on the deck; this makes it the engine's intent too, so nothing "re-asserts" the old state (a pause pressed
   * while a song was loading used to be undone when it finished loading), and tells the app.
   */
  remotePlayState(playing: boolean): void {
    if (playing) this.play()
    else this.pause()
    this.handlers?.onExternalPlayState(playing)
  }

  /** The volume a deck should have: the volume setting times its track's loudness factor. */
  private level(index: DeckIndex): number {
    return this.volume * this.gains[index]
  }

  /**
   * Makes `id` current: keeps it if a transition already started it, switches instantly if it was
   * preloaded, else loads it. `startAt` (seconds) resumes a track part-way through. `gain` is the track's
   * loudness factor; `info` is what the Now Bar shows for it.
   */
  load(id: string, source: string, play: boolean, startAt = 0, gain = 1, info?: NowPlayingInfo): void {
    if (this.trackIds[this.active] === id) {
      if (info) this.infos[this.active] = info
      this.showNowPlaying()
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
      this.gains[otherIndex] = gain
      if (info) this.infos[otherIndex] = info
      other.volume = this.level(otherIndex)
      if (startAt <= 0) this.rewindIfAhead(other)
    } else {
      const deck = this.decks[this.active]
      this.trackIds[this.active] = id
      this.gains[this.active] = gain
      this.infos[this.active] = info ?? null
      deck.replace(source)
      deck.shouldCorrectPitch = true
      deck.setPlaybackRate(this.rate)
      deck.volume = this.level(this.active)
    }
    this.finished[this.active] = false
    this.atEnd[this.active] = false
    this.pendingSeek = null
    this.showNowPlaying()
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
    // Already preloaded: it only needs to know its loudness factor, which the setting may have changed, and its details.
    if (next && this.trackIds[otherIndex] === next.id) {
      this.gains[otherIndex] = next.gain ?? 1
      if (next.info) this.infos[otherIndex] = next.info
    }
    if (this.trackIds[otherIndex] && this.trackIds[otherIndex] !== next?.id) {
      this.decks[otherIndex].pause()
      this.trackIds[otherIndex] = null
    }
  }

  play(): void {
    this.wantPlaying = true
    this.pendingPlay = true
    // During a call the music waits for it to end.
    if (!this.takeFocus()) return
    // A track that was played to its end (the end of the queue) starts again from the top: an ended player
    // ignores play().
    this.rewindIfEnded()
    this.decks[this.active].play()
  }

  pause(): void {
    this.finishFade()
    this.wantPlaying = false
    this.pendingPlay = false
    // Paused by choice: nothing starts again by itself when another app gives the sound back.
    this.interrupted = false
    this.decks[this.active].pause()
    // At the end of the queue the last track goes back to its start, paused, ready to be played again: an ended
    // player shows the Now Bar a "stopped" state, which can take the card away.
    this.rewindIfEnded()
  }

  private rewindIfEnded(): void {
    if (!this.atEnd[this.active]) return
    this.atEnd[this.active] = false
    this.pendingSeek = null
    this.decks[this.active].seekTo(0).catch(() => {})
  }

  seekTo(seconds: number): void {
    this.finishFade()
    this.pendingSeek = null
    this.atEnd[this.active] = false
    this.decks[this.active].seekTo(seconds).catch(() => {})
  }

  restart(): void {
    this.pendingSeek = null
    this.atEnd[this.active] = false
    const deck = this.decks[this.active]
    this.wantPlaying = true
    this.pendingPlay = true
    const now = this.takeFocus()
    deck
      .seekTo(0)
      .then(() => {
        if (now) deck.play()
      })
      .catch(() => {})
  }

  setVolume(volume: number): void {
    this.volume = volume
    if (!this.fade) this.decks[this.active].volume = this.level(this.active)
  }

  /** Changes the loudness factor of the track playing now (the setting was switched, or its tags became known). */
  setGain(gain: number): void {
    this.gains[this.active] = gain
    if (!this.fade) this.decks[this.active].volume = this.level(this.active)
  }

  /** Stops playback when the current track ends instead of going on; the next transition is not prepared meanwhile. */
  setStopAfterTrack(on: boolean): void {
    this.stopAfterTrack = on
  }

  get stoppingAfterTrack(): boolean {
    return this.stopAfterTrack
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
    // Statuses keep coming with the screen off and timers do not: this is what ends a fade whose time is up.
    if (this.fade && Date.now() - this.fade.start >= this.fade.durationMs + FADE_GRACE_MS) this.finishFade()
    const justFinished = status.didJustFinish && !this.finished[index]
    this.finished[index] = status.didJustFinish
    if (status.didJustFinish) this.atEnd[index] = true
    else if (status.playing) this.atEnd[index] = false
    if (index !== this.active) {
      if (justFinished && this.fade?.from === index) this.finishFade()
      // Only the current deck and the one fading out may play. Anything else that starts up on its own
      // (a preloaded source, an audio-focus resume) is stopped at once.
      else if (status.playing && this.fade?.from !== index) this.decks[index].pause()
      return
    }
    this.handlers?.onProgress(this.reportedTime(index, status), status.duration)
    const stalled = this.wantPlaying && status.isBuffering && !status.didJustFinish
    if (stalled !== this.stalled) {
      this.stalled = stalled
      this.handlers?.onBuffering?.(stalled)
    }

    // End of track must be handled before the mirroring below: the native status forces playing:false
    // on this tick, and letting that reach the store reads as "the user paused" - which is what
    // silently killed repeat-one.
    if (justFinished) {
      this.onActiveEnded()
      return
    }

    if (this.interrupted) {
      // Paused while another app has the sound: neither a choice of the person's nor a play to re-assert.
    } else if (this.pendingPlay) {
      // Re-assert play() once the source is ready: the call made right after replace() can land
      // before loading finished and be silently dropped.
      if (status.playing) this.pendingPlay = false
      else if (status.isLoaded && this.wantPlaying) this.decks[index].play()
    } else if (status.playing !== this.wantPlaying) {
      // Play/pause from outside the app's buttons. One that lands mid-crossfade also ends the fade, so the
      // outgoing track doesn't carry on by itself after the user paused.
      this.finishFade()
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
    if (this.stopAfterTrack || !this.next || this.fade || !status.playing || !status.duration) return
    if (this.crossfadeSeconds <= 0 && !this.gapless) return
    const remaining = (status.duration - status.currentTime) / (this.rate || 1)
    if (remaining <= this.crossfadeSeconds + PRELOAD_LEAD_S) this.preloadNext()
    if (this.crossfadeSeconds > 0 && remaining <= this.crossfadeSeconds) this.startCrossfade(remaining)
  }

  /** The preloaded track has to start from its first second: if its deck ran ahead of the handover, rewind it. */
  private rewindIfAhead(deck: AudioPlayer): void {
    if (deck.currentTime > START_TOLERANCE_S) deck.seekTo(0).catch(() => {})
  }

  private preloadNext(): void {
    const next = this.next
    const otherIndex = (1 - this.active) as DeckIndex
    if (!next || this.trackIds[otherIndex] === next.id) return
    const deck = this.decks[otherIndex]
    this.trackIds[otherIndex] = next.id
    this.infos[otherIndex] = next.info ?? null
    this.finished[otherIndex] = false
    this.atEnd[otherIndex] = false
    // Paused first (see the class comment): a deck that finished a track would start this one by itself.
    this.gains[otherIndex] = next.gain ?? 1
    deck.pause()
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
    this.rewindIfAhead(to)
    to.volume = 0
    this.active = toIndex
    this.finished[toIndex] = false
    this.atEnd[toIndex] = false
    this.pendingSeek = null
    this.play()
    const native = this.startNativeFade(this.decks[fromIndex], to, durationMs, this.level(fromIndex), this.level(toIndex))
    this.fade = {
      from: fromIndex,
      start: Date.now(),
      durationMs,
      timer: native ? null : setInterval(() => this.stepFade(), FADE_STEP_MS)
    }
    this.showNowPlaying()
    this.handlers?.onAutoAdvance()
  }

  /**
   * Hands the volume ramp to the native side, which keeps running with the screen off. False if it can't.
   * Each deck ramps between silence and its own level (volume times its track's loudness factor).
   */
  private startNativeFade(from: AudioPlayer, to: AudioPlayer, durationMs: number, fromLevel: number, toLevel: number): boolean {
    try {
      return SelfHostNative?.startCrossfade?.(from, to, durationMs, fromLevel, toLevel) === true
    } catch {
      return false
    }
  }

  /** Equal-power ramps keep the perceived loudness flat through the middle of the crossfade. */
  private stepFade(): void {
    const fade = this.fade
    if (!fade) return
    const progress = Math.min(1, (Date.now() - fade.start) / fade.durationMs)
    this.decks[this.active].volume = this.level(this.active) * Math.sin((progress * Math.PI) / 2)
    this.decks[fade.from].volume = this.level(fade.from) * Math.cos((progress * Math.PI) / 2)
    if (progress >= 1) this.finishFade()
  }

  /** Ends a crossfade in progress at once: the outgoing track stops and the new one plays at full volume. */
  private finishFade(): void {
    const fade = this.fade
    if (!fade) return
    if (fade.timer) clearInterval(fade.timer)
    else SelfHostNative?.cancelCrossfade?.()
    this.fade = null
    this.decks[fade.from].pause()
    this.trackIds[fade.from] = null
    this.decks[this.active].volume = this.level(this.active)
  }

  private onActiveEnded(): void {
    if (this.stopAfterTrack) {
      // The track the person asked to stop after is over: nothing follows it by itself.
      this.stopAfterTrack = false
      this.wantPlaying = false
      this.pendingPlay = false
      this.decks[this.active].pause()
      this.handlers?.onStopAfterTrack?.()
      return
    }
    const next = this.next
    const otherIndex = (1 - this.active) as DeckIndex
    const other = this.decks[otherIndex]
    // Gapless handoff - also the fallback when a crossfade window was missed (seek, slow preload).
    if (next && (this.gapless || this.crossfadeSeconds > 0) && this.trackIds[otherIndex] === next.id && other.isLoaded) {
      // Paused, not just ended: it keeps "play when ready" on and would start the next source it is given.
      this.decks[this.active].pause()
      this.trackIds[this.active] = null
      this.active = otherIndex
      this.rewindIfAhead(other)
      other.volume = this.level(otherIndex)
      this.finished[otherIndex] = false
      this.atEnd[otherIndex] = false
      this.pendingSeek = null
      this.play()
      this.showNowPlaying()
      this.handlers?.onAutoAdvance()
      return
    }
    // Nothing took over. Paused, not just ended: it keeps "play when ready" on, and would start whatever is loaded
    // into it next by itself, or the same track again after a seek.
    this.decks[this.active].pause()
    this.handlers?.onTrackEnd()
  }
}

export const engine = new DeckEngine()

export function seekTo(seconds: number): void {
  engine.seekTo(seconds)
}

/** Presses coming from outside the app: Now Bar, notification, headset, Android Auto. */
export type RemoteCommand = 'next' | 'previous' | 'play' | 'pause'

const REMOTE_COMMANDS: readonly string[] = ['next', 'previous', 'play', 'pause']

/**
 * Subscribes to the presses made outside the app. This event is added by our patch to expo-audio
 * (patches/expo-audio) - stock expo-audio strips the next/previous commands from its MediaSession
 * entirely, and only lets play/pause act on the player silently - so it isn't in the library's public
 * typings. It comes from whichever deck currently owns the lock screen, so both are listened to.
 */
export function onRemoteCommand(handler: (command: RemoteCommand) => void): () => void {
  const subscriptions = engine.decks.map((deck) => {
    const emitter = deck as unknown as {
      addListener(event: string, listener: (payload: { command: RemoteCommand }) => void): { remove(): void }
    }
    return emitter.addListener('remoteCommand', (payload) => {
      if (payload && REMOTE_COMMANDS.includes(payload.command)) handler(payload.command)
    })
  })
  return () => subscriptions.forEach((s) => s.remove())
}

let configured = false

/** Whether the installed build holds the audio focus itself (selfhost-native's MusicFocus). */
function nativeFocus(): boolean {
  try {
    return typeof SelfHostNative?.requestAudioFocus === 'function'
  } catch {
    return false
  }
}

export async function ensureAudioMode(): Promise<void> {
  if (configured) return
  configured = true
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    // 'mixWithOthers' switches expo-audio's own audio focus handling off on Android, where selfhost-native holds the
    // focus for the music instead: expo-audio's paused every player on any other sound (a notification included) and
    // gave the focus up at every rebuffer or change of song, which cut the music. (The lock screen controls don't
    // depend on it on Android: they come from patches/expo-audio.) An older build without the native focus keeps
    // expo-audio's.
    interruptionMode: nativeFocus() ? 'mixWithOthers' : 'doNotMix'
  })
}

// Set as soon as the engine exists, before anything can play: expo-audio must not take the focus itself first, or
// its request and the app's would take it from each other, and each loss pauses the music.
void ensureAudioMode()
