// Plays reported to Navidrome: when a song counts, what is kept for later and what is given up on.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const STUBS = {
  '@/services/navidrome': 'navidrome.js',
  '@/services/storage': 'storage.js',
  '@/store/navidromeStore': 'navidromeStore.js'
}

let m
let store
let ApiError
const song = (id, duration = 100) => ({ id, title: id, artist: 'x', duration })

/** A client whose scrobble() answers from `script(id, submission)`: undefined is success, an error is thrown. */
function client(script = () => undefined) {
  const calls = []
  return {
    calls,
    async scrobble(id, submission, time) {
      calls.push({ id, submission, time })
      const outcome = script(id, submission)
      if (outcome) throw outcome
    }
  }
}
const submitted = (c) => c.calls.filter((call) => call.submission).map((call) => call.id)
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** Plays a song from the start to `until` seconds, one second at a time, then moves on. */
async function listen(track, until, { jump } = {}) {
  store.setState({ queue: [track], queueIndex: 0, currentTime: 0, isPlaying: true, duration: track.duration })
  for (let t = 1; t <= until; t++) {
    store.setState({ currentTime: jump && t > 2 ? t * jump : t })
  }
  store.setState({ isPlaying: false })
  await tick()
}

async function start() {
  const entry = path.join(bundle.OUT, 'entries', 'scrobbler.ts')
  fs.writeFileSync(entry, "export * from '@/services/scrobbler'" + String.fromCharCode(10) + "export { useNavidromeStore } from '@/store/navidromeStore'" + String.fromCharCode(10) + "export { ApiError } from '@/services/navidrome'" + String.fromCharCode(10))
  const out = path.join(bundle.OUT, 'scrobbler.js')
  await bundle(entry, STUBS, out)
  delete require.cache[require.resolve(out)]
  m = require(out)
  store = m.useNavidromeStore
  ApiError = m.ApiError
  m.startScrobbler()
  await tick()
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('a song heard for half its length is reported once, and its start is announced', async () => {
  const c = client()
  store.setState({ client: c })
  await listen(song('a', 100), 60)
  assert.deepStrictEqual(submitted(c), ['a'])
  assert.deepStrictEqual(c.calls.filter((x) => !x.submission).map((x) => x.id), ['a'])
  assert.ok(c.calls.find((x) => x.submission).time > 0)
})

test('a song skipped early, or too short, or jumped through, is not reported', async () => {
  const c = client()
  store.setState({ client: c })
  await listen(song('early', 100), 20)
  await listen(song('short', 20), 19)
  await listen(song('seeker', 100), 20, { jump: 10 }) // each tick jumps ten seconds: seeking, not listening
  assert.deepStrictEqual(submitted(c), [])
})

test('plays made while the server is out of reach wait, in order, and go out when it is back', async () => {
  const down = client(() => new ApiError('x', 0))
  store.setState({ client: down })
  await listen(song('one'), 60)
  await listen(song('two'), 60)
  assert.deepStrictEqual(submitted(down), ['one', 'one'], 'the first is tried again, the second waits behind it untried')
  const saved = fake.prefs['scrobbles.pending']
  assert.deepStrictEqual(saved.map((p) => p.id), ['one', 'two'])
  const back = client()
  store.setState({ client: back })
  await tick()
  await tick()
  assert.deepStrictEqual(submitted(back), ['one', 'two'])
  assert.deepStrictEqual(fake.prefs['scrobbles.pending'], [])
})

test('a song the server says is gone is dropped, and the others still go out', async () => {
  const c = client((id) => (id === 'deleted' ? new ApiError('data not found', 500, 70) : undefined))
  store.setState({ client: c })
  await listen(song('deleted'), 60)
  await listen(song('fine'), 60)
  assert.deepStrictEqual(submitted(c), ['deleted', 'fine'])
  assert.deepStrictEqual(fake.prefs['scrobbles.pending'], [], 'nothing is kept for the deleted one')
})

test('a failure the server does not explain is tried again a few times, without holding up the others', async () => {
  const c = client((id) => (id === 'odd' ? new ApiError('boom', 500, 0) : undefined))
  store.setState({ client: c })
  await listen(song('odd'), 60)
  assert.deepStrictEqual(fake.prefs['scrobbles.pending'].map((p) => [p.id, p.tries]), [['odd', 1]])
  await listen(song('ok1'), 60)
  assert.deepStrictEqual(submitted(c).filter((id) => id === 'ok1'), ['ok1'], 'a later play is not stuck behind it')
  for (let i = 0; i < 6; i++) await listen(song('filler' + i, 20), 1) // nothing to send; flushing happens with real plays
  for (let i = 0; i < 4; i++) await listen(song('more' + i), 60)
  assert.ok(!fake.prefs['scrobbles.pending'].some((p) => p.id === 'odd'), 'given up on after five tries')
  assert.strictEqual(submitted(c).filter((id) => id === 'odd').length, 5)
})

test('a plain HTTP 500, and the proxy errors, are told apart', async () => {
  const classify = m.classifyFailure
  assert.strictEqual(classify(new ApiError('x', 500)), 'unexplained')
  assert.strictEqual(classify(new ApiError('x', 500, 0)), 'unexplained')
  assert.strictEqual(classify(new ApiError('x', 500, 70)), 'rejected')
  assert.strictEqual(classify(new ApiError('x', 404)), 'rejected')
  for (const status of [0, 408, 429, 502, 503, 504]) assert.strictEqual(classify(new ApiError('x', status)), 'outage', String(status))
  assert.strictEqual(classify(new ApiError('x', 401)), 'outage', 'a login that is wrong right now is no reason to lose plays')
  assert.strictEqual(classify(new ApiError('x', 500, 41)), 'outage')
  assert.strictEqual(classify(new Error('Network request failed')), 'outage')
})

test('plays waiting when the app is closed are sent after the next start', async () => {
  const down = client(() => new ApiError('x', 503))
  store.setState({ client: down })
  await listen(song('night'), 60)
  assert.deepStrictEqual(fake.prefs['scrobbles.pending'].map((p) => p.id), ['night'])
  await start() // the app starts again: a new copy of the module, the saved list survives
  const c = client()
  store.setState({ client: c })
  await tick()
  await tick()
  assert.deepStrictEqual(submitted(c), ['night'])
})

;(async () => {
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      fake.prefs = {}
      await start()
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + '\n     ' + String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n     '))
    }
  }
  console.log(failed ? failed + ' FAILED' : 'ALL SCROBBLER TESTS PASSED')
  process.exit(failed ? 1 : 0)
})()
