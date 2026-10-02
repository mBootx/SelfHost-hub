const fake = require('./fake')

// Just enough of expo-audio for the playback engine: players with a volume, a play state and a position, that
// report their state through the 'playbackStatusUpdate' listener when a test calls emit().
class FakePlayer {
  constructor() {
    this.volume = 1
    this.playing = false
    this.isLoaded = false
    this.currentTime = 0
    this.duration = 0
    this.source = null
    this.listeners = []
    this.pauses = 0
  }
  addListener(event, callback) {
    if (event === 'playbackStatusUpdate') this.listeners.push(callback)
    return { remove() {} }
  }
  replace(source) {
    this.source = source
    this.isLoaded = true
    this.currentTime = 0
    this.duration = (fake.durations && fake.durations[source]) || 100
  }
  play() {
    this.playing = true
  }
  pause() {
    this.playing = false
    this.pauses++
  }
  async seekTo(seconds) {
    this.currentTime = seconds
  }
  setPlaybackRate() {}
  clearLockScreenControls() {}
  /** Delivers the player's state to the engine, as the native side does. */
  emit(overrides = {}) {
    const status = { playing: this.playing, currentTime: this.currentTime, duration: this.duration, isLoaded: this.isLoaded, didJustFinish: false, ...overrides }
    for (const listener of this.listeners) listener(status)
  }
}

exports.createAudioPlayer = () => {
  const player = new FakePlayer()
  ;(fake.players = fake.players || []).push(player)
  return player
}
exports.setAudioModeAsync = async () => {}
