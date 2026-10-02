const assert = require('assert')
const { createFake } = require('./fake')
const { ROOT, vaultTree } = require('./fixture')

/** Alice's camera photos plus what other phone albums put in their own folders. */
function albumTree() {
  const t = vaultTree()
  const alice = t.backups.photos.alice
  alice.Screenshots = { 2026: { '09': { 'shot.png': 40, 'recording.mp4': 900 } } }
  alice['WhatsApp Images'] = { 2026: { '08': { 'wa.jpg': 60 } }, 'loose.jpg': 7 }
  alice.Corbeille = { '2026-10-01': { 2026: { '09': { 'binned.jpg': 5 } } } }
  return t
}

module.exports = async (v, test) => {
  await test('albums: folder names keep the album readable and cannot lead out of the account folder', () => {
    assert.strictEqual(v.albumFolderName('Screenshots'), 'Screenshots')
    assert.strictEqual(v.albumFolderName('WhatsApp Images'), 'WhatsApp Images')
    assert.strictEqual(v.albumFolderName('Événements été'), 'Événements été')
    assert.strictEqual(v.albumFolderName('a/b'), 'a~2f~b')
    assert.strictEqual(v.albumFolderName('..'), '~2e~~2e~')
    assert.strictEqual(v.albumFolderName('.hidden'), '~2e~hidden')
    assert.strictEqual(v.albumFolderName('2024'), '2024 (album)', 'would be taken for a year')
    assert.strictEqual(v.albumFolderName('Corbeille'), 'Corbeille (album)', 'would be taken for the bin')
    assert.strictEqual(v.albumFolderName('corbeille'), 'corbeille (album)')
    assert.throws(() => v.albumFolderName('   '))
    assert.throws(() => v.albumFolderName('x'.repeat(300)))
    for (const title of ['Screenshots', '../../bob', 'a/../b', 'x y', '2024']) {
      const folder = v.albumFolderName(title)
      assert.ok(v.isInside(ROOT, `${ROOT}/${folder}/2026/09/p.jpg`), title)
    }
  })

  await test('albums: the gallery knows which album each photo came from', async () => {
    const fake = createFake(albumTree())
    const listing = await v.loadPhotos(fake, ROOT)
    const byName = Object.fromEntries(listing.photos.map((p) => [p.name, p]))
    assert.strictEqual(byName['a.jpg'].album, null, 'camera photos sit straight in year/month folders')
    assert.deepStrictEqual([byName['shot.png'].album, byName['shot.png'].year, byName['shot.png'].month], ['Screenshots', 2026, 9])
    assert.strictEqual(byName['shot.png'].path, `${ROOT}/Screenshots/2026/09/shot.png`)
    assert.strictEqual(byName['shot.png'].relative, 'Screenshots/2026/09/shot.png')
    assert.deepStrictEqual([byName['wa.jpg'].album, byName['wa.jpg'].year, byName['wa.jpg'].month], ['WhatsApp Images', 2026, 8])
    assert.deepStrictEqual([byName['loose.jpg'].album, byName['loose.jpg'].year, byName['loose.jpg'].month], ['WhatsApp Images', null, null])
    assert.strictEqual(byName['recording.mp4'].kind, 'video')
    assert.strictEqual(byName['shot.png'].kind, 'photo')
  })

  await test('albums: the bin is not part of the gallery, and is not even read', async () => {
    const fake = createFake(albumTree())
    const listing = await v.loadPhotos(fake, ROOT)
    assert.ok(!listing.photos.some((p) => p.name === 'binned.jpg'))
    assert.ok(!fake.requested.some(([, path]) => path.includes('Corbeille')), 'the bin was listed')
  })

  await test('albums: an album folder named like the bin deeper down is still read', async () => {
    const t = albumTree()
    t.backups.photos.alice.Screenshots.Corbeille = { 'inner.png': 3 }
    const listing = await v.loadPhotos(createFake(t), ROOT)
    assert.ok(listing.photos.some((p) => p.name === 'inner.png'))
  })

  await test('albums: reading goes down to album/year/month and no further', async () => {
    const fake = createFake(albumTree())
    const listing = await v.loadPhotos(fake, ROOT)
    assert.ok(listing.photos.some((p) => p.name === 'shot.png'), 'album/year/month is read')
    assert.ok(!listing.photos.some((p) => p.name === 'z.jpg'), 'a fifth level is not')
    assert.ok(!fake.requested.some(([, path]) => path.endsWith('/w')))
  })

  await test('albums: sorting by date keeps the camera and the albums in one timeline', () => {
    const photos = [
      { name: 'a.jpg', path: '/r/2026/09/a.jpg', year: 2026, month: 9, modified: 1, size: 1, album: null, kind: 'photo' },
      { name: 's.png', path: '/r/S/2026/09/s.png', year: 2026, month: 9, modified: 2, size: 1, album: 'S', kind: 'photo' },
      { name: 'old.jpg', path: '/r/S/2025/01/old.jpg', year: 2025, month: 1, modified: 1, size: 1, album: 'S', kind: 'photo' }
    ]
    assert.deepStrictEqual(v.sortPhotos(photos, 'newest').map((p) => p.name), ['s.png', 'a.jpg', 'old.jpg'])
  })
}
