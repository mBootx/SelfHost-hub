// Shared state for every stub, kept on globalThis so it survives re-loading a bundle (a simulated app restart).
const fake = (globalThis.__fake = globalThis.__fake || {
  prefs: {},
  connections: {},
  secrets: {},
  secure: {},
  files: {},
  dirs: {},
  sizes: {},
  networkTasks: [],
  serverFiles: {},
  xhrLog: [],
  xhrReplies: [],
  appStateListeners: [],
  network: 'WIFI',
  permission: { granted: true, accessPrivileges: 'all' },
  assets: [],
  missingFiles: new Set(),
  tasks: {},
  registered: new Set(),
  uploads: [],
  folders: [],
  uploadBehaviour: {},
  logins: 0,
  fingerprint: { types: [1], level: 3, succeed: true },
  vibrations: 0
})
module.exports = fake
