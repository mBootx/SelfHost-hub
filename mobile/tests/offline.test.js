// Downloaded songs first when the network is bad: the verdict on the network (src/services/offlinePriority.ts) and what
// the player does with it (src/services/offlineMode.ts), against the real queue and offline stores.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const NL = String.fromCharCode(10)
const tests = []
const test = (name, fn) => tests.push([name, fn])
let p // the pure module
let m // the wired one, with the stores
let clock = 1_000_000

const STUBS = {
  'react-native': 'react-native.js',
  'expo-network': 'expo-network.js',
  'expo-file-system': 'expo-file-system.js',
  '@/services/storage': 'storage.js',
  '@/services/diagnostics': 'diagnostics.js',
  '@/store/navidromeStore': 'navidromeStore.js'
}

const song = (id) => ({ id, title: 'Titre ' + id, artist: 'A', duration: 200 })
const later = (ms) => (clock += ms)
const settle = () => new Promise((resolve) => setImmediate(resolve))

// --- The verdict ---

function monitor() {
  return new p.NetworkMonitor(() => clock)
}

test('a network that works is good; no network at all is offline, and coming back is good again', () => {
  const n = monitor()
  assert.strictEqual(n.quality(), 'good')
  n.noteConnectivity(false, false)
  assert.strictEqual(n.quality(), 'offline')
  n.noteConnectivity(true, true)
  assert.strictEqual(n.quality(), 'good')
})

test('Android doubting the internet is not offline: a server at home still answers', () => {
  const n = monitor()
  n.noteConnectivity(true, false)
  assert.strictEqual(n.quality(), 'good')
  assert.strictEqual(n.internetDoubtful, true)
})

test('the server not answering twice in a row is offline; one answer brings it back', () => {
  const n = monitor()
  n.notePing(null)
  assert.strictEqual(n.quality(), 'good', 'one failure is not enough')
  n.notePing(null)
  assert.strictEqual(n.quality(), 'offline')
  n.notePing(120)
  assert.strictEqual(n.quality(), 'good')
})

test('one long stall says the network is slow; a short one alone does not', () => {
  const short = monitor()
  short.noteBuffering(true)
  later(2_000)
  short.noteBuffering(false)
  assert.strictEqual(short.quality(), 'good')
  const long = monitor()
  long.noteBuffering(true)
  later(4_500)
  assert.strictEqual(long.quality(), 'slow', 'a stall still going counts too')
  assert.strictEqual(long.snapshot().reason, 'lecture bloquée')
})

test('two stalls of a second or more within two minutes are slow; stalls older than that are forgotten', () => {
  const n = monitor()
  n.noteBuffering(true)
  later(1_500)
  n.noteBuffering(false)
  later(3 * 60_000)
  n.noteBuffering(true)
  later(1_500)
  n.noteBuffering(false)
  assert.strictEqual(n.quality(), 'good', 'the first one is too old')
  later(30_000)
  n.noteBuffering(true)
  later(1_200)
  n.noteBuffering(false)
  assert.strictEqual(n.quality(), 'slow')
})

test('a server slow to answer is a slow network', () => {
  const n = monitor()
  n.notePing(1_800)
  assert.strictEqual(n.quality(), 'slow')
})

test('slow stays slow until two calm minutes and a quick answer: no flapping', () => {
  const n = monitor()
  n.noteBuffering(true)
  later(5_000)
  n.noteBuffering(false)
  assert.strictEqual(n.quality(), 'slow')
  later(60_000)
  n.notePing(300)
  assert.strictEqual(n.quality(), 'slow', 'calm, but not for long enough')
  later(2 * 60_000)
  n.notePing(900)
  assert.strictEqual(n.quality(), 'slow', 'calm, but the answer was not quick')
  n.notePing(300)
  assert.strictEqual(n.quality(), 'good')
})

// --- The queue ---

test('what is still to come is reordered: songs on the phone first, each group in its own order', () => {
  const queue = ['a', 'b', 'c', 'd', 'e', 'f'].map(song)
  const local = new Set(['a', 'd', 'f'])
  const result = p.prioritizeLocal(queue, 1, (id) => local.has(id))
  assert.deepStrictEqual(result.map((s) => s.id), ['a', 'b', 'd', 'f', 'c', 'e'])
})

test('nothing to move: the very same queue comes back', () => {
  const queue = ['a', 'b', 'c'].map(song)
  assert.strictEqual(p.prioritizeLocal(queue, 0, () => true), queue)
  assert.strictEqual(p.prioritizeLocal(queue, 2, () => false), queue)
})

test('the next song on the phone is found from here on, round to the start only when the queue repeats', () => {
  const queue = ['a', 'b', 'c', 'd'].map(song)
  const local = new Set(['a', 'c'])
  assert.strictEqual(p.nextLocalIndex(queue, 1, (id) => local.has(id), false), 2)
  assert.strictEqual(p.nextLocalIndex(queue, 2, (id) => local.has(id), false), 2)
  assert.strictEqual(p.nextLocalIndex(queue, 3, (id) => local.has(id), false), -1)
  assert.strictEqual(p.nextLocalIndex(queue, 3, (id) => local.has(id), true), 0)
  assert.strictEqual(p.nextLocalIndex(queue, 0, () => false, true), -1)
})

test('streams drop to 128 kb/s only while the network is not good, and only with the setting on', () => {
  assert.strictEqual(p.streamBitrate('good', true), null)
  assert.strictEqual(p.streamBitrate('slow', true), 128)
  assert.strictEqual(p.streamBitrate('offline', true), 128)
  assert.strictEqual(p.streamBitrate('slow', false), null)
})

// --- The player ---

function setPlayer(ids, index, extra = {}) {
  m.useNavidromeStore.setState({ queue: ids.map(song), queueIndex: index, isPlaying: true, repeatMode: 'off', ...extra })
}
function setLocal(ids) {
  m.useOfflineStore.setState({ tracks: Object.fromEntries(ids.map((id) => [id, { id, filename: id + '.mp3' }])) })
}
const ids = () => m.useNavidromeStore.getState().queue.map((s) => s.id)
const toasts = () => m.useToastStore.getState().toasts.map((t) => t.message)

test('with a good network nothing moves', async () => {
  m.startOfflineMode()
  await settle()
  setLocal(['c'])
  setPlayer(['a', 'b', 'c'], 0)
  assert.deepStrictEqual(ids(), ['a', 'b', 'c'])
  assert.strictEqual(m.useNetworkStore.getState().quality, 'good')
})

test('no network: the song that cannot be streamed gives way to the next one on the phone, the rest reordered', async () => {
  setLocal(['c', 'e'])
  setPlayer(['a', 'b', 'c', 'd', 'e'], 0)
  m.Network.__emitNetwork({ isConnected: false, isInternetReachable: false })
  await settle()
  assert.strictEqual(m.useNetworkStore.getState().quality, 'offline')
  assert.deepStrictEqual(ids(), ['a', 'c', 'e', 'b', 'd'])
  assert.strictEqual(m.useNavidromeStore.getState().queueIndex, 1, 'now on c')
  assert.ok(toasts().includes('Hors connexion : lecture des titres téléchargés'))
})

test('no network and nothing on the phone: playback stops, said once', async () => {
  setLocal([])
  m.useToastStore.setState({ toasts: [] })
  setPlayer(['x', 'y'], 0)
  await settle()
  assert.strictEqual(m.useNavidromeStore.getState().isPlaying, false)
  const said = toasts().filter((t) => t === 'Hors connexion : aucun titre téléchargé dans la file').length
  assert.strictEqual(said, 1)
  m.useNavidromeStore.setState({ queue: [...m.useNavidromeStore.getState().queue] })
  assert.strictEqual(toasts().filter((t) => t === 'Hors connexion : aucun titre téléchargé dans la file').length, 1, 'not again')
})

test('a song downloaded meanwhile is picked up at once', async () => {
  setLocal([])
  setPlayer(['x', 'y', 'z'], 0)
  setLocal(['z'])
  assert.strictEqual(m.useNavidromeStore.getState().queue[m.useNavidromeStore.getState().queueIndex].id, 'z')
})

test('with the setting off, the queue is left alone even offline', async () => {
  m.useAudioSettingsStore.getState().setOfflineFirst(false)
  setLocal(['c'])
  setPlayer(['a', 'b', 'c'], 0)
  assert.deepStrictEqual(ids(), ['a', 'b', 'c'])
  assert.strictEqual(m.useNavidromeStore.getState().queueIndex, 0)
  m.useAudioSettingsStore.getState().setOfflineFirst(true)
  assert.deepStrictEqual(ids(), ['a', 'c', 'b'], 'switched back on: reordered at once')
})

test('back on the network: good again, said, and nothing more moves', async () => {
  m.useNavidromeStore.setState({ client: { ping: async () => ({ version: '1', latencyMs: 80 }) } })
  m.Network.__emitNetwork({ isConnected: true, isInternetReachable: true })
  await settle()
  await settle()
  assert.strictEqual(m.useNetworkStore.getState().quality, 'good')
  assert.ok(toasts().includes('Connexion rétablie'))
  setLocal(['c'])
  setPlayer(['a', 'b', 'c'], 0)
  assert.deepStrictEqual(ids(), ['a', 'b', 'c'])
})

test('on a network Android doubts, the server itself is asked at once', async () => {
  let pings = 0
  m.useNavidromeStore.setState({ client: { ping: async () => (pings++, { version: '1', latencyMs: 60 }) } })
  m.Network.__emitNetwork({ isConnected: true, isInternetReachable: false })
  await settle()
  assert.strictEqual(pings, 1)
  assert.strictEqual(m.useNetworkStore.getState().quality, 'good', 'it answered: a home server without internet is fine')
})

test('a streamed song stalling makes the network slow: downloaded songs first, but the song playing is kept', async () => {
  setLocal(['c'])
  setPlayer(['a', 'b', 'c'], 0)
  m.noteStall(true)
  later(5_000)
  m.noteStall(false)
  await settle()
  assert.strictEqual(m.useNetworkStore.getState().quality, 'slow')
  assert.deepStrictEqual(ids(), ['a', 'c', 'b'])
  assert.strictEqual(m.useNavidromeStore.getState().queueIndex, 0, 'a still plays: slow is not offline')
  assert.ok(toasts().includes('Réseau lent : les titres téléchargés passent en premier'))
})

test('a server that stops answering is offline even with the phone on Wi-Fi', async () => {
  later(10 * 60_000)
  m.useNavidromeStore.setState({ client: { ping: async () => Promise.reject(new Error('down')) } })
  m.noteStall(true)
  await settle()
  await settle()
  m.noteStall(false)
  m.noteStall(true)
  await settle()
  await settle()
  assert.strictEqual(m.useNetworkStore.getState().quality, 'offline')
  assert.strictEqual(m.useNetworkStore.getState().reason, 'serveur injoignable')
})

test('offline playlists: cached playlists and downloaded tracks playlist work without server access', () => {
  const tracks = {
    t1: { id: 't1', title: 'Un', artist: 'A', album: 'Alb', duration: 120, uri: 'file:///t1.mp3', size: 1000, downloadedAt: 100 },
    t2: { id: 't2', title: 'Deux', artist: 'B', album: 'Alb', duration: 180, uri: 'file:///t2.mp3', size: 2000, downloadedAt: 200 }
  }
  const builtIn = m.offlinePlaylist(tracks)
  assert.strictEqual(builtIn.id, m.OFFLINE_PLAYLIST_ID)
  assert.strictEqual(builtIn.songCount, 2)
  assert.strictEqual(builtIn.duration, 300)
  assert.strictEqual(m.offlineTrackToSong(tracks.t1).title, 'Un')

  const pl = { id: 'pl-1', name: 'Mes trajets', songCount: 2, duration: 300 }
  const songs = [song('t1'), song('t2')]
  m.useOfflineStore.getState().cachePlaylist('pl-1', pl, songs)
  const cached = m.useOfflineStore.getState().playlistCache['pl-1']
  assert.ok(cached, 'playlist is cached in offlineStore')
  assert.strictEqual(cached.playlist.name, 'Mes trajets')
  assert.strictEqual(cached.songs.length, 2)
  m.useOfflineStore.getState().removeCachedPlaylist('pl-1')
  assert.strictEqual(m.useOfflineStore.getState().playlistCache['pl-1'], undefined)
})

let finished = false
process.on('exit', () => {
  if (!finished) {
    console.log('FAIL the run ended before every test had finished')
    process.exitCode = 1
  }
})

;(async () => {
  const realNow = Date.now
  Date.now = () => clock
  const pureEntry = path.join(bundle.OUT, 'entries', 'offline-pure.ts')
  fs.writeFileSync(pureEntry, "export * from '@/services/offlinePriority'" + NL)
  p = require(await bundle(pureEntry, {}, path.join(bundle.OUT, 'offline-pure.js')))
  const entry = path.join(bundle.OUT, 'entries', 'offline.ts')
  fs.writeFileSync(
    entry,
    [
      "export * from '@/services/offlineMode'",
      "export { useNavidromeStore } from '@/store/navidromeStore'",
      "export { useOfflineStore, OFFLINE_PLAYLIST_ID, offlinePlaylist, offlineTrackToSong } from '@/store/offlineStore'",
      "export { useAudioSettingsStore } from '@/store/audioSettingsStore'",
      "export { useToastStore } from '@/store/toastStore'",
      "export * as Network from 'expo-network'",
      ''
    ].join(NL)
  )
  m = require(await bundle(entry, STUBS, path.join(bundle.OUT, 'offline.js')))
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
  Date.now = realNow
  finished = true
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' offline tests passed')
  process.exit(failed ? 1 : 0)
})()
