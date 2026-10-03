// Updating the watch app from the phone (services/watchUpdate*.ts, store/watchUpdateStore.ts): what the watch says about
// itself, the header the phone writes, what the screen is told, and the whole trip: find the APK, download it, check it,
// send it, follow what the watch says. Set WRITE_GOLDEN=1 to rewrite the sample file the watch's own tests read.
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const REPO = path.resolve(bundle.MOBILE, '..')
const RESOURCES = path.join(REPO, 'wear/core/src/test/resources')
const NL = String.fromCharCode(10)
const tests = []
const test = (name, fn) => tests.push([name, fn])
let m

function golden(file, text) {
  const target = path.join(RESOURCES, file)
  if (process.env.WRITE_GOLDEN && text !== undefined) fs.writeFileSync(target, text + NL)
  return fs.readFileSync(target, 'utf8').trim()
}

const SHA = 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const sha256Of = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const APK = Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) % 251)
const FOLDER = 'file:///cache/watch-updates'
const FILE_253 = FOLDER + '/SelfHost-Hub-Watch-2.5.3.apk'

// --- What the watch says ---

test('a version code is what the repository computes: major * 10000 + minor * 100 + patch', () => {
  assert.strictEqual(m.versionCodeOf('2.5.2'), 20502)
  assert.strictEqual(m.versionCodeOf('2.5.0'), 20500)
  assert.strictEqual(m.versionCodeOf('10.0.1'), 100001)
  for (const bad of ['2.5', '2.5.2.1', 'v2.5.2', '2.5.2-beta', 'x', '', '1.2.99999']) assert.strictEqual(m.versionCodeOf(bad), null, bad)
})

test('the version of the watch app is read out of its request (shared sample)', () => {
  assert.deepStrictEqual(m.parseWatchRequest(golden('watch-request.json')), { name: '2.5.2', code: 20502 })
})

test('an older watch app says no version, and nothing that is not one is taken for one', () => {
  assert.strictEqual(m.parseWatchRequest('{"v":1}'), null)
  const bad = [
    '',
    'garbage',
    '[]',
    'null',
    '{"v":1,"app":null}',
    '{"v":1,"app":"2.5.2"}',
    '{"v":1,"app":{"name":"2.5.2"}}',
    '{"v":1,"app":{"code":20502}}',
    '{"v":1,"app":{"name":"two","code":20502}}',
    '{"v":1,"app":{"name":"2.5.2","code":"20502"}}',
    '{"v":1,"app":{"name":"2.5.2","code":20502.5}}',
    '{"v":1,"app":{"name":"2.5.2","code":0}}',
    '{"v":1,"app":{"name":"2.5.2","code":3000000000}}',
    '{"v":1,"app":{"name":"2.5.2","code":20502},"pad":"' + 'x'.repeat(5000) + '"}'
  ]
  for (const text of bad) assert.strictEqual(m.parseWatchRequest(text), null, text.slice(0, 60))
  assert.strictEqual(m.parseWatchRequest(undefined), null)
})

test('the statuses the watch writes are read (shared sample)', () => {
  const samples = JSON.parse(golden('watch-update-statuses.json'))
  assert.deepStrictEqual(Object.keys(samples), ['received', 'confirm', 'installed', 'version', 'refusedNotAllowed', 'failed'])
  assert.deepStrictEqual(m.parseUpdateStatus(JSON.stringify(samples.received)), { state: 'received', versionName: '2.5.2', versionCode: 20502 })
  assert.deepStrictEqual(m.parseUpdateStatus(JSON.stringify(samples.confirm)), { state: 'confirm', message: 'Confirmez la mise à jour sur la montre' })
  assert.deepStrictEqual(m.parseUpdateStatus(JSON.stringify(samples.installed)), { state: 'installed', versionName: '2.5.2', versionCode: 20502 })
  assert.deepStrictEqual(m.parseUpdateStatus(JSON.stringify(samples.version)), { state: 'version', versionName: '2.5.2', versionCode: 20502 })
  const refused = m.parseUpdateStatus(JSON.stringify(samples.refusedNotAllowed))
  assert.strictEqual(refused.state, 'refused')
  assert.strictEqual(refused.reason, 'not-allowed')
  assert.strictEqual(refused.versionCode, 20502)
  assert.ok(refused.message.length > 10)
  assert.strictEqual(m.parseUpdateStatus(JSON.stringify(samples.failed)).message, 'Fichier endommagé pendant le transfert')
})

test('a status that is not one is dropped, and what is odd inside a good one is left out', () => {
  const bad = ['', 'garbage', '[]', 'null', '{"v":2,"state":"received"}', '{"v":1}', '{"v":1,"state":"exploded"}', '{"v":1,"state":"received","pad":"' + 'x'.repeat(5000) + '"}']
  for (const text of bad) assert.strictEqual(m.parseUpdateStatus(text), null, text.slice(0, 60))
  assert.strictEqual(m.parseUpdateStatus(undefined), null)
  const odd = m.parseUpdateStatus('{"v":1,"state":"refused","versionName":"nope","versionCode":"x","reason":"because","message":"' + 'y'.repeat(500) + '"}')
  assert.deepStrictEqual({ ...odd, message: odd.message.length }, { state: 'refused', message: 300 })
})

// --- What the phone says ---

test('the header equals the sample file the watch reads, byte for byte', () => {
  const header = m.buildUpdateHeader({ versionName: '2.5.2', versionCode: 20502, size: 3562118, sha256: SHA })
  assert.strictEqual(header, golden('phone-update-header.json', header))
  assert.strictEqual(JSON.parse(m.buildUpdateHeader({ versionName: '2.5.2', versionCode: 20502, size: 1, sha256: SHA, reinstall: true })).reinstall, true)
  assert.ok(!header.includes(NL), 'a single line: the watch reads up to the first line break')
})

// --- What the screen says ---

test('the screen says which version the watch has, and offers what can be done', () => {
  const watch = (version) => ({ version, code: m.versionCodeOf(version) })
  const latest = { version: '2.5.3' }
  assert.deepStrictEqual(
    { ...m.describeWatchApp(null, latest), text: '' },
    { text: '', canUpdate: false, canReinstall: false, tooOld: false }
  )
  const old = m.describeWatchApp(watch('2.5.0'), latest)
  assert.strictEqual(old.tooOld, true)
  assert.strictEqual(old.canUpdate, false)
  assert.ok(old.text.includes('adb') && old.text.includes('2.5.3'))
  const behind = m.describeWatchApp(watch('2.5.2'), latest)
  assert.strictEqual(behind.canUpdate, true)
  assert.ok(behind.text.includes('2.5.3'))
  const current = m.describeWatchApp(watch('2.5.3'), latest)
  assert.deepStrictEqual({ canUpdate: current.canUpdate, canReinstall: current.canReinstall }, { canUpdate: false, canReinstall: true })
  assert.ok(current.text.includes('à jour'))
  const ahead = m.describeWatchApp(watch('2.6.0'), latest)
  assert.deepStrictEqual({ canUpdate: ahead.canUpdate, canReinstall: ahead.canReinstall }, { canUpdate: false, canReinstall: false })
  const unknownLatest = m.describeWatchApp(watch('2.5.2'), null)
  assert.deepStrictEqual({ canUpdate: unknownLatest.canUpdate, canReinstall: unknownLatest.canReinstall }, { canUpdate: false, canReinstall: false })
})

test('a refusal is explained in the person\'s terms, and a missing permission says how to give it', () => {
  assert.ok(m.describeRefusal('not-allowed', undefined).includes('REQUEST_INSTALL_PACKAGES'))
  assert.ok(m.describeRefusal('up-to-date', undefined).includes('déjà'))
  assert.ok(m.describeRefusal('no-space', undefined).includes('place'))
  assert.ok(m.describeRefusal('busy', undefined).includes('en cours'))
  assert.strictEqual(m.describeRefusal('bad-header', 'en-tête illisible'), 'en-tête illisible')
  assert.ok(m.describeRefusal(undefined, undefined).length > 5)
})

test('the screen says how far an update is, in words', () => {
  assert.strictEqual(m.describePhase('idle', 0), null)
  assert.strictEqual(m.describePhase('done', 1), null)
  assert.strictEqual(m.describePhase('error', 0.3), null)
  assert.strictEqual(m.describePhase('downloading', 0.456), 'Téléchargement de la mise à jour… 46 %')
  assert.strictEqual(m.describePhase('sending', 1), 'Envoi à la montre… 100 %')
  assert.ok(m.describePhase('installing', 1).includes('installe'))
  assert.ok(m.describePhase('confirm', 1).includes('confirmation'))
  assert.ok(m.describePhase('checking', 0).length > 3)
})

// --- The store follows the watch ---

const store = () => m.useWatchUpdate

function freshStore(over = {}) {
  store().setState({ watch: null, latest: null, checkedAt: 0, phase: 'idle', progress: 0, message: null, ...over })
}

test('the watch that spoke last is the one that is known, and saying the same again changes nothing', () => {
  freshStore()
  store().getState().noteWatch('w1', { name: '2.5.2', code: 20502 })
  assert.deepStrictEqual(store().getState().watch, { nodeId: 'w1', version: '2.5.2', code: 20502 })
  const before = store().getState().watch
  store().getState().noteWatch('w1', { name: '2.5.2', code: 20502 })
  assert.strictEqual(store().getState().watch, before, 'the same object: nobody is told to redraw')
  store().getState().noteWatch('w2', { name: '2.5.3', code: 20503 })
  assert.deepStrictEqual(store().getState().watch, { nodeId: 'w2', version: '2.5.3', code: 20503 })
})

test('an answer about the version sets it, whatever the phase', () => {
  freshStore({ phase: 'downloading' })
  store().getState().applyStatus('w1', { state: 'version', versionName: '2.5.2', versionCode: 20502 })
  assert.deepStrictEqual(store().getState().watch, { nodeId: 'w1', version: '2.5.2', code: 20502 })
  assert.strictEqual(store().getState().phase, 'downloading')
})

test('what the watch says moves an update along', () => {
  freshStore({ phase: 'sending', progress: 0.5 })
  const say = (status) => store().getState().applyStatus('w1', status)
  say({ state: 'received', versionName: '2.5.3', versionCode: 20503 })
  assert.strictEqual(store().getState().phase, 'installing')
  say({ state: 'confirm', message: 'Confirmez' })
  assert.strictEqual(store().getState().phase, 'confirm')
  assert.ok(store().getState().message.includes('Confirmez'))
  say({ state: 'installed', versionName: '2.5.3', versionCode: 20503 })
  assert.strictEqual(store().getState().phase, 'done')
  assert.ok(store().getState().message.includes('2.5.3'))
  assert.deepStrictEqual(store().getState().watch, { nodeId: 'w1', version: '2.5.3', code: 20503 })
})

test('a refusal or a failure ends it with a sentence', () => {
  freshStore({ phase: 'sending' })
  store().getState().applyStatus('w1', { state: 'refused', reason: 'no-space', message: 'x' })
  assert.strictEqual(store().getState().phase, 'error')
  assert.ok(store().getState().message.includes('place'))
  freshStore({ phase: 'installing' })
  store().getState().applyStatus('w1', { state: 'failed', message: 'Fichier endommagé' })
  assert.strictEqual(store().getState().phase, 'error')
  assert.strictEqual(store().getState().message, 'Fichier endommagé')
})

test('what the watch says when no update is under way is no news (but the version is kept)', () => {
  for (const phase of ['idle', 'downloading', 'error', 'done']) {
    freshStore({ phase, message: null })
    const say = (status) => store().getState().applyStatus('w1', status)
    say({ state: 'received' })
    say({ state: 'confirm' })
    say({ state: 'refused', reason: 'busy' })
    say({ state: 'failed', message: 'x' })
    say({ state: 'installed', versionName: '2.5.4', versionCode: 20504 })
    assert.strictEqual(store().getState().phase, phase, phase)
    assert.strictEqual(store().getState().message, null, phase)
    assert.strictEqual(store().getState().watch.version, '2.5.4', 'a watch updated some other way is still the version it says')
  }
})

// --- The trip ---

function release(over = {}) {
  const digest = 'sha256:' + sha256Of(APK)
  return {
    tag_name: 'v2.5.3',
    assets: [
      { name: 'SelfHost-Hub-Setup-2.5.3.exe', browser_download_url: 'https://example.org/setup.exe', size: 99 },
      { name: 'SelfHost-Hub-2.5.3.apk', browser_download_url: 'https://example.org/phone.apk', size: 98 },
      { name: 'SelfHost-Hub-Watch-2.5.3.apk', browser_download_url: 'https://example.org/watch.apk', size: APK.length, digest }
    ],
    ...over
  }
}

let fetched
let nextRelease
let nextStatus

async function fresh() {
  fake.native = fake.native || {}
  Object.assign(fake.native, { missing: false, updates: [], updateHook: null, updateError: null, pushed: [], pushCount: 1, pushError: null, shareListeners: [] })
  fake.files = {}
  fake.dirs = {}
  fake.sizes = {}
  fake.fileBytes = {}
  fake.networkTasks = []
  fake.downloadBytes = APK
  fake.downloadError = null
  fake.downloadReturnsNull = false
  fetched = []
  nextRelease = release()
  nextStatus = 200
  globalThis.fetch = async (url) => {
    fetched.push(String(url))
    return { ok: nextStatus === 200, status: nextStatus, json: async () => nextRelease }
  }
  freshStore({ watch: { nodeId: 'w1', version: '2.5.2', code: 20502 } })
  m.useDiagnosticsStore.setState({ entries: [] })
}

const sent = () => fake.native.updates

test('the watch APK of the latest release is found, named for its version, with the digest GitHub gives', async () => {
  await fresh()
  const found = await m.findWatchRelease()
  assert.deepStrictEqual(found, { version: '2.5.3', code: 20503, url: 'https://example.org/watch.apk', size: APK.length, digest: sha256Of(APK) })
  assert.ok(fetched[0].includes('api.github.com/repos/mBootx/SelfHost-hub/releases/latest'))
})

test('a release with no watch APK, or a digest that is not a SHA-256, or a GitHub that says no', async () => {
  await fresh()
  nextRelease = release({ assets: [{ name: 'SelfHost-Hub-2.5.3.apk', browser_download_url: 'x', size: 5 }] })
  assert.strictEqual(await m.findWatchRelease(), null)
  nextRelease = release({ assets: [{ name: 'SelfHost-Hub-Watch-2.5.2.apk', browser_download_url: 'x', size: 5 }] })
  assert.strictEqual(await m.findWatchRelease(), null, 'named for another version than the tag')
  nextRelease = release({ assets: [{ name: 'SelfHost-Hub-Watch-2.5.3.apk', browser_download_url: 'x', size: 5, digest: 'md5:abc' }] })
  assert.strictEqual((await m.findWatchRelease()).digest, null)
  nextRelease = release({ tag_name: 'nightly' })
  assert.strictEqual(await m.findWatchRelease(), null)
  nextStatus = 403
  await assert.rejects(() => m.findWatchRelease(), /403/)
})

test('looking for an update says whether the watch is behind, and does not ask GitHub again within the hour', async () => {
  await fresh()
  assert.strictEqual(await m.checkWatchUpdate(), 'available')
  assert.strictEqual(store().getState().latest.version, '2.5.3')
  assert.strictEqual(await m.checkWatchUpdate(), 'skipped')
  assert.strictEqual(fetched.length, 1)
  assert.strictEqual(await m.checkWatchUpdate(true), 'available', 'asked for by hand')
  assert.strictEqual(fetched.length, 2)
})

test('the other answers of the check', async () => {
  await fresh()
  freshStore({ watch: { nodeId: 'w1', version: '2.5.3', code: 20503 } })
  assert.strictEqual(await m.checkWatchUpdate(true), 'current')
  freshStore({ watch: null })
  assert.strictEqual(await m.checkWatchUpdate(true), 'unknown')
  nextStatus = 500
  freshStore({ watch: { nodeId: 'w1', version: '2.5.2', code: 20502 } })
  assert.strictEqual(await m.checkWatchUpdate(true), 'error')
  assert.ok(m.useDiagnosticsStore.getState().entries.some((e) => e.level === 'warn'))
  freshStore({ phase: 'sending' })
  assert.strictEqual(await m.checkWatchUpdate(true), 'skipped', 'not in the middle of an update')
})

test('asking the watch for its version sends the question, and never throws', async () => {
  await fresh()
  await m.askWatchVersion()
  assert.deepStrictEqual(fake.native.pushed, [{ path: '/selfhost/update/ask', json: '{"v":1}' }])
  fake.native.pushError = 'no data layer'
  await m.askWatchVersion()
  fake.native.missing = true
  await m.askWatchVersion()
})

test('an update is downloaded, checked and sent, with the header the watch needs', async () => {
  await fresh()
  await m.updateWatch()
  assert.strictEqual(fake.networkTasks.length, 1)
  assert.strictEqual(fake.networkTasks[0].url, 'https://example.org/watch.apk')
  assert.strictEqual(sent().length, 1)
  const [handed] = sent()
  assert.strictEqual(handed.nodeId, 'w1')
  assert.strictEqual(handed.fileUri, FILE_253)
  assert.deepStrictEqual(JSON.parse(handed.header), { v: 1, versionName: '2.5.3', versionCode: 20503, size: APK.length, sha256: sha256Of(APK), reinstall: false })
  assert.ok(!handed.header.includes(NL))
  assert.strictEqual(store().getState().phase, 'installing', 'handed over: the watch says the rest')
  assert.deepStrictEqual(Object.keys(fake.files), [FILE_253], 'one file kept, no .part left')
})

test('what the watch says afterwards finishes the job', async () => {
  await fresh()
  await m.updateWatch()
  store().getState().applyStatus('w1', { state: 'received', versionName: '2.5.3', versionCode: 20503 })
  store().getState().applyStatus('w1', { state: 'installed', versionName: '2.5.3', versionCode: 20503 })
  assert.strictEqual(store().getState().phase, 'done')
  assert.strictEqual(store().getState().watch.version, '2.5.3')
})

test('progress of the transfer follows what the native side reports, and the listener is let go', async () => {
  await fresh()
  const seen = []
  fake.native.updateHook = async () => {
    const listener = fake.native.shareListeners.find(([event]) => event === 'onWatchUpdateProgress')[1]
    for (const sentBytes of [1000, 2500, 5000]) {
      listener({ sent: sentBytes, total: 5000 })
      seen.push(store().getState().progress)
    }
  }
  await m.updateWatch()
  assert.deepStrictEqual(seen, [0.2, 0.5, 1])
  assert.strictEqual(fake.native.shareListeners.filter(([event]) => event === 'onWatchUpdateProgress').length, 0)
})

test('a complete copy in the cache is not downloaded again', async () => {
  await fresh()
  await m.updateWatch()
  freshStore({ watch: { nodeId: 'w1', version: '2.5.2', code: 20502 }, phase: 'idle' })
  await m.updateWatch()
  assert.strictEqual(fake.networkTasks.length, 1)
  assert.strictEqual(sent().length, 2)
})

test('an older or unfinished copy is cleared out before a download', async () => {
  await fresh()
  fake.dirs[FOLDER] = true
  fake.files[FOLDER + '/SelfHost-Hub-Watch-2.5.1.apk'] = ''
  fake.files[FOLDER + '/SelfHost-Hub-Watch-2.5.3.apk.part'] = ''
  await m.updateWatch()
  assert.deepStrictEqual(Object.keys(fake.files), [FILE_253])
})

test('a file that does not match what GitHub gives is not sent', async () => {
  await fresh()
  fake.downloadBytes = Uint8Array.from(APK, (b, i) => (i === 100 ? b ^ 1 : b))
  await m.updateWatch()
  assert.strictEqual(sent().length, 0)
  assert.strictEqual(store().getState().phase, 'error')
  assert.ok(store().getState().message.includes('corrompu'))
  assert.deepStrictEqual(Object.keys(fake.files), [], 'and it is not kept')
})

test('a download that stops short, fails, or returns nothing is not sent', async () => {
  await fresh()
  fake.downloadBytes = APK.slice(0, 4000)
  await m.updateWatch()
  assert.strictEqual(store().getState().phase, 'error')
  assert.ok(store().getState().message.includes('incomplet'))

  await fresh()
  fake.downloadError = 'réseau coupé'
  await m.updateWatch()
  assert.strictEqual(store().getState().message, 'réseau coupé')

  await fresh()
  fake.downloadReturnsNull = true
  await m.updateWatch()
  assert.ok(store().getState().message.includes('interrompu'))
  assert.strictEqual(sent().length, 0)
})

test('a release without a digest is still sent, on the strength of its size', async () => {
  await fresh()
  nextRelease = release({ assets: [{ name: 'SelfHost-Hub-Watch-2.5.3.apk', browser_download_url: 'https://example.org/watch.apk', size: APK.length }] })
  await m.updateWatch()
  assert.strictEqual(sent().length, 1)
})

test('a watch that refuses says why a moment after the channel broke, and the reason wins over "the channel closed"', async () => {
  await fresh()
  // The channel breaks under the phone at once; the watch's message about it comes a moment later.
  fake.native.updateHook = async () => {
    setTimeout(() => store().getState().applyStatus('w1', { state: 'refused', reason: 'not-allowed', message: 'x' }), 300)
  }
  fake.native.updateError = 'La montre a interrompu le transfert'
  await m.updateWatch()
  assert.strictEqual(store().getState().phase, 'error')
  assert.ok(store().getState().message.includes('REQUEST_INSTALL_PACKAGES'))
})

test('a transfer that fails with nobody saying why shows the failure itself', async () => {
  await fresh()
  fake.native.updateError = 'La montre n\'a pas répondu'
  await m.updateWatch()
  assert.strictEqual(store().getState().phase, 'error')
  assert.strictEqual(store().getState().message, 'La montre n\'a pas répondu')
})

test('an update is not started where it cannot go', async () => {
  await fresh()
  fake.native.missing = true
  await m.updateWatch()
  assert.strictEqual(store().getState().phase, 'error')
  assert.ok(store().getState().message.includes('ne sait pas envoyer'))
  assert.strictEqual(fake.networkTasks.length, 0)

  await fresh()
  freshStore({ watch: null })
  await m.updateWatch()
  assert.ok(store().getState().message.includes('ouvrez SelfHost Hub sur la montre'))

  await fresh()
  freshStore({ watch: { nodeId: 'w1', version: '2.5.0', code: 20500 } })
  await m.updateWatch()
  assert.ok(store().getState().message.includes('adb'))
  assert.strictEqual(fake.networkTasks.length, 0)

  await fresh()
  nextRelease = release({ assets: [] })
  await m.updateWatch()
  assert.ok(store().getState().message.includes("pas d'application pour montre"))
})

test('a watch that is up to date is told so, and not sent the same file, unless a reinstall was asked for', async () => {
  await fresh()
  freshStore({ watch: { nodeId: 'w1', version: '2.5.3', code: 20503 } })
  await m.updateWatch()
  assert.strictEqual(sent().length, 0)
  assert.strictEqual(store().getState().phase, 'idle')
  assert.strictEqual(store().getState().message, 'La montre est déjà à jour.')

  await m.updateWatch({ reinstall: true })
  assert.strictEqual(sent().length, 1)
  assert.strictEqual(JSON.parse(sent()[0].header).reinstall, true)
  assert.strictEqual(JSON.parse(sent()[0].header).versionCode, 20503)
})

test('an older release is never sent to a newer watch, reinstall or not', async () => {
  await fresh()
  freshStore({ watch: { nodeId: 'w1', version: '2.6.0', code: 20600 } })
  await m.updateWatch({ reinstall: true })
  assert.strictEqual(sent().length, 0)
  assert.strictEqual(store().getState().message, 'La montre est déjà à jour.')
})

test('pressing the button twice does not send twice', async () => {
  await fresh()
  const gates = []
  fake.native.updateHook = () => new Promise((resolve) => gates.push(resolve))
  const first = m.updateWatch()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.strictEqual(store().getState().phase, 'sending')
  const second = m.updateWatch()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.strictEqual(sent().length, 1, 'the second press was turned away')
  for (const open of gates) open()
  await Promise.all([first, second])
})

test('the message about an update can be closed', async () => {
  await fresh()
  freshStore({ phase: 'error', message: 'x', progress: 0.4 })
  m.dismissWatchUpdate()
  assert.deepStrictEqual({ phase: store().getState().phase, message: store().getState().message, progress: store().getState().progress }, { phase: 'idle', message: null, progress: 0 })
})

let finished = false
process.on('exit', () => {
  // A promise that never settles ends the process quietly with status 0: that must not pass for a success.
  if (!finished) {
    console.log('FAIL the run ended before every test had finished')
    process.exitCode = 1
  }
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'watchupdate.ts')
  fs.writeFileSync(
    entry,
    [
      "export * from '@/services/watchUpdateProtocol'",
      "export * from '@/services/watchUpdate'",
      "export { useWatchUpdate } from '@/store/watchUpdateStore'",
      "export { useDiagnosticsStore } from '@/services/diagnostics'",
      ''
    ].join(NL)
  )
  m = require(await bundle(entry, { '@/services/storage': 'storage.js', 'expo-file-system': 'expo-file-system.js' }, path.join(bundle.OUT, 'watchupdate.js')))
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + NL + '     ' + String(err && err.stack ? err.stack : err).split(NL).slice(0, 8).join(NL + '     '))
    }
  }
  finished = true
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' watch update tests passed')
  process.exit(failed ? 1 : 0)
})()
