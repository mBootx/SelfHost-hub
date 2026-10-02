const miniStore = require('./mini-store')
const fake = require('./fake')

// The slice of the player's store that the scrobbler watches.
exports.useNavidromeStore = miniStore({
  client: null,
  queue: [],
  queueIndex: 0,
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  refreshRecentlyPlayed() {
    fake.refreshes = (fake.refreshes || 0) + 1
  }
})
