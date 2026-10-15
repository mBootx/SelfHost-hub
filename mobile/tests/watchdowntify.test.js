// Downtify for the watch (services/watchDowntify.ts): what the watch may ask, what it is told back, and the sample files
// the watch's own tests read. Set WRITE_GOLDEN=1 to rewrite those files (review the diff before keeping it).
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const REPO = path.resolve(bundle.MOBILE, '..')
const RESOURCES = path.join(REPO, 'wear/core/src/test/resources')
const NL = String.fromCharCode(10)
const STUBS = { '@/services/diagnostics': 'diagnostics.js' }

let m
const tests = []
const test = (name, fn) => tests.push([name, fn])

const SEARCH = '/selfhost/downtify/search'
const RESULTS = '/selfhost/downtify/results'
const DOWNLOAD = '/selfhost/downtify/download'
const QUEUED = '/selfhost/downtify/queued'

const found = (id, name, artists, extra = {}) => ({ song_id: id, name, artists, album_name: '', cover_url: '', duration: 200, url: 'https://music.example/' + id, source: 'youtube', ...extra })
const SAMPLE_SONGS = [
  found('yt-1', 'Breezeblocks', ['alt-J'], { album_name: 'An Awesome Wave', duration: 227.4 }),
  found('yt-2', 'Tessellate', ['alt-J', 'Invité'], { duration: 183 })
]

function golden(file, text) {
  const target = path.join(RESOURCES, file)
  if (process.env.WRITE_GOLDEN && text !== undefined) fs.writeFileSync(target, text)
  return fs.readFileSync(target, 'utf8').trim()
}

/** The phone's side with a fake Downtify, and the answers it gave. */
function setup({ connected = true, songs = SAMPLE_SONGS, searchError = null } = {}) {
  const replies = []
  const downloads = []
  const client = connected ? { searchSongs: async () => { if (searchError) throw new Error(searchError); return songs } } : null
  const deps = { client: () => client, queueDownload: (song) => { downloads.push(song.song_id); return Promise.resolve() } }
  const reply = async (p, json) => { replies.push([p, JSON.parse(json)]) }
  const ask = (p, body) => m.handleDowntifyMessage(p, typeof body === 'string' ? body : JSON.stringify(body), reply, deps)
  return { replies, downloads, ask }
}

test('the results equal the sample file the watch reads, and the failure and the answer to a download too', () => {
  assert.strictEqual(m.resultsMessage('r1', SAMPLE_SONGS), golden('downtify-results.json', m.resultsMessage('r1', SAMPLE_SONGS)))
  assert.strictEqual(m.failureMessage('r1', 'Downtify n’est pas connecté sur le téléphone'), golden('downtify-failure.json', m.failureMessage('r1', 'Downtify n’est pas connecté sur le téléphone')))
  assert.strictEqual(m.queuedMessage('r2', 'yt-1', true), golden('downtify-queued.json', m.queuedMessage('r2', 'yt-1', true)))
})

test('a search is answered with the songs found, joined artists and rounded length', async () => {
  const { replies, ask } = setup()
  await ask(SEARCH, { v: 1, id: 'r1', query: 'alt-j' })
  assert.strictEqual(replies.length, 1)
  const [p, body] = replies[0]
  assert.strictEqual(p, RESULTS)
  assert.deepStrictEqual(body.songs.map((s) => [s.id, s.title, s.artist, s.duration]), [['yt-1', 'Breezeblocks', 'alt-J', 227], ['yt-2', 'Tessellate', 'alt-J, Invité', 183]])
  assert.strictEqual(body.songs[0].album, 'An Awesome Wave')
  assert.strictEqual('album' in body.songs[1], false, 'no empty album is sent')
})

test('at most twelve songs go to the watch', async () => {
  const many = Array.from({ length: 30 }, (_, i) => found('s' + i, 'Titre ' + i, ['A']))
  const { replies, ask } = setup({ songs: many })
  await ask(SEARCH, { v: 1, id: 'r1', query: 'x' })
  assert.strictEqual(replies[0][1].songs.length, 12)
})

test('without Downtify on the phone, or when it fails, the watch is told why', async () => {
  const none = setup({ connected: false })
  await none.ask(SEARCH, { v: 1, id: 'r1', query: 'x' })
  assert.deepStrictEqual(none.replies[0], [RESULTS, { v: 1, id: 'r1', ok: false, error: 'Downtify n’est pas connecté sur le téléphone' }])
  const broken = setup({ searchError: 'boom' })
  await broken.ask(SEARCH, { v: 1, id: 'r2', query: 'x' })
  assert.deepStrictEqual(broken.replies[0], [RESULTS, { v: 1, id: 'r2', ok: false, error: 'Downtify ne répond pas' }])
})

test('a download asks Downtify for the song from the latest results, and is answered at once', async () => {
  const { replies, downloads, ask } = setup()
  await ask(SEARCH, { v: 1, id: 'r1', query: 'alt-j' })
  await ask(DOWNLOAD, { v: 1, id: 'r2', songId: 'yt-2' })
  assert.deepStrictEqual(downloads, ['yt-2'])
  assert.deepStrictEqual(replies[1], [QUEUED, { v: 1, id: 'r2', songId: 'yt-2', ok: true }])
})

test('a download is not waited for: the answer comes while Downtify is still working', async () => {
  const replies = []
  let release
  const deps = { client: () => ({ searchSongs: async () => SAMPLE_SONGS }), queueDownload: () => new Promise((resolve) => { release = resolve }) }
  const reply = async (p, json) => { replies.push([p, JSON.parse(json)]) }
  await m.handleDowntifyMessage(SEARCH, JSON.stringify({ v: 1, id: 'r1', query: 'x' }), reply, deps)
  await m.handleDowntifyMessage(DOWNLOAD, JSON.stringify({ v: 1, id: 'r2', songId: 'yt-1' }), reply, deps)
  assert.strictEqual(replies[1][1].ok, true)
  release()
})

test('a song the phone no longer remembers, or Downtify gone, is refused with a reason', async () => {
  m.forgetResults()
  const { replies, downloads, ask } = setup()
  await ask(DOWNLOAD, { v: 1, id: 'r1', songId: 'yt-9' })
  assert.deepStrictEqual(replies[0], [QUEUED, { v: 1, id: 'r1', songId: 'yt-9', ok: false, message: 'Relancez la recherche' }])
  const gone = setup({ connected: false })
  await gone.ask(DOWNLOAD, { v: 1, id: 'r2', songId: 'yt-9' })
  assert.strictEqual(gone.replies[0][1].ok, false)
  assert.deepStrictEqual(downloads, [])
})

test('a failing download is logged, not lost, and never an unhandled rejection', async () => {
  const replies = []
  const deps = { client: () => ({ searchSongs: async () => SAMPLE_SONGS }), queueDownload: () => Promise.reject(new Error('serveur en panne')) }
  const reply = async (p, json) => { replies.push([p, JSON.parse(json)]) }
  fake.logs = []
  await m.handleDowntifyMessage(SEARCH, JSON.stringify({ v: 1, id: 'r1', query: 'x' }), reply, deps)
  await m.handleDowntifyMessage(DOWNLOAD, JSON.stringify({ v: 1, id: 'r2', songId: 'yt-1' }), reply, deps)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(fake.logs.some((l) => l.level === 'warn' && l.message.includes('serveur en panne')))
})

test('anything that is not a well-formed request gets no answer', async () => {
  const { replies, ask } = setup()
  for (const body of ['garbage', '{"v":2,"id":"r","query":"x"}', '{"v":1,"query":"x"}', '{"v":1,"id":"r","query":"  "}']) await ask(SEARCH, body)
  await ask(DOWNLOAD, { v: 1, id: 'r' })
  await ask('/selfhost/downtify/other', { v: 1, id: 'r', query: 'x' })
  assert.deepStrictEqual(replies, [])
})

test('a long query is cut to what the watch may send', () => {
  const request = m.parseDowntifyRequest(SEARCH, JSON.stringify({ v: 1, id: 'r', query: 'x'.repeat(500) }))
  assert.strictEqual(request.query.length, 120)
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'watchdowntify.ts')
  fs.writeFileSync(entry, "export * from '@/services/watchDowntify'" + NL)
  m = require(await bundle(entry, STUBS, path.join(bundle.OUT, 'watchdowntify.js')))
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
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' watch Downtify tests passed')
  process.exit(failed ? 1 : 0)
})()
