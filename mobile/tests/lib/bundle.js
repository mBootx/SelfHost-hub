// Bundles a module of the app with esbuild so it can run in plain Node, swapping chosen imports for stubs.
const fs = require('fs')
const path = require('path')

const MOBILE = path.resolve(__dirname, '..', '..')
const STUBS = path.resolve(__dirname, '..', 'stubs')
const OUT = path.resolve(__dirname, '..', '.out')

let esbuild
try {
  esbuild = require(path.resolve(MOBILE, '..', 'node_modules', 'esbuild'))
} catch {
  esbuild = require('esbuild')
}

// Entry files and bundles go here (git-ignored); created on first use.
fs.mkdirSync(path.join(OUT, 'entries'), { recursive: true })

function resolveTs(p) {
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (fs.existsSync(p + ext) && fs.statSync(p + ext).isFile()) return p + ext
  }
  throw new Error('cannot resolve ' + p)
}

/**
 * Bundles `entry` to CommonJS at `outfile`. `stubMap` maps an import specifier to a file in tests/stubs.
 * BACKUP_SRC, ENGINE_SRC point '@/services/cameraBackup' / '@/services/playbackEngine' at another file, which is how the
 * mutation checks swap in a broken copy.
 */
module.exports = async function bundle(entry, givenStubs, outfile) {
  // The phone-side module only exists in a built app, so every bundle gets the stand-in unless it brings its own.
  const stubMap = { '../../modules/selfhost-native': 'selfhost-native.js', ...givenStubs }
  fs.mkdirSync(path.dirname(outfile), { recursive: true })
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'error',
    jsx: 'automatic',
    nodePaths: [path.join(MOBILE, 'node_modules')],
    plugins: [
      {
        name: 'stubs',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (process.env.BACKUP_SRC && args.path === '@/services/cameraBackup') return { path: process.env.BACKUP_SRC }
            if (process.env.ENGINE_SRC && args.path === '@/services/playbackEngine') return { path: process.env.ENGINE_SRC }
            if (stubMap[args.path]) return { path: path.join(STUBS, stubMap[args.path]) }
            if (args.path.startsWith('@/')) return { path: resolveTs(path.join(MOBILE, 'src', args.path.slice(2))) }
            return undefined
          })
        }
      }
    ]
  })
  return outfile
}

module.exports.OUT = OUT
module.exports.MOBILE = MOBILE
