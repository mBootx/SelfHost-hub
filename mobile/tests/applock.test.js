// The app lock: wrong codes, the pauses they cause (which setting the date must not cut short), and keeping
// the app out of the recents screen while a lock is set.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const STUBS = {
  'react-native': 'react-native.js',
  'expo-file-system': 'expo-file-system.js',
  'expo-secure-store': 'expo-secure-store.js',
  'expo-local-authentication': 'expo-local-authentication.js',
  '@/services/storage': 'storage.js',
  '../../modules/selfhost-native': 'selfhost-native.js'
}

let wall = 1_800_000_000_000
Date.now = () => wall

let m
let store
async function launch() {
  const entry = path.join(bundle.OUT, 'entries', 'applock.ts')
  const NL = String.fromCharCode(10)
  fs.writeFileSync(entry, "export { useAppLockStore, startAppLock } from '@/store/appLockStore'" + NL)
  const out = path.join(bundle.OUT, 'applock.js')
  await bundle(entry, STUBS, out)
  delete require.cache[require.resolve(out)]
  fake.appStateListeners = []
  m = require(out)
  store = m.useAppLockStore
  m.startAppLock()
  await store.getState().load()
}

function reset() {
  fake.secure = {}
  fake.files = {}
  fake.native = { clock: { elapsed: 5000, boot: 7 }, privacy: [], charging: false, missing: false }
  wall = 1_800_000_000_000
}

async function wrongCodes(count) {
  let last
  for (let i = 0; i < count; i++) last = await store.getState().check('0000')
  return last
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('five wrong codes pause the lock, and the right code is refused during the pause', async () => {
  await launch()
  await store.getState().setSecret('pin', '1234')
  store.getState().lock()
  assert.strictEqual(await wrongCodes(4), 'wrong')
  assert.strictEqual(await wrongCodes(1), 'wrong', 'the fifth is still just wrong; the pause starts after it')
  assert.strictEqual(await store.getState().check('1234'), 'locked-out')
  assert.ok(store.getState().lockoutUntil > wall)
})

test('moving the date forward does not end the pause', async () => {
  await launch()
  await store.getState().setSecret('pin', '1234')
  await wrongCodes(5)
  const until = store.getState().lockoutUntil
  wall += 10 * 60_000 // somebody sets the date ten minutes ahead
  assert.ok(wall > until, 'by the date the pause is over')
  assert.strictEqual(await store.getState().check('1234'), 'locked-out', 'by the phone\'s own clock it is not')
  assert.ok(store.getState().lockoutUntil > wall, 'and the screen counts down again from what is really left')
})

test('the pause ends when the phone\'s own clock has run it out', async () => {
  await launch()
  await store.getState().setSecret('pin', '1234')
  await wrongCodes(5)
  fake.native.clock = { elapsed: fake.native.clock.elapsed + 29_000, boot: 7 }
  assert.strictEqual(await store.getState().check('1234'), 'locked-out')
  fake.native.clock = { elapsed: fake.native.clock.elapsed + 2_000, boot: 7 }
  assert.strictEqual(await store.getState().check('1234'), 'ok')
  assert.strictEqual(store.getState().failedAttempts, 0)
})

test('the pause survives closing the app', async () => {
  await launch()
  await store.getState().setSecret('pin', '1234')
  await wrongCodes(5)
  wall += 5000
  fake.native.clock = { elapsed: fake.native.clock.elapsed + 5000, boot: 7 }
  await launch() // the app starts again, reading what was saved
  assert.strictEqual(store.getState().failedAttempts, 5)
  assert.strictEqual(await store.getState().check('1234'), 'locked-out')
  wall += 60 * 60_000 // an hour on the date, but nothing on the phone's clock
  assert.strictEqual(await store.getState().check('1234'), 'locked-out')
})

test('after a restart of the phone the date decides, since its own clock began again', async () => {
  await launch()
  await store.getState().setSecret('pin', '1234')
  await wrongCodes(5)
  fake.native.clock = { elapsed: 300, boot: 8 } // restarted
  await launch()
  assert.strictEqual(await store.getState().check('1234'), 'locked-out', 'the date has not run it out yet')
  wall += 31_000
  assert.strictEqual(await store.getState().check('1234'), 'ok')
})

test('an older build without the phone-side module falls back to the date', async () => {
  fake.native = { clock: { elapsed: 0, boot: 0 }, privacy: [], charging: false, missing: true }
  await launch()
  await store.getState().setSecret('pin', '1234')
  await wrongCodes(5)
  assert.strictEqual(await store.getState().check('1234'), 'locked-out')
  wall += 31_000
  assert.strictEqual(await store.getState().check('1234'), 'ok')
})

test('the recents screen is hidden while a lock is set, and shown again when it is removed', async () => {
  await launch()
  assert.deepStrictEqual(fake.native.privacy.slice(-1), [false], 'no lock yet')
  await store.getState().setSecret('pin', '1234')
  assert.strictEqual(fake.native.privacy.slice(-1)[0], true)
  fake.native.privacy.length = 0
  // the app comes back to the front: the activity may have been rebuilt, so the setting is made again
  fake.appStateListeners.forEach((listener) => listener('active'))
  assert.deepStrictEqual(fake.native.privacy, [true])
  await store.getState().disable()
  assert.strictEqual(fake.native.privacy.slice(-1)[0], false)
})

test('a lock that was already set hides the recents screen as soon as the app has started', async () => {
  await launch()
  await store.getState().setSecret('pin', '1234')
  fake.native.privacy.length = 0
  await launch()
  assert.ok(fake.native.privacy.includes(true))
})

;(async () => {
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      reset()
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + '\n     ' + String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n     '))
    }
  }
  console.log(failed ? failed + ' FAILED' : 'ALL APP LOCK TESTS PASSED')
  process.exit(failed ? 1 : 0)
})()
