// The patched expo-audio sources (patches/expo-audio) only reach a build once scripts/patch-expo-audio.js has copied
// them into node_modules (npm install runs it). An edit to a patch file without that copy builds the OLD code while
// the tests of the patch pass: it happened once, and a release APK nearly shipped without its Now Bar fix. This fails
// when a copy in node_modules differs from its patch file.
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const MOBILE = path.resolve(__dirname, '..')
const TARGET = path.join(MOBILE, 'node_modules', 'expo-audio', 'android', 'src', 'main', 'java', 'expo', 'modules', 'audio')
const FILES = {
  'AudioPlayer.kt': '',
  'MetadataInjectingPlayer.kt': 'service',
  'AudioMediaSessionCallback.kt': 'service',
  'AudioControlsService.kt': 'service',
  'NowPlayingArtwork.kt': 'service'
}

if (!fs.existsSync(TARGET)) {
  console.log('skipped: expo-audio is not installed')
  process.exit(0)
}

const script = fs.readFileSync(path.join(MOBILE, 'scripts', 'patch-expo-audio.js'), 'utf8')
let failed = 0
for (const [file, folder] of Object.entries(FILES)) {
  try {
    assert.ok(script.includes(`'${file}'`), `${file} is not in the patch script's list`)
    const patch = fs.readFileSync(path.join(MOBILE, 'patches', 'expo-audio', file))
    const copy = fs.readFileSync(path.join(TARGET, folder, file))
    assert.ok(patch.equals(copy), `node_modules has an old copy of ${file}: run "node scripts/patch-expo-audio.js" in mobile`)
    console.log('ok   ' + file + ' is the patched version')
  } catch (err) {
    failed++
    console.log('FAIL ' + err.message)
  }
}
console.log(failed ? failed + ' patch file(s) out of date' : 'all ' + Object.keys(FILES).length + ' patched expo-audio files are in place')
process.exit(failed ? 1 : 0)
