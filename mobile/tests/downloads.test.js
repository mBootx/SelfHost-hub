// Songs kept on the phone: downloads of the original file under its own extension, the room they take, playlists kept
// downloaded (new songs fetched on Wi-Fi only), and the arithmetic of dragging rows (queue, playlists) and of swiping
// the mini player.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const NL = String.fromCharCode(10)
const tests = []
const test = (name, fn) => tests.push([name, fn])

let m // offlineStore, keptPlaylists, toastStore, the Navidrome store stub
let drag // services/dragMath

const STUBS = {
  'react-native': 'react-native.js',
  'expo-network': 'expo-network.js',
  'expo-file-system': 'expo-file-system.js',
  '@/services/storage': 'storage.js',
  '@/services/diagnostics': 'diagnostics.js',
  '@/store/navidromeStore': 'navidromeStore.js'
}

const song = (id, extra = {}) => ({ id, title: 'Titre ' + id, artist: 'A', duration: 200, ...extra })
/** A client that only builds addresses (the downloads themselves go through the file-system stub). */
function client(playlists = {}) {
  return {
    originalUrl: (id) => `http://music.lan/rest/stream.view?id=${id}&format=raw`,
    coverArtUrl: (id, size) => `http://music.lan/cover/${id}@${size}`,
    asked: [],
    async getPlaylist(id) {
      this.asked.push(id)
      const entry = playlists[id]
      if (!entry) {
        const err = new Error('Playlist not found')
        err.code = 70
        throw err
      }
      return { playlist: { id, name: entry.name }, songs: entry.songs }
    }
  }
}
function reset() {
  m.useOfflineStore.setState({ tracks: {}, downloading: {}, errors: {}, keptPlaylists: {} })
  fake.networkTasks.length = 0
  fake.downloadError = undefined
  fake.downloadBytes = new Uint8Array(3000)
  fake.network = 'WIFI'
  m.useToastStore.setState({ toasts: [] })
}
const toast = () => m.useToastStore.getState().toasts.slice(-1)[0]?.message ?? null
const downloads = () => fake.networkTasks.filter((t) => t.kind === 'download')

// --- Downloads ---

test('a song is downloaded as the original file, under its own extension', async () => {
  reset()
  await m.useOfflineStore.getState().downloadTrack(song('s1', { suffix: 'FLAC' }), client())
  const task = downloads()[0]
  assert.ok(task.url.includes('format=raw'), 'never converted by the server')
  assert.ok(task.destination.endsWith('/offline-music/s1.flac'), task.destination)
  const track = m.useOfflineStore.getState().tracks.s1
  assert.deepStrictEqual([track.filename, track.size], ['s1.flac', 3000])
  // No extension said, or a strange one: mp3, as before.
  await m.useOfflineStore.getState().downloadTrack(song('s2', { suffix: '../x' }), client())
  assert.strictEqual(m.useOfflineStore.getState().tracks.s2.filename, 's2.mp3')
})

test('a song twice in a playlist is downloaded once, and what is there is not fetched again', async () => {
  reset()
  const c = client()
  const count = await m.useOfflineStore.getState().downloadTracks([song('a'), song('b'), song('a')], c)
  assert.strictEqual(count, 2)
  assert.strictEqual(downloads().length, 2)
  assert.strictEqual(await m.useOfflineStore.getState().downloadTracks([song('a'), song('b')], c), 0)
  assert.strictEqual(downloads().length, 2)
  assert.strictEqual(toast(), 'Déjà téléchargé sur le téléphone')
})

test('a quiet download (a kept playlist) only speaks when it got something new', async () => {
  reset()
  m.useOfflineStore.setState({ tracks: { a: { id: 'a', filename: 'a.mp3', title: 'A', artist: 'A', duration: 1 } } })
  await m.useOfflineStore.getState().downloadTracks([song('a')], client(), { quiet: true, label: 'Route' })
  assert.strictEqual(toast(), null, 'nothing new: nothing said')
  await m.useOfflineStore.getState().downloadTracks([song('a'), song('b'), song('c')], client(), { quiet: true, label: 'Route' })
  assert.strictEqual(toast(), '2 nouveaux titres de « Route » sur le téléphone')
})

test('the room the downloads take: their recorded size, or the file measured for older ones', () => {
  fake.sizes['file:///doc/offline-music/old.mp3'] = 5000
  const bytes = m.offlineBytes({
    a: { id: 'a', filename: 'a.flac', size: 3000 },
    old: { id: 'old', filename: 'old.mp3' }
  })
  assert.strictEqual(bytes, 8000)
})

// --- Kept playlists ---

test('a kept playlist is remembered, and dropping it keeps the songs', async () => {
  reset()
  m.useOfflineStore.getState().setKeptPlaylist('p1', 'Route', true)
  assert.deepStrictEqual(fake.prefs['navidrome.keptPlaylists'], { p1: 'Route' })
  m.useOfflineStore.setState({ tracks: { a: { id: 'a', filename: 'a.mp3' } } })
  m.useOfflineStore.getState().setKeptPlaylist('p1', 'Route', false)
  assert.deepStrictEqual(fake.prefs['navidrome.keptPlaylists'], {})
  assert.ok(m.useOfflineStore.getState().tracks.a, 'the files stay')
})

test('new songs of a kept playlist come down on Wi-Fi, not on mobile data unless asked', async () => {
  reset()
  const c = client({ p1: { name: 'Route', songs: [song('a'), song('b')] } })
  m.useNavidromeStore.setState({ client: c, status: 'connected' })
  m.useOfflineStore.getState().setKeptPlaylist('p1', 'Route', true)
  fake.network = 'CELLULAR'
  await m.syncKeptPlaylists()
  assert.strictEqual(downloads().length, 0, 'not on mobile data')
  await m.syncKeptPlaylists(true)
  assert.strictEqual(downloads().length, 2, 'asked for: any network')
  assert.strictEqual(toast(), '2 nouveaux titres de « Route » sur le téléphone')
})

test('a kept playlist deleted on the server is not kept any more', async () => {
  reset()
  const c = client({})
  m.useNavidromeStore.setState({ client: c, status: 'connected' })
  m.useOfflineStore.getState().setKeptPlaylist('gone', 'Ancienne', true)
  await m.syncKeptPlaylists(true)
  assert.deepStrictEqual(m.useOfflineStore.getState().keptPlaylists, {})
})

// --- Dragging and swiping ---

test('a dragged row is over the slot its move reaches, never past the ends', () => {
  assert.strictEqual(drag.slotAt(2, 0, 60, 10), 2)
  assert.strictEqual(drag.slotAt(2, 89, 60, 10), 3)
  assert.strictEqual(drag.slotAt(2, 91, 60, 10), 4)
  assert.strictEqual(drag.slotAt(2, -500, 60, 10), 0)
  assert.strictEqual(drag.slotAt(2, 5000, 60, 10), 9)
})

test('the rows in between close the gap a dragged row leaves', () => {
  const start = { a: 0, b: 1, c: 2, d: 3 }
  assert.deepStrictEqual(drag.moveSlot(start, 'a', 2), { a: 2, b: 0, c: 1, d: 3 })
  assert.deepStrictEqual(drag.moveSlot(start, 'd', 1), { a: 0, b: 2, c: 3, d: 1 })
  assert.strictEqual(drag.moveSlot(start, 'b', 1), start, 'no move: the same object')
  const slots = Object.values(drag.moveSlot(start, 'c', 0)).sort()
  assert.deepStrictEqual(slots, [0, 1, 2, 3], 'every slot stays taken once')
})

test('the list scrolls on its own near its edges, faster closer to them', () => {
  assert.strictEqual(drag.edgeSpeed(400, 100, 600), 0)
  assert.ok(drag.edgeSpeed(110, 100, 600) < 0)
  assert.ok(drag.edgeSpeed(690, 100, 600) > 0)
  assert.ok(Math.abs(drag.edgeSpeed(101, 100, 600)) >= Math.abs(drag.edgeSpeed(150, 100, 600)))
})

test('the same song twice keeps two keys', () => {
  assert.deepStrictEqual(drag.occurrenceKeys(['a', 'b', 'a']), ['a#0', 'b#0', 'a#1'])
})

test('a swipe across the mini player skips when it is long or quick enough', () => {
  assert.strictEqual(drag.swipeSkip(-80, 0), 'next')
  assert.strictEqual(drag.swipeSkip(80, 0), 'prev')
  assert.strictEqual(drag.swipeSkip(-30, -900), 'next')
  assert.strictEqual(drag.swipeSkip(-30, -100), null)
  assert.strictEqual(drag.swipeSkip(10, 2000), null)
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'downloads.ts')
  fs.writeFileSync(
    entry,
    [
      "export { useOfflineStore, offlineBytes } from '@/store/offlineStore'",
      "export { syncKeptPlaylists } from '@/services/keptPlaylists'",
      "export { useToastStore } from '@/store/toastStore'",
      "export { useNavidromeStore } from '@/store/navidromeStore'",
      ''
    ].join(NL)
  )
  m = require(await bundle(entry, STUBS, path.join(bundle.OUT, 'downloads.js')))
  const dragEntry = path.join(bundle.OUT, 'entries', 'drag.ts')
  fs.writeFileSync(dragEntry, "export * from '@/services/dragMath'" + NL)
  drag = require(await bundle(dragEntry, {}, path.join(bundle.OUT, 'drag.js')))
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
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' download and drag tests passed')
  process.exit(failed ? 1 : 0)
})()
