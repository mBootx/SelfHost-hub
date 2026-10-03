// The live link with the watch (services/watchLink.ts): what the watch is told, what it may ask, and when the phone speaks.
// Set WRITE_GOLDEN=1 to rewrite the sample files the watch's own tests read (review the diff before keeping it).
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const REPO = path.resolve(bundle.MOBILE, '..')
const RESOURCES = path.join(REPO, 'wear/core/src/test/resources')
const NL = String.fromCharCode(10)
const STUBS = {
  '@/services/storage': 'storage.js',
  '@/store/navidromeStore': 'navidromeStore.js',
  '@/store/remoteStore': 'remoteStore.js'
}

let m
let nav
let remote
const tests = []
const test = (name, fn) => tests.push([name, fn])

// Time is the test's to move: the link decides what is "quiet" and what has "drifted" from the clock.
let clock = 1_000_000
Date.now = () => clock
const tick = () => new Promise((resolve) => setImmediate(resolve))

const REQUEST = '/selfhost/link/request'
const COMMAND = '/selfhost/link/command'
const SNAPSHOT = '/selfhost/link/snapshot'

const song = (id, title, extra = {}) => ({ id, title, artist: 'Artiste', album: 'Album', albumId: 'al-1', coverArt: 'al-1', duration: 200, ...extra })
const player = (over = {}) => ({ song: null, isPlaying: false, currentTime: 0, duration: 0, shuffle: false, repeatMode: 'off', volume: 1, ...over })

const FRESH_PLAYER = { client: null, queue: [], queueIndex: 0, isPlaying: false, currentTime: 0, duration: 0, shuffle: false, repeatMode: 'off', volume: 1 }
const FRESH_REMOTE = {
  enabled: false,
  status: 'disconnected',
  error: null,
  client: null,
  deviceId: 'phone-real-id',
  deviceName: 'Galaxy S25',
  pairing: null,
  deviceList: [],
  devices: {},
  selectedDeviceId: 'local'
}

async function fresh() {
  m.stopWatchLink()
  fake.native = fake.native || {}
  Object.assign(fake.native, { missing: false, pushed: [], pushCount: 1, pushError: null, pushGate: null, shareListeners: [] })
  fake.localCommands = []
  fake.autoConnects = 0
  nav.setState({ ...FRESH_PLAYER })
  remote.setState({ ...FRESH_REMOTE })
  m.useWatchLinkStatus.setState({ lastContactAt: null, lastPushAt: null, watches: null, error: null })
  m.useDiagnosticsStore.setState({ entries: [] })
  clock = 1_000_000
  await tick()
}

const listener = () => fake.native.shareListeners.find(([event]) => event === 'onWatchMessage')[1]
const sent = () => fake.native.pushed.map((p) => JSON.parse(p.json))
const fromWatch = (path, body) => listener()({ nodeId: 'watch-1', path, data: typeof body === 'string' ? body : JSON.stringify(body) })
const command = (targetId, action, payload) => fromWatch(COMMAND, { v: 1, targetId, action, ...(payload === undefined ? {} : { payload }) })
const logs = () => m.useDiagnosticsStore.getState().entries.map((e) => e.scope + ':' + e.level + ':' + e.message)

/** A phone playing "Nuits blanches", a PC paused on another song, and a tablet doing nothing: the sample both sides read. */
const SAMPLE_INPUT = {
  phoneName: 'Galaxy S25 Ultra',
  enabled: true,
  paired: true,
  status: 'connected',
  error: null,
  ownId: 'phone-real-id',
  deviceList: [
    { deviceId: 'hub', deviceName: 'PC de Maxime', platform: 'desktop' },
    { deviceId: 'phone-real-id', deviceName: 'Galaxy S25 Ultra', platform: 'mobile' },
    { deviceId: 'tablet-1', deviceName: 'Tablette salon', platform: 'mobile' }
  ],
  remoteStates: {
    hub: player({ song: song('s-9001', 'Ligne claire', { artist: 'Atlas Vert', album: 'Plans', albumId: 'al-12', coverArt: 'al-12', duration: 187 }), currentTime: 12, duration: 187, shuffle: true, repeatMode: 'all', volume: 0.5 }),
    'tablet-1': player()
  },
  local: player({
    song: song('s-4412', 'Nuits blanches', { artist: 'Les Phares', album: 'Courants', albumId: 'al-77', coverArt: 'al-77', duration: 243.5 }),
    isPlaying: true,
    currentTime: 61.25,
    duration: 243.5,
    volume: 0.8
  })
}

function golden(file, text) {
  const target = path.join(RESOURCES, file)
  if (process.env.WRITE_GOLDEN && text !== undefined) fs.writeFileSync(target, text)
  return fs.readFileSync(target, 'utf8').trim()
}

// --- The snapshot ---

test('the snapshot equals the sample file the watch reads, byte for byte', () => {
  assert.strictEqual(JSON.stringify(m.buildSnapshot(SAMPLE_INPUT)), golden('phone-snapshot.json', JSON.stringify(m.buildSnapshot(SAMPLE_INPUT))))
})

test('this phone comes first as "local", and its own entry at the hub is hidden', () => {
  const snapshot = m.buildSnapshot(SAMPLE_INPUT)
  assert.deepStrictEqual(snapshot.devices.map((d) => d.deviceId), ['local', 'hub', 'tablet-1'])
  assert.strictEqual(snapshot.devices[0].deviceName, 'Galaxy S25 Ultra')
  assert.deepStrictEqual(Object.keys(snapshot.states).sort(), ['hub', 'local', 'tablet-1'])
  assert.strictEqual(snapshot.states.local.song.title, 'Nuits blanches')
  assert.strictEqual(snapshot.states.hub.repeatMode, 'all')
})

test('how this phone stands with the PC is told in six words', () => {
  const pc = (over) => m.buildSnapshot({ ...SAMPLE_INPUT, ...over }).pc
  assert.deepStrictEqual(pc({}), { state: 'connected', name: 'PC de Maxime' })
  assert.deepStrictEqual(pc({ enabled: false }), { state: 'off' })
  assert.deepStrictEqual(pc({ paired: false }), { state: 'unpaired' })
  assert.deepStrictEqual(pc({ status: 'connecting' }), { state: 'connecting' })
  assert.deepStrictEqual(pc({ status: 'disconnected' }), { state: 'disconnected' })
  assert.deepStrictEqual(pc({ status: 'error', error: 'PC introuvable sur le réseau' }), { state: 'error', message: 'PC introuvable sur le réseau' })
  assert.deepStrictEqual(pc({ status: 'error', error: null }), { state: 'error' })
  assert.deepStrictEqual(pc({ deviceList: [] }), { state: 'connected' })
})

test('without a PC the watch still gets the phone, alone', () => {
  const snapshot = m.buildSnapshot({ ...SAMPLE_INPUT, status: 'disconnected', deviceList: [], remoteStates: {} })
  assert.deepStrictEqual(snapshot.devices.map((d) => d.deviceId), ['local'])
  assert.deepStrictEqual(Object.keys(snapshot.states), ['local'])
})

test('what other devices say is cleaned before it goes to the watch', () => {
  const dirty = {
    song: { id: 's1', title: 'T'.repeat(500), artist: 7, album: '', albumId: null, coverArt: 'c'.repeat(300), duration: 'long' },
    isPlaying: 'yes',
    currentTime: -5,
    duration: Infinity,
    shuffle: 1,
    repeatMode: 'sideways',
    volume: 9
  }
  const snapshot = m.buildSnapshot({ ...SAMPLE_INPUT, remoteStates: { hub: dirty } })
  const state = snapshot.states.hub
  assert.strictEqual(state.song.title.length, 200)
  assert.strictEqual(state.song.artist, '')
  assert.strictEqual('album' in state.song, false)
  assert.strictEqual(state.song.coverArt.length, 200)
  assert.strictEqual(state.song.duration, 0)
  assert.deepStrictEqual({ ...state, song: null }, { song: null, isPlaying: false, currentTime: 0, duration: 0, shuffle: false, repeatMode: 'off', volume: 1 })
  const noId = m.buildSnapshot({ ...SAMPLE_INPUT, remoteStates: { hub: player({ song: { id: '', title: 'x' } }) } })
  assert.strictEqual(noId.states.hub.song, null)
})

test('a snapshot with a crowd of devices stays small', () => {
  const crowd = Array.from({ length: 80 }, (_, i) => ({ deviceId: 'd' + i, deviceName: 'Appareil ' + i, platform: 'mobile' }))
  const states = Object.fromEntries(crowd.map((d) => [d.deviceId, player({ song: song(d.deviceId, 'T'.repeat(300)) })]))
  const snapshot = m.buildSnapshot({ ...SAMPLE_INPUT, deviceList: crowd, remoteStates: states })
  assert.strictEqual(snapshot.devices.length, 21)
  assert.ok(JSON.stringify(snapshot).length < 60_000)
})

// --- When a snapshot is news ---

test('time passing is not news, a jump is', () => {
  const at = 1_000_000
  const base = m.buildSnapshot(SAMPLE_INPUT)
  const pushed = { at, snapshot: base, signature: m.snapshotSignature(base) }
  const later = (seconds, localPosition, over = {}) => {
    const next = m.buildSnapshot({ ...SAMPLE_INPUT, local: { ...SAMPLE_INPUT.local, currentTime: localPosition, ...over } })
    return m.unchangedForWatch(pushed, next, m.snapshotSignature(next), at + seconds * 1000)
  }
  assert.strictEqual(later(0, 61.25), true)
  assert.strictEqual(later(30, 91.25), true, 'the song went on for 30 s, as expected')
  assert.strictEqual(later(30, 92.75), true, 'a second and a half off is within reach of the watch\'s own clock')
  assert.strictEqual(later(30, 100), false, 'a jump forward')
  assert.strictEqual(later(30, 61.25), false, 'a jump back')
  assert.strictEqual(later(30, 91.25, { isPlaying: false }), false, 'paused is news')
  assert.strictEqual(m.unchangedForWatch(null, base, m.snapshotSignature(base), at), false, 'nothing was ever sent')
})

test('a paused song does not move on by itself', () => {
  const at = 1_000_000
  const paused = m.buildSnapshot({ ...SAMPLE_INPUT, local: { ...SAMPLE_INPUT.local, isPlaying: false } })
  const pushed = { at, snapshot: paused, signature: m.snapshotSignature(paused) }
  const check = (seconds, position) => {
    const next = m.buildSnapshot({ ...SAMPLE_INPUT, local: { ...SAMPLE_INPUT.local, isPlaying: false, currentTime: position } })
    return m.unchangedForWatch(pushed, next, m.snapshotSignature(next), at + seconds * 1000)
  }
  assert.strictEqual(check(60, 61.25), true)
  assert.strictEqual(check(60, 120), false)
})

test('the end of a song is the end: a position past it counts as the end', () => {
  const at = 1_000_000
  const nearEnd = m.buildSnapshot({ ...SAMPLE_INPUT, local: { ...SAMPLE_INPUT.local, currentTime: 240 } })
  const pushed = { at, snapshot: nearEnd, signature: m.snapshotSignature(nearEnd) }
  const ended = m.buildSnapshot({ ...SAMPLE_INPUT, local: { ...SAMPLE_INPUT.local, currentTime: 243.5 } })
  assert.strictEqual(m.unchangedForWatch(pushed, ended, m.snapshotSignature(ended), at + 60_000), true)
})

// --- Commands ---

test('every action the watch may send is read, with its payload checked', () => {
  const ok = (body, expected) => assert.deepStrictEqual(m.parseWatchCommand(JSON.stringify({ v: 1, targetId: 'hub', ...body })), { targetId: 'hub', ...expected }, JSON.stringify(body))
  ok({ action: 'toggle' }, { action: 'toggle' })
  ok({ action: 'play', payload: { junk: 1 } }, { action: 'play' })
  ok({ action: 'pause' }, { action: 'pause' })
  ok({ action: 'next' }, { action: 'next' })
  ok({ action: 'prev' }, { action: 'prev' })
  ok({ action: 'toggleShuffle' }, { action: 'toggleShuffle' })
  ok({ action: 'seek', payload: { seconds: 95.5, junk: true } }, { action: 'seek', payload: { seconds: 95.5 } })
  ok({ action: 'setVolume', payload: { volume: 0.64 } }, { action: 'setVolume', payload: { volume: 0.64 } })
  ok({ action: 'setVolume', payload: { volume: 7 } }, { action: 'setVolume', payload: { volume: 1 } })
  ok({ action: 'setRepeatMode', payload: { mode: 'one' } }, { action: 'setRepeatMode', payload: { mode: 'one' } })
  ok({ action: 'playMedia', payload: { kind: 'album', id: 'al-1' } }, { action: 'playMedia', payload: { kind: 'album', id: 'al-1' } })
})

test('anything else is refused: the message comes off a radio link', () => {
  const bad = [
    'not json',
    '',
    '[]',
    'null',
    '{"v":2,"targetId":"hub","action":"toggle"}',
    '{"targetId":"hub","action":"toggle"}',
    '{"v":1,"action":"toggle"}',
    '{"v":1,"targetId":"","action":"toggle"}',
    '{"v":1,"targetId":7,"action":"toggle"}',
    '{"v":1,"targetId":"hub"}',
    '{"v":1,"targetId":"hub","action":"formatDisk"}',
    '{"v":1,"targetId":"hub","action":"seek"}',
    '{"v":1,"targetId":"hub","action":"seek","payload":{"seconds":-1}}',
    '{"v":1,"targetId":"hub","action":"seek","payload":{"seconds":"10"}}',
    '{"v":1,"targetId":"hub","action":"seek","payload":{"seconds":999999}}',
    '{"v":1,"targetId":"hub","action":"setVolume","payload":{"volume":"loud"}}',
    '{"v":1,"targetId":"hub","action":"setVolume","payload":[]}',
    '{"v":1,"targetId":"hub","action":"setRepeatMode","payload":{"mode":"sometimes"}}',
    '{"v":1,"targetId":"hub","action":"playMedia"}',
    '{"v":1,"targetId":"' + 'x'.repeat(101) + '","action":"toggle"}',
    '{"v":1,"targetId":"hub","action":"toggle","pad":"' + 'x'.repeat(5000) + '"}'
  ]
  for (const text of bad) assert.strictEqual(m.parseWatchCommand(text), null, text.slice(0, 80))
  assert.strictEqual(m.parseWatchCommand(undefined), null)
})

test('the commands the watch encodes are read as they were meant (shared sample)', () => {
  const samples = JSON.parse(golden('watch-commands.json'))
  const names = Object.keys(samples)
  assert.ok(names.length >= 5)
  for (const name of names) {
    const parsed = m.parseWatchCommand(JSON.stringify(samples[name]))
    assert.ok(parsed, name)
    assert.strictEqual(parsed.action, samples[name].action, name)
    assert.strictEqual(parsed.targetId, samples[name].targetId, name)
    assert.deepStrictEqual(parsed.payload, samples[name].payload, name)
  }
})

test('a command for this phone goes to its own player', async () => {
  await fresh()
  assert.strictEqual(m.applyWatchCommand({ targetId: 'local', action: 'toggle' }), 'phone')
  assert.strictEqual(m.applyWatchCommand({ targetId: 'phone-real-id', action: 'next' }), 'phone')
  assert.strictEqual(m.applyWatchCommand({ targetId: 'local', action: 'seek', payload: { seconds: 30 } }), 'phone')
  assert.deepStrictEqual(fake.localCommands, [
    { action: 'toggle', payload: undefined },
    { action: 'next', payload: undefined },
    { action: 'seek', payload: { seconds: 30 } }
  ])
})

test('a command for another player is forwarded to the hub, which relays it', async () => {
  await fresh()
  const forwarded = []
  remote.setState({ status: 'connected', client: { sendCommand: (...args) => forwarded.push(args) }, deviceList: [{ deviceId: 'hub', deviceName: 'PC', platform: 'desktop' }, { deviceId: 'tablet-1', deviceName: 'T', platform: 'mobile' }] })
  assert.strictEqual(m.applyWatchCommand({ targetId: 'hub', action: 'setVolume', payload: { volume: 0.3 } }), 'forwarded')
  assert.strictEqual(m.applyWatchCommand({ targetId: 'tablet-1', action: 'prev' }), 'forwarded')
  assert.deepStrictEqual(forwarded, [['hub', 'setVolume', { volume: 0.3 }], ['tablet-1', 'prev', undefined]])
  assert.deepStrictEqual(fake.localCommands, [], 'this phone\'s own player was left alone')
})

test('a command for a player that is gone, or for a PC that is not connected, goes nowhere', async () => {
  await fresh()
  const forwarded = []
  remote.setState({ status: 'connected', client: { sendCommand: (...args) => forwarded.push(args) }, deviceList: [{ deviceId: 'hub', deviceName: 'PC', platform: 'desktop' }] })
  assert.strictEqual(m.applyWatchCommand({ targetId: 'ghost', action: 'toggle' }), 'unknown-player')
  remote.setState({ status: 'disconnected', client: null })
  assert.strictEqual(m.applyWatchCommand({ targetId: 'hub', action: 'toggle' }), 'pc-offline')
  assert.deepStrictEqual(forwarded, [])
  assert.deepStrictEqual(fake.localCommands, [])
})

test('something to play is played on this phone, whoever the watch was controlling', async () => {
  await fresh()
  const queued = []
  nav.setState({
    client: {
      getAlbum: async () => ({ songs: [song('a', 'A'), song('b', 'B')] }),
      getPlaylist: async () => ({ songs: [] }),
      getSong: async (id) => song(id, 'Seul')
    },
    playQueue: (songs, start) => queued.push(['playQueue', songs.map((s) => s.id), start]),
    playNext: (s) => queued.push(['playNext', s.id]),
    addToQueue: (songs) => queued.push(['addToQueue', songs.map((s) => s.id)])
  })
  assert.strictEqual(m.applyWatchCommand({ targetId: 'hub', action: 'playMedia', payload: { kind: 'album', id: 'al-1', songId: 'b', mode: 'now' } }), 'media')
  assert.strictEqual(m.applyWatchCommand({ targetId: 'local', action: 'playMedia', payload: { kind: 'song', id: 's9', mode: 'last' } }), 'media')
  await tick()
  await tick()
  assert.deepStrictEqual(queued, [['playQueue', ['a', 'b'], 1], ['addToQueue', ['s9']]])
  assert.deepStrictEqual(fake.localCommands, [])
})

test('a request to play that makes no sense, or with no Navidrome, plays nothing and breaks nothing', async () => {
  await fresh()
  const queued = []
  nav.setState({ client: null, playQueue: (...a) => queued.push(a) })
  m.applyWatchCommand({ targetId: 'local', action: 'playMedia', payload: { kind: 'album', id: 'al-1', mode: 'now' } })
  nav.setState({ client: { getAlbum: async () => ({ songs: [song('a', 'A')] }) } })
  m.applyWatchCommand({ targetId: 'local', action: 'playMedia', payload: { kind: 'artist', id: 'x' } })
  nav.setState({ client: { getAlbum: async () => { throw new Error('serveur éteint') } } })
  m.applyWatchCommand({ targetId: 'local', action: 'playMedia', payload: { kind: 'album', id: 'al-1', mode: 'now' } })
  await tick()
  await tick()
  assert.deepStrictEqual(queued, [])
  assert.ok(logs().some((l) => /watch:warn:.*serveur éteint/.test(l)))
})

// --- The link at work ---

test('starting listens to the watch and tells it where things stand', async () => {
  await fresh()
  m.startWatchLink()
  await tick()
  assert.strictEqual(fake.native.pushed.length, 1)
  assert.strictEqual(fake.native.pushed[0].path, SNAPSHOT)
  const snapshot = sent()[0]
  assert.strictEqual(snapshot.v, 1)
  assert.deepStrictEqual(snapshot.devices.map((d) => d.deviceId), ['local'])
  assert.strictEqual(snapshot.pc.state, 'off')
  assert.ok(listener())
})

test('starting twice does not listen twice', async () => {
  await fresh()
  m.startWatchLink()
  m.startWatchLink()
  await tick()
  assert.strictEqual(fake.native.shareListeners.filter(([e]) => e === 'onWatchMessage').length, 1)
  assert.strictEqual(fake.native.pushed.length, 1)
})

test('an older build of the app, without the link, does nothing at all', async () => {
  await fresh()
  fake.native.missing = true
  m.startWatchLink()
  await tick()
  assert.deepStrictEqual(fake.native.pushed, [])
  assert.deepStrictEqual(fake.native.shareListeners, [])
})

test('what changes on the player is sent; time passing and nothing at all are not', async () => {
  await fresh()
  m.startWatchLink()
  await tick()
  assert.strictEqual(fake.native.pushed.length, 1)

  nav.setState({})
  nav.setState({ currentTime: 0.2 })
  await tick()
  assert.strictEqual(fake.native.pushed.length, 1, 'nothing worth saying')

  nav.setState({ queue: [song('s1', 'Premier')], queueIndex: 0, duration: 200, isPlaying: true })
  await tick()
  assert.strictEqual(fake.native.pushed.length, 2)
  assert.strictEqual(sent()[1].states.local.song.title, 'Premier')
  assert.strictEqual(sent()[1].states.local.isPlaying, true)

  clock += 30_000
  nav.setState({ currentTime: 30 })
  await tick()
  assert.strictEqual(fake.native.pushed.length, 2, 'the song went on as the watch expects')

  nav.setState({ currentTime: 120 })
  await tick()
  assert.strictEqual(fake.native.pushed.length, 3, 'a seek')
  assert.strictEqual(sent()[2].states.local.currentTime, 120)

  nav.setState({ isPlaying: false })
  await tick()
  nav.setState({ volume: 0.5, shuffle: true, repeatMode: 'one' })
  await tick()
  const last = sent()[sent().length - 1].states.local
  assert.deepStrictEqual([last.isPlaying, last.volume, last.shuffle, last.repeatMode], [false, 0.5, true, 'one'])
})

test('the PC and its players are relayed as they appear and go', async () => {
  await fresh()
  m.startWatchLink()
  await tick()
  remote.setState({ enabled: true, pairing: { hubId: 'h', code: 'C' }, status: 'connected', deviceList: SAMPLE_INPUT.deviceList, devices: SAMPLE_INPUT.remoteStates })
  await tick()
  const withPc = sent()[sent().length - 1]
  assert.deepStrictEqual(withPc.devices.map((d) => d.deviceId), ['local', 'hub', 'tablet-1'])
  assert.deepStrictEqual(withPc.pc, { state: 'connected', name: 'PC de Maxime' })
  assert.strictEqual(withPc.states.hub.song.title, 'Ligne claire')

  remote.setState({ status: 'disconnected', client: null, deviceList: [], devices: {} })
  await tick()
  const without = sent()[sent().length - 1]
  assert.deepStrictEqual(without.devices.map((d) => d.deviceId), ['local'])
  assert.deepStrictEqual(without.pc, { state: 'disconnected' })
})

test('a request from the watch is always answered, even when nothing changed', async () => {
  await fresh()
  m.startWatchLink()
  await tick()
  const before = fake.native.pushed.length
  fromWatch(REQUEST, { v: 1 })
  await tick()
  fromWatch(REQUEST, { v: 1 })
  await tick()
  assert.strictEqual(fake.native.pushed.length, before + 2)
  assert.ok(m.useWatchLinkStatus.getState().lastContactAt !== null)
  assert.ok(logs().some((l) => l === 'watch:info:La montre est en contact avec le téléphone'))
  assert.strictEqual(logs().filter((l) => /en contact/.test(l)).length, 1, 'said once')
})

test('the watch asking while the PC link is down makes the phone try to get it back, but not every time', async () => {
  await fresh()
  m.startWatchLink()
  await tick()
  remote.setState({ enabled: true, pairing: { hubId: 'h', code: 'C' }, status: 'disconnected' })
  fromWatch(REQUEST, { v: 1 })
  fromWatch(REQUEST, { v: 1 })
  assert.strictEqual(fake.autoConnects, 1, 'once, not for each request')
  clock += 60_000
  fromWatch(REQUEST, { v: 1 })
  assert.strictEqual(fake.autoConnects, 1, 'still too soon')
  clock += 31_000
  remote.setState({ status: 'error' })
  fromWatch(REQUEST, { v: 1 })
  assert.strictEqual(fake.autoConnects, 2, 'after a while, again (an error counts as down)')
})

test('and not when it would make no sense', async () => {
  await fresh()
  m.startWatchLink()
  await tick()
  const ask = () => {
    clock += 100_000
    fromWatch(REQUEST, { v: 1 })
  }
  remote.setState({ enabled: false, pairing: { hubId: 'h', code: 'C' }, status: 'disconnected' })
  ask()
  remote.setState({ enabled: true, pairing: null })
  ask()
  remote.setState({ pairing: { hubId: 'h', code: 'C' }, status: 'connected' })
  ask()
  remote.setState({ status: 'connecting' })
  ask()
  assert.strictEqual(fake.autoConnects, 0)
  fromWatch(COMMAND, { v: 1, targetId: 'local', action: 'toggle' })
  assert.strictEqual(fake.autoConnects, 0, 'a command is no reason to look for the PC')
})

test('with no watch around the phone stays quiet for two minutes, unless the watch speaks first', async () => {
  await fresh()
  fake.native.pushCount = 0
  m.startWatchLink()
  await tick()
  assert.strictEqual(fake.native.pushed.length, 1)
  nav.setState({ isPlaying: true, queue: [song('s1', 'A')] })
  nav.setState({ isPlaying: false })
  await tick()
  assert.strictEqual(fake.native.pushed.length, 1, 'quiet')

  clock += 121_000
  nav.setState({ isPlaying: true })
  await tick()
  assert.strictEqual(fake.native.pushed.length, 2, 'looked again after two minutes')

  nav.setState({ isPlaying: false })
  await tick()
  assert.strictEqual(fake.native.pushed.length, 2, 'and quiet again')
  fake.native.pushCount = 1
  fromWatch(REQUEST, { v: 1 })
  await tick()
  assert.strictEqual(fake.native.pushed.length, 3, 'the watch spoke: answered')
  nav.setState({ isPlaying: true })
  await tick()
  assert.strictEqual(fake.native.pushed.length, 4, 'and not quiet any more')
})

test('a failing data layer is noted, waited out for half a minute, and does not break the link', async () => {
  await fresh()
  fake.native.pushError = 'Les services Google pour les montres ne sont pas disponibles'
  m.startWatchLink()
  await tick()
  assert.match(m.useWatchLinkStatus.getState().error, /services Google/)
  assert.ok(!logs().some((l) => /Envoi à la montre impossible/.test(l)), 'no word in the diagnostics for a phone that has never heard from a watch')
  nav.setState({ isPlaying: true })
  await tick()
  assert.strictEqual(fake.native.pushed.length, 1, 'waiting')
  fake.native.pushError = null
  clock += 31_000
  nav.setState({ isPlaying: false })
  await tick()
  assert.strictEqual(fake.native.pushed.length, 2)
  assert.strictEqual(m.useWatchLinkStatus.getState().error, null)
})

test('once a watch has been in touch, a failing data layer is said in the diagnostics, once in a while', async () => {
  await fresh()
  m.startWatchLink()
  await tick()
  fromWatch(REQUEST, { v: 1 })
  await tick()
  fake.native.pushError = 'Les services Google pour les montres ne sont pas disponibles'
  clock += 61_000
  nav.setState({ isPlaying: true })
  await tick()
  const said = () => logs().filter((l) => /watch:warn:Envoi à la montre impossible/.test(l)).length
  assert.strictEqual(said(), 1)
  clock += 31_000
  nav.setState({ isPlaying: false })
  await tick()
  assert.strictEqual(said(), 1, 'not again within ten minutes')
  clock += 11 * 60_000
  nav.setState({ isPlaying: true })
  await tick()
  assert.strictEqual(said(), 2)
})

test('one send at a time: what changes meanwhile goes out together afterwards', async () => {
  await fresh()
  let release
  fake.native.pushGate = new Promise((resolve) => (release = resolve))
  m.startWatchLink()
  assert.strictEqual(fake.native.pushed.length, 1, 'the first is in flight')
  nav.setState({ queue: [song('s1', 'A')], isPlaying: true })
  nav.setState({ volume: 0.4 })
  nav.setState({ volume: 0.6 })
  await tick()
  assert.strictEqual(fake.native.pushed.length, 1, 'held back')
  fake.native.pushGate = null
  release()
  await tick()
  await tick()
  assert.strictEqual(fake.native.pushed.length, 2, 'one more, not three')
  assert.strictEqual(sent()[1].states.local.volume, 0.6)
  assert.strictEqual(sent()[1].states.local.isPlaying, true)
})

test('commands arriving from the watch are applied', async () => {
  await fresh()
  m.startWatchLink()
  await tick()
  command('local', 'toggle')
  command('local', 'setVolume', { volume: 0.25 })
  assert.deepStrictEqual(fake.localCommands, [{ action: 'toggle', payload: undefined }, { action: 'setVolume', payload: { volume: 0.25 } }])
  assert.ok(m.useWatchLinkStatus.getState().lastContactAt !== null)
})

test('garbage from the watch is dropped and noted, and nothing is applied', async () => {
  await fresh()
  m.startWatchLink()
  await tick()
  fromWatch(COMMAND, 'definitely not json')
  fromWatch(COMMAND, { v: 1, targetId: 'local', action: 'rm -rf' })
  fromWatch('/selfhost/link/other', { v: 1 })
  assert.deepStrictEqual(fake.localCommands, [])
  assert.strictEqual(logs().filter((l) => /Commande de la montre illisible/.test(l)).length, 2)
})

test('a command that could not be carried out gets the watch the true state at once', async () => {
  await fresh()
  m.startWatchLink()
  await tick()
  const before = fake.native.pushed.length
  command('hub', 'toggle')
  await tick()
  assert.strictEqual(fake.native.pushed.length, before + 1)
  assert.ok(logs().some((l) => /watch:warn:.*toggle.*PC n’est pas connecté/.test(l)))
})

// --- The watch's version and its updates ---

const UPDATE_STATUS = '/selfhost/update/status'
const freshUpdates = () => m.useWatchUpdate.setState({ watch: null, latest: null, checkedAt: 0, phase: 'idle', progress: 0, message: null })

test('the request says which version of the app the watch has, and that is remembered (shared sample)', async () => {
  await fresh()
  freshUpdates()
  m.startWatchLink()
  fromWatch(REQUEST, golden('watch-request.json'))
  assert.deepStrictEqual(m.useWatchUpdate.getState().watch, { nodeId: 'watch-1', version: '2.5.2', code: 20502 })
})

test('a request that says nothing about the version, or garbage, leaves what is known alone, and is still answered', async () => {
  await fresh()
  freshUpdates()
  m.startWatchLink()
  fromWatch(REQUEST, golden('watch-request.json'))
  const before = fake.native.pushed.length
  fromWatch(REQUEST, { v: 1 })
  fromWatch(REQUEST, 'garbage')
  fromWatch(REQUEST, { v: 1, app: { name: 'x', code: 'y' } })
  await tick()
  assert.deepStrictEqual(m.useWatchUpdate.getState().watch, { nodeId: 'watch-1', version: '2.5.2', code: 20502 })
  assert.ok(fake.native.pushed.length > before, 'each request got its answer')
})

test('what the watch says about an update goes to the store, and is not taken for a command or a request', async () => {
  await fresh()
  freshUpdates()
  m.useWatchUpdate.setState({ phase: 'sending' })
  m.startWatchLink()
  const before = fake.native.pushed.length
  fromWatch(UPDATE_STATUS, { v: 1, state: 'confirm', message: 'Confirmez' })
  assert.strictEqual(m.useWatchUpdate.getState().phase, 'confirm')
  fromWatch(UPDATE_STATUS, { v: 1, state: 'installed', versionName: '2.5.3', versionCode: 20503 })
  assert.strictEqual(m.useWatchUpdate.getState().phase, 'done')
  assert.deepStrictEqual(m.useWatchUpdate.getState().watch, { nodeId: 'watch-1', version: '2.5.3', code: 20503 })
  assert.strictEqual(fake.native.pushed.length, before, 'no snapshot is pushed in answer to a status')
  assert.deepStrictEqual(fake.localCommands, [])
})

test('a status that is not one is dropped', async () => {
  await fresh()
  freshUpdates()
  m.useWatchUpdate.setState({ phase: 'sending' })
  m.startWatchLink()
  for (const text of ['garbage', '[]', { v: 2, state: 'confirm' }, { v: 1, state: 'exploded' }]) fromWatch(UPDATE_STATUS, text)
  assert.strictEqual(m.useWatchUpdate.getState().phase, 'sending')
})

test('stopping lets go of the stores and the watch', async () => {
  await fresh()
  m.startWatchLink()
  await tick()
  m.stopWatchLink()
  const before = fake.native.pushed.length
  nav.setState({ isPlaying: true, queue: [song('s1', 'A')] })
  await tick()
  assert.strictEqual(fake.native.pushed.length, before)
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'watchlink.ts')
  fs.writeFileSync(
    entry,
    [
      "export * from '@/services/watchLink'",
      "export { useNavidromeStore } from '@/store/navidromeStore'",
      "export { useRemoteStore } from '@/store/remoteStore'",
      "export { useDiagnosticsStore } from '@/services/diagnostics'",
      "export { useWatchUpdate } from '@/store/watchUpdateStore'",
      ''
    ].join(NL)
  )
  m = require(await bundle(entry, STUBS, path.join(bundle.OUT, 'watchlink.js')))
  nav = m.useNavidromeStore
  remote = m.useRemoteStore
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
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' watch link tests passed')
  process.exit(failed ? 1 : 0)
})()
