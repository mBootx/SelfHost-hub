// The Diagnostic screen's logic: the activity record, the report and what it hides, the problem list, the backup's surroundings.
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
const LOG_KEY = 'diagnostics.log'
const NL = String.fromCharCode(10)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let m
async function load() {
  const entry = path.join(bundle.OUT, 'entries', 'diagnostics.ts')
  fs.writeFileSync(
    entry,
    ["export * from '@/services/diagnostics'", "export * from '@/services/diagnosticsReport'", "export { backupEnvironment } from '@/services/cameraBackup'"].join(NL) + NL
  )
  const out = path.join(bundle.OUT, 'diagnostics.js')
  await bundle(entry, STUBS, out)
  delete require.cache[require.resolve(out)]
  m = require(out)
}

const store = () => m.useDiagnosticsStore
const entries = () => store().getState().entries
const reset = () => {
  store().setState({ entries: [] })
  delete fake.prefs[LOG_KEY]
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ---- the record ----

test('events are kept in order, with their scope and level', () => {
  reset()
  m.logEvent('backup', 'one')
  m.logEvent('files', 'two', 'warn')
  assert.deepStrictEqual(entries().map((e) => [e.scope, e.level, e.message]), [['backup', 'info', 'one'], ['files', 'warn', 'two']])
  assert.ok(entries()[0].t <= entries()[1].t)
})

test('the record is cut to the 300 newest events, and a long message is shortened', () => {
  reset()
  for (let i = 0; i < 350; i++) m.logEvent('app', 'line ' + i)
  assert.strictEqual(entries().length, 300)
  assert.strictEqual(entries()[0].message, 'line 50')
  assert.strictEqual(entries()[299].message, 'line 349')
  m.logEvent('app', 'x'.repeat(5000))
  const last = entries()[entries().length - 1].message
  assert.ok(last.length <= 401 && last.endsWith('…'))
})

test('an error is saved at once, an ordinary line a moment later', async () => {
  reset()
  m.logEvent('backup', 'ordinary')
  await sleep(20)
  assert.strictEqual(fake.prefs[LOG_KEY], undefined, 'an ordinary line waits')
  m.logEvent('app', 'crash', 'error')
  await sleep(20)
  assert.deepStrictEqual(fake.prefs[LOG_KEY].map((e) => e.message), ['ordinary', 'crash'])
})

test('lines written one after another reach the storage together after the delay', async () => {
  reset()
  m.logEvent('backup', 'a')
  m.logEvent('backup', 'b')
  await sleep(2300)
  assert.deepStrictEqual(fake.prefs[LOG_KEY].map((e) => e.message), ['a', 'b'])
})

test('what another run saved is merged in time order, without doubles', async () => {
  reset()
  m.logEvent('backup', 'mine')
  const mine = entries()[0]
  fake.prefs[LOG_KEY] = [
    { t: mine.t - 5000, scope: 'backup', level: 'info', message: 'background earlier' },
    mine,
    { t: mine.t + 5000, scope: 'backup', level: 'info', message: 'background later' },
    'garbage',
    null
  ]
  await store().getState().load()
  assert.deepStrictEqual(entries().map((e) => e.message), ['background earlier', 'mine', 'background later'])
  await store().getState().load()
  assert.strictEqual(entries().length, 3, 'loading again adds nothing')
})

test('flushing writes at once and keeps the other run\'s lines', async () => {
  reset()
  fake.prefs[LOG_KEY] = [{ t: 1, scope: 'backup', level: 'info', message: 'from the app' }]
  m.logEvent('backup', 'from the background run')
  await m.flushDiagnostics()
  assert.deepStrictEqual(fake.prefs[LOG_KEY].map((e) => e.message), ['from the app', 'from the background run'])
})

test('clearing empties the record in memory and in storage', async () => {
  reset()
  m.logEvent('backup', 'x', 'error')
  await sleep(10)
  store().getState().clear()
  await sleep(10)
  assert.deepStrictEqual(entries(), [])
  assert.deepStrictEqual(fake.prefs[LOG_KEY], [])
  await store().getState().load()
  assert.deepStrictEqual(entries(), [], 'nothing comes back')
})

test('an uncaught error is written down and still handed to the previous handler', async () => {
  reset()
  const seen = []
  let installed = null
  globalThis.ErrorUtils = {
    getGlobalHandler: () => (error, fatal) => seen.push([error.message, fatal]),
    setGlobalHandler: (handler) => {
      installed = handler
    }
  }
  m.installErrorLogging()
  m.installErrorLogging() // the second call changes nothing
  assert.ok(installed)
  installed(new Error('boom'), true)
  assert.deepStrictEqual(seen, [['boom', true]])
  assert.strictEqual(entries().length, 1)
  assert.strictEqual(entries()[0].level, 'error')
  assert.ok(entries()[0].message.startsWith('Erreur fatale : boom'))
  await sleep(10)
  assert.strictEqual(fake.prefs[LOG_KEY].length, 1, 'saved before the app goes down')
  delete globalThis.ErrorUtils
})

// ---- the report and what it hides ----

const SECRETS = [
  { value: 'https://music.example.org', label: '[adresse]' },
  { value: 'music.example.org', label: '[hôte]' },
  { value: 'maxime', label: '[compte]' }
]

test('redact replaces names whatever their case and leaves the rest alone', () => {
  const text = 'Maxime sur MUSIC.EXAMPLE.ORG (https://music.example.org/rest) : maxime@music.example.org'
  assert.strictEqual(m.redact(text, SECRETS), '[compte] sur [hôte] ([adresse]/rest) : [compte]@[hôte]')
  assert.strictEqual(m.redact('rien à cacher', SECRETS), 'rien à cacher')
  assert.strictEqual(m.redact('texte', []), 'texte')
})

test('a short name is only replaced as a whole word', () => {
  const secrets = [{ value: 'al', label: '[compte]' }]
  assert.strictEqual(m.redact('al a envoyé 12 fichiers, normal, Al.', secrets), '[compte] a envoyé 12 fichiers, normal, [compte].')
  assert.strictEqual(m.redact('un seul caractère : x', [{ value: 'x', label: '[x]' }]), 'un seul caractère : x', 'one letter is never a secret')
})

test('a label that was put in is not read again as part of another secret', () => {
  const secrets = [
    { value: 'navidrome', label: '[compte Navidrome]' },
    { value: 'https://nas.local:4533', label: '[adresse Navidrome]' }
  ]
  const out = m.redact('Navidrome sur https://nas.local:4533', secrets)
  assert.strictEqual(out, '[compte Navidrome] sur [adresse Navidrome]')
})

test('special characters in a name are taken literally', () => {
  const secrets = [{ value: 'a.b+c(d)', label: '[nom]' }]
  assert.strictEqual(m.redact('x a.b+c(d) y aXb+c(d)', secrets), 'x [nom] y aXb+c(d)')
})

test('addresses left in the text are masked', () => {
  assert.strictEqual(m.maskAddresses('PC 192.168.1.20:8765 et 10.0.0.5, version 2.3.1, build 12'), 'PC [adresse IP] et [adresse IP], version 2.3.1, build 12')
})

test('host and port are taken from an address', () => {
  assert.strictEqual(m.hostOf('https://nas.local:4533/music/'), 'nas.local:4533')
  assert.strictEqual(m.hostName('https://nas.local:4533/music/'), 'nas.local')
  assert.strictEqual(m.hostOf('http://192.168.1.5'), '192.168.1.5')
  assert.strictEqual(m.hostName('nas.local'), 'nas.local')
  assert.strictEqual(m.hostName('http://[fe80::1]:8080/x'), '[fe80::1]')
})

const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime()
const at = (minutesAgo) => NOW - minutesAgo * 60_000

function snapshot(change = {}) {
  const base = {
    now: NOW,
    app: { version: '2.4.0', build: '24', device: 'Samsung SM-S918B Android 15', lock: true },
    servers: [
      { name: 'Navidrome', state: 'ok', status: 'connecté', account: 'maxime', host: 'music.example.org:4533', latencyMs: 85 },
      { name: 'FileBrowser', state: 'ok', status: 'connecté', account: 'maxime', host: 'files.example.org' },
      { name: 'Downtify', state: 'off', status: 'non configuré' }
    ],
    backup: {
      enabled: true,
      phase: 'idle',
      destination: '/backups/photos/maxime/AAAA/MM',
      pending: 0,
      uploaded: 1200,
      gaveUp: 0,
      lastSuccessAt: at(30),
      lastCheckAt: at(5),
      error: null,
      cursor: at(60),
      rememberedSent: 14,
      failing: 0,
      permission: 'accordé',
      network: 'Wi-Fi',
      charging: true,
      wifiOnly: true
    },
    remote: { enabled: true, status: 'connecté au PC', failed: false, paired: true, error: null },
    entries: [
      { t: at(20), scope: 'backup', level: 'info', message: 'Envoi de 3 fichiers' },
      { t: at(10), scope: 'connection', level: 'warn', message: 'Navidrome : timeout sur music.example.org' },
      { t: at(1), scope: 'app', level: 'info', message: 'Connecté au PC (192.168.1.20)' }
    ]
  }
  return { ...base, ...change }
}

test('the report lists every section and the log with the newest line last', () => {
  const report = m.buildReport(snapshot())
  for (const heading of ['SelfHost Hub — rapport de diagnostic', 'Application', 'Serveurs', 'Sauvegarde des photos', 'Contrôle à distance', 'Journal']) {
    assert.ok(report.includes(heading), heading)
  }
  assert.ok(report.includes('Version : 2.4.0 (build 24)'))
  assert.ok(report.includes('Navidrome : connecté — compte « maxime » — music.example.org:4533 — 85 ms'))
  assert.ok(report.includes('Downtify : non configuré'))
  assert.ok(report.includes('Destination : /backups/photos/maxime/AAAA/MM'))
  assert.ok(report.includes('en charge : oui'))
  const lines = report.split(NL)
  const first = lines.findIndex((l) => l.includes('Envoi de 3 fichiers'))
  const last = lines.findIndex((l) => l.includes('Connecté au PC'))
  assert.ok(first > 0 && last > first, 'oldest first, newest last')
  assert.ok(lines[lines.findIndex((l) => l.includes('Navidrome : timeout'))].startsWith('!  '), 'a warning is marked')
})

test('the report keeps only the last log lines asked for', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ t: at(200 - i), scope: 'app', level: 'info', message: 'event ' + i }))
  const report = m.buildReport(snapshot({ entries: many }), { logLines: 10 })
  assert.ok(report.includes('les 10 derniers événements'))
  assert.ok(report.includes('event 199') && !report.includes('event 189'))
  assert.ok(m.buildReport(snapshot({ entries: [] })).includes('(vide)'))
})

test('the copied report hides the servers, the accounts and any address', () => {
  const services = [
    { label: 'Navidrome', url: 'https://music.example.org:4533/', accounts: ['maxime'] },
    { label: 'FileBrowser', url: 'https://files.example.org', accounts: ['Maxime', null] },
    { label: 'Downtify', url: null, accounts: [] }
  ]
  const text = m.shareableReport(snapshot(), services)
  for (const leaked of ['music.example.org', 'files.example.org', 'maxime', 'Maxime', '192.168.1.20']) {
    assert.ok(!text.toLowerCase().includes(leaked.toLowerCase()), 'still shows ' + leaked)
  }
  assert.ok(text.includes('[hôte Navidrome]') && text.includes('[compte Navidrome]') && text.includes('[adresse IP]'))
  assert.ok(text.includes('Version : 2.4.0') && text.includes('Envoi de 3 fichiers'), 'the rest stays readable')
})

test('a backup that has not looked at anything yet is not reported as up to date to 1970', () => {
  const report = m.buildReport(snapshot({ backup: { ...snapshot().backup, cursor: 0 } }))
  assert.ok(!report.includes('1970') && report.includes('rien n’a encore été passé en revue'))
})

// ---- the problem list ----

const withBackup = (change) => snapshot({ backup: { ...snapshot().backup, ...change } })
const withServer = (index, change) => {
  const s = snapshot()
  s.servers[index] = { ...s.servers[index], ...change }
  return s
}

test('nothing is flagged when everything works', () => {
  assert.deepStrictEqual(m.findProblems(snapshot()), [])
  assert.deepStrictEqual(m.findProblems(withBackup({ enabled: false, phase: 'error', gaveUp: 9, permission: 'refusé' })), [], 'a backup that is off is not a problem')
})

test('a server that is down, or that fails its test, is flagged; one never set up is not', () => {
  assert.deepStrictEqual(m.findProblems(withServer(0, { state: 'down', status: 'déconnecté' })), ['Navidrome : déconnecté.'])
  assert.deepStrictEqual(m.findProblems(withServer(0, { state: 'down', status: 'erreur', detail: 'Identifiants invalides' })), ['Navidrome : Identifiants invalides.'])
  assert.ok(m.findProblems(withServer(1, { latencyMs: null, detail: 'le serveur ne répond pas' }))[0].startsWith('FileBrowser ne répond pas au test'))
  assert.deepStrictEqual(m.findProblems(withServer(1, { latencyMs: 40, detail: "la session n'est plus valide" })), ["FileBrowser : la session n'est plus valide."])
  assert.deepStrictEqual(m.findProblems(withServer(2, { state: 'off' })), [])
})

test('the backup problems are named', () => {
  assert.ok(m.findProblems(withBackup({ phase: 'no-permission', permission: 'refusé' })).some((p) => p.includes("n'a pas accès aux photos")))
  assert.ok(m.findProblems(withBackup({ permission: 'limité' })).some((p) => p.includes('limité')))
  assert.ok(m.findProblems(withBackup({ phase: 'no-server', error: 'timeout' })).some((p) => p.includes('ne joint pas FileBrowser (timeout)')))
  assert.ok(m.findProblems(withBackup({ phase: 'error', error: 'disque plein' })).some((p) => p.includes('interrompue : disque plein')))
  assert.ok(m.findProblems(withBackup({ gaveUp: 2 })).some((p) => p.startsWith('2 fichiers que le serveur refuse')))
  assert.ok(m.findProblems(withBackup({ gaveUp: 1 })).some((p) => p.startsWith('1 fichier que le serveur refuse')))
})

test('files waiting for days with nothing sent are flagged, a busy or fresh backup is not', () => {
  const stalled = withBackup({ pending: 40, lastSuccessAt: NOW - 4 * 24 * 3600_000 })
  assert.ok(m.findProblems(stalled).some((p) => p.includes('40 fichiers attendent depuis plus de 3 jours')))
  assert.deepStrictEqual(m.findProblems(withBackup({ pending: 40, lastSuccessAt: NOW - 3_600_000 })), [])
  assert.deepStrictEqual(m.findProblems(withBackup({ pending: 40, phase: 'running', lastSuccessAt: NOW - 4 * 24 * 3600_000 })), [])
})

test('a remote control that failed is flagged, one that is just not connected or turned off is not', () => {
  const remote = (change) => snapshot({ remote: { ...snapshot().remote, ...change } })
  assert.deepStrictEqual(m.findProblems(remote({ status: 'erreur', failed: true, error: 'code refusé' })), ['Contrôle à distance : code refusé.'])
  assert.deepStrictEqual(m.findProblems(remote({ status: 'non connecté' })), [])
  assert.deepStrictEqual(m.findProblems(remote({ enabled: false, status: 'désactivé', failed: true })), [])
})

test('a recent crash is flagged, an old one is not', () => {
  const recent = snapshot({ entries: [{ t: at(90), scope: 'app', level: 'error', message: 'Erreur fatale : x' }] })
  assert.ok(m.findProblems(recent).some((p) => p.startsWith('Un plantage a été enregistré il y a')))
  const old = snapshot({ entries: [{ t: NOW - 5 * 24 * 3600_000, scope: 'app', level: 'error', message: 'Erreur fatale : x' }] })
  assert.deepStrictEqual(m.findProblems(old), [])
  const other = snapshot({ entries: [{ t: at(5), scope: 'backup', level: 'error', message: 'Erreur inattendue' }] })
  assert.deepStrictEqual(m.findProblems(other), [], 'only crashes of the app itself')
})

// ---- words and times ----

test('times, delays and phases are worded for the screen', () => {
  assert.strictEqual(m.formatStamp(NOW - 1000, NOW), '11:59:59')
  assert.strictEqual(m.formatStamp(NOW - 86_400_000, NOW), '01/10 12:00')
  assert.strictEqual(m.ago(null, NOW), 'jamais')
  assert.strictEqual(m.ago(NOW - 20_000, NOW), "à l'instant")
  assert.strictEqual(m.ago(NOW - 5 * 60_000, NOW), 'il y a 5 min')
  assert.strictEqual(m.ago(NOW - 3 * 3600_000, NOW), 'il y a 3 h')
  assert.strictEqual(m.ago(NOW - 2 * 86_400_000, NOW), 'il y a 2 j')
  assert.strictEqual(m.describePhase('waiting-wifi'), 'attend le Wi-Fi')
  assert.strictEqual(m.describePhase('something-new'), 'something-new')
  assert.strictEqual(m.formatDateTime(new Date(2026, 0, 5, 9, 3, 7).getTime()), '05/01/2026 09:03:07')
})

// ---- the phone around the backup ----

test('the backup\'s surroundings are read from the phone, and a missing piece is "unknown", never an error', async () => {
  fake.permission = { granted: true, accessPrivileges: 'all' }
  fake.network = 'WIFI'
  fake.native.missing = false
  fake.native.charging = true
  assert.deepStrictEqual(await m.backupEnvironment(), { permission: 'accordé', network: 'Wi-Fi', charging: true })

  fake.permission = { granted: true, accessPrivileges: 'limited' }
  fake.network = 'CELLULAR'
  fake.native.charging = false
  assert.deepStrictEqual(await m.backupEnvironment(), { permission: 'limité', network: 'données mobiles', charging: false })

  fake.permission = { granted: false }
  fake.network = 'ETHERNET'
  assert.strictEqual((await m.backupEnvironment()).permission, 'refusé')
  assert.strictEqual((await m.backupEnvironment()).network, 'Ethernet')

  fake.network = 'NONE'
  assert.strictEqual((await m.backupEnvironment()).network, 'aucun')

  fake.native.missing = true // a build from before the native check
  assert.strictEqual((await m.backupEnvironment()).charging, null)
  fake.native.missing = false

  fake.permission = null // the platform call fails
  assert.strictEqual((await m.backupEnvironment()).permission, 'inconnu')
  fake.permission = { granted: true, accessPrivileges: 'all' }
  fake.network = 'WIFI'
})

;(async () => {
  await load()
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + NL + '     ' + (err && err.stack ? err.stack.split(NL).slice(0, 6).join(NL + '     ') : err))
    }
  }
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' diagnostics tests passed')
  process.exit(failed ? 1 : 0)
})()
