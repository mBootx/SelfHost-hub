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

test('a tap in the queue plays that song and leaves the shuffled order and the radio alone', () => {
  reset(client(() => []))
  store.setState({ queue: [song('a'), song('b'), song('c'), song('d')], orderedQueue: [song('d'), song('c'), song('b'), song('a')], shuffle: true, queueIndex: 0, radio: { seedId: 'a', seedTitle: 'A' } })
  store.getState().jumpTo(2)
  assert.deepStrictEqual(ids(), ['a', 'b', 'c', 'd'], 'the queue is not shuffled again')
  assert.deepStrictEqual([store.getState().queueIndex, store.getState().isPlaying, store.getState().currentTime], [2, true, 0])
  assert.deepStrictEqual(store.getState().orderedQueue.map((s) => s.id), ['d', 'c', 'b', 'a'], 'the order to go back to is kept')
  assert.strictEqual(store.getState().radio.seedId, 'a', 'the radio keeps going')
  globalThis.__seeks = []
  store.getState().jumpTo(2)
  assert.deepStrictEqual(globalThis.__seeks, [0], 'the song playing starts again')
  store.getState().jumpTo(9)
  assert.strictEqual(store.getState().queueIndex, 2, 'out of range: nothing happens')
})

test('songs added with "play next" line up in the order they were added', () => {
  reset()
  store.setState({ queue: [song('a'), song('b'), song('c')], queueIndex: 0, isPlaying: true })
  assert.strictEqual(store.getState().playNext(song('x')), 0, 'the first plays next')
  assert.strictEqual(store.getState().playNext(song('y')), 1, 'the second after it')
  assert.strictEqual(store.getState().playNext(song('z')), 2)
  assert.deepStrictEqual(ids(), ['a', 'x', 'y', 'z', 'b', 'c'])
  // Once the first of them plays, a new one still goes after those left.
  store.getState().next()
  assert.strictEqual(store.getState().playNext(song('w')), 2)
  assert.deepStrictEqual(ids(), ['a', 'x', 'y', 'z', 'w', 'b', 'c'])
  // A song that is in the queue already, but not added this way, is not counted as one of them.
  reset()
  store.setState({ queue: [song('a'), song('b')], queueIndex: 0 })
  store.getState().playNext(song('b'))
  assert.deepStrictEqual(ids(), ['a', 'b', 'b'])
  store.getState().playNext(song('c'))
  assert.deepStrictEqual(ids(), ['a', 'b', 'c', 'b'])
  // An empty queue starts playing the song.
  reset()
  store.getState().playNext(song('q'))
  assert.deepStrictEqual([ids(), store.getState().queueIndex, store.getState().isPlaying], [['q'], 0, true])
})

test('a song moved while shuffled keeps its move when shuffle is turned off', () => {
  reset()
  const album = ['1', '2', '3', '4', '5', '6'].map((n) => song(n))
  store.setState({ queue: [album[4], album[1], album[5], album[0], album[3], album[2]], orderedQueue: album, shuffle: true, queueIndex: 0 })
  // "6" is moved right after the song playing ("5").
  store.getState().reorderQueue(2, 1)
  assert.deepStrictEqual(ids(), ['5', '6', '2', '1', '4', '3'])
  store.getState().toggleShuffle()
  assert.deepStrictEqual(ids(), ['1', '2', '3', '4', '5', '6'].filter((n) => n !== '6').flatMap((n) => (n === '5' ? ['5', '6'] : [n])))
  assert.strictEqual(store.getState().queue[store.getState().queueIndex].id, '5', 'the song playing stays the one playing')
  // Moved to the very top, it leads the order shuffle goes back to.
  reset()
  store.setState({ queue: [album[2], album[0], album[1]], orderedQueue: album.slice(0, 3), shuffle: true, queueIndex: 0 })
  store.getState().reorderQueue(2, 0)
  store.getState().toggleShuffle()
  assert.deepStrictEqual(ids(), ['2', '1', '3'])
})

// A Subsonic server answering through the global fetch.
function serve(answer) {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return answer(String(url))
  }
  return calls
}
const ok = (body) => ({ ok: true, status: 200, json: async () => ({ 'subsonic-response': { status: 'ok', ...body } }) })
const failed = (code) => ({ ok: true, status: 200, json: async () => ({ 'subsonic-response': { status: 'failed', error: { code, message: 'Wrong username or password' } } }) })

async function saved() {
  fake.connections.navidrome = { url: 'http://music.lan', username: 'ana' }
  fake.secrets.navidrome_password = 'secret'
  store.setState({ client: null, status: 'disconnected', error: null, savedSession: null, username: null })
}

test('a saved login whose server cannot be reached keeps a client, so downloaded songs still play, and says so', async () => {
  await saved()
  serve(() => {
    throw new TypeError('Network request failed')
  })
  await store.getState().restoreSession()
  const s = store.getState()
  assert.strictEqual(s.status, 'error')
  assert.strictEqual(s.savedSession, true, 'the screens offer to try again rather than an empty login form')
  assert.strictEqual(s.error, 'Serveur injoignable', 'in French, not the platform English')
  assert.ok(s.client, 'a client is kept')
  assert.strictEqual(s.username, 'ana')
})

test('a saved password the server refuses leaves no client', async () => {
  await saved()
  store.setState({ client: { stale: true } })
  serve(() => failed(40))
  await store.getState().restoreSession()
  assert.strictEqual(store.getState().status, 'error')
  assert.strictEqual(store.getState().client, null)
})

test('no saved login: known at once, nothing is asked of a server', async () => {
  delete fake.connections.navidrome
  store.setState({ savedSession: null })
  const calls = serve(() => ok({}))
  await store.getState().restoreSession()
  assert.strictEqual(store.getState().savedSession, false)
  assert.strictEqual(calls.length, 0)
})

test('tries of the saved login asked at the same time make one try', async () => {
  await saved()
  const calls = serve((url) => (url.includes('/ping') ? ok({}) : ok({ albumList2: { album: [] }, artists: {}, playlists: {} })))
  await Promise.all([store.getState().restoreSession(), store.getState().restoreSession(), store.getState().restoreSession()])
  assert.strictEqual(calls.filter((u) => u.includes('/rest/ping')).length, 1)
  assert.strictEqual(store.getState().status, 'connected')
})

test('every album of a big library is listed, 500 at a time, newest first', async () => {
  const { NavidromeClient } = require(path.join(bundle.OUT, 'queue-navidrome.js'))
  const calls = serve((url) => {
    const offset = Number(new URL(url).searchParams.get('offset'))
    const count = offset === 0 ? 500 : offset === 500 ? 500 : 12
    return ok({ albumList2: { album: Array.from({ length: count }, (_, i) => ({ id: 'al' + (offset + i), name: 'A', artist: 'B' })) } })
  })
  const albums = await new NavidromeClient({ url: 'http://music.lan', username: 'ana', password: 'x' }).getAllAlbums()
  assert.strictEqual(albums.length, 1012)
  assert.ok(calls.every((u) => u.includes('type=newest')))
  assert.deepStrictEqual(calls.map((u) => new URL(u).searchParams.get('offset')), ['0', '500', '1000'])
})

;(async () => {
  const clientEntry = path.join(bundle.OUT, 'entries', 'queue-navidrome.ts')
  fs.writeFileSync(clientEntry, "export { NavidromeClient } from '@/services/navidrome'" + NL)
  await bundle(clientEntry, {}, path.join(bundle.OUT, 'queue-navidrome.js'))
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
