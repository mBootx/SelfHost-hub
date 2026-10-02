const fake = require('./fake')
exports.AssetField = { CREATION_TIME: 'creationTime', MODIFICATION_TIME: 'modificationTime', MEDIA_TYPE: 'mediaType' }
exports.MediaType = { UNKNOWN: 'unknown', IMAGE: 'image', AUDIO: 'audio', VIDEO: 'video' }
exports.getPermissionsAsync = async () => fake.permission
exports.requestPermissionsAsync = async () => fake.permission
// fake.albums lists the phone's albums ({ id, title }); an asset's `album` is the id of the one it is in (the camera's by default).
const albums = () => fake.albums || [{ id: 'cam', title: 'Camera' }]
class Album {
  constructor(id) { this.id = id || 'cam' }
  static async get(title) { const found = albums().find((a) => a.title === title); return found ? new Album(found.id) : null }
  static async getAll() { return albums().map((a) => new Album(a.id)) }
  async getTitle() { const found = albums().find((a) => a.id === this.id); if (!found) throw new Error('album gone'); return found.title }
}
class Query {
  album(album) { this.albumId = album.id; return this }
  gte(field, value) { this.min = value; return this }
  orderBy(d) { this.order = d; return this }
  async exeForMetadata() {
    fake.queries = (fake.queries || 0) + 1
    fake.lastQueryMin = this.min
    if (this.albumId !== undefined && !albums().some((a) => a.id === this.albumId)) throw new Error('album gone')
    return fake.assets
      .filter((a) => this.albumId === undefined || (a.album || 'cam') === this.albumId)
      .filter((a) => this.min === undefined || (a.creationTime !== null && a.creationTime >= this.min))
      .sort((a, b) => a.creationTime - b.creationTime)
      .map(({ id, filename, mediaType, creationTime }) => ({ id, filename, mediaType, creationTime, width: null, height: null, duration: null, modificationTime: creationTime, isFavorite: false }))
  }
}
class Asset {
  constructor(id) { this.id = id }
  async getInfo() {
    const a = fake.assets.find((x) => x.id === this.id)
    if (!a) throw new Error('asset gone')
    return { id: a.id, filename: a.filename, uri: `file:///storage/emulated/0/DCIM/Camera/${a.filename}`, mediaType: a.mediaType, creationTime: a.creationTime }
  }
}
exports.Album = Album
exports.Query = Query
exports.Asset = Asset
