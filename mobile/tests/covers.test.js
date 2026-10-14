// Covers kept on the phone (src/services/coverStore.ts): saved once, found again after a restart, never twice at once,
// a few at a time, the least seen dropped past the limit but never a downloaded song's, and the whole library on demand.
// Also: a downloaded song brings its covers along (src/store/offlineStore.ts).
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
  'react-native': 'react-native.js',
  'expo-file-system': 'expo-file-system.js',
  '@/services/storage': 'storage.js'
}

const DIR = 'file:///doc/covers'
const url = (id, size = 320) => `https://music.example/rest/getCoverArt?u=me&t=abc&s=salt&v=1.16.1&c=x&f=json&id=${encodeURIComponent(id)}&size=${size}`
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const coverFiles = () => Object.keys(fake.files).filter((uri) => uri.startsWith(DIR + '/'))

function restart() {
  delete require.cache[require.resolve(outfile)]
  m = require(outfile)
}

function fresh() {
  for (const uri of Object.keys(fake.files)) if (uri.startsWith(DIR)) delete fake.files[uri]
  fake.dirs = {}
  fake.prefs = {}
  fake.networkTasks = []
  fake.failUrls = new Set()
  fake.downloadDelayMs = 0
  fake.downloadSize = 2000
  fake.maxActiveDownloads = 0
  fake.activeDownloads = 0
  restart()
}

const downloads = () => fake.networkTasks.filter((t) => t.kind === 'downloadFile')

// --- Keys ---

test('a cover address gives its id and size; anything else gives nothing', () => {
  fresh()
  assert.strictEqual(m.coverKey(url('al-123', 640)), 'al-123@640')
  assert.strictEqual(m.coverKey(url('a b/c', 160)), 'a b/c@160')
  assert.strictEqual(m.coverKey('https://music.example/rest/stream?id=1'), null)
  assert.strictEqual(m.coverKey('https://music.example/rest/stream?id=1&size=320'), null, 'an id and a size do not make a cover')
  assert.strictEqual(m.coverKey('file:///doc/covers/x@320.jpg'), null)
  assert.strictEqual(m.coverKey(''), null)
})

test('file names are safe whatever the id', () => {
  fresh()
  assert.strictEqual(m.fileNameFor('al-123_x@320'), 'al-123_x@320.jpg')
  assert.ok(/^[A-Za-z0-9_~@.-]+$/.test(m.fileNameFor('a b/c:d@160')), m.fileNameFor('a b/c:d@160'))
})

// --- Saving ---

test('a cover is saved once, and from then on shown from the phone', async () => {
  fresh()
  await m.loadCoverStore()
  assert.strictEqual(m.storedCoverUri(url('al-1')), null)
  assert.strictEqual(await m.storeCover(url('al-1')), true)
  assert.strictEqual(await m.storeCover(url('al-1')), true)
  assert.strictEqual(downloads().length, 1)
  assert.strictEqual(m.storedCoverUri(url('al-1')), DIR + '/al-1@320.jpg')
  assert.deepStrictEqual(coverFiles(), [DIR + '/al-1@320.jpg'], 'no .part left behind')
  const state = m.useCoverStore.getState()
  assert.strictEqual(state.count, 1)
  assert.strictEqual(state.bytes, 2000)
  assert.strictEqual(state.stored['al-1@320'], true)
})

test('each size is its own cover', async () => {
  fresh()
  await m.loadCoverStore()
  await m.storeCover(url('al-1', 160))
  assert.strictEqual(m.storedCoverUri(url('al-1', 640)), null)
  assert.ok(m.storedCoverUri(url('al-1', 160)))
})

test('the same cover asked for many times at once is downloaded once', async () => {
  fresh()
  fake.downloadDelayMs = 20
  await m.loadCoverStore()
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => m.storeCover(url('al-2'))))
  assert.deepStrictEqual(results, [true, true, true, true, true])
  assert.strictEqual(downloads().length, 1)
})

test('never more than four downloads at once, and all of them done in the end', async () => {
  fresh()
  fake.downloadDelayMs = 15
  await m.loadCoverStore()
  const ids = Array.from({ length: 12 }, (_, i) => 'al-' + i)
  const results = await Promise.all(ids.map((id) => m.storeCover(url(id))))
  assert.ok(results.every(Boolean))
  assert.strictEqual(fake.maxActiveDownloads, 4)
  assert.strictEqual(m.useCoverStore.getState().count, 12)
})

test('a cover that fails is not kept, leaves no file, and is tried again next time', async () => {
  fresh()
  await m.loadCoverStore()
  fake.failUrls = new Set([url('al-bad')])
  assert.strictEqual(await m.storeCover(url('al-bad')), false)
  assert.strictEqual(m.storedCoverUri(url('al-bad')), null)
  assert.deepStrictEqual(coverFiles(), [])
  fake.failUrls = new Set()
  assert.strictEqual(await m.storeCover(url('al-bad')), true)
  assert.strictEqual(downloads().length, 2)
})

test('something that is not a cover address is not downloaded', async () => {
  fresh()
  await m.loadCoverStore()
  assert.strictEqual(await m.storeCover('https://elsewhere.example/picture.png'), false)
  assert.strictEqual(downloads().length, 0)
})

// --- Restart ---

test('after a restart the covers are found on the phone, odd ids included, and half downloads are cleaned up', async () => {
  fresh()
  await m.loadCoverStore()
  await m.storeCover(url('al-1'))
  await m.storeCover(url('a b/c:d', 640))
  fake.files[DIR + '/al-9@320.jpg.part'] = 'half'
  restart()
  await m.loadCoverStore()
  assert.strictEqual(m.storedCoverUri(url('al-1')), DIR + '/al-1@320.jpg')
  assert.ok(m.storedCoverUri(url('a b/c:d', 640)), 'the odd id comes back from its file name')
  assert.strictEqual(m.useCoverStore.getState().count, 2)
  assert.ok(!(DIR + '/al-9@320.jpg.part' in fake.files))
  assert.strictEqual(await m.storeCover(url('al-1')), true)
  assert.strictEqual(downloads().length, 2, 'nothing downloaded again')
})

// --- The limit ---

test('past the limit the covers not seen for longest go, never a downloaded song’s', async () => {
  fresh()
  const realNow = Date.now
  let clock = 1_000_000
  Date.now = () => clock
  try {
    fake.downloadSize = 80 * 1024 * 1024
    m.setCoverPinning((id) => id === 'al-pinned')
    await m.loadCoverStore()
    await m.storeCover(url('al-pinned'))
    clock += 120_000
    await m.storeCover(url('al-old'))
    clock += 120_000
    await m.storeCover(url('al-seen'))
    clock += 120_000
    // Shown again: now the most recent.
    m.storedCoverUri(url('al-old'))
    clock += 120_000
    await m.storeCover(url('al-new'))
    // 320 MB > 300 MB: down to 270 MB at most (one cover goes), the least seen first, the pinned one kept whatever its age.
    assert.ok(m.storedCoverUri(url('al-pinned')), 'pinned kept')
    assert.strictEqual(m.storedCoverUri(url('al-seen')), null, 'the least seen went')
    assert.ok(m.storedCoverUri(url('al-old')), 'seen lately: kept')
    assert.ok(m.storedCoverUri(url('al-new')))
    assert.ok(m.useCoverStore.getState().bytes <= 300 * 1024 * 1024)
  } finally {
    Date.now = realNow
    m.setCoverPinning(() => false)
  }
})

test('emptying the store keeps the covers of downloaded songs', async () => {
  fresh()
  m.setCoverPinning((id) => id === 'al-kept')
  await m.loadCoverStore()
  await m.storeCover(url('al-kept'))
  await m.storeCover(url('al-gone'))
  m.clearCovers()
  assert.ok(m.storedCoverUri(url('al-kept')))
  assert.strictEqual(m.storedCoverUri(url('al-gone')), null)
  assert.deepStrictEqual(coverFiles(), [DIR + '/al-kept@320.jpg'])
  m.setCoverPinning(() => false)
})

// --- The whole library ---

test('saving the whole library reads every page, each cover once, and says how far it got', async () => {
  fresh()
  await m.loadCoverStore()
  const albums = Array.from({ length: 1203 }, (_, i) => ({ id: 'al-' + i, coverArt: i % 2 ? 'al-' + i : undefined }))
  albums.push({ id: 'dup', coverArt: 'al-1' })
  const pages = []
  const progress = []
  const done = await m.storeLibraryCovers(
    async (offset, size) => {
      pages.push(offset)
      return albums.slice(offset, offset + size)
    },
    (id) => url(id, 320),
    (p) => progress.push(p)
  )
  assert.deepStrictEqual(pages, [0, 500, 1000])
  assert.strictEqual(done.total, 1203)
  assert.strictEqual(done.done, 1203)
  assert.strictEqual(downloads().length, 1203)
  assert.strictEqual(progress[progress.length - 1].done, 1203)
})

test('it can be stopped, and covers already there are not downloaded again', async () => {
  fresh()
  await m.loadCoverStore()
  await m.storeCover(url('al-0', 320))
  const albums = Array.from({ length: 50 }, (_, i) => ({ id: 'al-' + i }))
  let seen = 0
  const done = await m.storeLibraryCovers(
    async (offset, size) => albums.slice(offset, offset + size),
    (id) => url(id, 320),
    (p) => (seen = p.done),
    () => seen >= 10
  )
  assert.ok(done.done >= 10 && done.done < 50, 'stopped part way: ' + done.done)
  assert.ok(downloads().length <= done.done, 'al-0 was not downloaded again')
})

// --- Downloaded songs ---

test('a downloaded song brings its covers at every size the app shows', async () => {
  fresh()
  const offlineEntry = path.join(bundle.OUT, 'entries', 'covers-offline.ts')
  fs.writeFileSync(offlineEntry, ["export { useOfflineStore } from '@/store/offlineStore'", "export * from '@/services/coverStore'", ''].join(NL))
  const o = require(await bundle(offlineEntry, STUBS, path.join(bundle.OUT, 'covers-offline.js')))
  await o.loadCoverStore()
  const client = { originalUrl: (id) => 'https://music.example/rest/stream?id=' + id + '&format=raw', coverArtUrl: (id, size) => url(id, size) }
  await o.useOfflineStore.getState().downloadTrack({ id: 'song-1', title: 'T', artist: 'A', albumId: 'al-7', duration: 100 }, client)
  for (let i = 0; i < 5; i++) await settle()
  for (const size of [160, 320, 640]) assert.ok(o.storedCoverUri(url('al-7', size)), 'size ' + size)
})

let finished = false
process.on('exit', () => {
  if (!finished) {
    console.log('FAIL the run ended before every test had finished')
    process.exitCode = 1
  }
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'covers.ts')
  fs.writeFileSync(entry, "export * from '@/services/coverStore'" + NL)
  outfile = await bundle(entry, STUBS, path.join(bundle.OUT, 'covers.js'))
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
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' cover tests passed')
  process.exit(failed ? 1 : 0)
})()
