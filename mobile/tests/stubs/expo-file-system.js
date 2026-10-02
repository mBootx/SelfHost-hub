const fake = require('./fake')

// Just enough of expo-file-system for the code under test: files that exist in `fake.files` (or, under
// file:///storage, unless listed in fake.missingFiles), folders, and network tasks that record what they were asked.
exports.Paths = { document: 'file:///doc', cache: 'file:///cache' }
exports.UploadType = { BINARY_CONTENT: 'binary' }

class Directory {
  constructor(a, b) {
    this.uri = b ? `${a}/${b}` : a
  }
  get exists() {
    return this.uri in fake.dirs
  }
  create() {
    fake.dirs[this.uri] = true
  }
  list() {
    return Object.keys(fake.files).filter((uri) => uri.startsWith(this.uri + '/')).map((uri) => new File(uri))
  }
}

class File {
  constructor(a, b) {
    this.uri = b ? `${typeof a === 'string' ? a : a.uri}/${b}` : a
  }
  get exists() {
    return this.uri in fake.files || (this.uri.startsWith('file:///storage') && !fake.missingFiles.has(this.uri))
  }
  get size() {
    return fake.sizes && this.uri in fake.sizes ? fake.sizes[this.uri] : 1000
  }
  get name() {
    return this.uri.split('/').pop()
  }
  textSync() {
    return fake.files[this.uri]
  }
  create() {
    fake.files[this.uri] = ''
  }
  write(text) {
    fake.files[this.uri] = text
  }
  delete() {
    delete fake.files[this.uri]
  }
  createUploadTask(url, options) {
    return {
      uploadAsync: async () => {
        fake.networkTasks.push({ kind: 'upload', url, options, file: this.uri })
        return { status: fake.uploadStatus ?? 200 }
      }
    }
  }
  static createDownloadTask(url, destination, options) {
    return {
      downloadAsync: async () => {
        fake.networkTasks.push({ kind: 'download', url, options, destination: destination.uri })
        fake.files[destination.uri] = ''
        return destination
      }
    }
  }
}

exports.Directory = Directory
exports.File = File
