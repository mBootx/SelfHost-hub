// Playlists by account: each account sees only its own, new ones are private, and the server's owner manages everyone's
// through Navidrome's own API (sign-in, a session that runs out, what is sent back when a playlist is given away).
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const NL = String.fromCharCode(10)
globalThis.__seeks = []
globalThis.__engineStub = { seekTo: () => {}, engine: {} }

let admin // services/navidromeAdmin
let store // store/navidromeStore
const tests = []
const test = (name, fn) => tests.push([name, fn])

/** A server answering through the global fetch; `answer(url, init)` returns { status, body, headers }. */
function serve(answer) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const { status = 200, body = null, headers = {} } = answer(call) || {}
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => lower[name.toLowerCase()] ?? null },
      json: async () => body,
      text: async () => (body === null ? '' : JSON.stringify(body))
    }
  }
  return calls
}
const subsonic = (payload) => ({ body: { 'subsonic-response': { status: 'ok', ...payload } } })

test('only the account’s own playlists are kept, whoever the server lists them to', () => {
  const lists = [
    { id: '1', name: 'Mienne', owner: 'MBootx' },
    { id: '2', name: 'Celle d’Ana', owner: 'ana' },
    { id: '3', name: 'Sans propriétaire dit' }
  ]
  assert.deepStrictEqual(admin.ownPlaylists(lists, 'mbootx').map((p) => p.id), ['1', '3'])
  assert.deepStrictEqual(admin.ownPlaylists(lists, 'ana ').map((p) => p.id), ['2', '3'])
  assert.strictEqual(admin.ownPlaylists(lists, null).length, 3, 'no account known: nothing hidden')
})

test('the library keeps the account’s playlists and leaves the others out', async () => {
  const client = new (require(path.join(bundle.OUT, 'playlists-navidrome.js')).NavidromeClient)({ url: 'http://music.lan', username: 'ana', password: 'x' })
  serve((call) => {
    if (call.url.includes('getPlaylists')) return subsonic({ playlists: { playlist: [{ id: 'p1', name: 'Route', owner: 'ana' }, { id: 'p2', name: 'Admin', owner: 'mbootx', public: true }] } })
    if (call.url.includes('getArtists')) return subsonic({ artists: { index: [] } })
    return subsonic({ albumList2: { album: [] } })
  })
  store.setState({ client, username: 'ana', playlists: [] })
  await store.getState().loadLibrary()
  assert.deepStrictEqual(store.getState().playlists.map((p) => p.id), ['p1'])
})

test('a new playlist is made private and kept as the account’s own', async () => {
  const client = new (require(path.join(bundle.OUT, 'playlists-navidrome.js')).NavidromeClient)({ url: 'http://music.lan', username: 'ana', password: 'x' })
  const calls = serve((call) =>
    call.url.includes('createPlaylist') ? subsonic({ playlist: { id: 'new', name: 'Neuve', owner: 'ana', public: true, songCount: 0, duration: 0 } }) : subsonic({})
  )
  store.setState({ client, username: 'ana', playlists: [] })
  const created = await store.getState().createPlaylist('Neuve')
  const update = calls.find((c) => c.url.includes('updatePlaylist'))
  assert.ok(update, 'the server is told')
  const params = new URL(update.url).searchParams
  assert.deepStrictEqual([params.get('playlistId'), params.get('public')], ['new', 'false'])
  assert.strictEqual(created.public, false)
  assert.deepStrictEqual(store.getState().playlists.map((p) => p.id), ['new'])
})

test('the admin API signs in once, sends its token, and lists users and playlists', async () => {
  const calls = serve((call) => {
    if (call.url.endsWith('/auth/login')) return { body: { token: 'T1', isAdmin: true } }
    if (call.url.includes('/api/user')) return { body: [{ id: 'u1', userName: 'ana', name: 'Ana', isAdmin: false }] }
    return { body: [{ id: 'p1', name: 'Route', ownerId: 'u0', public: true, songCount: 3 }] }
  })
  const api = new admin.NavidromeAdmin('http://music.lan', 'mbootx', 'secret')
  const [playlists, users] = await Promise.all([api.playlists(), api.users()])
  assert.strictEqual(playlists[0].name, 'Route')
  assert.strictEqual(users[0].userName, 'ana')
  const login = calls.filter((c) => c.url.endsWith('/auth/login'))
  assert.strictEqual(login.length, 1, 'two requests at once share one sign-in')
  assert.deepStrictEqual(login[0].body, { username: 'mbootx', password: 'secret' })
  assert.strictEqual(login[0].method, 'POST')
  for (const c of calls.filter((c) => c.url.includes('/api/'))) assert.strictEqual(c.headers['X-ND-Authorization'], 'Bearer T1')
})

test('an account that is not an admin is told so', async () => {
  serve(() => ({ body: { token: 'T', isAdmin: false } }))
  await assert.rejects(() => new admin.NavidromeAdmin('http://music.lan', 'ana', 'x').playlists(), /administrateur/)
})

test('a session that ran out signs in again once, then goes on', async () => {
  let logins = 0
  let first = true
  const calls = serve((call) => {
    if (call.url.endsWith('/auth/login')) return { body: { token: 'T' + ++logins, isAdmin: true } }
    if (first) {
      first = false
      return { status: 401 }
    }
    return { body: [] }
  })
  await new admin.NavidromeAdmin('http://music.lan', 'mbootx', 'x').playlists()
  assert.strictEqual(logins, 2)
  assert.strictEqual(calls[calls.length - 1].headers['X-ND-Authorization'], 'Bearer T2')
})

test('giving a playlist away sends it back whole with the new owner, and nothing the server makes itself', async () => {
  const current = { id: 'p1', name: 'Route', comment: '', ownerId: 'u0', ownerName: 'mbootx', public: true, songCount: 3, path: '/music/Route.m3u', sync: true, rules: null, tracks: [] }
  const calls = serve((call) => {
    if (call.url.endsWith('/auth/login')) return { body: { token: 'T', isAdmin: true } }
    if (call.method === 'GET') return { body: current, headers: { 'X-ND-Authorization': 'Bearer T-renewed' } }
    return { body: { id: 'p1' } }
  })
  const api = new admin.NavidromeAdmin('http://music.lan', 'mbootx', 'x')
  await api.update('p1', { ownerId: 'u1', public: false, sync: false })
  const put = calls.find((c) => c.method === 'PUT')
  assert.ok(put.url.endsWith('/api/playlist/p1'))
  assert.strictEqual(put.headers['X-ND-Authorization'], 'Bearer T-renewed', 'the renewed token is used')
  assert.strictEqual(put.body.ownerId, 'u1')
  assert.strictEqual(put.body.public, false)
  assert.strictEqual(put.body.sync, false)
  assert.strictEqual(put.body.name, 'Route', 'what is not changed is sent as it was')
  assert.ok(!('ownerName' in put.body) && !('tracks' in put.body))
})

test('a server out of reach, or a refusal, is said in words', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Network request failed')
  }
  await assert.rejects(() => new admin.NavidromeAdmin('http://music.lan', 'mbootx', 'x').users(), /Serveur injoignable/)
  serve((call) => (call.url.endsWith('/auth/login') ? { body: { token: 'T', isAdmin: true } } : { status: 403 }))
  await assert.rejects(() => new admin.NavidromeAdmin('http://music.lan', 'mbootx', 'x').users(), /administrateur/)
})

test('a playlist that follows its file, or a smart one, has songs that cannot be changed', () => {
  assert.strictEqual(admin.tracksEditable({ sync: true }), false)
  assert.strictEqual(admin.tracksEditable({ sync: false, rules: { all: [] } }), false)
  assert.strictEqual(admin.tracksEditable({ sync: false, rules: null }), true)
})

let desktop // src/renderer/src/services/navidromeAdmin (the PC's copy, through the main process)

test('the PC signs in, follows the renewed token and gives a playlist away the same way', async () => {
  const sent = []
  const current = { id: 'p1', name: 'Route', ownerId: 'u0', ownerName: 'mbootx', public: true, songCount: 3, sync: true, tracks: [] }
  globalThis.window = {
    api: {
      net: {
        request: async (config) => {
          sent.push(config)
          if (config.url.endsWith('/auth/login')) return { ok: true, status: 200, data: { token: 'T', isAdmin: true }, headers: {} }
          if (config.method === 'GET') return { ok: true, status: 200, data: current, headers: { 'x-nd-authorization': 'Bearer T2' } }
          return { ok: true, status: 200, data: { id: 'p1' }, headers: {} }
        }
      }
    }
  }
  await new desktop.NavidromeAdmin('http://music.lan', 'mbootx', 'x').update('p1', { ownerId: 'u1', public: false, sync: false })
  const login = sent.find((c) => c.url.endsWith('/auth/login'))
  assert.deepStrictEqual([login.method, login.data], ['POST', { username: 'mbootx', password: 'x' }])
  const put = sent.find((c) => c.method === 'PUT')
  assert.strictEqual(put.headers['X-ND-Authorization'], 'Bearer T2')
  assert.deepStrictEqual([put.data.ownerId, put.data.public, put.data.sync, put.data.name], ['u1', false, false, 'Route'])
  assert.ok(!('ownerName' in put.data) && !('tracks' in put.data))
  assert.deepStrictEqual(desktop.ownPlaylists([{ owner: 'ana' }, { owner: 'MBOOTX' }], 'mbootx').length, 1)
})

;(async () => {
  const desktopEntry = path.join(bundle.OUT, 'entries', 'playlists-desktop.ts')
  fs.writeFileSync(desktopEntry, "export * from '" + path.resolve(bundle.MOBILE, '..', 'src/renderer/src/services/navidromeAdmin').split(String.fromCharCode(92)).join('/') + "'" + NL)
  desktop = require(await bundle(desktopEntry, {}, path.join(bundle.OUT, 'playlists-desktop.js')))
  const adminEntry = path.join(bundle.OUT, 'entries', 'playlists-admin.ts')
  fs.writeFileSync(adminEntry, "export * from '@/services/navidromeAdmin'" + NL)
  admin = require(await bundle(adminEntry, {}, path.join(bundle.OUT, 'playlists-admin.js')))
  const clientEntry = path.join(bundle.OUT, 'entries', 'playlists-navidrome.ts')
  fs.writeFileSync(clientEntry, "export { NavidromeClient } from '@/services/navidrome'" + NL)
  await bundle(clientEntry, {}, path.join(bundle.OUT, 'playlists-navidrome.js'))
  const storeEntry = path.join(bundle.OUT, 'entries', 'playlists-store.ts')
  fs.writeFileSync(storeEntry, "export { useNavidromeStore } from '@/store/navidromeStore'" + NL)
  store = require(
    await bundle(
      storeEntry,
      { '@/services/playbackEngine': 'engine-handle.js', '@/services/storage': 'storage.js', '@/services/imagePrefetch': 'image-prefetch.js' },
      path.join(bundle.OUT, 'playlists-store.js')
    )
  ).useNavidromeStore
  void fake
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
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' playlist tests passed')
  process.exit(failed ? 1 : 0)
})()
