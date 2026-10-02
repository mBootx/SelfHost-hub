const fake = require('./fake')

class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

// A FileBrowser with memory: fake.serverFiles maps a folder to { name: size }. A file is only replaced
// when asked to; otherwise a name that is taken answers 409, as the real server does.
class FileBrowserClient {
  constructor(config) {
    this.config = config
  }
  getAccountName() {
    return fake.accountName || this.config.username
  }
  async isReachable() {
    return !fake.serverDown
  }
  async login() {
    fake.logins++
    if (fake.loginFails) throw new ApiError('Identifiants invalides', 401)
  }
  async createFolder(path) {
    fake.folders.push(path)
    if (fake.folderExists && fake.folderExists.has(path)) throw new ApiError('exists', 409)
    ;(fake.folderExists = fake.folderExists || new Set()).add(path)
  }
  async list(path) {
    fake.listCalls = (fake.listCalls || 0) + 1
    if (fake.listFailure) throw new ApiError('list failed', fake.listFailure)
    const folder = fake.serverFiles[path]
    if (!folder) throw new ApiError('not found', 404)
    return Object.entries(folder).map(([name, size]) => ({ name, path: path + '/' + name, size, isDir: false, modified: '' }))
  }
  async uploadLocalFile(uri, dir, name, onProgress, options = {}) {
    ;(fake.attempts = fake.attempts || []).push(name)
    if (fake.beforeUpload) fake.beforeUpload(name, dir)
    const behaviour = fake.uploadBehaviour[name]
    if (behaviour && behaviour.length) {
      const next = behaviour.shift()
      if (next === 'network') throw new Error('Failed to connect to server')
      if (typeof next === 'number') throw new ApiError("Échec de l'upload", next)
    }
    const folder = (fake.serverFiles[dir] = fake.serverFiles[dir] || {})
    if (name in folder && !options.override) throw new ApiError('Un fichier du même nom existe déjà', 409)
    if (fake.onUpload) fake.onUpload(name)
    fake.uploads.push(`${dir}/${name}`)
    folder[name] = fake.sizes && uri in fake.sizes ? fake.sizes[uri] : 1000
  }
}

exports.ApiError = ApiError
exports.FileBrowserClient = FileBrowserClient
