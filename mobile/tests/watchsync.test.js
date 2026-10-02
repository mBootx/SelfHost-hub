// "Montre" setting: what the phone hands a Wear OS watch, and how it reacts to the watches it finds.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const REPO = path.resolve(bundle.MOBILE, '..')
const NL = String.fromCharCode(10)
const STUBS = {
  '@/services/storage': 'storage.js',
  '@/store/navidromeStore': 'navidromeStore.js'
}

let m
let navidromeStore
const tests = []
const test = (name, fn) => tests.push([name, fn])

/** The sample file the watch's own tests read: both sides are held to it. */
const SAMPLE = path.join(REPO, 'wear/core/src/test/resources/phone-setup.json')
const SAMPLE_SOURCES = {
  navidrome: { url: 'https://music.example.org', username: 'maxime', salt: 'c19b2d', token: crypto.createHash('md5').update('sesame' + 'c19b2d').digest('hex') }
}

function reset() {
  fake.prefs = {}
  fake.native = fake.native || {}
  Object.assign(fake.native, { missing: false, watches: [], outcomes: [], sentSetups: [], watchError: null, sendError: null })
  navidromeStore.setState({ client: null })
}

test('the message equals the sample file the watch reads, byte for byte', () => {
  assert.strictEqual(m.buildWatchSetup(SAMPLE_SOURCES), fs.readFileSync(SAMPLE, 'utf8').trim())
})

test('the token is the md5 of the password and the salt, as Subsonic documents it', () => {
  assert.strictEqual(SAMPLE_SOURCES.navidrome.token, '26719a1196d2a940705a59634eb18eab')
})

test('only the Navidrome login goes to the watch, and nothing about the PC', () => {
  const message = JSON.parse(m.buildWatchSetup(SAMPLE_SOURCES))
  assert.deepStrictEqual(Object.keys(message), ['v', 'navidrome'])
  assert.deepStrictEqual(Object.keys(message.navidrome), ['url', 'username', 'salt', 'token'])
  assert.ok(!/hub|pairing|code/i.test(m.buildWatchSetup(SAMPLE_SOURCES)))
})

test('no login, no message', () => {
  assert.strictEqual(m.buildWatchSetup({ navidrome: null }), null)
})

test('a login that is not complete is not sent half empty', () => {
  assert.strictEqual(m.buildWatchSetup({ navidrome: { url: 'https://m.example', username: 'u', salt: 's' } }), null)
  assert.strictEqual(m.buildWatchSetup({ navidrome: { url: '', username: 'u', salt: 's', token: 't' } }), null)
  assert.strictEqual(m.buildWatchSetup({ navidrome: { url: 'https://m.example', username: 'u', salt: 's', token: 7 } }), null)
})

test('the password is never in the message', () => {
  const json = m.buildWatchSetup(SAMPLE_SOURCES)
  assert.ok(!json.includes('sesame'))
  assert.ok(!/password/i.test(json))
})

test('salts are twelve hex characters and change from one call to the next', () => {
  const a = m.newSalt()
  const b = m.newSalt()
  assert.match(a, /^[0-9a-f]{12}$/)
  assert.notStrictEqual(a, b)
  assert.strictEqual(m.newSalt(() => 0), '000000000000')
  assert.strictEqual(m.newSalt(() => 0.999999), 'ffffffffffff')
})

test('what the phone knows is read from the signed-in client', () => {
  reset()
  assert.deepStrictEqual(m.readSetupSources(), { navidrome: null })
  navidromeStore.setState({ client: { sharedLogin: (salt) => ({ url: 'https://m.example', username: 'u', salt, token: 'f'.repeat(32) }) } })
  const sources = m.readSetupSources()
  assert.strictEqual(sources.navidrome.url, 'https://m.example')
  assert.match(sources.navidrome.salt, /^[0-9a-f]{12}$/)
})

test('signed out there is nothing to send, and the watch is not bothered', async () => {
  reset()
  fake.native.watches = [{ id: 'w1', name: 'Galaxy Watch', nearby: true, hasApp: true }]
  assert.deepStrictEqual(await m.sendSetupToWatches(), { status: 'nothing-to-send' })
  assert.deepStrictEqual(fake.native.sentSetups, [])
})

test('a setup is sent once and each watch\'s answer is passed on', async () => {
  reset()
  navidromeStore.setState({ client: { sharedLogin: (salt) => ({ url: 'https://m.example', username: 'u', salt, token: 'a'.repeat(32) }) } })
  fake.native.outcomes = [
    { id: 'w1', name: 'Galaxy Watch', ok: true, error: null },
    { id: 'w2', name: 'Vieille montre', ok: false, error: "La montre n'a pas répondu" }
  ]
  const result = await m.sendSetupToWatches()
  assert.strictEqual(result.status, 'sent')
  assert.strictEqual(result.outcomes.length, 2)
  assert.strictEqual(fake.native.sentSetups.length, 1)
  assert.strictEqual(JSON.parse(fake.native.sentSetups[0]).navidrome.url, 'https://m.example')
})

test('no watch with the app is reported as such', async () => {
  reset()
  navidromeStore.setState({ client: { sharedLogin: (salt) => ({ url: 'u', username: 'u', salt, token: 'a'.repeat(32) }) } })
  fake.native.outcomes = []
  assert.deepStrictEqual(await m.sendSetupToWatches(), { status: 'no-watch' })
})

test('a failing data layer is reported with its message', async () => {
  reset()
  navidromeStore.setState({ client: { sharedLogin: (salt) => ({ url: 'u', username: 'u', salt, token: 'a'.repeat(32) }) } })
  fake.native.sendError = 'Les services Google pour les montres ne sont pas disponibles'
  const result = await m.sendSetupToWatches()
  assert.strictEqual(result.status, 'error')
  assert.match(result.message, /services Google/)
})

test('an older build of the app, without the native functions, says it cannot', async () => {
  reset()
  fake.native.missing = true
  assert.strictEqual(m.watchSupported(), false)
  assert.deepStrictEqual(await m.sendSetupToWatches(), { status: 'unsupported' })
  assert.deepStrictEqual(await m.listWatches(), [])
})

test('the watches that are connected are listed', async () => {
  reset()
  fake.native.watches = [{ id: 'w1', name: 'Galaxy Watch', nearby: true, hasApp: false }]
  assert.deepStrictEqual(await m.listWatches(), fake.native.watches)
  fake.native.watchError = 'boom'
  await assert.rejects(() => m.listWatches(), /boom/)
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'watchsync.ts')
  fs.writeFileSync(entry, ["export * from '@/services/watchSync'", "export { useNavidromeStore } from '@/store/navidromeStore'", ''].join(NL))
  m = require(await bundle(entry, STUBS, path.join(bundle.OUT, 'watchsync.js')))
  navidromeStore = m.useNavidromeStore
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
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' watch setup tests passed')
  process.exit(failed ? 1 : 0)
})()
