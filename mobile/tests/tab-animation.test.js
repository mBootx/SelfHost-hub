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
  '@/services/storage': 'storage.js'
}

function fresh() {
  fake.prefs = {}
  delete require.cache[require.resolve(outfile)]
  for (const key of Object.keys(require.cache)) if (key.includes(path.sep + 'stubs' + path.sep)) delete require.cache[key]
  m = require(outfile)
}

test('defaults to shift animation at normal speed (250 ms)', () => {
  fresh()
  const state = m.useTabAnimationStore.getState()
  assert.strictEqual(state.animationType, 'shift')
  assert.strictEqual(state.speed, 'normal')
  assert.strictEqual(state.durationMs, 250)
  assert.strictEqual(state.getSummary(), 'Glissement · 250 ms')
})

test('switching animation type updates state and summary', () => {
  fresh()
  const store = m.useTabAnimationStore
  store.getState().setAnimationType('fade')
  assert.strictEqual(store.getState().animationType, 'fade')
  assert.strictEqual(store.getState().getSummary(), 'Fondu · 250 ms')

  store.getState().setAnimationType('none')
  assert.strictEqual(store.getState().animationType, 'none')
  assert.strictEqual(store.getState().getSummary(), 'Désactivées')
})

test('changing speed preset adjusts durationMs accordingly', () => {
  fresh()
  const store = m.useTabAnimationStore

  store.getState().setSpeed('fast')
  assert.strictEqual(store.getState().speed, 'fast')
  assert.strictEqual(store.getState().durationMs, 150)

  store.getState().setSpeed('relaxed')
  assert.strictEqual(store.getState().speed, 'relaxed')
  assert.strictEqual(store.getState().durationMs, 380)

  store.getState().setSpeed('normal')
  assert.strictEqual(store.getState().speed, 'normal')
  assert.strictEqual(store.getState().durationMs, 250)
})

test('custom duration updates durationMs and clamps within safe bounds (80 to 600 ms)', () => {
  fresh()
  const store = m.useTabAnimationStore

  store.getState().setCustomDurationMs(200)
  assert.strictEqual(store.getState().durationMs, 200)

  store.getState().setCustomDurationMs(20)
  assert.strictEqual(store.getState().durationMs, 80)

  store.getState().setCustomDurationMs(999)
  assert.strictEqual(store.getState().durationMs, 600)
})

test('settings are persisted and restored via load()', async () => {
  fresh()
  const store = m.useTabAnimationStore

  store.getState().setAnimationType('fade')
  store.getState().setSpeed('fast')

  // Check persisted prefs
  assert.deepStrictEqual(fake.prefs['tab.animation'], {
    animationType: 'fade',
    speed: 'fast'
  })

  // Restart store from clean state and call load
  delete require.cache[require.resolve(outfile)]
  m = require(outfile)
  await m.useTabAnimationStore.getState().load()

  const loaded = m.useTabAnimationStore.getState()
  assert.strictEqual(loaded.animationType, 'fade')
  assert.strictEqual(loaded.speed, 'fast')
  assert.strictEqual(loaded.durationMs, 150)
})

let finished = false
process.on('exit', () => {
  if (!finished) {
    console.log('FAIL the run ended before every test had finished')
    process.exitCode = 1
  }
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'tab-animation.ts')
  fs.writeFileSync(entry, ["export * from '@/store/tabAnimationStore'", ''].join(NL))
  outfile = await bundle(entry, STUBS, path.join(bundle.OUT, 'tab-animation.js'))
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
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' tab animation tests passed')
  process.exit(failed ? 1 : 0)
})()
