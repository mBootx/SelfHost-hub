const assert = require('assert')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const STUBS = {
  'react-native': 'react-native.js',
  'expo-background-task': 'expo-background-task.js',
  'expo-file-system': 'expo-file-system.js',
  'expo-media-library': 'expo-media-library.js',
  'expo-network': 'expo-network.js',
  'expo-task-manager': 'expo-task-manager.js',
  'expo-local-authentication': 'expo-local-authentication.js',
  '@/services/filebrowser': 'filebrowser.js',
  '@/services/storage': 'storage.js',
  '@/store/filebrowserStore': 'filebrowserStore.js'
}

const H = 3600e3
const D = 24 * H
let now = new Date(2026, 8, 20, 12, 0, 0).getTime()
Date.now = () => now

const asset = (i, t, mediaType = 'image') => ({
  id: `content://media/external/images/media/${i}`,
  filename: mediaType === 'video' ? `VID_${i}.mp4` : `IMG_${i}.jpg`,
  mediaType,
  creationTime: t
})
const names = () => fake.uploads.map((u) => u.split('/').pop())
const journal = () => fake.prefs['cameraBackup.journal']

let cb
let store
async function fresh() {
  fake.serverDown = false
  const entry = path.join(__dirname, '.out', 'entries', 'backup.ts')
  const out = path.join(__dirname, '.out', 'backup.js')
  await bundle(entry, STUBS, out)
  delete require.cache[require.resolve(out)]
  cb = require(out)
  store = cb.useCameraBackupStore
  Object.assign(fake, {
    prefs: {},
    uploads: [],
    serverFiles: {},
    folders: [],
    uploadBehaviour: {},
    folderExists: new Set(),
    assets: [],
    attempts: [],
    network: 'WIFI',
    permission: { granted: true, accessPrivileges: 'all' },
    logins: 0,
    onUpload: null,
    missingFiles: new Set(),
    registered: new Set()
  })
  fake.connections.filebrowser = { url: 'https://files.example', username: 'mBootx' }
  fake.secrets.filebrowser_password = 'pw'
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('a big first backup sends the newest photos first, videos after the photos', async () => {
  const lib = [asset(1, now - 9 * D), asset(2, now - 8 * D), asset(3, now - 7 * D, 'video'), asset(4, now - 6 * D), asset(5, now - 5 * D)]
  fake.assets = lib
  await cb.enableCameraBackup(true)
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_5.jpg', 'IMG_4.jpg', 'IMG_2.jpg', 'IMG_1.jpg', 'VID_3.mp4'])
  assert.strictEqual(journal().cursor, lib[4].creationTime)
  assert.strictEqual(store.getState().pending, 0)
})

test('an interrupted backlog keeps what it already sent, and a new photo jumps the queue', async () => {
  const lib = [1, 2, 3, 4, 5, 6].map((i) => asset(i, now - (10 - i) * D))
  fake.assets = lib
  await cb.enableCameraBackup(true)
  fake.onUpload = () => {
    now += 60e3
  }
  await cb.runCameraBackup(100e3) // two uploads
  assert.deepStrictEqual(names(), ['IMG_6.jpg', 'IMG_5.jpg'])
  assert.strictEqual(journal().cursor, 0, 'the cursor waits for the oldest')
  assert.deepStrictEqual(Object.keys(journal().recent).sort(), [lib[4].id, lib[5].id].sort(), 'what was sent is remembered')
  fake.uploads = []
  fake.assets.push(asset(7, now - 1000))
  await cb.runCameraBackup(100e3)
  assert.deepStrictEqual(names(), ['IMG_7.jpg', 'IMG_4.jpg'], 'the new photo goes before the backlog')
  fake.onUpload = null
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_7.jpg', 'IMG_4.jpg', 'IMG_3.jpg', 'IMG_2.jpg', 'IMG_1.jpg'])
  assert.strictEqual(journal().cursor, fake.assets.find((a) => a.filename === 'IMG_7.jpg').creationTime)
  assert.ok(Object.keys(journal().recent).length <= 2, 'the list of sent files shrinks once the oldest are done')
})

test('a very large roll: the newest go first, the rest oldest first, so the journal stays small', async () => {
  const items = [1, 2, 3, 4, 5, 6].map((i) => asset(i, now - (10 - i) * D))
  const order = cb.sendingOrder(items, 0, 3).map((a) => a.filename)
  assert.deepStrictEqual(order, ['IMG_6.jpg', 'IMG_5.jpg', 'IMG_4.jpg', 'IMG_1.jpg', 'IMG_2.jpg', 'IMG_3.jpg'])
})

test('one file that keeps failing no longer holds back the photos behind it', async () => {
  const lib = [asset(1, now - 3 * D), asset(2, now - 2 * D), asset(3, now - 1 * D)]
  fake.assets = lib
  await cb.enableCameraBackup(true)
  fake.uploadBehaviour['IMG_3.jpg'] = [500, 500, 500, 500]
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_2.jpg', 'IMG_1.jpg'], 'the others went through')
  assert.strictEqual(journal().failures[lib[2].id].attempts, 1)
  assert.strictEqual(store.getState().phase, 'idle')
  assert.match(store.getState().error, /IMG_3\.jpg/)
  assert.strictEqual(store.getState().pending, 1)
  await cb.runCameraBackup()
  assert.strictEqual(journal().failures[lib[2].id].attempts, 2)
  await cb.runCameraBackup()
  assert.strictEqual(journal().cursor, lib[2].creationTime, 'given up after three tries, the cursor moves on')
  assert.strictEqual(store.getState().gaveUp, 1)
})

test('a file that failed once because of the network is simply sent next time', async () => {
  const lib = [asset(1, now - 2 * D), asset(2, now - 1 * D)]
  fake.assets = lib
  await cb.enableCameraBackup(true)
  fake.uploadBehaviour['IMG_2.jpg'] = ['network']
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_1.jpg'])
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_1.jpg', 'IMG_2.jpg'])
  assert.strictEqual(store.getState().gaveUp, 0)
  assert.strictEqual(store.getState().pending, 0)
})

test('a server that is down stops the run at the first failure and holds nothing against the files', async () => {
  const lib = [1, 2, 3, 4].map((i) => asset(i, now - (5 - i) * D))
  fake.assets = lib
  await cb.enableCameraBackup(true)
  fake.serverDown = true
  for (const n of ['IMG_1.jpg', 'IMG_2.jpg', 'IMG_3.jpg', 'IMG_4.jpg']) fake.uploadBehaviour[n] = ['network']
  await cb.runCameraBackup()
  assert.strictEqual(fake.attempts.length, 1, 'one try, then it stops: ' + fake.attempts.join())
  assert.strictEqual(store.getState().phase, 'error')
  assert.deepStrictEqual(journal().failures, {})
  assert.strictEqual(store.getState().pending, 4)
  fake.serverDown = false
  fake.uploadBehaviour = {}
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_4.jpg', 'IMG_3.jpg', 'IMG_2.jpg', 'IMG_1.jpg'])
  assert.strictEqual(store.getState().phase, 'idle')
  assert.strictEqual(store.getState().pending, 0)
  fake.serverDown = false
})

test('a server that answers but refuses every upload stops the run after three, holding nothing against the files', async () => {
  const lib = [1, 2, 3, 4, 5].map((i) => asset(i, now - (6 - i) * D))
  fake.assets = lib
  await cb.enableCameraBackup(true)
  for (const n of ['IMG_1.jpg', 'IMG_2.jpg', 'IMG_3.jpg', 'IMG_4.jpg', 'IMG_5.jpg']) fake.uploadBehaviour[n] = [500]
  await cb.runCameraBackup()
  assert.strictEqual(fake.attempts.length, 3, 'three tries, then it stops: ' + fake.attempts.join())
  assert.strictEqual(store.getState().phase, 'error')
  assert.deepStrictEqual(journal().failures, {})
  assert.strictEqual(store.getState().gaveUp, 0)
  fake.uploadBehaviour = {} // the server is fixed
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_5.jpg', 'IMG_4.jpg', 'IMG_3.jpg', 'IMG_2.jpg', 'IMG_1.jpg'])
  assert.strictEqual(store.getState().phase, 'idle')
})

test('a file that failed before a later one went through stays counted when the run then hits an outage', async () => {
  const lib = [1, 2, 3].map((i) => asset(i, now - (4 - i) * D))
  fake.assets = lib
  await cb.enableCameraBackup(true)
  fake.uploadBehaviour['IMG_3.jpg'] = [504]
  fake.uploadBehaviour['IMG_1.jpg'] = ['network']
  fake.onUpload = (name) => {
    if (name === 'IMG_2.jpg') fake.serverDown = true
  }
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_2.jpg'])
  assert.strictEqual(journal().failures[lib[2].id].attempts, 1, 'IMG_3 failed while the server was fine')
  assert.ok(!journal().failures[lib[0].id], 'IMG_1 failed in the outage: nothing held against it')
  assert.strictEqual(store.getState().phase, 'error')
  assert.strictEqual(store.getState().pending, 2)
})

test('a single file that never uploads is counted against itself even with nothing behind it', async () => {
  const lib = [asset(1, now - 1000)]
  fake.assets = lib
  await cb.enableCameraBackup(true)
  fake.uploadBehaviour['IMG_1.jpg'] = [504, 504, 504, 504]
  await cb.runCameraBackup()
  assert.strictEqual(journal().failures[lib[0].id].attempts, 1)
  assert.strictEqual(store.getState().phase, 'idle')
  assert.strictEqual(store.getState().pending, 1)
  await cb.runCameraBackup()
  await cb.runCameraBackup()
  assert.strictEqual(store.getState().gaveUp, 1)
  assert.strictEqual(store.getState().pending, 0)
  fake.uploads = []
  await cb.runCameraBackup()
  assert.deepStrictEqual(fake.attempts.length, 3, 'not tried a fourth time: ' + fake.attempts.join())
})

test('files given up can be tried again from the app', async () => {
  const lib = [asset(1, now - 3 * D), asset(2, now - 2 * D)]
  fake.assets = lib
  await cb.enableCameraBackup(true)
  fake.uploadBehaviour['IMG_1.jpg'] = [413, 413, 413, 413]
  for (let i = 0; i < 3; i++) await cb.runCameraBackup()
  assert.strictEqual(store.getState().gaveUp, 1)
  assert.deepStrictEqual(names(), ['IMG_2.jpg'])
  now += 5 * D
  fake.assets.push(asset(3, now - 1000), asset(4, now - 500))
  await cb.runCameraBackup()
  fake.uploads = []
  fake.uploadBehaviour['IMG_1.jpg'] = [] // the server limit was raised
  await cb.retryFailedBackups()
  assert.deepStrictEqual(names(), ['IMG_1.jpg'], 'only the given-up file is sent again')
  assert.ok(fake.uploads[0].includes('/2026/09/'), fake.uploads[0])
  assert.strictEqual(store.getState().gaveUp, 0)
  fake.uploads = []
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), [])
})

test('a photo deleted from the phone is not reported as a failure', async () => {
  const lib = [asset(1, now - 2 * D), asset(2, now - 1 * D)]
  fake.assets = lib
  await cb.enableCameraBackup(true)
  fake.missingFiles.add('file:///storage/emulated/0/DCIM/Camera/IMG_1.jpg')
  for (let i = 0; i < 4; i++) await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_2.jpg'])
  assert.strictEqual(store.getState().gaveUp, 0)
})

test('"send anyway" and "try again" pressed while nothing can run are not left waiting for a later run', async () => {
  fake.assets = [asset(1, now + 5000)]
  fake.network = 'CELLULAR'
  await cb.backupOverMobileData() // the backup is off: the run does nothing
  await cb.retryFailedBackups()
  assert.strictEqual(fake.attempts.length, 0)
  await cb.enableCameraBackup(true) // starts its own run
  await cb.runCameraBackup()
  assert.strictEqual(store.getState().phase, 'waiting-wifi', 'the exception did not carry over to this run')
  assert.strictEqual(fake.attempts.length, 0)
})

test('"send anyway" sends over mobile data once, the setting stays', async () => {
  fake.assets = [asset(1, now - 1000)]
  await cb.enableCameraBackup(true)
  fake.uploads = []
  fake.network = 'CELLULAR'
  await cb.runCameraBackup()
  assert.strictEqual(store.getState().phase, 'waiting-wifi')
  await cb.backupOverMobileData()
  assert.deepStrictEqual(names(), ['IMG_1.jpg'])
  assert.strictEqual(store.getState().settings.wifiOnly, true)
  fake.assets.push(asset(2, now - 500))
  await cb.runCameraBackup()
  assert.strictEqual(store.getState().phase, 'waiting-wifi', 'the next run waits for Wi-Fi again')
})

;(async () => {
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fresh()
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + '\n     ' + String(err.message).split('\n').slice(0, 4).join('\n     '))
    }
  }
  console.log(failed ? failed + ' FAILED' : 'ALL ORDER TESTS PASSED')
  process.exit(failed ? 1 : 0)
})()
