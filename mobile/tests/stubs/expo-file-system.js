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
  // The bytes of a file, for the code that hashes or reads one (fake.fileBytes[uri], a Uint8Array).
  async arrayBuffer() {
    const bytes = fake.fileBytes && fake.fileBytes[this.uri]
    if (!bytes) throw new Error('no bytes for ' + this.uri)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  // Renames within the same folder; the instance follows the file, as the real one does.
  rename(name) {
    const next = this.uri.slice(0, this.uri.lastIndexOf('/')) + '/' + name
    for (const table of [fake.files, fake.sizes, fake.fileBytes]) {
      if (table && this.uri in table) {
        table[next] = table[this.uri]
        delete table[this.uri]
      }
    }
    this.uri = next
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
    if (fake.fileBytes) delete fake.fileBytes[this.uri]
  }
  createUploadTask(url, options) {
    return {
      uploadAsync: async () => {
        fake.networkTasks.push({ kind: 'upload', url, options, file: this.uri })
        return { status: fake.uploadStatus ?? 200 }
      }
    }
  }
  // A one-shot download (the cover store's): fake.downloadSize bytes (2000 by default), fake.downloadDelayMs to keep it
  // in flight, fake.failUrls to make some fail (a 404 leaves no file); fake.activeDownloads counts those in flight.
  static async downloadFileAsync(url, destination, options) {
    fake.networkTasks.push({ kind: 'downloadFile', url, options, destination: destination.uri })
    fake.activeDownloads = (fake.activeDownloads || 0) + 1
    fake.maxActiveDownloads = Math.max(fake.maxActiveDownloads || 0, fake.activeDownloads)
    try {
      if (fake.downloadDelayMs) await new Promise((resolve) => setTimeout(resolve, fake.downloadDelayMs))
      if (fake.failUrls && fake.failUrls.has(url)) throw new Error('UnableToDownload: 404')
      fake.files[destination.uri] = 'image'
      fake.sizes[destination.uri] = fake.downloadSize ?? 2000
      return destination
    } finally {
      fake.activeDownloads--
    }
  }
  static createDownloadTask(url, destination, options) {
    return {
      downloadAsync: async () => {
        fake.networkTasks.push({ kind: 'download', url, options, destination: destination.uri })
        if (fake.downloadError) throw new Error(fake.downloadError)
        fake.files[destination.uri] = ''
        if (fake.downloadBytes) {
          fake.fileBytes = fake.fileBytes || {}
          fake.fileBytes[destination.uri] = fake.downloadBytes
          fake.sizes[destination.uri] = fake.downloadBytes.length
          if (options && options.onProgress) options.onProgress({ bytesWritten: fake.downloadBytes.length, totalBytes: fake.downloadBytes.length })
        }
        return fake.downloadReturnsNull ? null : destination
      }
    }
  }
}

exports.Directory = Directory
exports.File = File
