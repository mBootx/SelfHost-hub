// The phone's client of the hub server (src/services/hubServer.ts), against a stand-in server that speaks
// docs/server-protocol.md: addresses, health check, sign-in, refusals, reconnecting, the frames it sends and reads.
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const REPO = path.resolve(bundle.MOBILE, '..')
const NL = String.fromCharCode(10)

let m
let WS

const tests = []
const test = (name, fn) => tests.push([name, fn])
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

/** A WebSocket server that records its connections and lets each test script what it says. */
async function fakeServer(onConnection) {
  const server = new WS.WebSocketServer({ port: 0 })
  const connections = []
  server.on('connection', (socket) => {
    const conn = { socket, received: [] }
    connections.push(conn)
    socket.on('message', (raw) => conn.received.push(JSON.parse(raw.toString())))
    socket.send(JSON.stringify({ type: 'challenge', v: 2, nonce: 'n' + connections.length, serverName: 'Maison', serverVersion: '0.1.0' }))
    onConnection(conn, connections.length)
  })
  await new Promise((r) => server.on('listening', r))
  return { port: server.address().port, connections, close: () => server.close() }
}

function clientFor(port, extra = {}) {
  const client = new m.HubServerClient({
    baseUrl: 'http://127.0.0.1:' + port,
    deviceId: 'phone-1',
    deviceName: 'Pixel',
    getAuth: (nonce) => ({ user: 'max', token: 'tok-' + nonce }),
    ...extra
  })
  const statuses = []
  client.onStatus((status, info) => statuses.push([status, info]))
  return { client, statuses }
}

test('an address is trimmed, given http when it has no scheme, and loses its trailing slash', () => {
  assert.strictEqual(m.normalizeServerUrl('  https://hub.example.tld/  '), 'https://hub.example.tld')
  assert.strictEqual(m.normalizeServerUrl('http://192.168.1.10:51823//'), 'http://192.168.1.10:51823')
  assert.strictEqual(m.normalizeServerUrl('192.168.1.10:51823'), 'http://192.168.1.10:51823')
  assert.strictEqual(m.normalizeServerUrl('   '), '')
  assert.ok(m.isValidServerUrl('http://a.b'))
  assert.ok(!m.isValidServerUrl('ftp://a.b'))
  assert.ok(!m.isValidServerUrl('http://'))
})

test('the WebSocket address is the base with ws or wss and /ws', () => {
  assert.strictEqual(m.serverWsUrl('http://192.168.1.10:51823'), 'ws://192.168.1.10:51823/ws')
  assert.strictEqual(m.serverWsUrl('https://hub.example.tld/'), 'wss://hub.example.tld/ws')
})

test('refusals have a French message, and the backoff is 1, 2, 5, 10 then 30 seconds', () => {
  assert.match(m.refusalMessage('bad-auth'), /Navidrome/)
  assert.match(m.refusalMessage('too-many-attempts'), /10 minutes/)
  assert.match(m.refusalMessage('update-required'), /jour/)
  assert.ok(m.refusalMessage('something-new').length > 0)
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 20].map(m.reconnectDelay), [1000, 2000, 5000, 10000, 30000, 30000, 30000])
})

test('the device id remote control already kept is reused, else one is made and kept', async () => {
  fake.prefs = { 'remote.deviceId': 'old-id' }
  assert.strictEqual(await m.loadOrCreateDeviceId(), 'old-id')
  fake.prefs = {}
  const made = await m.loadOrCreateDeviceId()
  assert.ok(made.length > 8)
  assert.strictEqual(fake.prefs['remote.deviceId'], made)
  assert.strictEqual(await m.loadOrCreateDeviceId(), made)
})

test('the health check says which server answered, or why none did', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') res.end(JSON.stringify({ app: 'selfhost-hub-server', version: '0.1.0', name: 'Maison' }))
    else if (req.url === '/other/api/health') res.end(JSON.stringify({ app: 'something-else' }))
    else {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  assert.deepStrictEqual(await m.checkHealth(base + '/'), { ok: true, name: 'Maison', version: '0.1.0' })
  assert.deepStrictEqual(await m.checkHealth(base + '/other'), { ok: false, error: "Ce n'est pas un serveur SelfHost Hub" })
  assert.strictEqual((await m.checkHealth(base + '/missing')).ok, false)
  server.close()
  if (server.closeAllConnections) server.closeAllConnections()
  assert.deepStrictEqual(await m.checkHealth(base), { ok: false, error: 'Serveur injoignable' })
  assert.deepStrictEqual(await m.checkHealth('not a url'), { ok: false, error: 'Adresse invalide' })
})

test('it answers the challenge with a v2 hello, reads what the server sends and sends states and commands', async () => {
  const server = await fakeServer((conn) => {
    conn.socket.once('message', () => {
      conn.socket.send(JSON.stringify({ type: 'welcome', accepted: true, user: 'max', deviceId: 'phone-1', serverVersion: '0.1.0', features: ['remote', 'listening'] }))
      conn.socket.send(JSON.stringify({ type: 'devices', devices: [{ deviceId: 'phone-1', deviceName: 'Pixel', platform: 'mobile' }, { deviceId: 'pc-1', deviceName: 'Bureau', platform: 'desktop' }, { nope: 1 }] }))
      conn.socket.send(JSON.stringify({ type: 'state', deviceId: 'pc-1', song: null, isPlaying: true, currentTime: 3, duration: 0, shuffle: false, repeatMode: 'off', volume: 1 }))
      conn.socket.send(JSON.stringify({ type: 'command', targetId: 'phone-1', fromId: 'pc-1', action: 'seek', payload: { seconds: 12 } }))
      conn.socket.send(JSON.stringify({ type: 'listening.changed', rev: 9 }))
      conn.socket.send(JSON.stringify({ type: 'future-thing' }))
    })
  })
  const { client, statuses } = clientFor(server.port)
  const devices = []
  const states = []
  const commands = []
  const messages = []
  client.onDevices((d) => devices.push(d))
  client.onState((s) => states.push(s))
  client.onCommand((c) => commands.push(c))
  client.onMessage((msg) => messages.push(msg.type))
  client.send({ type: 'state' })
  client.start()
  await pause(150)

  const [hello] = server.connections[0].received
  assert.deepStrictEqual(hello, { type: 'hello', v: 2, deviceId: 'phone-1', deviceName: 'Pixel', platform: 'mobile', user: 'max', token: 'tok-n1' })
  assert.strictEqual(client.status, 'connected')
  assert.strictEqual(statuses[statuses.length - 1][1].user, 'max')
  assert.strictEqual(statuses[statuses.length - 1][1].serverName, 'Maison')
  assert.deepStrictEqual(devices[0].map((d) => d.deviceId), ['phone-1', 'pc-1'], 'malformed entries are left out')
  assert.strictEqual(states[0].deviceId, 'pc-1')
  assert.deepStrictEqual(commands, [{ targetId: 'phone-1', fromId: 'pc-1', action: 'seek', payload: { seconds: 12 } }])
  assert.deepStrictEqual(messages, ['listening.changed', 'future-thing'])

  client.sendState({ song: null, isPlaying: false, currentTime: 0, duration: 0, shuffle: false, repeatMode: 'off', volume: 0.5 })
  client.sendCommand('pc-1', 'toggle')
  client.sendCommand('pc-1', 'seek', { seconds: 5 })
  await pause(80)
  const sent = server.connections[0].received.slice(1)
  assert.deepStrictEqual(sent.map((s) => s.type), ['state', 'command', 'command'])
  assert.strictEqual(sent[0].volume, 0.5)
  assert.deepStrictEqual(sent[2], { type: 'command', targetId: 'pc-1', action: 'seek', payload: { seconds: 5 } })
  client.stop()
  server.close()
})

test('a refusal is reported in French and, when trying again cannot help, not repeated', async () => {
  const server = await fakeServer((conn) => {
    conn.socket.once('message', () => {
      conn.socket.send(JSON.stringify({ type: 'welcome', accepted: false, reason: 'bad-auth' }))
      conn.socket.close()
    })
  })
  const { client, statuses } = clientFor(server.port)
  client.start()
  await pause(1400)
  assert.strictEqual(client.status, 'refused')
  assert.strictEqual(client.info.reason, 'bad-auth')
  assert.match(client.info.message, /Navidrome/)
  assert.strictEqual(server.connections.length, 1, 'no second try with the same password')
  client.retryNow()
  await pause(100)
  assert.strictEqual(server.connections.length, 1, 'not on a network blip either')
  client.retryNow(true)
  await pause(150)
  assert.strictEqual(server.connections.length, 2, 'but when something changed')
  assert.ok(statuses.some(([s]) => s === 'refused'))
  client.stop()
  server.close()
})

test('with no Navidrome login it says so instead of signing in', async () => {
  const server = await fakeServer(() => {})
  const { client } = clientFor(server.port, { getAuth: () => null })
  client.start()
  await pause(150)
  assert.strictEqual(client.status, 'refused')
  assert.match(client.info.message, /Navidrome/)
  assert.deepStrictEqual(server.connections[0].received, [])
  client.stop()
  server.close()
})

test('a lost connection is dialled again after a second, with a new challenge', async () => {
  const server = await fakeServer((conn, count) => {
    conn.socket.on('message', () => {
      conn.socket.send(JSON.stringify({ type: 'welcome', accepted: true, user: 'max' }))
      if (count === 1) setTimeout(() => conn.socket.terminate(), 30)
    })
  })
  const { client } = clientFor(server.port)
  client.start()
  await pause(200)
  assert.strictEqual(server.connections.length, 1)
  assert.strictEqual(client.status, 'connecting', 'looking for it again')
  await pause(1200)
  assert.strictEqual(server.connections.length, 2)
  assert.strictEqual(client.status, 'connected')
  assert.strictEqual(server.connections[1].received[0].token, 'tok-n2', 'the token follows the new nonce')
  client.stop()
  assert.strictEqual(client.status, 'stopped')
  await pause(50)
  server.close()
})

test('a connection replaced by the same device elsewhere (4000) is not fought over', async () => {
  const server = await fakeServer((conn) => {
    conn.socket.once('message', () => {
      conn.socket.send(JSON.stringify({ type: 'welcome', accepted: true, user: 'max' }))
      setTimeout(() => conn.socket.close(4000, 'replaced'), 30)
    })
  })
  const { client } = clientFor(server.port)
  client.start()
  await pause(1500)
  assert.strictEqual(server.connections.length, 1)
  assert.strictEqual(client.info.reason, 'replaced')
  client.stop()
  server.close()
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'hubserver.ts')
  fs.writeFileSync(entry, "export * from '@/services/hubServer'" + NL)
  WS = require(path.join(REPO, 'node_modules', 'ws'))
  global.WebSocket = WS
  m = require(await bundle(entry, { '@/services/storage': 'storage.js' }, path.join(bundle.OUT, 'hubserver.js')))
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + NL + '     ' + String(err && err.stack ? err.stack : err).split(NL).slice(0, 7).join(NL + '     '))
    }
  }
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' hub server tests passed')
  process.exit(failed ? 1 : 0)
})()
