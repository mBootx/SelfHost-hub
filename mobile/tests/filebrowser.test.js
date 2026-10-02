// The FileBrowser client against a scripted server: the requests it sends must be the ones the server's
// source says it accepts (FileBrowser Quantum 1.3+), and a half-failed batch must not pass for success.
const assert = require('assert')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')
const fs = require('fs')

const STUBS = { 'expo-file-system': 'expo-file-system.js', './httpXhr': 'httpXhr.js' }
const BASE = 'https://files.example'

function reset() {
  fake.xhrLog = []
  fake.xhrReplies = []
  fake.networkTasks = []
  fake.uploadStatus = 200
  fake.dirs = {}
  fake.files = {}
}

const tests = []
const test = (name, fn) => tests.push([name, fn])
let FileBrowserClient
let ApiError

async function signedIn() {
  reset()
  fake.xhrReplies.push(
    ['POST ' + BASE + '/api/auth/login', { status: 200, headers: { 'set-cookie': 'filebrowser_quantum_jwt=aaa.bbb.ccc; Path=/' }, data: {} }],
    ['GET ' + BASE + '/api/users?id=self', { status: 200, data: { username: 'Alice', scopes: [{ name: 'main', scope: '/' }] } }]
  )
  const client = new FileBrowserClient({ url: BASE + '/', username: 'alice', password: 'pw' })
  await client.login()
  fake.xhrLog = []
  return client
}
const last = () => fake.xhrLog[fake.xhrLog.length - 1]
const query = (url) => Object.fromEntries(new URL(url).searchParams)

test('login keeps the token, the source name and the account name', async () => {
  const client = await signedIn()
  assert.strictEqual(client.getSourceName(), 'main')
  assert.strictEqual(client.getAccountName(), 'Alice')
  assert.deepStrictEqual(client.getAuthHeaders(), { Authorization: 'Bearer aaa.bbb.ccc' })
})

test('a listing carries whether each file has a thumbnail and whether it is shared', async () => {
  const client = await signedIn()
  fake.xhrReplies.push([
    'GET ' + BASE + '/api/resources?',
    { status: 200, data: { folders: [{ name: 'Trips', type: 'directory' }], files: [{ name: 'a.jpg', size: 5, type: 'image/jpeg', hasPreview: true, isShared: true }, { name: 'b.mp4', size: 9, type: 'video/mp4', hasPreview: false }, { name: 'c.txt', size: 1, type: 'text/plain' }] } }
  ])
  const items = await client.list('/Photos')
  assert.deepStrictEqual(items.map((i) => [i.name, i.isDir, i.hasPreview, i.isShared]), [
    ['Trips', true, undefined, undefined],
    ['a.jpg', false, true, true],
    ['b.mp4', false, false, undefined],
    ['c.txt', false, undefined, undefined]
  ])
  assert.strictEqual(items[1].path, '/Photos/a.jpg')
})

test('addresses of files and thumbnails never contain the login', async () => {
  const client = await signedIn()
  const raw = client.rawUrl('/a b/c.jpg')
  assert.ok(!raw.includes('auth'), raw)
  assert.ok(!raw.includes('aaa.bbb.ccc'), raw)
  assert.deepStrictEqual(query(raw), { source: 'main', file: '/a b/c.jpg', inline: 'true' })
  for (const url of client.previewUrls('/a b/c.jpg')) {
    assert.ok(!url.includes('auth') && !url.includes('aaa.bbb.ccc'), url)
  }
  const source = client.imageSource(raw, 'k')
  assert.deepStrictEqual(source, { uri: raw, headers: { Authorization: 'Bearer aaa.bbb.ccc' }, cacheKey: 'k' })
})

test('thumbnails are asked for at the current route first, the old one second, and the one that answered goes first', async () => {
  const client = await signedIn()
  const [first, second] = client.previewUrls('/p.jpg', 'small')
  assert.ok(first.startsWith(BASE + '/api/resources/preview?'), first)
  assert.ok(second.startsWith(BASE + '/api/preview?'), second)
  assert.deepStrictEqual(query(first), { source: 'main', path: '/p.jpg', size: 'small', inline: 'true' })
  client.notePreviewWorked(second)
  assert.ok(client.previewUrls('/q.jpg')[0].startsWith(BASE + '/api/preview?'))
  client.notePreviewWorked(first)
  assert.ok(client.previewUrls('/q.jpg')[0].startsWith(BASE + '/api/resources/preview?'))
})

test('creating a share link: the right request, and a link built on the address the app uses', async () => {
  const client = await signedIn()
  fake.xhrReplies.push([
    'POST ' + BASE + '/api/share',
    { status: 200, data: { hash: 'h4sh', path: '/Photos/a.jpg', expire: 1790000000, hasPassword: false, shareUrl: 'http://backend:8080/public/share/h4sh', downloadURL: 'http://backend:8080/x' } }
  ])
  const link = await client.createShare('/Photos/a.jpg', { value: 7, unit: 'days' })
  assert.strictEqual(last().method, 'POST')
  assert.deepStrictEqual(last().data, { path: '/Photos/a.jpg', source: 'main', expires: '7', unit: 'days' })
  assert.strictEqual(last().headers.Authorization, 'Bearer aaa.bbb.ccc')
  assert.strictEqual(link.url, BASE + '/public/share/h4sh', 'not the server\'s idea of its own address')
  assert.strictEqual(link.downloadUrl, BASE + '/public/api/resources/download?hash=h4sh')
  assert.strictEqual(link.expiresAt, 1790000000 * 1000)
  assert.ok(!JSON.stringify(link).includes('aaa.bbb.ccc'), 'the login is nowhere in the link')
})

test('a share without an end date sends no expiry; a password-protected one gets its download token', async () => {
  const client = await signedIn()
  fake.xhrReplies.push(['POST ' + BASE + '/api/share', { status: 200, data: { hash: 'zz', path: '/f', expire: 0, hasPassword: true, token: 'p.q' } }])
  const link = await client.createShare('/f', null, 'secret')
  assert.deepStrictEqual(last().data, { path: '/f', source: 'main', password: 'secret' })
  assert.strictEqual(link.expiresAt, null)
  assert.strictEqual(link.hasPassword, true)
  assert.strictEqual(link.downloadUrl, BASE + '/public/api/resources/download?hash=zz&token=p.q')
})

test('an account that may not share is told so', async () => {
  const client = await signedIn()
  fake.xhrReplies.push(['POST ' + BASE + '/api/share', { status: 403, data: { message: 'forbidden' } }])
  await assert.rejects(() => client.createShare('/f'), (err) => err.status === 403 && /pas le droit/.test(err.message))
})

test('the list of share links: newest first, and the old route when the new one is missing', async () => {
  const client = await signedIn()
  fake.xhrReplies.push(['GET ' + BASE + '/api/share/list', { status: 404, data: null }])
  fake.xhrReplies.push(['GET ' + BASE + '/api/shares', { status: 200, data: [{ hash: 'one', path: '/a', expire: 0 }, { hash: 'two', path: '/b', expire: 10, username: 'bob' }] }])
  const links = await client.listShares()
  assert.deepStrictEqual(links.map((l) => l.hash), ['two', 'one'])
  assert.strictEqual(links[0].username, 'bob')
  fake.xhrReplies.length = 0
  fake.xhrReplies.push(['GET ' + BASE + '/api/share/list', { status: 200, data: [{ hash: 'x', path: '/a' }] }])
  assert.strictEqual((await client.listShares()).length, 1)
})

test('deleting a share link', async () => {
  const client = await signedIn()
  fake.xhrReplies.push(['DELETE ' + BASE + '/api/share?hash=ab%2Fc', { status: 200, data: null }])
  await client.deleteShare('ab/c')
  assert.strictEqual(last().method, 'DELETE')
})

test('search: the request, the session header, the old route as a fallback, and folders tidied', async () => {
  const client = await signedIn()
  fake.xhrReplies.push(['GET ' + BASE + '/api/tools/search', { status: 404, data: null }])
  fake.xhrReplies.push([
    'GET ' + BASE + '/api/search',
    { status: 200, data: [{ path: '/Docs/report.pdf', type: 'pdf', size: 12, modified: '2026-01-01T00:00:00Z' }, { path: '/Docs/Old/', type: 'directory' }, { type: 'x' }] }
  ])
  const hits = await client.search('rep ort', '/Docs')
  const calls = fake.xhrLog.filter((r) => r.url.includes('search'))
  assert.deepStrictEqual(query(calls[0].url), { query: 'rep ort', source: 'main', scope: '/Docs' })
  assert.ok(calls[0].headers.SessionId && calls[0].headers.SessionId.length > 3)
  assert.ok(calls[1].url.startsWith(BASE + '/api/search?'))
  assert.deepStrictEqual(hits.map((h) => [h.path, h.name, h.isDir]), [['/Docs/report.pdf', 'report.pdf', false], ['/Docs/Old', 'Old', true]])
})

test('deleting several files: all gone, some failed (207) and none deleted (500) are told apart', async () => {
  const client = await signedIn()
  fake.xhrReplies.push([(r) => r.method === 'DELETE', { status: 200, data: { succeeded: [], failed: [] } }])
  assert.deepStrictEqual(await client.removeMany(['/a', '/b']), { done: ['/a', '/b'], failed: [] })
  assert.deepStrictEqual(last().data, [{ source: 'main', path: '/a' }, { source: 'main', path: '/b' }])

  fake.xhrReplies.length = 0
  fake.xhrReplies.push([(r) => r.method === 'DELETE', { status: 207, data: { succeeded: [{ path: '/a' }], failed: [{ path: '/b', message: 'permission denied' }] } }])
  assert.deepStrictEqual(await client.removeMany(['/a', '/b']), { done: ['/a'], failed: [{ path: '/b', message: 'permission denied' }] })

  fake.xhrReplies.length = 0
  fake.xhrReplies.push([(r) => r.method === 'DELETE', { status: 500, data: { succeeded: [], failed: [{ path: '/a', message: 'busy' }, { path: '/b', message: 'busy' }] } }])
  const none = await client.removeMany(['/a', '/b'])
  assert.deepStrictEqual(none.done, [])
  assert.strictEqual(none.failed.length, 2)

  fake.xhrReplies.length = 0
  fake.xhrReplies.push([(r) => r.method === 'DELETE', { status: 502, data: null, error: 'Bad Gateway' }])
  await assert.rejects(() => client.removeMany(['/a']), (err) => err.status === 502)
  await assert.rejects(() => client.remove('/a'), (err) => err.status === 502)
})

test('one file that cannot be deleted makes remove() fail with the reason', async () => {
  const client = await signedIn()
  fake.xhrReplies.push([(r) => r.method === 'DELETE', { status: 500, data: { succeeded: [], failed: [{ path: '/a', message: 'file is locked' }] } }])
  await assert.rejects(() => client.remove('/a'), /file is locked/)
})

test('moving several files into a folder', async () => {
  const client = await signedIn()
  fake.xhrReplies.push([(r) => r.method === 'PATCH', { status: 200, data: { succeeded: [], failed: [] } }])
  const result = await client.move(['/a/x.txt', '/b/y.txt'], '/Archive')
  assert.deepStrictEqual(last().data, {
    items: [
      { fromSource: 'main', fromPath: '/a/x.txt', toSource: 'main', toPath: '/Archive/x.txt' },
      { fromSource: 'main', fromPath: '/b/y.txt', toSource: 'main', toPath: '/Archive/y.txt' }
    ],
    action: 'move',
    overwrite: false,
    rename: false
  })
  assert.deepStrictEqual(result, { done: ['/a/x.txt', '/b/y.txt'], failed: [] })
  fake.xhrReplies.length = 0
  fake.xhrReplies.push([(r) => r.method === 'PATCH', { status: 207, data: { succeeded: [], failed: [{ fromPath: '/b/y.txt', message: 'destination exists' }] } }])
  const partial = await client.move(['/a/x.txt', '/b/y.txt'], '/Archive')
  assert.deepStrictEqual(partial, { done: ['/a/x.txt'], failed: [{ path: '/b/y.txt', message: 'destination exists' }] })
})

test('a rename the server refused is an error with its reason, not a success', async () => {
  const client = await signedIn()
  fake.xhrReplies.push([(r) => r.method === 'PATCH', { status: 500, data: { succeeded: [], failed: [{ fromPath: '/a', message: 'destination exists' }] } }])
  await assert.rejects(() => client.rename('/a', '/b'), /destination exists/)
  fake.xhrReplies.length = 0
  fake.xhrReplies.push([(r) => r.method === 'PATCH', { status: 207, data: { succeeded: [], failed: [{ fromPath: '/a', message: 'nope' }] } }])
  await assert.rejects(() => client.rename('/a', '/b'), /nope/)
  fake.xhrReplies.length = 0
  fake.xhrReplies.push([(r) => r.method === 'PATCH', { status: 200, data: { succeeded: [{ fromPath: '/a' }], failed: [] } }])
  await client.rename('/a', '/b')
})

test('an upload does not replace a file of the same name unless told to', async () => {
  const client = await signedIn()
  await client.uploadLocalFile('file:///cache/x.jpg', '/Photos', 'x.jpg')
  let task = fake.networkTasks.pop()
  assert.deepStrictEqual(query(task.url), { path: '/Photos/x.jpg', source: 'main', override: 'false' })
  assert.strictEqual(task.options.headers.Authorization, 'Bearer aaa.bbb.ccc')
  await client.uploadLocalFile('file:///cache/x.jpg', '/Photos', 'x.jpg', undefined, { override: true })
  task = fake.networkTasks.pop()
  assert.strictEqual(query(task.url).override, 'true')
  fake.uploadStatus = 409
  await assert.rejects(() => client.uploadLocalFile('file:///cache/x.jpg', '/Photos', 'x.jpg'), (err) => err.status === 409 && /existe déjà/.test(err.message))
  fake.uploadStatus = 500
  await assert.rejects(() => client.uploadLocalFile('file:///cache/x.jpg', '/Photos', 'x.jpg'), (err) => err.status === 500)
})

test('downloads send the login in a header, never in the address, and a zip lists every file', async () => {
  const client = await signedIn()
  await client.downloadToDevice('/a/b.pdf', 'b.pdf')
  let task = fake.networkTasks.pop()
  assert.ok(!task.url.includes('auth') && !task.url.includes('aaa.bbb.ccc'), task.url)
  assert.strictEqual(task.options.headers.Authorization, 'Bearer aaa.bbb.ccc')
  await client.downloadArchive(['/a/b.pdf', '/c d'], 'selection.zip')
  task = fake.networkTasks.pop()
  const url = new URL(task.url)
  assert.deepStrictEqual(url.searchParams.getAll('file'), ['/a/b.pdf', '/c d'])
  assert.strictEqual(url.searchParams.get('algo'), 'zip')
  assert.ok(!task.url.includes('aaa.bbb.ccc'))
  assert.ok(task.destination.endsWith('selection.zip'))
})

test('a file for sharing goes to the cache with the login in a header, and the previous hand-over is cleared', async () => {
  const client = await signedIn()
  fake.dirs['file:///cache/shared'] = true
  fake.files['file:///cache/shared/old.jpg'] = ''
  fake.files['file:///doc/downloads/keep.pdf'] = ''
  const uri = await client.downloadToCache('/photos/2026/09/a b.jpg', 'a b.jpg')
  const task = fake.networkTasks.pop()
  assert.strictEqual(uri, 'file:///cache/shared/a b.jpg')
  assert.strictEqual(task.destination, uri)
  assert.ok(!task.url.includes('aaa.bbb.ccc'))
  assert.strictEqual(task.options.headers.Authorization, 'Bearer aaa.bbb.ccc')
  assert.strictEqual(new URL(task.url).searchParams.get('file'), '/photos/2026/09/a b.jpg')
  assert.ok(!('file:///cache/shared/old.jpg' in fake.files), 'the earlier file is gone')
  assert.ok('file:///doc/downloads/keep.pdf' in fake.files, 'what the user saved is untouched')
  // A name that would climb out of the folder is not used as it is.
  assert.strictEqual(await client.downloadToCache('/x', '..'), 'file:///cache/shared/fichier')
  assert.strictEqual(await client.downloadToCache('/x', 'a/b.jpg'), 'file:///cache/shared/a_b.jpg')
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'filebrowser.ts')
  fs.writeFileSync(entry, "export * from '@/services/filebrowser'" + String.fromCharCode(10))
  const mod = require(await bundle(entry, STUBS, path.join(bundle.OUT, 'filebrowser.js')))
  FileBrowserClient = mod.FileBrowserClient
  ApiError = mod.ApiError
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + '\n     ' + String(err && err.stack ? err.stack : err).split('\n').slice(0, 5).join('\n     '))
    }
  }
  console.log(failed ? failed + ' FAILED' : 'ALL FILEBROWSER CLIENT TESTS PASSED')
  process.exit(failed ? 1 : 0)
})()
