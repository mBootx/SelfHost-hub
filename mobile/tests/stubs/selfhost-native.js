const fake = require('./fake')

// The phone-side module as the JS code sees it. fake.native.missing = true plays an older build without these functions.
fake.native = fake.native || { clock: { elapsed: 1000, boot: 7 }, privacy: [], charging: false, missing: false, share: null, shareListeners: [], crossfades: [], cancelledFades: 0 }

function api() {
  if (fake.native.missing) return {}
  return {
    setPrivacyScreen(enabled) {
      fake.native.privacy.push(enabled)
      return true
    },
    getClock() {
      return fake.native.clock
    },
    isCharging() {
      return fake.native.charging
    },
    startCrossfade(outgoing, incoming, durationMs, outgoingLevel, incomingLevel) {
      fake.native.crossfades.push({ outgoing, incoming, durationMs, outgoingLevel, incomingLevel })
      return true
    },
    cancelCrossfade() {
      fake.native.cancelledFades++
    },
    startSleepTimer(first, second, durationMs, fadeMs) {
      fake.native.sleep = { first, second, durationMs, fadeMs }
      return !fake.native.sleepFails
    },
    cancelSleepTimer() {
      fake.native.sleep = null
      fake.native.sleepCancels = (fake.native.sleepCancels || 0) + 1
    },
    // A share waiting to be read (reading empties it), and the listeners told when another arrives.
    async consumeSharedContent() {
      const share = fake.native.share
      fake.native.share = null
      return share
    },
    clearSharedContent() {
      fake.native.clearedShares = (fake.native.clearedShares || 0) + 1
    },
    addListener(event, listener) {
      fake.native.shareListeners.push([event, listener])
      return { remove() {} }
    }
  }
}

// Looked up on every use so a test can switch the build between calls.
module.exports = {
  __esModule: true,
  get default() {
    return new Proxy({}, { get: (_t, key) => api()[key], has: (_t, key) => key in api() })
  }
}
