// Bundles the photo vault and gallery helpers and runs every t-*.js file here against them.
// VAULT_SRC points at another copy of photoVault.ts, which is how the mutation checks swap in a broken one.
const fs = require('fs')
const path = require('path')
const bundle = require('../lib/bundle')

const SRC = path.join(bundle.MOBILE, 'src', 'services')
const NL = String.fromCharCode(10)

;(async () => {
  const source = (process.env.VAULT_SRC || path.join(SRC, 'photoVault')).split(String.fromCharCode(92)).join('/')
  const layout = path.join(SRC, 'photoLayout').split(String.fromCharCode(92)).join('/')
  const entry = path.join(bundle.OUT, 'entries', 'vault.ts')
  fs.writeFileSync(entry, "export * from '" + source + "'" + NL + "export * from '" + layout + "'" + NL)
  const out = await bundle(entry, {}, path.join(bundle.OUT, 'vault.js'))
  const vault = require(out)
  let failed = 0
  let passed = 0
  const test = async (name, fn) => {
    try {
      await fn()
      passed++
    } catch (err) {
      failed++
      console.log('FAIL: ' + name + NL + '      ' + (err && err.message ? err.message.split(NL).join(NL + '      ') : err))
    }
  }
  for (const file of fs.readdirSync(__dirname).filter((f) => f.startsWith('t-') && f.endsWith('.js')).sort()) {
    await require('./' + file)(vault, test)
  }
  console.log((failed ? failed + ' FAILED, ' : 'all passed: ') + passed + ' passed')
  process.exitCode = failed ? 1 : 0
})().catch((e) => {
  console.error(e)
  process.exit(2)
})
