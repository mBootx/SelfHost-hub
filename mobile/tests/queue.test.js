// The player's queue: the song radio that keeps itself topped up, and the stop after a track.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const NL = String.fromCharCode(10)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const song = (id, extra = {}) => ({ id, title: 'Title ' + id, artist: 'Artist', duration: 100, ...extra })

globalThis.__seeks = []
globalThis.__engineStub = { seekTo: (seconds) => globalThis.__seeks.push(seconds), engine: {} }

let store
const tests = []
const test = (name, fn) => tests.push([name, fn])

/** A server that answers similar-song requests from a script, and remembers what it was asked. */
function client(script) {
  const asked = []
  return {
    asked,
    coverArtUrl: () => 'cover',
    async getSimilarSongs(id, count) {
      asked.push(['similar', id])
      return script(id, count)
    },
    async getSimilarSongs2() {
      return []
    },
    async getRandomSongs() {
      return []
    }
  }
}
const ids = () => store.getState().queue.map((s) => s.id)
const reset = (c = null) => store.setState({ client: c, queue: [], orderedQueue: null, queueIndex: -1, isPlaying: false, radio: null, shuffle: false, repeatMode: 'off', currentTime: 0 })

test('a radio plays the song first and then the songs like it', async () => {
  reset(client(() => [song('b'), song('c'), song('a')]))
  const result = await store.getState().startRadio(song('a'))
  assert.strictEqual(result, 'started')
  assert.deepStrictEqual(ids(), ['a', 'b', 'c'])
  assert.deepStrictEqual([store.getState().queueIndex, store.getState().isPlaying], [0, true])
  assert.deepStrictEqual(store.getState().radio, { seedId: 'a', seedTitle: 'Title a' })
})

test('a song with nothing similar does not start a radio or touch the queue', async () => {
  reset(client(() => []))
  store.setState({ queue: [song('x')], queueIndex: 0 })
  assert.strictEqual(await store.getState().startRadio(song('a')), 'empty')
  assert.deepStrictEqual(ids(), ['x'])
  assert.strictEqual(store.getState().radio, null)
  reset(null)
  assert.strictEqual(await store.getState().startRadio(song('a')), 'empty', 'signed out')
})

test('skipping towards the end of a radio adds more songs like the last one, without repeats', async () => {
  const c = client((id) => (id === 'a' ? [song('b'), song('c'), song('d')] : [song('d'), song('e'), song('f'), song('a')]))
  reset(c)
  await store.getState().startRadio(song('a'))
  assert.deepStrictEqual(ids(), ['a', 'b', 'c', 'd'])
  store.getState().next() // on 'b': 2 songs left after it, which is low
  await sleep(20)
  assert.deepStrictEqual(ids(), ['a', 'b', 'c', 'd', 'e', 'f'], 'asked for songs like the last one, minus those already queued')
  assert.deepStrictEqual(c.asked.map((x) => x[1]), ['a', 'd'])
  assert.ok(store.getState().radio)
})

test('while a batch is being fetched, skipping again does not ask twice', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  let calls = 0
  const c = client(async (id) => {
    if (id === 'a') return [song('b'), song('c')]
    calls++
    await gate
    return [song('x'), song('y')]
  })
  reset(c)
  await store.getState().startRadio(song('a'))
  store.getState().next()
  store.getState().next()
  await sleep(10)
  assert.strictEqual(calls, 1)
  release()
  await sleep(10)
  assert.deepStrictEqual(ids(), ['a', 'b', 'c', 'x', 'y'])
})

test('playing something by hand ends the radio, and so does emptying the queue', async () => {
  reset(client(() => [song('b'), song('c')]))
  await store.getState().startRadio(song('a'))
  store.getState().playQueue([song('p'), song('q')], 0)
  assert.strictEqual(store.getState().radio, null)
  await store.getState().startRadio(song('a'))
  store.getState().clearQueue()
  assert.strictEqual(store.getState().radio, null)
})

test('a batch that arrives after another radio started is thrown away', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const c = client(async (id) => {
    if (id === 'a') return [song('b'), song('c')]
    if (id === 'c') {
      await gate
      return [song('late1'), song('late2')]
    }
    if (id === 'z') return [song('z1'), song('z2')]
    return []
  })
  reset(c)
  await store.getState().startRadio(song('a'))
  store.getState().next() // low on songs: asks for more, like the last one ('c'), and waits
  await sleep(5)
  await store.getState().startRadio(song('z')) // a different radio takes over meanwhile
  release()
  await sleep(10)
  assert.deepStrictEqual(ids(), ['z', 'z1', 'z2'], 'the late batch of the first radio was dropped')
  assert.strictEqual(store.getState().radio.seedId, 'z')
})

test('stopping after a track moves on to the next one, paused', () => {
  reset()
  globalThis.__seeks.length = 0
  store.setState({ queue: [song('a'), song('b')], queueIndex: 0, isPlaying: true, currentTime: 90 })
  store.getState().stopAtTrackEnd()
  assert.deepStrictEqual([store.getState().queueIndex, store.getState().isPlaying, store.getState().currentTime], [1, false, 0])
  assert.deepStrictEqual(globalThis.__seeks, [], 'nothing to rewind: the next track starts from its beginning')
})

test('stopping after the last track stays on it, paused and back at its start', () => {
  reset()
  globalThis.__seeks.length = 0
  store.setState({ queue: [song('a'), song('b')], queueIndex: 1, isPlaying: true, currentTime: 99 })
  store.getState().stopAtTrackEnd()
  assert.deepStrictEqual([store.getState().queueIndex, store.getState().isPlaying], [1, false])
  assert.deepStrictEqual(globalThis.__seeks, [0])
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'queue.ts')
  fs.writeFileSync(entry, "export { useNavidromeStore } from '@/store/navidromeStore'" + NL)
  store = require(
    await bundle(
      entry,
      {
        '@/services/playbackEngine': 'engine-handle.js',
        '@/services/storage': 'storage.js',
        '@/services/imagePrefetch': 'image-prefetch.js'
      },
      path.join(bundle.OUT, 'queue.js')
    )
  ).useNavidromeStore
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
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' queue tests passed')
  process.exit(failed ? 1 : 0)
})()
