// Which file of a GitHub release the phone installs: its own APK, never the watch's.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')

const NL = String.fromCharCode(10)
const tests = []
const test = (name, fn) => tests.push([name, fn])
let m

const names = (list) => list.map((name) => ({ name }))

test('the phone APK named for the version is the one picked, wherever it stands in the list', () => {
  const assets = names(['SelfHost-Hub-Watch-2.5.0.apk', 'latest.yml', 'SelfHost-Hub-2.5.0.apk', 'SelfHost-Hub-Setup-2.5.0.exe'])
  assert.strictEqual(m.pickPhoneApk(assets, '2.5.0').name, 'SelfHost-Hub-2.5.0.apk')
})

test('an APK that is not the watch\'s is the fallback when the name is not the usual one', () => {
  assert.strictEqual(m.pickPhoneApk(names(['app-release.apk']), '2.5.0').name, 'app-release.apk')
  assert.strictEqual(m.pickPhoneApk(names(['SelfHost-Hub-Watch-2.5.0.apk', 'other.apk']), '2.5.0').name, 'other.apk')
})

test('a release with only the watch APK offers the phone nothing', () => {
  assert.strictEqual(m.pickPhoneApk(names(['SelfHost-Hub-Watch-2.5.0.apk']), '2.5.0'), undefined)
  assert.strictEqual(m.pickPhoneApk(names(['SelfHost-Hub-Wear-2.5.0.apk']), '2.5.0'), undefined)
  assert.strictEqual(m.pickPhoneApk(names(['latest.yml']), '2.5.0'), undefined)
  assert.strictEqual(m.pickPhoneApk([], '2.5.0'), undefined)
})

test('the watch APK is the one named for the version, and nothing else is taken for it', () => {
  const assets = names(['SelfHost-Hub-2.5.2.apk', 'SelfHost-Hub-Watch-2.5.1.apk', 'SelfHost-Hub-Watch-2.5.2.apk', 'latest.yml'])
  assert.strictEqual(m.pickWatchApk(assets, '2.5.2').name, 'SelfHost-Hub-Watch-2.5.2.apk')
  assert.strictEqual(m.pickWatchApk(names(['SelfHost-Hub-2.5.2.apk', 'other.apk']), '2.5.2'), undefined, 'a phone APK is never the one of the watch')
  assert.strictEqual(m.pickWatchApk(names(['SelfHost-Hub-Watch-2.5.1.apk']), '2.5.2'), undefined, 'nor another version')
  assert.strictEqual(m.pickWatchApk([], '2.5.2'), undefined)
})

test('the name a release gives the watch APK', () => {
  assert.strictEqual(m.watchApkName('2.5.2'), 'SelfHost-Hub-Watch-2.5.2.apk')
})

test('versions are compared part by part, and a leading v does not matter', () => {
  assert.strictEqual(m.isNewer('2.5.2', '2.5.0'), true)
  assert.strictEqual(m.isNewer('v2.5.2', '2.5.1'), true)
  assert.strictEqual(m.isNewer('2.10.0', '2.9.9'), true, 'ten is more than nine')
  assert.strictEqual(m.isNewer('2.5.0', '2.5.0'), false)
  assert.strictEqual(m.isNewer('2.4.9', '2.5.0'), false)
  assert.strictEqual(m.isNewer('3', '2.9.9'), true)
  assert.strictEqual(m.isNewer('2.5', '2.5.0'), false)
})

test('the name a release gives the phone APK', () => {
  assert.strictEqual(m.phoneApkName('2.5.0'), 'SelfHost-Hub-2.5.0.apk')
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'updateasset.ts')
  fs.writeFileSync(entry, "export * from '@/services/updateAsset'" + NL)
  m = require(await bundle(entry, {}, path.join(bundle.OUT, 'updateasset.js')))
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
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' update asset tests passed')
  process.exit(failed ? 1 : 0)
})()
