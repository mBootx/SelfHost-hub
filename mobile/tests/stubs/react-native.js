const fake = require('./fake')
exports.AppState = {
  addEventListener(event, cb) {
    fake.appStateListeners.push(cb)
    return { remove() {} }
  }
}
exports.Vibration = { vibrate() { fake.vibrations++ } }
exports.__emitAppState = (state) => fake.appStateListeners.forEach((cb) => cb(state))
