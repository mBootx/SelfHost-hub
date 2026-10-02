// The backup of albums other than the camera's, and the "charging only" condition.
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

const H = 3600e3
const D = 24 * H
let now = new Date(2026, 8, 20, 12, 0, 0).getTime()
Date.now = () => now

const ROOT = '/backups/photos/mBootx'
const SHOTS = { id: 'shots', title: 'Screenshots' }
const WHATSAPP = { id: 'wa', title: 'WhatsApp Images' }
let counter = 0
/** A photo on the phone, in the camera's album unless another is named. */
const asset = (name, t, album = 'cam', mediaType = 'image') => ({ id: `content://media/${++counter}`, filename: name, mediaType, creationTime: t, album })
const sent = () => [...fake.uploads]
const journalOf = (key) => fake.prefs[key]
const SHOTS_JOURNAL = 'cameraBackup.journal.album.shots'

let cb
let store

/**
 * Runs set-up steps that start backups of their own without letting those send anything: the phone is on
 * mobile data meanwhile, which "Wi-Fi only" waits out. Afterwards the Wi-Fi is back.
 */
async function quietly(steps) {
  fake.network = 'CELLULAR'
  await steps()
  await cb.runCameraBackup()
  fake.network = 'WIFI'
  fake.uploads = []
}

/** A clean phone and server, with the backup on for the camera. */
async function fresh(settings = {}) {
  await cb.runCameraBackup() // a run left over from the previous test must be over
  fake.assets = []
  fake.uploads = []
  fake.serverFiles = {}
  fake.folders = []
  fake.folderExists = new Set()
  fake.uploadBehaviour = {}
  fake.onUpload = null
  fake.prefs = {}
  fake.albums = [{ id: 'cam', title: 'Camera' }, SHOTS, WHATSAPP, { id: 'blank', title: '  ' }]
  fake.network = 'WIFI'
  fake.native.charging = false
  fake.native.missing = false
  fake.permission = { granted: true, accessPrivileges: 'all' }
  fake.accountName = null
  store.setState({ settings: { ...store.getState().settings, enabled: false, albums: [], chargingOnly: false, wifiOnly: true, folder: '/backups/photos/{user}', legacyFolder: null, ...settings }, loaded: true, phase: 'idle', pending: null, error: null, uploadedTotal: 0, gaveUp: 0, lastSuccessAt: null, progress: null })
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('an album added for what comes next sends only new photos, into its own folder', async () => {
  await fresh()
  fake.assets = [asset('IMG_1.jpg', now - 2 * D), asset('old.png', now - 3 * D, 'shots')]
  await cb.enableCameraBackup(false)
  await cb.addBackupAlbum(SHOTS, false)
  await cb.runCameraBackup()
  assert.deepStrictEqual(sent(), [], 'photos taken before are not sent')
  now += H
  fake.assets.push(asset('new.png', now - 60e3, 'shots'), asset('IMG_2.jpg', now - 30e3))
  await cb.runCameraBackup()
  assert.deepStrictEqual(sent().sort(), [`${ROOT}/2026/09/IMG_2.jpg`, `${ROOT}/Screenshots/2026/09/new.png`])
})

test('an album added with everything sends what it already holds', async () => {
  await fresh()
  fake.assets = [asset('IMG_1.jpg', now - 2 * D), asset('old.png', now - 3 * D, 'shots')]
  await cb.enableCameraBackup(false)
  await cb.addBackupAlbum(SHOTS, true)
  await cb.runCameraBackup()
  assert.deepStrictEqual(sent(), [`${ROOT}/Screenshots/2026/09/old.png`])
  assert.deepStrictEqual(store.getState().settings.albums, [SHOTS])
  await cb.addBackupAlbum(SHOTS, true)
  assert.strictEqual(store.getState().settings.albums.length, 1, 'adding it twice changes nothing')
})

test('one run sends the camera first, then each album, and the totals are the sums', async () => {
  await fresh()
  fake.assets = [asset('c1.jpg', now - 4 * H), asset('c2.jpg', now - 3 * H), asset('s1.png', now - 2 * H, 'shots'), asset('w1.jpg', now - H, 'wa'), asset('s2.png', now - 30 * 60e3, 'shots')]
  await quietly(async () => {
    await cb.enableCameraBackup(true)
    await cb.addBackupAlbum(SHOTS, true)
    await cb.addBackupAlbum(WHATSAPP, true)
  })
  const seen = []
  fake.onUpload = (name) => {
    const s = store.getState()
    seen.push([name, s.progress.done, s.progress.total, s.pending])
  }
  await cb.runCameraBackup()
  assert.deepStrictEqual(sent().map((u) => u.split('/').pop()), ['c2.jpg', 'c1.jpg', 's2.png', 's1.png', 'w1.jpg'])
  assert.deepStrictEqual(seen.map((s) => s.slice(1, 3)), [[0, 5], [1, 5], [2, 5], [3, 5], [4, 5]], 'one progress bar for the whole run')
  const s = store.getState()
  assert.deepStrictEqual([s.phase, s.pending, s.uploadedTotal, s.gaveUp], ['idle', 0, 5, 0])
  assert.ok(s.lastSuccessAt !== null)
})

test('each album has a journal of its own: a refused file in one holds nothing back in the others', async () => {
  await fresh()
  fake.assets = [asset('c1.jpg', now - 4 * H), asset('bad.png', now - 3 * H, 'shots'), asset('s2.png', now - 2 * H, 'shots')]
  await quietly(async () => {
    await cb.enableCameraBackup(true)
    await cb.addBackupAlbum(SHOTS, true)
  })
  fake.uploadBehaviour['bad.png'] = [413, 413, 413]
  await cb.runCameraBackup()
  assert.deepStrictEqual(sent().map((u) => u.split('/').pop()).sort(), ['c1.jpg', 's2.png'])
  await cb.runCameraBackup()
  await cb.runCameraBackup()
  const shots = journalOf(SHOTS_JOURNAL)
  assert.strictEqual(Object.keys(shots.gaveUp).length, 1)
  assert.strictEqual(Object.keys(journalOf('cameraBackup.journal').gaveUp).length, 0)
  assert.strictEqual(store.getState().gaveUp, 1)
  assert.deepStrictEqual((await cb.backupJournalSummary()).gaveUp.map((g) => g.name), ['Screenshots/bad.png'])
})

test('a file refused in an album can be sent again on request', async () => {
  await fresh()
  fake.assets = [asset('bad.png', now - 3 * H, 'shots')]
  await quietly(async () => {
    await cb.enableCameraBackup(true)
    await cb.addBackupAlbum(SHOTS, true)
  })
  fake.uploadBehaviour['bad.png'] = [413, 413, 413]
  for (let i = 0; i < 3; i++) await cb.runCameraBackup()
  assert.strictEqual(store.getState().gaveUp, 1)
  fake.uploads = []
  await cb.retryFailedBackups()
  assert.deepStrictEqual(sent(), [`${ROOT}/Screenshots/2026/09/bad.png`])
  assert.strictEqual(store.getState().gaveUp, 0)
})

test('removing an album stops its backup and forgets its journal, and what was sent stays', async () => {
  await fresh()
  fake.assets = [asset('s1.png', now - 3 * H, 'shots')]
  await cb.enableCameraBackup(true)
  await cb.addBackupAlbum(SHOTS, true)
  await cb.runCameraBackup()
  assert.strictEqual(sent().length, 1)
  await cb.removeBackupAlbum('shots')
  assert.deepStrictEqual(store.getState().settings.albums, [])
  assert.strictEqual(journalOf(SHOTS_JOURNAL), null)
  fake.uploads = []
  fake.assets.push(asset('s2.png', now - 60e3, 'shots'))
  await cb.runCameraBackup()
  assert.deepStrictEqual(sent(), [], 'no longer backed up')
  assert.ok(fake.serverFiles[`${ROOT}/Screenshots/2026/09`]['s1.png'], 'the server still has it')
  await cb.addBackupAlbum(SHOTS, false)
  await cb.runCameraBackup()
  assert.deepStrictEqual(sent(), [], 'added again for what comes next: the old ones stay out')
})

test('an album that is gone from the phone does not stop the camera', async () => {
  await fresh()
  fake.assets = [asset('c1.jpg', now - 3 * H)]
  await quietly(async () => {
    await cb.enableCameraBackup(true)
    await store.getState().saveSettings({ albums: [{ id: 'gone', title: 'Gone' }] })
  })
  await cb.runCameraBackup()
  assert.deepStrictEqual(sent(), [`${ROOT}/2026/09/c1.jpg`])
  assert.strictEqual(store.getState().phase, 'idle')
  assert.strictEqual(store.getState().error, null)
})

test('an album added while a backup is running is picked up right after it', async () => {
  await fresh()
  fake.assets = [asset('c1.jpg', now - 4 * H), asset('s1.png', now - 3 * H, 'shots')]
  await quietly(async () => {
    await cb.enableCameraBackup(true)
  })
  const running = cb.runCameraBackup() // planned without the album
  await cb.addBackupAlbum(SHOTS, true)
  await running
  assert.ok(sent().some((u) => u.endsWith('/Screenshots/2026/09/s1.png')), sent().join(' '))
  assert.ok(sent().some((u) => u.endsWith('/c1.jpg')))
})

test('an album folder is named so that nothing can lead out of the account folder', async () => {
  await fresh()
  const odd = { id: 'odd', title: 'a/../b' }
  const year = { id: 'year', title: '2024' }
  fake.albums.push(odd, year)
  fake.assets = [asset('x.jpg', now - 3 * H, 'odd'), asset('y.jpg', now - 2 * H, 'year')]
  await cb.enableCameraBackup(true)
  await cb.addBackupAlbum(odd, true)
  await cb.addBackupAlbum(year, true)
  await cb.runCameraBackup()
  assert.deepStrictEqual(sent().sort(), [`${ROOT}/2024 (album)/2026/09/y.jpg`, `${ROOT}/a~2f~..~2f~b/2026/09/x.jpg`])
})

test('turning the backup on again starts every album from the same point', async () => {
  await fresh()
  await cb.enableCameraBackup(true)
  await cb.addBackupAlbum(SHOTS, true)
  assert.strictEqual(journalOf(SHOTS_JOURNAL).cursor, 0)
  now += D
  await cb.enableCameraBackup(false)
  assert.strictEqual(journalOf(SHOTS_JOURNAL).cursor, now)
  assert.strictEqual(journalOf(SHOTS_JOURNAL).floor, now)
})

test('the phone\'s albums are listed without the camera, by name, and counted for photos and videos only', async () => {
  await fresh()
  assert.deepStrictEqual(await cb.listDeviceAlbums(), [SHOTS, WHATSAPP])
  fake.assets = [asset('a.png', now - H, 'shots'), asset('b.mp4', now - H, 'shots', 'video'), asset('c.mp3', now - H, 'shots', 'audio'), asset('d.jpg', now - H)]
  assert.strictEqual(await cb.countAlbumItems('shots'), 2)
  assert.strictEqual(await cb.countAlbumItems('wa'), 0)
})

test('charging only: nothing is sent unplugged, and the backup goes on as soon as the phone is plugged in', async () => {
  await fresh({ chargingOnly: true })
  fake.assets = [asset('c1.jpg', now - 3 * H)]
  await cb.enableCameraBackup(true)
  await cb.runCameraBackup()
  assert.strictEqual(store.getState().phase, 'waiting-charger')
  assert.deepStrictEqual(sent(), [])
  fake.native.charging = true
  await cb.runCameraBackup()
  assert.deepStrictEqual(sent(), [`${ROOT}/2026/09/c1.jpg`])
  assert.strictEqual(store.getState().phase, 'idle')
})

test('charging only: "send anyway" is for one run, and Wi-Fi is asked for first', async () => {
  await fresh({ chargingOnly: true })
  fake.assets = [asset('c1.jpg', now - 3 * H)]
  await cb.enableCameraBackup(true)
  fake.native.charging = false
  await cb.backupOverMobileData()
  assert.strictEqual(sent().length, 1, 'sent although unplugged')
  fake.assets.push(asset('c2.jpg', now - 60e3))
  await cb.runCameraBackup()
  assert.strictEqual(sent().length, 1, 'the next run waits for the charger again')
  assert.strictEqual(store.getState().phase, 'waiting-charger')
  fake.network = 'CELLULAR'
  await cb.runCameraBackup()
  assert.strictEqual(store.getState().phase, 'waiting-wifi', 'both conditions fail: Wi-Fi is the one reported')
})

test('charging only: a build that cannot tell never blocks the backup', async () => {
  await fresh({ chargingOnly: true })
  fake.assets = [asset('c1.jpg', now - 3 * H)]
  await cb.enableCameraBackup(true)
  fake.native.missing = true
  await cb.runCameraBackup()
  assert.strictEqual(sent().length, 1)
})

test('the journal summary adds up the camera and the albums', async () => {
  await fresh()
  fake.assets = [asset('c1.jpg', now - 4 * H), asset('s1.png', now - 3 * H, 'shots')]
  await cb.enableCameraBackup(true)
  await cb.addBackupAlbum(SHOTS, true)
  await cb.runCameraBackup()
  const summary = await cb.backupJournalSummary()
  assert.strictEqual(summary.rememberedSent, 2)
  assert.strictEqual(summary.failing, 0)
  assert.ok(summary.cursor > 0)
})

;(async () => {
  const entry = path.join(__dirname, '.out', 'entries', 'backup-albums.ts')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, "export * from '@/services/cameraBackup'\nexport { useCameraBackupStore } from '@/store/cameraBackupStore'\n")
  cb = require(await bundle(entry, STUBS, path.join(__dirname, '.out', 'backup-albums.js')))
  store = cb.useCameraBackupStore
  fake.connections.filebrowser = { url: 'https://files.example', username: 'mBootx' }
  fake.secrets.filebrowser_password = 'pw'

  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack.split('\n').slice(0, 7).join('\n     ') : err))
    }
  }
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'ALL ALBUM BACKUP TESTS PASSED')
  process.exit(failed ? 1 : 0)
})()
