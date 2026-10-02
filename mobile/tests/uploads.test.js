// Picking files whose names are already in the folder, and the upload queue.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')

const tests = []
const test = (name, fn) => tests.push([name, fn])
let m

const set = (...names) => new Set(names)

test('freeName numbers a taken name and keeps the extension', () => {
  assert.strictEqual(m.freeName('a.jpg', set()), 'a.jpg')
  assert.strictEqual(m.freeName('a.jpg', set('a.jpg')), 'a (2).jpg')
  assert.strictEqual(m.freeName('a.jpg', set('a.jpg', 'a (2).jpg', 'a (3).jpg')), 'a (4).jpg')
  assert.strictEqual(m.freeName('archive.tar.gz', set('archive.tar.gz')), 'archive.tar (2).gz')
  assert.strictEqual(m.freeName('.env', set('.env')), '.env (2)')
  assert.strictEqual(m.freeName('noext', set('noext')), 'noext (2)')
})

test('path helpers', () => {
  assert.strictEqual(m.baseName('/a/b/c.jpg'), 'c.jpg')
  assert.strictEqual(m.baseName('/'), '')
  assert.strictEqual(m.parentPath('/a/b/c.jpg'), '/a/b')
  assert.strictEqual(m.parentPath('/c.jpg'), '/')
  assert.strictEqual(m.childPath('/', 'x'), '/x')
  assert.strictEqual(m.childPath('/a//b/', 'x'), '/a/b/x')
})

test('findConflicts names the picked files whose name is taken', () => {
  assert.deepStrictEqual(m.findConflicts(['a', 'b', 'c'], set('b', 'z')), [1])
  assert.deepStrictEqual(m.findConflicts(['a'], set()), [])
})

test('with no clash every file goes as it is, replacing nothing', () => {
  assert.deepStrictEqual(m.planUploads(['a', 'b'], set('z'), 'replace'), [
    { index: 0, name: 'a', override: false },
    { index: 1, name: 'b', override: false }
  ])
})

test('replace sends the clashing file under its own name and allows overwriting', () => {
  assert.deepStrictEqual(m.planUploads(['a.txt', 'b.txt'], set('a.txt'), 'replace'), [
    { index: 0, name: 'a.txt', override: true },
    { index: 1, name: 'b.txt', override: false }
  ])
})

test('keep both gives the clashing file a free name', () => {
  assert.deepStrictEqual(m.planUploads(['a.txt', 'b.txt'], set('a.txt', 'a (2).txt'), 'keep-both'), [
    { index: 0, name: 'a (3).txt', override: false },
    { index: 1, name: 'b.txt', override: false }
  ])
})

test('skip leaves out the clashing files only', () => {
  assert.deepStrictEqual(m.planUploads(['a.txt', 'b.txt'], set('a.txt'), 'skip'), [{ index: 1, name: 'b.txt', override: false }])
})

test('two picked files with one name never replace each other', () => {
  for (const choice of ['replace', 'keep-both', 'skip']) {
    const plan = m.planUploads(['x.jpg', 'x.jpg'], set(), choice)
    assert.deepStrictEqual(
      plan,
      [
        { index: 0, name: 'x.jpg', override: false },
        { index: 1, name: 'x (2).jpg', override: false }
      ],
      choice
    )
  }
  // and a renamed copy cannot land on a name the folder already has
  const plan = m.planUploads(['x.jpg', 'x.jpg'], set('x (2).jpg'), 'keep-both')
  assert.deepStrictEqual(plan.map((p) => p.name), ['x.jpg', 'x (3).jpg'])
})

function fakeClient(log, behaviour = {}) {
  return {
    async uploadLocalFile(uri, dir, name, onProgress, options) {
      log.active++
      log.peak = Math.max(log.peak, log.active)
      log.calls.push({ uri, dir, name, override: options && options.override })
      try {
        await new Promise((r) => setTimeout(r, behaviour.delay ?? 15))
        if (behaviour.fail && behaviour.fail.has(name)) throw new Error('refusé : ' + name)
        onProgress && onProgress(10, 10)
      } finally {
        log.active--
      }
    }
  }
}

test('uploads run two at a time, in order, and each one ends done', async () => {
  const log = { active: 0, peak: 0, calls: [] }
  const client = fakeClient(log)
  const store = m.useUploadStore
  const runs = ['a', 'b', 'c', 'd', 'e'].map((n) => store.getState().startUpload({ uri: 'file:///' + n, name: n, size: 10 }, '/Docs', client))
  assert.ok(store.getState().tasks.filter((t) => t.status === 'queued').length >= 3, 'the rest wait')
  await Promise.all(runs)
  assert.strictEqual(log.peak, 2)
  assert.deepStrictEqual(log.calls.map((c) => c.name), ['a', 'b', 'c', 'd', 'e'])
  assert.ok(store.getState().tasks.every((t) => t.status === 'done'))
  assert.deepStrictEqual(store.getState().finished, { seq: 5, destPath: '/Docs' })
  store.getState().clearFinished()
  assert.strictEqual(store.getState().tasks.length, 0)
})

test('a failed upload is shown with its reason and does not hold up the others', async () => {
  const log = { active: 0, peak: 0, calls: [] }
  const client = fakeClient(log, { fail: new Set(['bad']) })
  const store = m.useUploadStore
  const before = store.getState().finished.seq
  await Promise.all(['ok1', 'bad', 'ok2'].map((n) => store.getState().startUpload({ uri: 'f', name: n, size: 1 }, '/Y', client)))
  const byName = Object.fromEntries(store.getState().tasks.slice(-3).map((t) => [t.filename, t]))
  assert.strictEqual(byName.bad.status, 'error')
  assert.match(byName.bad.error, /refusé : bad/)
  assert.strictEqual(byName.ok1.status, 'done')
  assert.strictEqual(byName.ok2.status, 'done')
  assert.strictEqual(store.getState().finished.seq, before + 2, 'only the good ones count as finished')
})

test('the replace choice reaches the client', async () => {
  const log = { active: 0, peak: 0, calls: [] }
  const client = fakeClient(log)
  const store = m.useUploadStore
  await store.getState().startUpload({ uri: 'f', name: 'a.txt', size: 1 }, '/Z', client, { override: true })
  await store.getState().startUpload({ uri: 'f', name: 'b.txt', size: 1 }, '/Z', client)
  assert.deepStrictEqual(log.calls.map((c) => c.override), [true, false])
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'uploads.ts')
  const NL = String.fromCharCode(10)
  fs.writeFileSync(entry, ["export * from '@/services/fileNames'", "export * from '@/services/uploadConflicts'", "export { useUploadStore } from '@/store/uploadStore'", ''].join(NL))
  m = require(await bundle(entry, {}, path.join(bundle.OUT, 'uploads.js')))
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
  console.log(failed ? failed + ' FAILED' : 'ALL UPLOAD TESTS PASSED')
  process.exit(failed ? 1 : 0)
})()
