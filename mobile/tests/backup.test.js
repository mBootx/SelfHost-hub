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

const asset = (i, t, mediaType = 'image') => ({
  id: `content://media/external/images/media/${i}`,
  filename: `IMG_${i}.jpg`,
  mediaType,
  creationTime: t
})
const names = () => fake.uploads.map((u) => u.split('/').pop())
const journal = () => fake.prefs['cameraBackup.journal']

;(async () => {
  const entry = path.join(__dirname, '.out', 'entries', 'backup.ts')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(
    entry,
    "export * from '@/services/cameraBackup'\nexport { useCameraBackupStore } from '@/store/cameraBackupStore'\n"
  )
  const cb = require(await bundle(entry, STUBS, path.join(__dirname, '.out', 'backup.js')))
  const store = cb.useCameraBackupStore

  fake.connections.filebrowser = { url: 'https://files.example', username: 'mBootx' }
  fake.secrets.filebrowser_password = 'pw'

  // The background task exists as soon as the module loads.
  assert.ok(fake.tasks['selfhost-camera-backup'], 'task defined at import')

  // 1. Turning it on with the existing photos: all of them, newest first, in year/month folders.
  const a = [1, 2, 3, 4, 5].map((i) => asset(i, now - (6 - i) * D))
  fake.assets = [...a, { ...asset(99, now - 3 * D), mediaType: 'audio' }]
  await cb.enableCameraBackup(true)
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_5.jpg', 'IMG_4.jpg', 'IMG_3.jpg', 'IMG_2.jpg', 'IMG_1.jpg'])
  assert.ok(fake.uploads[0].startsWith('/backups/photos/mBootx/2026/09/'), fake.uploads[0])
  assert.deepStrictEqual(fake.folders.slice(0, 5), ['/backups', '/backups/photos', '/backups/photos/mBootx', '/backups/photos/mBootx/2026', '/backups/photos/mBootx/2026/09'])
  assert.ok(fake.registered.has('selfhost-camera-backup'), 'background task registered')
  assert.strictEqual(fake.registeredOptions.minimumInterval, 15)
  assert.strictEqual(journal().cursor, a[4].creationTime)
  assert.strictEqual(journal().uploadedTotal, 5)
  assert.deepStrictEqual(Object.keys(journal().recent).sort(), [a[3].id, a[4].id].sort(), 'older entries pruned')
  assert.strictEqual(store.getState().phase, 'idle')
  assert.strictEqual(store.getState().pending, 0)
  assert.strictEqual(fake.logins, 1, 'signed in from the saved credentials')
  console.log('ok 1 full first backup')

  // 2. Nothing new: nothing sent, and the look-back starts 24 h before the cursor.
  fake.uploads = []
  await cb.runCameraBackup()
  assert.strictEqual(fake.uploads.length, 0)
  assert.strictEqual(fake.lastQueryMin, a[4].creationTime - D)
  console.log('ok 2 idle run')

  // 3. A new photo.
  now += H
  fake.assets.push(asset(6, now - 10 * 60e3))
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_6.jpg'])
  console.log('ok 3 new photo')

  // 4. A late arrival, dated before the cursor but within the look-back (a long video).
  fake.uploads = []
  fake.assets.push(asset(7, now - 5 * H, 'video'))
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_7.jpg'])
  console.log('ok 4 late arrival')

  // 5. A file the server refuses: retried on the next runs, given up after 3 attempts, without holding back the rest.
  fake.uploads = []
  const a8 = asset(8, now - 2 * 60e3)
  const a9 = asset(9, now - 60e3)
  fake.assets.push(a8, a9)
  fake.uploadBehaviour['IMG_8.jpg'] = [413, 413, 413]
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_9.jpg'])
  assert.strictEqual(journal().failures[a8.id].attempts, 1)
  assert.strictEqual(journal().cursor, fake.assets.find((x) => x.filename === 'IMG_6.jpg').creationTime, 'cursor waits for the failed file')
  assert.match(store.getState().error, /IMG_8\.jpg : fichier trop volumineux/)
  assert.strictEqual(store.getState().phase, 'idle')
  assert.strictEqual(store.getState().pending, 1)
  await cb.runCameraBackup()
  assert.strictEqual(journal().failures[a8.id].attempts, 2)
  await cb.runCameraBackup()
  assert.strictEqual(journal().failures[a8.id].attempts, 3)
  assert.strictEqual(journal().cursor, a9.creationTime, 'cursor moves on once the file is given up')
  fake.uploads = []
  await cb.runCameraBackup()
  assert.strictEqual(fake.uploads.length, 0, 'given-up file not retried')
  console.log('ok 5 failing file')

  // 6. Server unreachable: the run stops at the first failure, nothing is lost, nothing is held against the file.
  fake.uploads = []
  now += H
  const a10 = asset(10, now - 3 * 60e3)
  const a11 = asset(11, now - 2 * 60e3)
  fake.assets.push(a10, a11)
  fake.serverDown = true
  fake.uploadBehaviour['IMG_11.jpg'] = ['network']
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), [])
  assert.strictEqual(store.getState().phase, 'error')
  assert.match(store.getState().error, /Failed to connect/)
  assert.ok(!journal().failures[a11.id] && !journal().failures[a10.id], 'a network error is not held against the file')
  fake.serverDown = false
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_11.jpg', 'IMG_10.jpg'])
  assert.strictEqual(store.getState().phase, 'idle')
  assert.strictEqual(store.getState().error, null)
  console.log('ok 6 server unreachable')

  // 7. Expired session: signs in again once and retries the file.
  fake.uploads = []
  const logins = fake.logins
  fake.assets.push(asset(12, now - 60e3))
  fake.uploadBehaviour['IMG_12.jpg'] = [401]
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_12.jpg'])
  assert.strictEqual(fake.logins, logins + 2, 'one sign-in for the run, one after the 401')
  console.log('ok 7 expired session')

  // 8. Wi-Fi only on mobile data: waits, sends nothing.
  fake.uploads = []
  fake.assets.push(asset(13, now - 30e3))
  fake.network = 'CELLULAR'
  await cb.runCameraBackup()
  assert.strictEqual(store.getState().phase, 'waiting-wifi')
  assert.strictEqual(fake.uploads.length, 0)
  await store.getState().saveSettings({ wifiOnly: false })
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_13.jpg'])
  fake.network = 'WIFI'
  await store.getState().saveSettings({ wifiOnly: true })
  console.log('ok 8 wifi only')

  // 9. A photo deleted between the listing and the upload: a file problem, the run goes on.
  fake.uploads = []
  const a14 = asset(14, now - 20e3)
  const a15 = asset(15, now - 10e3)
  fake.assets.push(a14, a15)
  fake.missingFiles.add(`file:///storage/emulated/0/DCIM/Camera/${a14.filename}`)
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_15.jpg'])
  assert.strictEqual(journal().failures[a14.id].attempts, 1)
  fake.missingFiles.clear()
  console.log('ok 9 missing file')

  // 10. Time budget: a background run stops starting uploads when its time is up; the next run continues.
  fake.uploads = []
  now += H
  const batch = [16, 17, 18, 19, 20].map((i, k) => asset(i, now - (5 - k) * 1000))
  fake.assets.push(...batch)
  fake.onUpload = () => {
    now += 60e3
  }
  await cb.runCameraBackup(150e3)
  assert.deepStrictEqual(names(), ['IMG_20.jpg', 'IMG_19.jpg', 'IMG_18.jpg'], 'newest first, stops after ~150 s')
  await fake.tasks['selfhost-camera-backup']().then((result) => assert.strictEqual(result, 1, 'background task reports success'))
  assert.deepStrictEqual(names(), ['IMG_20.jpg', 'IMG_19.jpg', 'IMG_18.jpg', 'IMG_17.jpg', 'IMG_16.jpg', 'IMG_14.jpg'])
  fake.onUpload = null
  console.log('ok 10 time budget')

  // 11. A background run joining a foreground one lowers its deadline.
  fake.uploads = []
  const more = [21, 22, 23, 24].map((i, k) => asset(i, now + k * 1000))
  now += 10e3
  fake.assets.push(...more)
  let joined = null
  fake.onUpload = (name) => {
    now += 60e3
    if (name === 'IMG_24.jpg') joined = cb.runCameraBackup(30e3)
  }
  const foreground = cb.runCameraBackup()
  await foreground
  assert.strictEqual(await joined, undefined)
  assert.deepStrictEqual(names(), ['IMG_24.jpg', 'IMG_23.jpg'], 'no upload starts after the joined background budget ran out')
  fake.onUpload = null
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_24.jpg', 'IMG_23.jpg', 'IMG_22.jpg', 'IMG_21.jpg'])
  console.log('ok 11 joined run deadline')

  // 12. Turning it off unregisters the task; runs do nothing.
  fake.uploads = []
  await cb.disableCameraBackup()
  assert.ok(!fake.registered.has('selfhost-camera-backup'))
  fake.assets.push(asset(25, now))
  await cb.runCameraBackup()
  assert.strictEqual(fake.uploads.length, 0)
  console.log('ok 12 disable')

  // 13. Turning it back on for new photos only: the existing ones stay out, the next ones go.
  now += H
  await cb.enableCameraBackup(false)
  await cb.runCameraBackup()
  assert.strictEqual(fake.uploads.length, 0, 'IMG_25 predates turning it on')
  now += 60e3
  fake.assets.push(asset(26, now - 1000))
  await cb.runCameraBackup()
  assert.deepStrictEqual(names(), ['IMG_26.jpg'])
  console.log('ok 13 only new photos')

  // 14. No permission: nothing happens, and the state says why.
  fake.permission = { granted: false, accessPrivileges: 'none' }
  await cb.runCameraBackup()
  assert.strictEqual(store.getState().phase, 'no-permission')
  fake.permission = { granted: true, accessPrivileges: 'limited' }
  await cb.runCameraBackup()
  assert.strictEqual(store.getState().limitedAccess, true)
  console.log('ok 14 permissions')

  // 15. No saved FileBrowser account: says so instead of failing.
  fake.permission = { granted: true, accessPrivileges: 'all' }
  delete fake.secrets.filebrowser_password
  fake.assets.push(asset(27, now))
  await cb.runCameraBackup()
  assert.strictEqual(store.getState().phase, 'no-server')
  console.log('ok 15 no account')

  // 16. Backups go into the folder of the account the server knows, however the name was typed.
  fake.secrets.filebrowser_password = 'pw'
  fake.accountName = 'mbootx'
  fake.uploads = []
  fake.folderExists = new Set()
  fake.assets.push(asset(28, now))
  await cb.runCameraBackup()
  assert.ok(fake.uploads.length > 0 && fake.uploads.every((u) => u.startsWith('/backups/photos/mbootx/')), fake.uploads.join(' '))
  console.log('ok 16 the account name comes from the server')

  // 17. A folder setting that tries to leave the account's area stops the run, sends nothing, loses nothing.
  await store.getState().saveSettings({ folder: '/backups/../elsewhere/{user}' })
  fake.uploads = []
  fake.assets.push(asset(29, now))
  await cb.runCameraBackup()
  assert.deepStrictEqual(fake.uploads, [])
  assert.strictEqual(store.getState().phase, 'error')
  assert.ok(/dossier de sauvegarde invalide/.test(store.getState().error || ''), store.getState().error)
  await store.getState().saveSettings({ folder: '/backups/photos/{user}' })
  await cb.runCameraBackup()
  assert.ok(fake.uploads.some((u) => u.endsWith('IMG_29.jpg')), 'the photo was not sent once the setting was fixed')
  console.log('ok 17 an invalid folder stops the run and loses nothing')

  console.log('ALL BACKUP TESTS PASSED')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
