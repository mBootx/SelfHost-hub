// Volume normalisation and the song radio: the pure rules behind the new music features.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')

const NL = String.fromCharCode(10)
const song = (id, extra = {}) => ({ id, title: id, artist: 'x', duration: 100, ...extra })
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`)

let m
const tests = []
const test = (name, fn) => tests.push([name, fn])

// ---- loudness ----

test('without the setting or without tags a track is left alone', () => {
  assert.strictEqual(m.loudnessFactor(song('a', { replayGain: { trackGain: -10 } }), 'off'), 1)
  assert.strictEqual(m.loudnessFactor(song('a'), 'track'), 1)
  assert.strictEqual(m.loudnessFactor(null, 'track'), 1)
  assert.strictEqual(m.loudnessFactor(song('a', { replayGain: {} }), 'album'), 1)
})

test('a loud track is turned down by its gain plus the target boost', () => {
  // -10 dB gain + 4 dB boost = -6 dB = 0.501
  near(m.loudnessFactor(song('a', { replayGain: { trackGain: -10 } }), 'track'), 10 ** (-6 / 20))
  near(m.loudnessFactor(song('a', { replayGain: { trackGain: -4 } }), 'track'), 1, 1e-9)
})

test('a quiet track is never turned up', () => {
  assert.strictEqual(m.loudnessFactor(song('a', { replayGain: { trackGain: 3 } }), 'track'), 1)
  assert.strictEqual(m.loudnessFactor(song('a', { replayGain: { trackGain: -2 } }), 'track'), 1, '-2 + 4 would be a boost')
})

test('track mode prefers the track gain, album mode the album gain, each falls back to the other', () => {
  const both = song('a', { replayGain: { trackGain: -12, albumGain: -8 } })
  near(m.loudnessFactor(both, 'track'), 10 ** (-8 / 20))
  near(m.loudnessFactor(both, 'album'), 10 ** (-4 / 20))
  near(m.loudnessFactor(song('a', { replayGain: { albumGain: -10 } }), 'track'), 10 ** (-6 / 20))
  near(m.loudnessFactor(song('a', { replayGain: { trackGain: -10 } }), 'album'), 10 ** (-6 / 20))
})

test('the server\'s fallback gain is used for files without tags of their own', () => {
  near(m.loudnessFactor(song('a', { replayGain: { fallbackGain: -9 } }), 'track'), 10 ** (-5 / 20))
  near(m.loudnessFactor(song('a', { replayGain: { trackGain: -10, fallbackGain: -20 } }), 'track'), 10 ** (-6 / 20), 1e-6)
})

test('absurd or broken tags do not silence or break playback', () => {
  const floor = m.loudnessFactor(song('a', { replayGain: { trackGain: -90 } }), 'track')
  near(floor, 10 ** (-30 / 20))
  assert.ok(floor > 0.02)
  for (const bad of [NaN, Infinity, -Infinity, '5', null]) {
    assert.strictEqual(m.loudnessFactor(song('a', { replayGain: { trackGain: bad } }), 'track'), 1, String(bad))
  }
})

// ---- radio ----

function source(parts = {}) {
  const calls = []
  return {
    calls,
    async getSimilarSongs(id, count) { calls.push(['similar', id, count]); if (parts.similar instanceof Error) throw parts.similar; return parts.similar || [] },
    async getSimilarSongs2(id, count) { calls.push(['artist', id, count]); if (parts.artist instanceof Error) throw parts.artist; return parts.artist || [] },
    async getRandomSongs(count, genre) { calls.push(['random', count, genre]); if (parts.random instanceof Error) throw parts.random; return parts.random || [] }
  }
}
const ids = (result) => result.songs.map((s) => s.id)

test('the radio is the songs the server finds similar, without the seed or doubles', async () => {
  const src = source({ similar: [song('seed'), song('a'), song('b'), song('a'), song('c')] })
  const result = await m.findRadioSongs(src, song('seed', { artistId: 'art', genre: 'Rock' }), { count: 3 })
  assert.deepStrictEqual(ids(result), ['a', 'b', 'c'])
  assert.strictEqual(result.kind, 'similar')
  assert.deepStrictEqual(src.calls.map((c) => c[0]), ['similar'], 'enough: nothing else is asked')
})

test('when similar songs are too few, artists like the artist fill in, then the genre', async () => {
  const src = source({ similar: [song('a')], artist: [song('b'), song('a')], random: [song('c'), song('d'), song('b')] })
  const result = await m.findRadioSongs(src, song('seed', { artistId: 'art', genre: 'Rock' }), { count: 4 })
  assert.deepStrictEqual(ids(result), ['a', 'b', 'c', 'd'])
  assert.strictEqual(result.kind, 'similar', 'named after the first source that gave anything')
  assert.deepStrictEqual(src.calls.map((c) => c[0]), ['similar', 'artist', 'random'])
  assert.strictEqual(src.calls[2][2], 'Rock')
})

test('a server without similar songs still gives a radio from the genre, and one without a genre from anything', async () => {
  const noSimilar = source({ similar: new Error('no such call'), artist: new Error('no such call'), random: [song('r1'), song('r2')] })
  const fromGenre = await m.findRadioSongs(noSimilar, song('seed', { artistId: 'art', genre: 'Jazz' }))
  assert.deepStrictEqual(ids(fromGenre), ['r1', 'r2'])
  assert.strictEqual(fromGenre.kind, 'genre')
  const anything = source({ random: [song('r1')] })
  await m.findRadioSongs(anything, song('seed'))
  assert.strictEqual(anything.calls.find((c) => c[0] === 'random')[2], undefined)
  assert.ok(!anything.calls.some((c) => c[0] === 'artist'), 'no artist known: that step is skipped')
})

test('nothing known at all is an empty radio, not an error', async () => {
  const result = await m.findRadioSongs(source(), song('seed'))
  assert.deepStrictEqual(result, { songs: [], kind: null })
})

test('songs already queued are not added again', async () => {
  const src = source({ similar: [song('a'), song('b'), song('c')] })
  const result = await m.findRadioSongs(src, song('seed'), { exclude: new Set(['a', 'c']), count: 10 })
  assert.deepStrictEqual(ids(result), ['b'])
})

test('malformed answers are ignored', async () => {
  const src = {
    getSimilarSongs: async () => [null, { title: 'no id' }, song('ok')],
    getSimilarSongs2: async () => 'oops',
    getRandomSongs: async () => undefined
  }
  assert.deepStrictEqual(ids(await m.findRadioSongs(src, song('seed', { artistId: 'x' }))), ['ok'])
})

test('a radio asks for more when few songs are left', () => {
  assert.strictEqual(m.radioNeedsMore(30, 0), false)
  assert.strictEqual(m.radioNeedsMore(30, 25), false)
  assert.strictEqual(m.radioNeedsMore(30, 26), true)
  assert.strictEqual(m.radioNeedsMore(30, 29), true)
  assert.strictEqual(m.radioNeedsMore(1, 0), true)
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'music.ts')
  fs.writeFileSync(entry, ["export * from '@/services/loudness'", "export * from '@/services/radio'"].join(NL) + NL)
  m = require(await bundle(entry, {}, path.join(bundle.OUT, 'music.js')))
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + NL + '     ' + String(err && err.stack ? err.stack : err).split(NL).slice(0, 5).join(NL + '     '))
    }
  }
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' music tests passed')
  process.exit(failed ? 1 : 0)
})()
