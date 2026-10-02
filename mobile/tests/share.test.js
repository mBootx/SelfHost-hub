// Files and text shared to the app from other apps: what waits for a destination, notes made from text, cleanup.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const STUBS = { 'expo-file-system': 'expo-file-system.js', '@/services/storage': 'storage.js' }
const NL = String.fromCharCode(10)
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

const file = (name, size = 100) => ({ uri: `file:///cache/shared-in/${name}`, name, size, mime: null })

let m
const tests = []
const test = (name, fn) => tests.push([name, fn])
const pending = () => m.useShareStore.getState().pending

test('a note is named after the first words of the text, or the date', () => {
  const at = new Date(2026, 9, 2, 14, 5)
  assert.strictEqual(m.noteName('https://example.com/page?x=1' + NL + 'second line', at), 'example.com page - 2026-10-02 14.05.txt', 'a link loses its query string')
  assert.strictEqual(m.noteName('https://example.com/a/b#section', at), 'example.com a b - 2026-10-02 14.05.txt', 'and its fragment')
  assert.strictEqual(m.noteName('Voir ce lien : https://example.com/page?x=1', at), 'Voir ce lien https example.com page x=1 - 2026-10-02 14.05.txt', 'a sentence is left as it is')
  assert.strictEqual(m.noteName('Acheter du pain', at), 'Acheter du pain - 2026-10-02 14.05.txt')
  assert.strictEqual(m.noteName('   ' + NL + NL + 'after blank lines', at), 'after blank lines - 2026-10-02 14.05.txt')
  assert.strictEqual(m.noteName('', at), 'Note 2026-10-02 14.05.txt')
  assert.strictEqual(m.noteName('???///***', at), 'Note 2026-10-02 14.05.txt', 'only forbidden characters')
  assert.strictEqual(m.noteName('...hidden', at), 'hidden - 2026-10-02 14.05.txt', 'no leading dots')
  assert.ok(m.noteName('x'.repeat(200), at).length < 70, 'long text gives a short name')
})

test('a typed note name ends in .txt and cannot climb out of a folder', () => {
  assert.strictEqual(m.withTextExtension('Courses'), 'Courses.txt')
  assert.strictEqual(m.withTextExtension('Courses.md'), 'Courses.md')
  assert.strictEqual(m.withTextExtension('a/b\\c'), 'a_b_c.txt')
  assert.strictEqual(m.withTextExtension('..'), 'Note.txt')
  assert.strictEqual(m.withTextExtension('   '), 'Note.txt')
  assert.strictEqual(m.withTextExtension('v1.2 notes'), 'v1.2 notes.txt', 'a dot in the middle is not an extension')
})

test('a note is written to the cache as a text file', () => {
  fake.files = {}
  const note = m.writeNote('Courses', 'pain, lait')
  assert.strictEqual(note.name, 'Courses.txt')
  assert.strictEqual(note.mime, 'text/plain')
  assert.ok(note.uri.startsWith('file:///cache/shared-in/') && note.uri.endsWith('-Courses.txt'), note.uri)
  assert.strictEqual(fake.files[note.uri], 'pain, lait')
})

test('what arrives waits for a destination; a second share while one is open is added to it', () => {
  const store = m.useShareStore
  store.getState().dismiss()
  store.getState().receive({ files: [file('a.jpg')], text: null, unreadable: 0 })
  assert.deepStrictEqual(pending().files.map((f) => f.name), ['a.jpg'])
  store.getState().receive({ files: [file('b.pdf')], text: 'caption', unreadable: 2 })
  assert.deepStrictEqual(pending().files.map((f) => f.name), ['a.jpg', 'b.pdf'])
  assert.strictEqual(pending().text, 'caption')
  assert.strictEqual(pending().unreadable, 2)
  store.getState().dismiss()
  assert.strictEqual(pending(), null)
})

test('an empty share is ignored, but one whose files were all unreadable is reported', () => {
  const store = m.useShareStore
  store.getState().dismiss()
  store.getState().receive({ files: [], text: null, unreadable: 0 })
  assert.strictEqual(pending(), null)
  store.getState().receive({ files: [], text: null, unreadable: 3 })
  assert.strictEqual(pending().unreadable, 3)
  store.getState().dismiss()
})

test('forgetting shared files deletes their copies and tolerates ones already gone', () => {
  fake.files = { 'file:///cache/shared-in/a.jpg': '', 'file:///cache/shared-in/keep.jpg': '' }
  m.forgetShared([file('a.jpg'), file('already-gone.jpg')])
  assert.ok(!('file:///cache/shared-in/a.jpg' in fake.files))
  assert.ok('file:///cache/shared-in/keep.jpg' in fake.files, 'only the named copies')
})

test('the share the app was opened with is picked up at start, and later ones as they arrive', async () => {
  const store = m.useShareStore
  store.getState().dismiss()
  fake.native.missing = false
  fake.native.share = { files: [file('first.jpg')], text: null, unreadable: 0 }
  fake.native.shareListeners = []
  m.startShareIntake()
  await tick()
  assert.deepStrictEqual(pending().files.map((f) => f.name), ['first.jpg'])
  assert.strictEqual(fake.native.share, null, 'reading it emptied it')
  assert.strictEqual(fake.native.shareListeners.length, 1)
  assert.strictEqual(fake.native.shareListeners[0][0], 'onShareReceived')
  // The app is running and another share comes in.
  fake.native.share = { files: [file('second.jpg')], text: null, unreadable: 0 }
  fake.native.shareListeners[0][1]()
  await tick()
  assert.deepStrictEqual(pending().files.map((f) => f.name), ['first.jpg', 'second.jpg'])
  // Nothing waiting: the event changes nothing.
  fake.native.shareListeners[0][1]()
  await tick()
  assert.strictEqual(pending().files.length, 2)
  store.getState().dismiss()
})

test('starting twice listens once', async () => {
  fake.native.shareListeners = []
  m.startShareIntake()
  assert.strictEqual(fake.native.shareListeners.length, 0)
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'share.ts')
  fs.writeFileSync(entry, "export * from '@/services/shareIntake'" + NL)
  m = require(await bundle(entry, STUBS, path.join(bundle.OUT, 'share.js')))
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
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' share tests passed')
  process.exit(failed ? 1 : 0)
})()
