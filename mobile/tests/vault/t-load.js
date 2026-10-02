const assert = require('assert')
const { createFake } = require('./fake')
const { ROOT, vaultTree } = require('./fixture')

module.exports = async (v, test) => {
  await test('lists the photos of the account, with their year and month', async () => {
    const fake = createFake(vaultTree())
    const listing = await v.loadPhotos(fake, ROOT)
    const byName = Object.fromEntries(listing.photos.map((p) => [p.name, p]))
    assert.deepStrictEqual(Object.keys(byName).sort(), ['a.jpg', 'b.HEIC', 'c.mp4', 'd.png', 'e.jpg', 'stray.jpg'])
    assert.deepStrictEqual([byName['c.mp4'].kind, byName['a.jpg'].kind, byName['b.HEIC'].kind], ['video', 'photo', 'photo'])
    assert.strictEqual(listing.incomplete, false)
    assert.deepStrictEqual([byName['a.jpg'].year, byName['a.jpg'].month], [2026, 9])
    assert.deepStrictEqual([byName['d.png'].year, byName['d.png'].month], [2026, 8])
    assert.deepStrictEqual([byName['e.jpg'].year, byName['e.jpg'].month], [2025, 12])
    assert.deepStrictEqual([byName['stray.jpg'].year, byName['stray.jpg'].month], [null, null])
    assert.strictEqual(byName['b.HEIC'].size, 200)
    assert.strictEqual(byName['a.jpg'].path, ROOT + '/2026/09/a.jpg')
    assert.ok(byName['a.jpg'].modified > 0)
  })

  await test('never asks the server about anything outside the account folder', async () => {
    const fake = createFake(vaultTree())
    await v.loadPhotos(fake, ROOT)
    assert.ok(fake.requested.length > 3)
    for (const [op, path] of fake.requested) {
      assert.strictEqual(op, 'list')
      assert.ok(v.isInside(ROOT, path), 'asked for ' + path)
    }
  })

  await test('reads at most four folders at once, newest first', async () => {
    const tree = { backups: { photos: { alice: {} } } }
    for (let year = 2015; year <= 2026; year++) {
      tree.backups.photos.alice[year] = {}
      for (let month = 1; month <= 12; month++) tree.backups.photos.alice[year][String(month).padStart(2, '0')] = { ['p' + year + month + '.jpg']: 10 }
    }
    const fake = createFake(tree)
    const listing = await v.loadPhotos(fake, ROOT)
    assert.strictEqual(listing.photos.length, 144)
    assert.ok(fake.listPeak <= 4, 'peak ' + fake.listPeak)
    assert.ok(fake.listPeak > 1, 'no parallelism at all')
    assert.strictEqual(fake.requested[1][1], ROOT + '/2026', 'the newest year should be read first')
  })

  await test('reports what it has found as it goes', async () => {
    const fake = createFake(vaultTree())
    const seen = []
    const listing = await v.loadPhotos(fake, ROOT, { onPartial: (photos) => seen.push(photos.length) })
    assert.ok(seen.length >= 3)
    assert.deepStrictEqual(seen, [...seen].sort((a, b) => a - b))
    assert.strictEqual(seen[seen.length - 1], listing.photos.length)
  })

  await test('an account with no backup folder yet has an empty gallery', async () => {
    const fake = createFake({ backups: { photos: {} } })
    assert.deepStrictEqual(await v.loadPhotos(fake, ROOT), { photos: [], incomplete: false })
  })

  await test('server answers are mapped to errors the screen can explain', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'denied'], [0, 'offline'], [500, 'failed']]) {
      const fake = createFake(vaultTree())
      fake.failures.list[ROOT] = status
      try {
        await v.loadPhotos(fake, ROOT)
        assert.fail('did not throw for ' + status)
      } catch (err) {
        assert.strictEqual(err.code, code, status + ' -> ' + err.code)
      }
    }
  })

  await test('a folder that cannot be read marks the list incomplete but keeps the rest', async () => {
    const fake = createFake(vaultTree())
    fake.failures.list[ROOT + '/2026/08'] = 500
    const listing = await v.loadPhotos(fake, ROOT)
    assert.strictEqual(listing.incomplete, true)
    assert.ok(listing.photos.some((p) => p.name === 'a.jpg'))
    assert.ok(!listing.photos.some((p) => p.name === 'd.png'))
  })

  await test('names the server sends that lead out of the folder are ignored', async () => {
    const tree = vaultTree()
    tree.backups.photos.alice['..'] = { 'loot.jpg': 1 }
    tree.backups.photos.alice['x/../y.jpg'] = 1
    tree.backups.photos.alice['a' + String.fromCharCode(92) + 'b.jpg'] = 1
    tree.backups.photos.alice['.'] = { 'dot.jpg': 1 }
    const fake = createFake(tree)
    const listing = await v.loadPhotos(fake, ROOT)
    assert.ok(!listing.photos.some((p) => p.name.includes('..') || p.name.includes('/') || p.name === 'loot.jpg' || p.name === 'dot.jpg'))
    for (const [, path] of fake.requested) assert.ok(!path.includes('..'), 'asked for ' + path)
  })

  await test('stops reading when told to', async () => {
    const fake = createFake(vaultTree())
    const listing = await v.loadPhotos(fake, ROOT, { isCancelled: () => true })
    assert.strictEqual(listing.photos.length, 0)
    assert.strictEqual(fake.requested.length, 0)
  })
}
