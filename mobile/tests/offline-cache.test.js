// Smart offline storage cap (LRU eviction) and Wi-Fi queue pre-caching (src/services/preCache.ts, src/store/offlineStore.ts).
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const NL = String.fromCharCode(10)
const tests = []
const test = (name, fn) => tests.push([name, fn])

const STUBS = {
  'react-native': 'react-native.js',
  'expo-network': 'expo-network.js',
  'expo-file-system': 'expo-file-system.js',
  '@/services/storage': 'storage.js',
  '@/services/diagnostics': 'diagnostics.js',
  '@/store/navidromeStore': 'navidromeStore.js'
}

let m
const song = (id, extra = {}) => ({ id, title: 'Titre ' + id, artist: 'Artiste', duration: 180, suffix: 'mp3', ...extra })
const track = (id, size, extra = {}) => ({
  id,
  title: 'Titre ' + id,
  artist: 'Artiste',
  duration: 180,
  filename: id + '.mp3',
  size,
  ...extra
})

function resetFake() {
  fake.prefs = {}
  fake.files = {}
  fake.sizes = {}
  fake.dirs = {}
  fake.networkTasks = []
  fake.downloadBytes = new Uint8Array(1024 * 1024) // 1 MiB per downloaded track
  fake.downloadError = null
  fake.network = 'WIFI'
}

// --- selectEvictions ---

test('selectEvictions: returns [] when maxBytes <= 0 or total <= maxBytes', () => {
  const tracks = {
    a: track('a', 500, { autoCached: true, lastPlayedAt: 10 }),
    b: track('b', 500, { autoCached: true, lastPlayedAt: 20 })
  }
  assert.deepStrictEqual(m.selectEvictions(tracks, 0, new Set()), [])
  assert.deepStrictEqual(m.selectEvictions(tracks, -100, new Set()), [])
  assert.deepStrictEqual(m.selectEvictions(tracks, 1000, new Set()), [])
  assert.deepStrictEqual(m.selectEvictions(tracks, 1500, new Set()), [])
})

test('selectEvictions: evicts oldest autoCached tracks first (LRU) and stops once total <= maxBytes', () => {
  const tracks = {
    never: track('never', 400, { autoCached: true }),
    old: track('old', 400, { autoCached: true, lastPlayedAt: 100 }),
    mid: track('mid', 400, { autoCached: true, lastPlayedAt: 200 }),
    fresh: track('fresh', 400, { autoCached: true, lastPlayedAt: 300 })
  }
  // Total = 1600, maxBytes = 800 -> need to free at least 800 -> 'never' (0) + 'old' (100) = 800 freed, leaving 800 <= 800
  assert.deepStrictEqual(m.selectEvictions(tracks, 800, new Set()), ['never', 'old'])
  // Total = 1600, maxBytes = 799 -> also needs 'mid'
  assert.deepStrictEqual(m.selectEvictions(tracks, 799, new Set()), ['never', 'old', 'mid'])
})

test('selectEvictions: skips manual downloads (autoCached !== true) and protectedIds', () => {
  const tracks = {
    manualOld: track('manualOld', 500, { lastPlayedAt: 1 }),
    manualFalse: track('manualFalse', 500, { autoCached: false, lastPlayedAt: 2 }),
    protectedAuto: track('protectedAuto', 500, { autoCached: true, lastPlayedAt: 3 }),
    evict1: track('evict1', 400, { autoCached: true, lastPlayedAt: 10 }),
    evict2: track('evict2', 400, { autoCached: true, lastPlayedAt: 20 })
  }
  // Total = 2300, maxBytes = 1500 -> only evict1 (400) + evict2 (400) can go, leaving 1500 <= 1500
  assert.deepStrictEqual(m.selectEvictions(tracks, 1500, new Set(['protectedAuto'])), ['evict1', 'evict2'])
  // Even if maxBytes is smaller than manual + protected (1500 > 1000), only autoCached unprotected tracks are returned
  assert.deepStrictEqual(m.selectEvictions(tracks, 1000, new Set(['protectedAuto'])), ['evict1', 'evict2'])
})

// --- pickQueueToPreCache ---

test('pickQueueToPreCache: respects bounds, skips current and earlier tracks', () => {
  const q = ['a', 'b', 'c', 'd', 'e'].map((id) => song(id))
  assert.deepStrictEqual(m.pickQueueToPreCache(q, 1, 2, new Set()).map((s) => s.id), ['c', 'd'])
  assert.deepStrictEqual(m.pickQueueToPreCache(q, 4, 3, new Set()), [])
  assert.deepStrictEqual(m.pickQueueToPreCache(q, 10, 3, new Set()), [])
  assert.deepStrictEqual(m.pickQueueToPreCache(q, 0, 0, new Set()), [])
  assert.deepStrictEqual(m.pickQueueToPreCache([], 0, 3, new Set()), [])
  assert.deepStrictEqual(m.pickQueueToPreCache(q, -1, 2, new Set()).map((s) => s.id), ['a', 'b'])
})

test('pickQueueToPreCache: deduplicates queue entries and skips alreadyOfflineIds', () => {
  const q = ['a', 'b', 'b', 'c', 'd', 'c', 'e'].map((id) => song(id))
  const offline = new Set(['c'])
  assert.deepStrictEqual(m.pickQueueToPreCache(q, 0, 3, offline).map((s) => s.id), ['b', 'd', 'e'])
})

// --- Store integration + preCacheUpcoming ---

test('touchPlayed updates lastPlayedAt and persists; evictIfNeeded protects active, kept playlists, and favorites', async () => {
  resetFake()
  const store = m.useOfflineStore
  store.setState({
    tracks: {
      playing: track('playing', 1024 * 1024, { autoCached: true, lastPlayedAt: 1 }),
      keptSong: track('keptSong', 1024 * 1024, { autoCached: true, lastPlayedAt: 2 }),
      favSong: track('favSong', 1024 * 1024, { autoCached: true, lastPlayedAt: 3, starred: true }),
      oldAuto: track('oldAuto', 1024 * 1024, { autoCached: true, lastPlayedAt: 4 }),
      manual: track('manual', 1024 * 1024, { lastPlayedAt: 5 })
    },
    keptPlaylists: { pl1: 'Ma playlist' },
    playlistCache: { pl1: { playlist: { id: 'pl1', name: 'Ma playlist', songCount: 1, duration: 180 }, songs: [song('keptSong')] } },
    keepFavorites: true,
    maxCacheMb: 0
  })

  // Record playing track
  store.getState().touchPlayed('playing')
  const touched = store.getState().tracks.playing
  assert.ok(typeof touched.lastPlayedAt === 'number' && touched.lastPlayedAt > 5)
  assert.strictEqual(fake.prefs['navidrome.offlineTracks'].playing.lastPlayedAt, touched.lastPlayedAt)

  // Set cap to 4 MiB while total is 5 MiB -> only oldAuto should be evicted
  store.getState().setMaxCacheMb(4)
  await new Promise((r) => setTimeout(r, 20))

  const remainingIds = Object.keys(store.getState().tracks).sort()
  assert.deepStrictEqual(remainingIds, ['favSong', 'keptSong', 'manual', 'playing'])
})

test('preCacheUpcoming skips on cellular and pre-caches on Wi-Fi with LRU eviction', async () => {
  resetFake()
  const store = m.useOfflineStore
  store.setState({
    tracks: {
      old1: track('old1', 1024 * 1024, { autoCached: true, lastPlayedAt: 100 })
    },
    keptPlaylists: {},
    playlistCache: {},
    keepFavorites: false,
    maxCacheMb: 2,
    preCacheCount: 2
  })

  const client = {
    originalUrl: (id) => `http://music.lan/download?id=${id}`,
    coverArtUrl: (id, size) => `http://music.lan/cover?id=${id}&size=${size}`
  }
  const q = ['cur', 'next1', 'next2', 'next3'].map((id) => song(id))

  // Cellular: should not download
  fake.network = 'CELLULAR'
  await m.preCacheUpcoming(q, 0, client)
  assert.strictEqual(fake.networkTasks.length, 0)

  // Wi-Fi: should download next1 + next2 (2 MiB), total becomes 3 MiB > 2 MiB cap -> old1 is evicted
  fake.network = 'WIFI'
  await m.preCacheUpcoming(q, 0, client)
  const tracks = store.getState().tracks
  assert.strictEqual(tracks.old1, undefined, 'oldest auto-cached track evicted to stay within 2 MiB')
  assert.strictEqual(tracks.next1.autoCached, true)
  assert.strictEqual(tracks.next2.autoCached, true)
  assert.strictEqual(tracks.next3, undefined)
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'offline-cache.ts')
  fs.writeFileSync(
    entry,
    [
      "export * from '@/services/preCache'",
      "export { useOfflineStore, offlineBytes } from '@/store/offlineStore'",
      ''
    ].join(NL)
  )
  m = require(await bundle(entry, STUBS, path.join(bundle.OUT, 'offline-cache.js')))
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
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' offline-cache tests passed')
  process.exit(failed ? 1 : 0)
})()
