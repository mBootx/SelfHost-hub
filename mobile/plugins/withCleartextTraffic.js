const { withAndroidManifest } = require('expo/config-plugins')

// Since Android 9 an app that targets it may not speak plain HTTP or WebSocket unless its manifest says so, and only the
// debug manifest of a React Native project does. This app talks to servers the user runs at home, most of them by
// a LAN address with no certificate (the login screens even offer "http://192.168.1.10:4533"), and to the PC's remote
// control hub, which listens on ws://<LAN address>:51823: without the flag a release build cannot reach any of them,
// and the failure is a silent "network request failed". The addresses are the user's own, typed or discovered on their
// network, so the flag is allowed for the whole app: Android offers no way to name "any private address" instead.
function allowCleartext(manifest) {
  const application = manifest.application && manifest.application[0]
  if (application) application.$['android:usesCleartextTraffic'] = 'true'
  return manifest
}

function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    cfg.modResults.manifest = allowCleartext(cfg.modResults.manifest)
    return cfg
  })
}

module.exports = withCleartextTraffic
module.exports.allowCleartext = allowCleartext
