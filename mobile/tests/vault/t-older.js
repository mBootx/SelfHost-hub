const assert = require('assert')
const { createFake } = require('./fake')
const { ROOT, vaultTree } = require('./fixture')

const OLD = '/Appareil photo'

/** Alice's account folder, plus the old single folder the app used before backups were kept per account. */
function tree() {
  const t = vaultTree()
  t['Appareil photo'] = {
    2026: { '09': { 'a.jpg': 100, 'old1.jpg': 111, 'clip.mp4': 5000 }, '07': { 'old2.jpg': 222 } },
    2025: { 12: { 'e.jpg': 51 } },
    'readme.txt': 3
  }
  return t
}

module.exports = async (vault, test) => {
  await test('older folders: their photos are listed with the account\'s own', async () => {
    const fake = createFake(tree())
    const listing = await vault.loadPhotos(fake, ROOT, { olderFolders: [OLD] })
    const names = listing.photos.map((p) => p.path).sort()
    assert.ok(names.includes('/Appareil photo/2026/09/old1.jpg'), names.join())
    assert.ok(names.includes('/Appareil photo/2026/07/old2.jpg'))
    assert.ok(names.includes('/backups/photos/alice/2026/08/d.png'))
    assert.strictEqual(listing.photos.filter((p) => p.kind === 'video').length, 2, 'the clip in each folder')
  })

  await test('older folders: the same photo in both is shown once, the account\'s copy first', async () => {
    const fake = createFake(tree())
    const listing = await vault.loadPhotos(fake, ROOT, { olderFolders: [OLD] })
    const a = listing.photos.filter((p) => p.name === 'a.jpg')
    assert.strictEqual(a.length, 1)
    assert.strictEqual(a[0].path, '/backups/photos/alice/2026/09/a.jpg')
    // e.jpg is 50 bytes in the account's folder and 51 in the old one: different files, both kept.
    assert.strictEqual(listing.photos.filter((p) => p.name === 'e.jpg').length, 2)
  })

  await test('older folders: year, month and relative path come from each folder\'s own layout', async () => {
    const fake = createFake(tree())
    const listing = await vault.loadPhotos(fake, ROOT, { olderFolders: [OLD] })
    const old2 = listing.photos.find((p) => p.name === 'old2.jpg')
    assert.deepStrictEqual([old2.year, old2.month, old2.relative], [2026, 7, '2026/07/old2.jpg'])
  })

  await test('older folders: a missing or unreadable one never breaks the gallery', async () => {
    const fake = createFake(vaultTree())
    const missing = await vault.loadPhotos(fake, ROOT, { olderFolders: ['/does/not/exist'] })
    assert.strictEqual(missing.incomplete, false)
    assert.ok(missing.photos.length > 0)
    const broken = createFake(tree())
    broken.failures.list[OLD] = 500
    const listing = await vault.loadPhotos(broken, ROOT, { olderFolders: [OLD] })
    assert.strictEqual(listing.incomplete, true, 'the list says it may be missing photos')
    assert.ok(listing.photos.some((p) => p.name === 'd.png'))
  })

  await test('older folders: only the account folder missing is still a gallery of the old photos', async () => {
    const fake = createFake({ 'Appareil photo': tree()['Appareil photo'] })
    const listing = await vault.loadPhotos(fake, ROOT, { olderFolders: [OLD] })
    assert.ok(listing.photos.some((p) => p.name === 'old1.jpg'))
    assert.strictEqual(listing.incomplete, false)
  })

  await test('older folders: a fatal error on the account folder still throws', async () => {
    const fake = createFake(tree())
    fake.failures.list[ROOT] = 403
    await assert.rejects(() => vault.loadPhotos(fake, ROOT, { olderFolders: [OLD] }), (err) => err.code === 'denied')
  })

  await test('older folders: folders nested in, around or equal to the account folder are ignored', async () => {
    const fake = createFake(tree())
    const plain = await vault.loadPhotos(fake, ROOT)
    for (const bad of [ROOT, ROOT + '/2026', '/backups/photos', '/backups', '/', '', '/backups/../etc']) {
      const listing = await vault.loadPhotos(createFake(tree()), ROOT, { olderFolders: [bad] })
      assert.strictEqual(listing.photos.length, plain.photos.length, 'folder ' + JSON.stringify(bad))
    }
  })

  await test('older folders: never lists anything outside the two folders', async () => {
    const fake = createFake(tree())
    await vault.loadPhotos(fake, ROOT, { olderFolders: [OLD] })
    const outside = fake.requested.filter(([, path]) => !(path.startsWith(ROOT) || path.startsWith(OLD)))
    assert.deepStrictEqual(outside, [])
    assert.ok(fake.listPeak <= 4, 'at most four folders at once, even for two roots: ' + fake.listPeak)
  })

  await test('older folders: the partial results already contain both folders', async () => {
    const fake = createFake(tree())
    const seen = []
    await vault.loadPhotos(fake, ROOT, { olderFolders: [OLD], onPartial: (photos) => seen.push(photos.length) })
    assert.ok(seen.length >= 2)
    assert.ok(seen.every((n, i) => i === 0 || n >= seen[i - 1]), 'only grows: ' + seen.join())
  })

  await test('delete: a photo in the old folder can be deleted when that folder is one of the roots', async () => {
    const fake = createFake(tree())
    const report = await vault.deletePhotos(fake, [ROOT, OLD], ['/Appareil photo/2026/07/old2.jpg', '/backups/photos/alice/2026/08/d.png'])
    assert.deepStrictEqual(report.deleted.sort(), ['/Appareil photo/2026/07/old2.jpg', '/backups/photos/alice/2026/08/d.png'])
    assert.strictEqual(fake.find('/Appareil photo/2026/07/old2.jpg'), null)
  })

  await test('delete: with only the account folder as root, the old folder stays out of reach', async () => {
    const fake = createFake(tree())
    const report = await vault.deletePhotos(fake, ROOT, ['/Appareil photo/2026/07/old2.jpg'])
    assert.strictEqual(report.deleted.length, 0)
    assert.strictEqual(report.failed.length, 1)
    assert.ok(fake.find('/Appareil photo/2026/07/old2.jpg'))
  })

  await test('delete: other accounts and traversal stay refused with several roots', async () => {
    const fake = createFake(tree())
    const report = await vault.deletePhotos(fake, [ROOT, OLD], [
      '/backups/photos/bob/2026/09/secret.jpg',
      '/Appareil photo/../backups/photos/bob/2026/09/secret.jpg',
      '/Appareil photo',
      '/backups/photos/alice',
      '/Appareil photo/readme.txt'
    ])
    assert.strictEqual(report.deleted.length, 0, report.deleted.join())
    assert.strictEqual(report.failed.length, 5)
    assert.ok(fake.find('/backups/photos/bob/2026/09/secret.jpg'))
    assert.ok(fake.find('/Appareil photo/readme.txt'))
    assert.deepStrictEqual(fake.requested.filter(([kind]) => kind === 'remove'), [])
  })
}
