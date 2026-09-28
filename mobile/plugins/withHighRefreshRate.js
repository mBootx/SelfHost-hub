const { withMainActivity } = require('expo/config-plugins')

// Asks Android for the display's fastest mode (120 Hz on the S25) instead of leaving
// the choice to the system, which can keep an app at 60 Hz.
const METHOD = `
  // Pick the display's fastest mode (e.g. 120 Hz) at the current resolution.
  @Suppress("DEPRECATION")
  private fun requestHighestRefreshRate() {
    val activeDisplay = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) display else windowManager.defaultDisplay) ?: return
    val current = activeDisplay.mode
    val fastest = activeDisplay.supportedModes
      .filter { it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight }
      .maxByOrNull { it.refreshRate } ?: return
    window.attributes = window.attributes.apply { preferredDisplayModeId = fastest.modeId }
  }
`

function addHighRefreshRate(contents) {
  if (contents.includes('fun requestHighestRefreshRate')) return contents
  const withCall = contents.replace(/super\.onCreate\([^)]*\)/, (call) => `${call}\n    requestHighestRefreshRate()`)
  const classEnd = withCall.lastIndexOf('}')
  return withCall.slice(0, classEnd) + METHOD + withCall.slice(classEnd)
}

function withHighRefreshRate(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language === 'kt') cfg.modResults.contents = addHighRefreshRate(cfg.modResults.contents)
    return cfg
  })
}

module.exports = withHighRefreshRate
module.exports.addHighRefreshRate = addHighRefreshRate
