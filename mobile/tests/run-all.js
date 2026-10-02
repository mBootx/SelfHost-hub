// Runs every test file in its own Node process (they keep module-level state) and reports the result.
// Usage: node tests/run-all.js [filter]
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const NL = String.fromCharCode(10)
const filter = process.argv[2] || ''
const files = [
  ...fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort(),
  'vault/run.js'
].filter((f) => f.includes(filter))

let failed = 0
for (const file of files) {
  const started = Date.now()
  const run = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', timeout: 5 * 60 * 1000 })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const lines = (run.stdout || '').trim().split(NL)
  if (run.status === 0) {
    console.log('PASS ' + file + '  (' + seconds + ' s)  ' + (lines[lines.length - 1] || ''))
  } else {
    failed++
    console.log('FAIL ' + file + '  (' + seconds + ' s)')
    console.log((run.stdout || '').trim().split(NL).slice(-25).join(NL))
    console.log((run.stderr || '').trim().split(NL).slice(-25).join(NL))
  }
}
console.log(NL + (failed ? failed + ' of ' + files.length + ' test files failed' : 'all ' + files.length + ' test files passed'))
process.exit(failed ? 1 : 0)
