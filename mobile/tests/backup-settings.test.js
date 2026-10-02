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
const KEY = 'cameraBackup.settings'

;(async () => {
  const entry = path.join(__dirname, '.out', 'entries', 'backup-settings.ts')
  fs.writeFileSync(entry, "export { useCameraBackupStore, DEFAULT_BACKUP_FOLDER } from '@/store/cameraBackupStore'" + String.fromCharCode(10))
  const out = await bundle(entry, STUBS, path.join(__dirname, '.out', 'backup-settings.js'))
  /** The app starting with these saved settings. */
  const launch = async (saved) => {
    if (saved === undefined) delete fake.prefs[KEY]
    else fake.prefs[KEY] = saved
    delete require.cache[require.resolve(out)]
    const mod = require(out)
    await mod.useCameraBackupStore.getState().load()
    return { settings: mod.useCameraBackupStore.getState().settings, mod }
  }

  let r = await launch(undefined)
  assert.strictEqual(r.settings.folder, '/backups/photos/{user}')
  assert.strictEqual(r.settings.legacyFolder, null)
  assert.strictEqual(r.settings.enabled, false)
  console.log('ok 1 a new install gets the per-account folder')

  r = await launch({ enabled: true, folder: '/Appareil photo', wifiOnly: false })
  assert.strictEqual(r.settings.folder, '/backups/photos/{user}')
  assert.strictEqual(r.settings.legacyFolder, '/Appareil photo')
  assert.strictEqual(r.settings.enabled, true)
  assert.strictEqual(r.settings.wifiOnly, false)
  assert.deepStrictEqual(fake.prefs[KEY], { enabled: true, folder: '/backups/photos/{user}', wifiOnly: false, legacyFolder: '/Appareil photo', chargingOnly: false, albums: [] })
  console.log('ok 2 an install on the old default moves over and remembers the old folder')

  const saved = fake.prefs[KEY]
  r = await launch({ ...saved })
  assert.deepStrictEqual(r.settings, saved)
  console.log('ok 3 starting again changes nothing')

  r = await launch({ enabled: true, folder: '/backups/photos/{user}', wifiOnly: true, legacyFolder: null })
  assert.strictEqual(r.settings.legacyFolder, null)
  console.log('ok 4 once the old folder is dealt with it is not offered again')

  r = await launch({ enabled: true, folder: '/MesPhotos', wifiOnly: true })
  assert.strictEqual(r.settings.folder, '/MesPhotos')
  assert.strictEqual(r.settings.legacyFolder, null)
  console.log('ok 5 a folder the user chose is left alone')

  console.log('ALL SETTINGS TESTS PASSED')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
