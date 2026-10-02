const miniStore = require('./mini-store')
const fake = require('./fake')

// The slice of the remote-control store that the watch link reads and drives (see tests/watchlink.test.js).
exports.LOCAL_DEVICE_ID = 'local'

exports.useRemoteStore = miniStore({
  enabled: false,
  status: 'disconnected',
  error: null,
  client: null,
  deviceId: 'phone-real-id',
  deviceName: 'Galaxy S25',
  pairing: null,
  deviceList: [],
  devices: {},
  selectedDeviceId: 'local',
  /** Reconnecting to the PC; counted, not done. */
  autoConnect: async () => {
    fake.autoConnects = (fake.autoConnects || 0) + 1
  }
})

/** What the phone's own player is doing, built from its store the way store/remoteStore.ts builds it. */
exports.currentStatePayload = () => {
  const s = require('./navidromeStore').useNavidromeStore.getState()
  const song = s.queue[s.queueIndex] || null
  return {
    song: song
      ? { id: song.id, title: song.title, artist: song.artist, album: song.album, albumId: song.albumId, coverArt: song.coverArt, duration: song.duration }
      : null,
    isPlaying: s.isPlaying,
    currentTime: s.currentTime,
    duration: s.duration,
    shuffle: s.shuffle,
    repeatMode: s.repeatMode,
    volume: s.volume
  }
}

/** The commands this phone's own player was given. */
exports.applyCommandLocally = (action, payload) => {
  fake.localCommands = fake.localCommands || []
  fake.localCommands.push({ action, payload })
}
