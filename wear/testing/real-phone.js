// Runs the phone app's real watch link (mobile/src/services/watchLink.ts) under Node, with the stores it reads stubbed,
// so that the watch's code can be tested against the code it will really talk to. Used by
// service/src/test/.../RealPhoneIntegrationTest.kt. Needs esbuild, which the repository's root install has.
//
//   node real-phone.js
//
// stdout, one JSON object per line:
//   {"ready":true}                                                       once the link listens
//   {"pushed":{"path":"/selfhost/link/snapshot","json":"..."}}           what the phone hands the data layer for the watch
//   {"local":{"action":"toggle","payload":{...}}}                        a command applied to the phone's own player
//   {"forwarded":{"target":"hub","action":"next","payload":{...}}}       a command sent on to a player through the hub link
//   {"queued":["playQueue",["al-77-1","al-77-2"],1]}                     something the phone started playing from its Navidrome
// stdin, one JSON object per line:
//   {"cmd":"message","path":"/selfhost/link/request","data":"{\"v\":1}"}  a message from the watch
//   {"cmd":"player","state":{...}}                                       sets fields of the phone's player store
//   {"cmd":"remote","state":{...}}                                       sets fields of the hub link store ("client":true gives it a client)
//   {"cmd":"stop"}
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.join(__dirname, '.out')
fs.mkdirSync(OUT, { recursive: true })

const emit = (object) => process.stdout.write(JSON.stringify(object) + String.fromCharCode(10))
globalThis.__phoneHarness = { emit, listeners: {} }

// The shared state of the phone app's test stubs (storage keeps its preferences there), and the phone's own player:
// what it is told to do is reported rather than done.
globalThis.__fake = { prefs: {}, connections: {}, secrets: {}, secure: {}, localCommands: { push: (command) => emit({ local: command }) } }

async function main() {
  const bundle = require(path.join(REPO, 'mobile', 'tests', 'lib', 'bundle.js'))
  const entry = path.join(OUT, 'entry.ts')
  fs.writeFileSync(
    entry,
    [
      "export * from '@/services/watchLink'",
      "export { useNavidromeStore } from '@/store/navidromeStore'",
      "export { useRemoteStore } from '@/store/remoteStore'",
      ''
    ].join(String.fromCharCode(10))
  )
  const outfile = await bundle(
    entry,
    {
      '../../modules/selfhost-native': '../../../wear/testing/stubs/native.js',
      zustand: '../../../wear/testing/stubs/zustand.js',
      '@/services/storage': 'storage.js',
      '@/store/navidromeStore': 'navidromeStore.js',
      '@/store/remoteStore': 'remoteStore.js'
    },
    path.join(OUT, 'watchlink.js')
  )
  const link = require(outfile)

  // The phone's Navidrome: an album is three songs named after it, and what is queued is reported.
  const songs = (id) => [1, 2, 3].map((n) => ({ id: id + '-' + n, title: 'Titre ' + n, artist: 'Artiste', albumId: id, duration: 200 }))
  link.useNavidromeStore.setState({
    client: {
      getAlbum: async (id) => ({ songs: songs(id) }),
      getPlaylist: async (id) => ({ songs: songs(id) }),
      getSong: async (id) => ({ id, title: 'Seul', artist: 'Artiste', duration: 200 })
    },
    queue: [],
    queueIndex: 0,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    shuffle: false,
    repeatMode: 'off',
    volume: 1,
    playQueue: (list, start) => emit({ queued: ['playQueue', list.map((s) => s.id), start] }),
    playNext: (song) => emit({ queued: ['playNext', song.id] }),
    addToQueue: (list) => emit({ queued: ['addToQueue', list.map((s) => s.id)] })
  })

  link.startWatchLink()
  emit({ ready: true })

  const lines = readline.createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.cmd === 'message') {
      globalThis.__phoneHarness.listeners.onWatchMessage({ nodeId: 'watch-1', path: message.path, data: message.data })
    } else if (message.cmd === 'player') {
      link.useNavidromeStore.setState(message.state)
    } else if (message.cmd === 'remote') {
      const state = { ...message.state }
      if (state.client === true) {
        state.client = { sendCommand: (target, action, payload) => emit({ forwarded: { target, action, payload } }) }
      }
      link.useRemoteStore.setState(state)
    } else if (message.cmd === 'stop') {
      process.exit(0)
    }
  })
  lines.on('close', () => process.exit(0))
}

main().catch((error) => {
  emit({ ready: false, error: String(error && error.stack ? error.stack : error) })
  process.exit(1)
})
