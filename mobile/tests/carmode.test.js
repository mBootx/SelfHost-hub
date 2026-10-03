// The car mode around the gestures: what each gesture does (src/services/carActions.ts) on this phone or on the device
// the player drives, and the car mode's store (src/store/carModeStore.ts): settings kept across a restart, the camera
// permission, the sunshine switch.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const NL = String.fromCharCode(10)
const tests = []
const test = (name, fn) => tests.push([name, fn])
let m
let outfile

const STUBS = {
  'react-native': 'react-native.js',
  '@/services/storage': 'storage.js',
  '@/store/navidromeStore': 'navidromeStore.js',
  '@/store/remoteStore': 'remoteStore.js'
}

/** Loads the app's modules afresh, as a restart would (what the stubs keep on globalThis survives, like the phone's storage). */
function restart() {
  delete require.cache[require.resolve(outfile)]
  for (const key of Object.keys(require.cache)) if (key.includes(path.sep + 'stubs' + path.sep)) delete require.cache[key]
  m = require(outfile)
}

function fresh() {
  fake.prefs = {}
  fake.sentCommands = []
  fake.native = { missing: false, shareListeners: [] }
  restart()
}

const SONG = { id: 's1', title: 'Titre', artist: 'Artiste', album: 'Album', albumId: 'a1', duration: 200 }

function fakeClient({ fails = false } = {}) {
  const calls = []
  return {
    calls,
    async star(id) {
      calls.push(['star', id])
      if (fails) throw new Error('500')
    },
    async unstar(id) {
      calls.push(['unstar', id])
      if (fails) throw new Error('500')
    }
  }
}

function playLocally(song = SONG, extra = {}) {
  m.useNavidromeStore.setState({ queue: song ? [song] : [], queueIndex: 0, client: extra.client ?? fakeClient(), volume: extra.volume ?? 0.8 })
  m.useRemoteStore.setState({ selectedDeviceId: 'local', devices: {} })
}

function driveRemote(device) {
  m.useRemoteStore.setState({ selectedDeviceId: 'pc', devices: { pc: device } })
}

// --- What the gestures do ---

test('each gesture does what the spec says: pinch plays or pauses, waves skip, an open hand sets the volume, a thumb likes', () => {
  fresh()
  assert.deepStrictEqual(m.ACTION_FOR, {
    PINCH: 'toggle',
    WAVE_RIGHT: 'next',
    WAVE_LEFT: 'prev',
    PALM_UP: 'volumeUp',
    PALM_DOWN: 'volumeDown',
    THUMB_UP: 'like'
  })
  for (const g of m.GESTURES) assert.ok(m.ACTION_FOR[g], g)
})

test('play / pause and the skips go where the player buttons go (this phone or the device picked)', async () => {
  fresh()
  playLocally()
  for (const action of ['toggle', 'next', 'prev']) assert.strictEqual(await m.runCarAction(action), null)
  assert.deepStrictEqual(fake.sentCommands, [{ action: 'toggle' }, { action: 'next' }, { action: 'prev' }])
})

test("on this phone the volume is the phone's media volume, moved like its buttons", async () => {
  fresh()
  playLocally()
  fake.native.mediaVolume = 0.6
  const up = await m.runCarAction('volumeUp')
  assert.deepStrictEqual(fake.native.volumeSteps, [1])
  assert.strictEqual(up, 'Volume 67 %')
  await m.runCarAction('volumeDown')
  await m.runCarAction('volumeDown')
  assert.deepStrictEqual(fake.native.volumeSteps, [1, -1, -1])
  assert.strictEqual(m.useNavidromeStore.getState().volume, 0.8, "the app's own volume is left alone")
  assert.deepStrictEqual(fake.sentCommands, [])
})

test("without the phone's volume (an older build) the app's own volume moves instead, within 0 and 1", async () => {
  fresh()
  fake.native.missing = true
  playLocally(SONG, { volume: 0.95 })
  assert.strictEqual(await m.runCarAction('volumeUp'), 'Volume 100 %')
  assert.strictEqual(m.useNavidromeStore.getState().volume, 1)
  m.useNavidromeStore.setState({ volume: 0.05 })
  await m.runCarAction('volumeDown')
  assert.strictEqual(m.useNavidromeStore.getState().volume, 0)
})

test('driving another device, the volume is that device’s, a tenth at a time, within 0 and 1', async () => {
  fresh()
  playLocally()
  fake.native.mediaVolume = 0.5
  driveRemote({ song: SONG, isPlaying: true, volume: 0.45 })
  assert.strictEqual(await m.runCarAction('volumeUp'), 'Volume 55 %')
  assert.deepStrictEqual(fake.sentCommands, [{ action: 'setVolume', payload: { volume: 0.55 } }])
  assert.strictEqual(fake.native.volumeSteps, undefined, "the phone's own volume is not touched")
  driveRemote({ song: SONG, isPlaying: true, volume: 0.98 })
  await m.runCarAction('volumeUp')
  driveRemote({ song: SONG, isPlaying: true, volume: 0.02 })
  await m.runCarAction('volumeDown')
  driveRemote({ song: SONG, isPlaying: true })
  await m.runCarAction('volumeDown')
  assert.deepStrictEqual(
    fake.sentCommands.slice(1).map((c) => c.payload.volume),
    [1, 0, 0.4]
  )
})

test('a thumb up likes the song playing, once: on a favourite it does nothing, it never unlikes', async () => {
  fresh()
  const client = fakeClient()
  playLocally(SONG, { client })
  assert.strictEqual(await m.runCarAction('like'), 'Ajouté aux favoris')
  assert.strictEqual(await m.runCarAction('like'), 'Déjà dans vos favoris')
  assert.deepStrictEqual(client.calls, [['star', 's1']])
  const starredSong = { ...SONG, id: 's2', starred: '2026-01-01' }
  playLocally(starredSong, { client })
  assert.strictEqual(await m.runCarAction('like'), 'Déjà dans vos favoris')
  assert.deepStrictEqual(client.calls, [['star', 's1']])
})

test("driving another device, the thumb likes that device's song", async () => {
  fresh()
  const client = fakeClient()
  playLocally(SONG, { client })
  driveRemote({ song: { ...SONG, id: 'remote-song' }, isPlaying: true, volume: 0.5 })
  await m.runCarAction('like')
  assert.deepStrictEqual(client.calls, [['star', 'remote-song']])
})

test('nothing playing, or the server refusing, is said; a refused like is not kept', async () => {
  fresh()
  playLocally(null)
  assert.strictEqual(await m.runCarAction('like'), 'Aucun titre en cours')
  const client = fakeClient({ fails: true })
  playLocally(SONG, { client })
  assert.strictEqual(await m.runCarAction('like'), 'Favoris injoignables')
  assert.strictEqual(m.isStarred(m.useStarStore.getState(), SONG), false)
})

// --- The store ---

test('the settings start at the defaults: every gesture on, the middle sensitivity, 24 frames a second', () => {
  fresh()
  const s = m.useCarModeStore.getState()
  assert.strictEqual(s.sensitivity, 0.5)
  assert.deepStrictEqual(s.gestureThresholds, m.DEFAULT_THRESHOLDS)
  assert.ok(m.GESTURES.every((g) => s.gestures[g] === true))
  assert.strictEqual(s.testMode, false)
  assert.strictEqual(m.fpsFor(s.batterySaver), 24)
  assert.strictEqual(m.fpsFor(true), 15)
})

test('the settings are kept across a restart', async () => {
  fresh()
  let s = m.useCarModeStore.getState()
  s.setSensitivity(0.8)
  s.setGestureEnabled('PALM_UP', false)
  s.setTestMode(true)
  s.setBatterySaver(true)
  s.setOrientation('landscape')
  s.setHaptics(false)
  s.setSunBoost(false)
  const thresholds = m.useCarModeStore.getState().gestureThresholds
  restart()
  await m.useCarModeStore.getState().load()
  s = m.useCarModeStore.getState()
  assert.strictEqual(s.sensitivity, 0.8)
  assert.deepStrictEqual(s.gestureThresholds, thresholds)
  assert.strictEqual(s.gestures.PALM_UP, false)
  assert.strictEqual(s.gestures.PINCH, true)
  assert.deepStrictEqual([s.testMode, s.batterySaver, s.orientation, s.haptics, s.sunBoost], [true, true, 'landscape', false, false])
  assert.strictEqual(s.loaded, true)
})

test('what is open, the camera and the last gesture are not kept', async () => {
  fresh()
  const s = m.useCarModeStore.getState()
  s.setCarModeEnabled(true)
  s.setCameraActive(true)
  s.setLastGesture('PINCH', 0.9)
  restart()
  await m.useCarModeStore.getState().load()
  const after = m.useCarModeStore.getState()
  assert.deepStrictEqual([after.isCarModeEnabled, after.isCameraActive, after.lastDetectedGesture], [false, false, null])
})

test('a damaged or foreign saved file gives defaults where it is wrong, and keeps what is right', async () => {
  fresh()
  fake.prefs['carMode.settings'] = {
    sensitivity: 'loud',
    gestureThresholds: { pinchDistance: 99, swipeMinDistance: -1, swipeConfidenceThreshold: 0.8 },
    gestures: { PINCH: 'yes', THUMB_UP: false },
    orientation: 'upside-down',
    haptics: 0,
    sunBoost: false
  }
  await m.useCarModeStore.getState().load()
  const s = m.useCarModeStore.getState()
  assert.strictEqual(s.sensitivity, 0.5)
  assert.deepStrictEqual(s.gestureThresholds, { pinchDistance: 1, swipeMinDistance: 0.05, swipeConfidenceThreshold: 0.8 })
  assert.strictEqual(s.gestures.PINCH, true)
  assert.strictEqual(s.gestures.THUMB_UP, false)
  assert.strictEqual(s.orientation, 'auto')
  assert.strictEqual(s.haptics, true)
  assert.strictEqual(s.sunBoost, false)
  fake.prefs['carMode.settings'] = 'nonsense'
  await m.useCarModeStore.getState().load()
  assert.deepStrictEqual(m.useCarModeStore.getState().gestureThresholds, m.DEFAULT_THRESHOLDS)
})

test('the sensitivity sets every threshold; one threshold can still be tuned, within reason', () => {
  fresh()
  const s = m.useCarModeStore.getState()
  s.setSensitivity(1)
  assert.deepStrictEqual(m.useCarModeStore.getState().gestureThresholds, m.thresholdsFor(1))
  s.updateThreshold('swipeMinDistance', 0.5)
  assert.strictEqual(m.useCarModeStore.getState().gestureThresholds.swipeMinDistance, 0.5)
  assert.strictEqual(m.useCarModeStore.getState().gestureThresholds.pinchDistance, m.thresholdsFor(1).pinchDistance)
  s.updateThreshold('pinchDistance', 40)
  assert.strictEqual(m.useCarModeStore.getState().gestureThresholds.pinchDistance, 1)
  s.updateThreshold('pinchDistance', NaN)
  assert.strictEqual(m.useCarModeStore.getState().gestureThresholds.pinchDistance, 1)
  s.setSensitivity(5)
  assert.strictEqual(m.useCarModeStore.getState().sensitivity, 1)
  assert.deepStrictEqual(fake.prefs['carMode.settings'].gestureThresholds, m.thresholdsFor(1))
})

test('each gesture counts, even the same one twice; clearing it keeps the count', () => {
  fresh()
  const s = m.useCarModeStore.getState()
  s.setLastGesture('PINCH', 0.9)
  s.setLastGesture('PINCH', 1.7)
  let after = m.useCarModeStore.getState()
  assert.deepStrictEqual([after.lastDetectedGesture, after.lastConfidence, after.gestureCount], ['PINCH', 1, 2])
  s.setLastGesture(null)
  after = m.useCarModeStore.getState()
  assert.deepStrictEqual([after.lastDetectedGesture, after.gestureCount], [null, 2])
})

// --- The camera permission ---

test('the camera permission reads the way Android answers it', () => {
  fresh()
  assert.strictEqual(m.permissionFrom({ status: 'granted', granted: true, canAskAgain: true }), 'granted')
  assert.strictEqual(m.permissionFrom({ status: 'undetermined', granted: false, canAskAgain: true }), 'unknown')
  assert.strictEqual(m.permissionFrom({ status: 'denied', granted: false, canAskAgain: true }), 'denied')
  assert.strictEqual(m.permissionFrom({ status: 'denied', granted: false, canAskAgain: false }), 'blocked')
  assert.strictEqual(m.permissionFrom(null), 'unavailable')
})

test('reading the permission does not ask; asking does, and the answer is kept', async () => {
  fresh()
  fake.native.cameraAnswer = { status: 'granted', granted: true, canAskAgain: true }
  assert.strictEqual(await m.useCarModeStore.getState().refreshPermission(), 'unknown')
  assert.strictEqual(fake.native.cameraAsks, undefined)
  assert.strictEqual(await m.useCarModeStore.getState().requestPermission(), 'granted')
  assert.strictEqual(fake.native.cameraAsks, 1)
  assert.strictEqual(m.useCarModeStore.getState().permission, 'granted')
  assert.strictEqual(await m.useCarModeStore.getState().refreshPermission(), 'granted')
})

test('a build without the camera, or a failing one, says the gestures are unavailable', async () => {
  fresh()
  fake.native.missing = true
  assert.strictEqual(await m.useCarModeStore.getState().requestPermission(), 'unavailable')
  fake.native.missing = false
  fake.native.cameraError = 'boom'
  assert.strictEqual(await m.useCarModeStore.getState().refreshPermission(), 'unavailable')
})

// --- The sun ---

test('the screen goes bright in sunshine and back only once it is clearly darker', () => {
  fresh()
  let sunny = false
  const seen = []
  for (const lux of [300, 5000, 9000, 6000, 2000, 1400, 7000, 12000]) {
    sunny = m.sunnyAfter(sunny, lux)
    seen.push(sunny)
  }
  assert.deepStrictEqual(seen, [false, false, true, true, true, false, false, true])
  assert.strictEqual(m.sunnyAfter(true, NaN), true)
})

let finished = false
process.on('exit', () => {
  if (!finished) {
    console.log('FAIL the run ended before every test had finished')
    process.exitCode = 1
  }
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'carmode.ts')
  fs.writeFileSync(
    entry,
    [
      "export * from '@/services/carActions'",
      "export * from '@/store/carModeStore'",
      "export { useStarStore, isStarred } from '@/store/starStore'",
      "export { useNavidromeStore } from '@/store/navidromeStore'",
      "export { useRemoteStore } from '@/store/remoteStore'",
      "export { GESTURES, DEFAULT_THRESHOLDS, thresholdsFor } from '@/services/gestureRecognizer'",
      ''
    ].join(NL)
  )
  outfile = await bundle(entry, STUBS, path.join(bundle.OUT, 'carmode.js'))
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + NL + '     ' + String(err && err.stack ? err.stack : err).split(NL).slice(0, 6).join(NL + '     '))
    }
  }
  finished = true
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' car mode tests passed')
  process.exit(failed ? 1 : 0)
})()
