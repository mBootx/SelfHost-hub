// The config plugins that change the Android project: what they do to a manifest.
const assert = require('assert')
const path = require('path')

const allowCleartext = require(path.join(__dirname, '..', 'plugins', 'withCleartextTraffic')).allowCleartext

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('plain HTTP and WebSocket are allowed on the application, and nothing else is touched', () => {
  const manifest = { $: {}, application: [{ $: { 'android:name': '.MainApplication', 'android:label': 'x' }, activity: [] }] }
  const result = allowCleartext(manifest)
  assert.strictEqual(result.application[0].$['android:usesCleartextTraffic'], 'true')
  assert.strictEqual(result.application[0].$['android:name'], '.MainApplication')
  assert.deepStrictEqual(result.application[0].activity, [])
})

test('a manifest with no application tag is left alone', () => {
  assert.deepStrictEqual(allowCleartext({ $: {} }), { $: {} })
})

test('the plugin is registered in app.json, so a fresh prebuild keeps the flag', () => {
  const app = require(path.join(__dirname, '..', 'app.json'))
  assert.ok(app.expo.plugins.includes('./plugins/withCleartextTraffic'))
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log('ok   ' + name)
  } catch (err) {
    failed++
    console.log('FAIL ' + name + '\n     ' + String(err && err.stack ? err.stack : err).split('\n').slice(0, 5).join('\n     '))
  }
}
console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' plugin tests passed')
process.exit(failed ? 1 : 0)
