// The home-screen widget's buttons: each does what the matching button on the player does.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')
const miniStore = require('./stubs/mini-store')

const NL = String.fromCharCode(10)
const calls = []
globalThis.__navidromeStub = miniStore({
  togglePlay: () => calls.push('toggle'),
  next: () => calls.push('next'),
  prev: () => calls.push('previous')
})

let m
const tests = []
const test = (name, fn) => tests.push([name, fn])

test('toggle, next and previous reach the player\'s own actions', () => {
  calls.length = 0
  for (const action of ['toggle', 'next', 'previous']) m.handleWidgetAction(action)
  assert.deepStrictEqual(calls, ['toggle', 'next', 'previous'])
})

test('anything else is ignored', () => {
  calls.length = 0
  for (const action of ['', 'delete', undefined, null, 'TOGGLE']) m.handleWidgetAction(action)
  assert.deepStrictEqual(calls, [])
})

test('the widget\'s events are listened to once, and carry the action', () => {
  fake.native.shareListeners = []
  m.startWidget()
  m.startWidget()
  const listeners = fake.native.shareListeners.filter(([event]) => event === 'onWidgetAction')
  assert.strictEqual(listeners.length, 1)
  calls.length = 0
  listeners[0][1]({ action: 'next' })
  listeners[0][1](undefined)
  assert.deepStrictEqual(calls, ['next'])
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'widget.ts')
  fs.writeFileSync(entry, "export * from '@/services/widget'" + NL)
  m = require(await bundle(entry, { '@/store/navidromeStore': 'navidrome-handle.js' }, path.join(bundle.OUT, 'widget.js')))
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
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' widget tests passed')
  process.exit(failed ? 1 : 0)
})()
