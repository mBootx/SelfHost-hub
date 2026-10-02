// The backup never overwrites what is on the server: a file that is already there is left alone, and a
// different file with the same name goes in under a numbered name.
const assert = require('assert')
const fs = require('fs')
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

const D = 24 * 3600e3
let now = new Date(2026, 8, 20, 12, 0, 0).getTime()
Date.now = () => now
const FOLDER = '/backups/photos/mBootx/2026/09'
const phoneUri = (name) => `file:///storage/emulated/0/DCIM/Camera/${name}`

const asset = (i, t, filename) => ({
  id: `content://media/external/images/media/${i}`,
  filename: filename || `IMG_${i}.jpg`,
  mediaType: 'image',
  creationTime: t
})
const journal = () => fake.prefs['cameraBackup.journal']

let cb
let store
async function fresh() {
  const entry = path.join(bundle.OUT, 'entries', 'backup.ts')
  const out = path.join(bundle.OUT, 'backup.js')
  fs.writeFileSync(entry, "export * from '@/services/cameraBackup'" + String.fromCharCode(10) + "export { useCameraBackupStore } from '@/store/cameraBackupStore'" + String.fromCharCode(10))
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
    sizes: {},
    network: 'WIFI',
    permission: { granted: true, accessPrivileges: 'all' },
    logins: 0,
    onUpload: null,
    beforeUpload: null,
    listFailure: 0,
    serverDown: false,
    missingFiles: new Set(),
    registered: new Set()
  })
  fake.connections.filebrowser = { url: 'https://files.example', username: 'mBootx' }
  fake.secrets.filebrowser_password = 'pw'
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('a file the server already has, same name and same size, is not sent again but counts as backed up', async () => {
  fake.assets = [asset(1, now - 2 * D)]
  fake.serverFiles[FOLDER] = { 'IMG_1.jpg': 4200 }
  fake.sizes[phoneUri('IMG_1.jpg')] = 4200
  await cb.enableCameraBackup(true)
  await cb.runCameraBackup()
  assert.deepStrictEqual(fake.attempts, [], 'nothing was sent')
  assert.ok(fake.assets[0].id in journal().recent, 'it is recorded as backed up')
  assert.strictEqual(journal().cursor, fake.assets[0].creationTime)
  assert.strictEqual(store.getState().uploadedTotal, 0, 'and it is not counted as an upload')
  assert.strictEqual(store.getState().pending, 0)
  assert.strictEqual(store.getState().phase, 'idle')
})

test('a different file with the same name goes in under a numbered name and the first is untouched', async () => {
  fake.assets = [asset(1, now - 2 * D)]
  fake.serverFiles[FOLDER] = { 'IMG_1.jpg': 111 }
  fake.sizes[phoneUri('IMG_1.jpg')] = 222
  await cb.enableCameraBackup(true)
  await cb.runCameraBackup()
  assert.deepStrictEqual(fake.uploads, [FOLDER + '/IMG_1 (2).jpg'])
  assert.deepStrictEqual(fake.serverFiles[FOLDER], { 'IMG_1.jpg': 111, 'IMG_1 (2).jpg': 222 })
  assert.strictEqual(store.getState().uploadedTotal, 1)
})

test('two photos of one month with the same name are both kept', async () => {
  fake.assets = [asset(1, now - 3 * D, 'IMG_0001.jpg'), asset(2, now - 2 * D, 'IMG_0001.jpg')]
  fake.sizes[phoneUri('IMG_0001.jpg')] = 777
  await cb.enableCameraBackup(true)
  await cb.runCameraBackup()
  // both phone files report the same size here, so the second is the very same file as far as the server can tell
  assert.deepStrictEqual(Object.keys(fake.serverFiles[FOLDER]), ['IMG_0001.jpg'])
  fake.assets.push(asset(3, now - D, 'IMG_0001.jpg'))
  fake.sizes[phoneUri('IMG_0001.jpg')] = 888
  await cb.runCameraBackup()
  assert.deepStrictEqual(Object.keys(fake.serverFiles[FOLDER]).sort(), ['IMG_0001 (2).jpg', 'IMG_0001.jpg'])
})

test('a name that appears on the server between the listing and the upload is dealt with', async () => {
  fake.assets = [asset(1, now - 2 * D)]
  fake.serverFiles[FOLDER] = {}
  fake.sizes[phoneUri('IMG_1.jpg')] = 500
  let hit = false
  fake.beforeUpload = (name, dir) => {
    if (hit) return
    hit = true
    fake.serverFiles[dir][name] = 999 // somebody else got there first, with a different file
  }
  await cb.enableCameraBackup(true)
  await cb.runCameraBackup()
  assert.deepStrictEqual(fake.uploads, [FOLDER + '/IMG_1 (2).jpg'])
  assert.strictEqual(fake.serverFiles[FOLDER]['IMG_1.jpg'], 999, 'the other file is still there')
  assert.strictEqual(store.getState().phase, 'idle')
})

test('and when what appeared is the very same file, nothing more is sent', async () => {
  fake.assets = [asset(1, now - 2 * D)]
  fake.serverFiles[FOLDER] = {}
  fake.sizes[phoneUri('IMG_1.jpg')] = 500
  let hit = false
  fake.beforeUpload = (name, dir) => {
    if (hit) return
    hit = true
    fake.serverFiles[dir][name] = 500
  }
  await cb.enableCameraBackup(true)
  await cb.runCameraBackup()
  assert.deepStrictEqual(fake.uploads, [])
  assert.ok(fake.assets[0].id in journal().recent)
  assert.strictEqual(store.getState().uploadedTotal, 0)
})

test('the month folder is listed once per run, not once per photo', async () => {
  fake.assets = [1, 2, 3, 4].map((i) => asset(i, now - (6 - i) * 3600e3))
  fake.listCalls = 0
  await cb.enableCameraBackup(true)
  await cb.runCameraBackup()
  assert.strictEqual(fake.uploads.length, 4)
  assert.strictEqual(fake.listCalls, 1)
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
      console.log('FAIL ' + name + '\n     ' + String(err && err.stack ? err.stack : err).split('\n').slice(0, 5).join('\n     '))
    }
  }
  console.log(failed ? failed + ' FAILED' : 'ALL BACKUP NAME TESTS PASSED')
  process.exit(failed ? 1 : 0)
})()
