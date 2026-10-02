// "Play this album / playlist / song", asked of the phone by the watch: what is accepted, and what is queued.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')

const NL = String.fromCharCode(10)
const tests = []
const test = (name, fn) => tests.push([name, fn])

let media

function library(songs) {
  const calls = []
  return {
    calls,
    getSong: async (id) => {
      calls.push(['getSong', id])
      const song = songs.find((s) => s.id === id)
      if (!song) throw new Error('not found')
      return song
    },
    getAlbum: async (id) => {
      calls.push(['getAlbum', id])
      return { songs: songs.filter((s) => s.albumId === id) }
    },
    getPlaylist: async (id) => {
      calls.push(['getPlaylist', id])
      return { songs }
    }
  }
}

function queue() {
  const log = []
  return {
    log,
    playQueue: (songs, start) => log.push(['playQueue', songs.map((s) => s.id), start]),
    playNext: (song) => log.push(['playNext', song.id]),
    addToQueue: (songs) => log.push(['addToQueue', songs.map((s) => s.id)])
  }
}

const SONGS = [
  { id: 's1', albumId: 'al-1' },
  { id: 's2', albumId: 'al-1' },
  { id: 's3', albumId: 'al-1' },
  { id: 's9', albumId: 'al-2' }
]

test('a valid request is read, with the mode defaulting to "now"', () => {
  assert.deepStrictEqual(media.parsePlayMedia({ kind: 'album', id: 'al-1' }), { kind: 'album', id: 'al-1', mode: 'now' })
  assert.deepStrictEqual(media.parsePlayMedia({ kind: 'playlist', id: 'pl-1', index: 3, mode: 'last' }), { kind: 'playlist', id: 'pl-1', index: 3, mode: 'last' })
  assert.deepStrictEqual(media.parsePlayMedia({ kind: 'song', id: 's1', songId: 's1', mode: 'next' }), { kind: 'song', id: 's1', songId: 's1', mode: 'next' })
})

test('anything else is refused: the payload comes off the network', () => {
  const bad = [
    null,
    undefined,
    'album',
    42,
    [],
    {},
    { kind: 'artist', id: 'x' },
    { kind: 'album' },
    { kind: 'album', id: '' },
    { kind: 'album', id: 'x'.repeat(201) },
    { kind: 'album', id: 'al-1', mode: 'sideways' },
    { kind: 'album', id: 'al-1', mode: 3 },
    { kind: 'album', id: 'al-1', index: -1 },
    { kind: 'album', id: 'al-1', index: 1.5 },
    { kind: 'album', id: 'al-1', index: '2' },
    { kind: 'album', id: 'al-1', index: 100001 },
    { kind: 'album', id: 'al-1', songId: '' },
    { kind: 'album', id: 'al-1', songId: 7 }
  ]
  for (const payload of bad) assert.strictEqual(media.parsePlayMedia(payload), null, JSON.stringify(payload))
})

test('an album plays from the song asked for, by id first and by position otherwise', async () => {
  const lib = library(SONGS)
  const q = queue()
  assert.ok(await media.runPlayMedia({ kind: 'album', id: 'al-1', songId: 's2', mode: 'now' }, lib, q))
  assert.ok(await media.runPlayMedia({ kind: 'album', id: 'al-1', index: 2, mode: 'now' }, lib, q))
  assert.ok(await media.runPlayMedia({ kind: 'album', id: 'al-1', mode: 'now' }, lib, q))
  assert.deepStrictEqual(q.log, [
    ['playQueue', ['s1', 's2', 's3'], 1],
    ['playQueue', ['s1', 's2', 's3'], 2],
    ['playQueue', ['s1', 's2', 's3'], 0]
  ])
})

test('a song that is not in the album, or a position past the end, starts at the first', async () => {
  const q = queue()
  await media.runPlayMedia({ kind: 'album', id: 'al-1', songId: 'gone', mode: 'now' }, library(SONGS), q)
  await media.runPlayMedia({ kind: 'album', id: 'al-1', index: 40, mode: 'now' }, library(SONGS), q)
  assert.deepStrictEqual(q.log.map((l) => l[2]), [0, 0])
})

test('a single song is looked up on its own', async () => {
  const lib = library(SONGS)
  const q = queue()
  assert.ok(await media.runPlayMedia({ kind: 'song', id: 's9', mode: 'now' }, lib, q))
  assert.deepStrictEqual(lib.calls, [['getSong', 's9']])
  assert.deepStrictEqual(q.log, [['playQueue', ['s9'], 0]])
})

test('"last" adds from the starting song to the end of the queue', async () => {
  const q = queue()
  await media.runPlayMedia({ kind: 'album', id: 'al-1', songId: 's2', mode: 'last' }, library(SONGS), q)
  assert.deepStrictEqual(q.log, [['addToQueue', ['s2', 's3']]])
})

test('"next" puts the songs right after the one playing, in order', async () => {
  const q = queue()
  await media.runPlayMedia({ kind: 'album', id: 'al-1', mode: 'next' }, library(SONGS), q)
  // playNext puts each one first in line, so the last goes in first.
  assert.deepStrictEqual(q.log, [['playNext', 's3'], ['playNext', 's2'], ['playNext', 's1']])
})

test('an empty album plays nothing, and a failing lookup is the caller\'s to handle', async () => {
  const q = queue()
  assert.strictEqual(await media.runPlayMedia({ kind: 'album', id: 'al-404', mode: 'now' }, library(SONGS), q), false)
  assert.deepStrictEqual(q.log, [])
  await assert.rejects(() => media.runPlayMedia({ kind: 'song', id: 'nope', mode: 'now' }, library(SONGS), q), /not found/)
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'playmedia.ts')
  fs.writeFileSync(entry, "export * from '@/services/playMedia'" + NL)
  media = require(await bundle(entry, {}, path.join(bundle.OUT, 'playmedia.js')))
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
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' playMedia tests passed')
  process.exit(failed ? 1 : 0)
})()
