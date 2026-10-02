// The PC's remote-control hub (src/main/remoteHub.ts) against the phone's client (src/services/remoteControl.ts),
// both for real, over local sockets: pairing by code, what a stranger can and cannot do.
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const path = require('path')
const bundle = require('./lib/bundle')

const REPO = path.resolve(bundle.MOBILE, '..')
const NL = String.fromCharCode(10)
const posix = (p) => p.split(String.fromCharCode(92)).join('/')

let hub // the PC's modules
let phone // the phone's modules
let WS

const tests = []
const test = (name, fn) => tests.push([name, fn])

/** The window the hub reports to: it records what the hub passes on to the PC's own player. */
function fakeWindow() {
  const sent = []
  return { sent, webContents: { send: (channel, payload) => sent.push([channel, payload]) } }
}

function memoryStore() {
  let saved = null
  return { load: () => saved, save: (p) => (saved = p), get saved() { return saved } }
}

async function startHub(options = {}) {
  const win = fakeWindow()
  const store = options.store || memoryStore()
  const result = await hub.startHub({ window: win, deviceName: 'Bureau', store, port: 0 })
  assert.ok(result.ok, JSON.stringify(result))
  return { win, store, port: result.port, code: hub.getPairingCode(store).replace('-', '') }
}

function connect(port, code, deviceId = 'phone-1', name = 'Pixel') {
  return new phone.RemoteHubClient().connect('127.0.0.1', port, deviceId, name, code)
}

/** A bare socket that speaks the protocol by hand, to be as wrong as a stranger would be. */
function rawSocket(port) {
  return new Promise((resolve) => {
    const socket = new WS('ws://127.0.0.1:' + port)
    const messages = []
    const waiting = []
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      const at = waiting.findIndex((w) => w.type === msg.type)
      if (at >= 0) waiting.splice(at, 1)[0].resolve(msg)
      else messages.push(msg)
    })
    const closed = new Promise((r) => socket.on('close', () => r(true)))
    const next = (type) =>
      new Promise((res) => {
        const at = messages.findIndex((m) => m.type === type)
        if (at >= 0) res(messages.splice(at, 1)[0])
        else waiting.push({ type, resolve: res })
      })
    socket.on('open', () => resolve({ socket, next, closed }))
  })
}

const get = (port, urlPath) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject)
  })

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

test('codes: ten characters from the safe alphabet, formatted for reading, forgiving to type', () => {
  const code = hub.generateCode()
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/)
  assert.notStrictEqual(hub.generateCode(), hub.generateCode())
  assert.strictEqual(hub.formatCode('ABCDEFGHJK'), 'ABCDE-FGHJK')
  assert.strictEqual(hub.normalizeCode(' abcde-fghjk '), 'ABCDEFGHJK')
  assert.strictEqual(phone.normalizeCode(' abcde-fghjk '), 'ABCDEFGHJK')
  assert.strictEqual(phone.normalizeCode('0O1Iabc'), 'ABC', 'lookalikes that are not in the alphabet are dropped')
})

test('the PC and the phone compute the same proof', () => {
  const code = 'ABCDEFGHJK'
  assert.strictEqual(phone.proofFor(code, 'n0nce', 'dev-1'), hub.proofFor(code, 'n0nce', 'dev-1'))
  assert.notStrictEqual(phone.proofFor(code, 'n0nce', 'dev-1'), phone.proofFor(code, 'other', 'dev-1'))
  assert.notStrictEqual(phone.proofFor(code, 'n0nce', 'dev-1'), phone.proofFor(code, 'n0nce', 'dev-2'))
  assert.ok(hub.proofMatches(code, 'n', 'd', hub.proofFor(code, 'n', 'd')))
  assert.ok(!hub.proofMatches(code, 'n', 'd', 'nope'))
  assert.ok(!hub.proofMatches(code, 'n', 'd', 42))
})

test('home-network addresses are allowed, the internet is not', () => {
  for (const ok of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.42', '169.254.3.4', '::1', '::ffff:192.168.0.5', 'fd12:3456::1', 'fe80::1']) {
    assert.ok(hub.isPrivateAddress(ok), ok)
  }
  for (const bad of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '2001:db8::1', '::ffff:8.8.8.8', '', undefined, 'garbage']) {
    assert.ok(!hub.isPrivateAddress(bad), String(bad))
  }
})

test('the attempt limiter blocks an address after five wrong guesses and forgives after a while', () => {
  const limiter = new hub.AttemptLimiter(5, 600_000, 600_000)
  const t = 1_000_000
  for (let i = 0; i < 4; i++) limiter.recordFailure('10.0.0.9', t + i)
  assert.ok(!limiter.isBlocked('10.0.0.9', t + 10))
  limiter.recordFailure('10.0.0.9', t + 5)
  assert.ok(limiter.isBlocked('10.0.0.9', t + 6))
  assert.ok(!limiter.isBlocked('10.0.0.8', t + 6), 'other addresses are not affected')
  assert.ok(!limiter.isBlocked('10.0.0.9', t + 600_006), 'the block ends')
  limiter.recordFailure('10.0.0.7', t)
  limiter.recordSuccess('10.0.0.7')
  for (let i = 0; i < 4; i++) limiter.recordFailure('10.0.0.7', t + i)
  assert.ok(!limiter.isBlocked('10.0.0.7', t + 5), 'a success starts the count again')
})

test('a phone with the right code gets in, shows in the device list and can drive the PC', async () => {
  const { win, port, code } = await startHub()
  const client = new phone.RemoteHubClient()
  const devices = []
  client.onDevices((d) => devices.push(d))
  const welcome = await client.connect('127.0.0.1', port, 'phone-1', 'Pixel', code)
  assert.strictEqual(welcome.hubDeviceName, 'Bureau')
  assert.ok(welcome.hubId.length > 10)
  await pause(50)
  assert.deepStrictEqual(win.sent.find(([c]) => c === 'remote:deviceListChanged')[1].map((d) => d.deviceName), ['Bureau', 'Pixel'])
  assert.ok(devices.length > 0)
  client.sendCommand('hub', 'next')
  client.sendCommand('hub', 'setVolume', { volume: 0.4 })
  await pause(50)
  assert.deepStrictEqual(win.sent.filter(([c]) => c === 'remote:command').map(([, m]) => m.action), ['next', 'setVolume'])
  client.close()
  hub.stopHub()
})

test('what a phone may ask for is limited to playback controls', async () => {
  const { win, port, code } = await startHub()
  const client = new phone.RemoteHubClient()
  await client.connect('127.0.0.1', port, 'phone-1', 'Pixel', code)
  for (const action of ['rm -rf', 'eval', '__proto__', 'openUrl', 'play']) client.sendCommand('hub', action)
  await pause(80)
  assert.deepStrictEqual(win.sent.filter(([c]) => c === 'remote:command').map(([, m]) => m.action), ['play'])
  client.close()
  hub.stopHub()
})

test('a wrong code is refused, and says so', async () => {
  const { port } = await startHub()
  await assert.rejects(() => connect(port, 'AAAAAAAAAA'), (err) => err instanceof phone.HubRejected && err.reason === 'bad-code' && /incorrect/.test(err.message))
  hub.stopHub()
})

test('after five wrong codes the address is ignored, even with the right one', async () => {
  const { port, code } = await startHub()
  for (let i = 0; i < 5; i++) await assert.rejects(() => connect(port, 'AAAAAAAAA' + i.toString().replace(/[0-9]/, 'B')))
  await assert.rejects(() => connect(port, code), (err) => err.reason === 'too-many-attempts')
  hub.stopHub()
})

test('a right code clears the count of wrong ones', async () => {
  const { port, code } = await startHub()
  for (let i = 0; i < 4; i++) await assert.rejects(() => connect(port, 'AAAAAAAAAB'))
  const client = new phone.RemoteHubClient()
  await client.connect('127.0.0.1', port, 'phone-ok', 'Pixel', code)
  client.close()
  await pause(30)
  for (let i = 0; i < 4; i++) await assert.rejects(() => connect(port, 'AAAAAAAAAB'), (err) => err.reason === 'bad-code')
  hub.stopHub()
})

test('an old app version, which sends no proof, is told to update and is not counted as guessing', async () => {
  const { port, code } = await startHub()
  for (let i = 0; i < 7; i++) {
    const raw = await rawSocket(port)
    await raw.next('challenge')
    raw.socket.send(JSON.stringify({ type: 'hello', deviceId: 'old', deviceName: 'Old', platform: 'mobile', accountHash: 'abc' }))
    const welcome = await raw.next('welcome')
    assert.deepStrictEqual([welcome.accepted, welcome.reason], [false, 'update-required'])
    await raw.closed
  }
  const client = new phone.RemoteHubClient()
  await client.connect('127.0.0.1', port, 'phone-new', 'Pixel', code)
  client.close()
  hub.stopHub()
})

test('nothing is relayed before the challenge is answered', async () => {
  const { win, port } = await startHub()
  const raw = await rawSocket(port)
  await raw.next('challenge')
  raw.socket.send(JSON.stringify({ type: 'command', targetId: 'hub', action: 'next' }))
  raw.socket.send(JSON.stringify({ type: 'state', song: null }))
  raw.socket.send('not json')
  await pause(80)
  assert.deepStrictEqual(win.sent.filter(([c]) => c === 'remote:command' || c === 'remote:deviceState'), [])
  raw.socket.close()
  hub.stopHub()
})

test('a proof cannot be replayed on another connection, nor for another device', async () => {
  const { port, code } = await startHub()
  const first = await rawSocket(port)
  const challenge = await first.next('challenge')
  const proof = phone.proofFor(code, challenge.nonce, 'phone-1')
  first.socket.send(JSON.stringify({ type: 'hello', deviceId: 'phone-1', deviceName: 'A', platform: 'mobile', proof }))
  assert.strictEqual((await first.next('welcome')).accepted, true)
  const second = await rawSocket(port)
  await second.next('challenge')
  second.socket.send(JSON.stringify({ type: 'hello', deviceId: 'phone-1', deviceName: 'B', platform: 'mobile', proof }))
  assert.strictEqual((await second.next('welcome')).accepted, false)
  const third = await rawSocket(port)
  const c3 = await third.next('challenge')
  third.socket.send(JSON.stringify({ type: 'hello', deviceId: 'someone-else', deviceName: 'C', platform: 'mobile', proof: phone.proofFor(code, c3.nonce, 'phone-1') }))
  assert.strictEqual((await third.next('welcome')).accepted, false)
  first.socket.close()
  hub.stopHub()
})

test('discovery tells which PC it is and nothing secret', async () => {
  const { port, code } = await startHub()
  const answer = await get(port, '/selfhosthub/ping')
  const info = JSON.parse(answer.body)
  assert.deepStrictEqual(Object.keys(info).sort(), ['app', 'deviceName', 'hubId'])
  assert.ok(!answer.body.includes(code))
  assert.ok(!/hash/i.test(Object.keys(info).join()), 'no account hash any more')
  assert.strictEqual((await get(port, '/other')).status, 404)
  hub.stopHub()
})

test('the phone finds the PC it was paired with by its id, and no other', async () => {
  const { port } = await startHub()
  const info = JSON.parse((await get(port, '/selfhosthub/ping')).body)
  const found = await phone.discoverHubs({ hubId: info.hubId, port })
  assert.strictEqual(found.length, 1)
  assert.strictEqual(found[0].hubId, info.hubId)
  assert.strictEqual(found[0].deviceName, 'Bureau')
  assert.deepStrictEqual(await phone.discoverHubs({ hubId: 'not-this-one', port }), [])
  assert.ok((await phone.discoverHubs({ port })).length >= 1, 'without an id it lists every hub it finds')
  hub.stopHub()
})

test('the code and the PC\'s identity are kept between runs', async () => {
  const store = memoryStore()
  const first = await startHub({ store })
  const id = JSON.parse((await get(first.port, '/selfhosthub/ping')).body).hubId
  hub.stopHub()
  const second = await startHub({ store })
  assert.strictEqual(second.code, first.code)
  assert.strictEqual(JSON.parse((await get(second.port, '/selfhosthub/ping')).body).hubId, id)
  hub.stopHub()
})

test('a new code disconnects the paired phones and the old one stops working', async () => {
  const store = memoryStore()
  const { port, code } = await startHub({ store })
  const client = new phone.RemoteHubClient()
  let closed = false
  client.onClose(() => (closed = true))
  await client.connect('127.0.0.1', port, 'phone-1', 'Pixel', code)
  const fresh = hub.regeneratePairingCode(store).replace('-', '')
  await pause(80)
  assert.ok(closed, 'the paired phone was disconnected')
  assert.notStrictEqual(fresh, code)
  await assert.rejects(() => connect(port, code, 'phone-2'), (err) => err.reason === 'bad-code')
  const again = new phone.RemoteHubClient()
  await again.connect('127.0.0.1', port, 'phone-1', 'Pixel', fresh)
  again.close()
  hub.stopHub()
})

test('the same phone connecting again replaces its old connection', async () => {
  const { win, port, code } = await startHub()
  const a = new phone.RemoteHubClient()
  let aClosed = false
  a.onClose(() => (aClosed = true))
  await a.connect('127.0.0.1', port, 'phone-1', 'Pixel', code)
  const b = new phone.RemoteHubClient()
  await b.connect('127.0.0.1', port, 'phone-1', 'Pixel', code)
  await pause(80)
  assert.ok(aClosed)
  const lists = win.sent.filter(([c]) => c === 'remote:deviceListChanged').map(([, d]) => d.length)
  assert.strictEqual(lists[lists.length - 1], 2, 'one phone, not two')
  b.close()
  hub.stopHub()
})

;(async () => {
  const tmp = bundle.OUT
  const hubEntry = path.join(tmp, 'entries', 'remote-hub.ts')
  fs.writeFileSync(
    hubEntry,
    ["export * from '" + posix(path.join(REPO, 'src/main/remoteHub')) + "'", "export * from '" + posix(path.join(REPO, 'src/main/pairing')) + "'", ''].join(NL)
  )
  hub = require(await bundle(hubEntry, {}, path.join(tmp, 'remote-hub.js')))
  const phoneEntry = path.join(tmp, 'entries', 'remote-phone.ts')
  fs.writeFileSync(phoneEntry, "export * from '@/services/remoteControl'" + NL)
  WS = require(path.join(REPO, 'node_modules', 'ws'))
  global.WebSocket = WS
  phone = require(await bundle(phoneEntry, { 'expo-network': 'expo-network-lan.js' }, path.join(tmp, 'remote-phone.js')))
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      hub.stopHub()
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      hub.stopHub()
      console.log('FAIL ' + name + NL + '     ' + String(err && err.stack ? err.stack : err).split(NL).slice(0, 6).join(NL + '     '))
    }
  }
  console.log(failed ? failed + ' FAILED' : 'ALL REMOTE CONTROL TESTS PASSED')
  process.exit(failed ? 1 : 0)
})()
