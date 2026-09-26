/**
 * Re-applies our expo-audio fork of the Android media session after every install.
 *
 * Why: stock expo-audio strips COMMAND_SEEK_TO_NEXT/PREVIOUS from its MediaSession
 * (AudioMediaSessionCallback.onConnect), so no external surface - Samsung Now Bar,
 * the media notification, Android Auto, Bluetooth headset buttons - can ever skip
 * tracks. Our copies put those commands back, have MetadataInjectingPlayer claim
 * them (expo-audio only ever holds one media item, so ExoPlayer would otherwise
 * report "no next track"), and forward the presses to JS as a `remoteCommand`
 * event, where the real play queue lives.
 *
 * patch-package would be the usual tool, but it shells out to git to build the
 * diff and git isn't installed on this machine, so we copy whole files instead.
 * That means the copies are pinned to one expo-audio version: on a mismatch we
 * refuse to clobber the newer library and say so loudly rather than silently
 * pasting stale sources over it.
 */
const fs = require('fs')
const path = require('path')

const PINNED_VERSION = '57.0.5'
const FILES = ['MetadataInjectingPlayer.kt', 'AudioMediaSessionCallback.kt', 'AudioControlsService.kt']

const root = path.resolve(__dirname, '..')
const moduleRoot = path.join(root, 'node_modules', 'expo-audio')
const targetDir = path.join(moduleRoot, 'android', 'src', 'main', 'java', 'expo', 'modules', 'audio', 'service')
const sourceDir = path.join(root, 'patches', 'expo-audio')

function warn(message) {
  console.warn(`\n  expo-audio patch: ${message}\n`)
}

if (!fs.existsSync(moduleRoot)) {
  // Nothing to patch yet (e.g. a partial install); npm will run us again.
  process.exit(0)
}

const installed = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'package.json'), 'utf8')).version
if (installed !== PINNED_VERSION) {
  warn(
    `expo-audio is now ${installed} but the patched sources are for ${PINNED_VERSION}. ` +
      `NOT patching. Lock screen / Samsung Now Bar skip buttons will be missing until the files in ` +
      `patches/expo-audio are refreshed from the new version and PINNED_VERSION is bumped.`
  )
  // Exiting 0 here would let npm/expo report a clean install while silently
  // shipping an unpatched build - the opposite of "say so loudly" above.
  process.exit(1)
}

let patched = 0
for (const file of FILES) {
  const source = path.join(sourceDir, file)
  const target = path.join(targetDir, file)
  if (!fs.existsSync(source)) {
    warn(`missing ${path.relative(root, source)} - skipping`)
    continue
  }
  const next = fs.readFileSync(source)
  if (fs.existsSync(target) && fs.readFileSync(target).equals(next)) continue
  fs.writeFileSync(target, next)
  patched++
}

if (patched > 0) console.log(`  expo-audio patch: applied ${patched} file(s) for Now Bar transport controls`)
