const fake = require('./fake')

// Just enough of expo-audio for the playback engine: players with a volume, a play state and a position, that
// report their state through the 'playbackStatusUpdate' listener when a test calls emit().
//
// The lock screen / Now Bar is modelled as the native side behaves (patches/expo-audio): one session, held by the
// last player that claimed it, showing that player's metadata. fake.lockScreen is what it shows (null when taken
// down) and fake.lockScreenCalls every claim. A press on it comes back through press(), as the 'remoteCommand' event
// of the player holding it.
class FakePlayer {
  constructor() {
    this.volume = 1
    this.playing = false
    this.isLoaded = false
    this.currentTime = 0
    this.duration = 0
    this.source = null
    this.listeners = []
    this.remoteListeners = []
    this.pauses = 0
    this.plays = 0
    this.seeks = []
  }
  addListener(event, callback) {
    const list = event === 'playbackStatusUpdate' ? this.listeners : event === 'remoteCommand' ? this.remoteListeners : null
    if (list) list.push(callback)
    return {
      remove() {
        if (!list) return
        const at = list.indexOf(callback)
        if (at >= 0) list.splice(at, 1)
      }
    }
  }
  replace(source) {
    this.source = source
    this.isLoaded = true
    this.currentTime = 0
    this.duration = (fake.durations && fake.durations[source]) || 100
  }
  play() {
    this.playing = true
    this.plays++
  }
  pause() {
    this.playing = false
    this.pauses++
  }
  async seekTo(seconds) {
    this.seeks.push(seconds)
    this.currentTime = seconds
  }
  setPlaybackRate() {}
  setActiveForLockScreen(active, metadata, options) {
    if (!active) return
    fake.lockScreen = { player: this, metadata, options }
    ;(fake.lockScreenCalls = fake.lockScreenCalls || []).push(fake.lockScreen)
  }
  clearLockScreenControls() {
    if (fake.lockScreen && fake.lockScreen.player === this) fake.lockScreen = null
  }
  /** Delivers the player's state to the engine, as the native side does. */
  emit(overrides = {}) {
    const status = { playing: this.playing, currentTime: this.currentTime, duration: this.duration, isLoaded: this.isLoaded, didJustFinish: false, ...overrides }
    for (const listener of this.listeners) listener(status)
  }
  /** A press on the Now Bar while this player holds it ('play', 'pause', 'next', 'previous'). */
  press(command) {
    for (const listener of this.remoteListeners) listener({ command })
  }
}

exports.createAudioPlayer = () => {
  const player = new FakePlayer()
  ;(fake.players = fake.players || []).push(player)
  return player
}
exports.setAudioModeAsync = async (mode) => {
  fake.audioMode = mode
}
