// The phone's native module (modules/selfhost-native) as the watch link sees it under real-phone.js: what the phone hands
// the Wear OS data layer goes to the harness's stdout, and the harness delivers the watch's messages to the listener.
const harness = () => globalThis.__phoneHarness

module.exports = {
  __esModule: true,
  default: {
    async sendToWatch(path, json) {
      harness().emit({ pushed: { path, json } })
      return 1
    },
    addListener(event, listener) {
      harness().listeners[event] = listener
      return {
        remove() {
          delete harness().listeners[event]
        }
      }
    }
  }
}
