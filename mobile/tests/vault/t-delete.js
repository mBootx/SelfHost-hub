const assert = require('assert')
const { createFake } = require('./fake')
const { ROOT, vaultTree } = require('./fixture')

module.exports = async (v, test) => {
  await test('deletes photos from the folder and nothing else', async () => {
    const fake = createFake(vaultTree())
    const report = await v.deletePhotos(fake, ROOT, [ROOT + '/2026/09/a.jpg', ROOT + '/2025/12/e.jpg'])
    assert.deepStrictEqual(report.deleted, [ROOT + '/2026/09/a.jpg', ROOT + '/2025/12/e.jpg'])
    assert.strictEqual(report.failed.length, 0)
    const left = fake.dump()
    assert.ok(!left.includes(ROOT + '/2026/09/a.jpg') && !left.includes(ROOT + '/2025/12/e.jpg'))
    assert.ok(left.includes(ROOT + '/2026/09/b.HEIC') && left.includes('/backups/photos/bob/2026/09/secret.jpg'))
  })

  await test("refuses another account's photos, folders, other files and the folder itself", async () => {
    const fake = createFake(vaultTree())
    const targets = [
      '/backups/photos/bob/2026/09/secret.jpg',
      ROOT + '/../bob/2026/09/secret.jpg',
      ROOT + '/%2e%2e/bob/2026/09/secret.jpg',
      ROOT + '/2026',
      ROOT + '/2026/09/notes.txt',
      ROOT,
      '/backups/photos',
      '/'
    ]
    const before = fake.dump()
    const report = await v.deletePhotos(fake, ROOT, targets)
    assert.strictEqual(report.deleted.length, 0)
    assert.strictEqual(report.failed.length, targets.length)
    assert.deepStrictEqual(fake.dump(), before)
    assert.strictEqual(fake.requested.filter((r) => r[0] === 'remove').length, 0, 'a delete reached the server')
  })

  await test('a lost session stops a delete run; a missing file does not', async () => {
    const fake = createFake(vaultTree())
    fake.failures.remove[ROOT + '/2026/09/b.HEIC'] = 401
    const report = await v.deletePhotos(fake, ROOT, [ROOT + '/2026/09/ghost.jpg', ROOT + '/2026/09/b.HEIC', ROOT + '/2026/08/d.png', ROOT + '/2025/12/e.jpg'])
    assert.deepStrictEqual(report.deleted, [])
    assert.strictEqual(report.failed.length, 4)
    assert.strictEqual(fake.requested.filter((r) => r[0] === 'remove').length, 2, 'should stop after the 401')
    assert.ok(fake.dump().includes(ROOT + '/2026/08/d.png'))
  })

  await test('a missing file is reported and the rest still goes', async () => {
    const fake = createFake(vaultTree())
    const report = await v.deletePhotos(fake, ROOT, [ROOT + '/2026/09/ghost.jpg', ROOT + '/2026/08/d.png'])
    assert.deepStrictEqual(report.deleted, [ROOT + '/2026/08/d.png'])
    assert.strictEqual(report.failed.length, 1)
  })

  await test('reports progress', async () => {
    const fake = createFake(vaultTree())
    const steps = []
    await v.deletePhotos(fake, ROOT, [ROOT + '/2026/09/a.jpg', ROOT + '/2026/08/d.png'], (done, total) => steps.push(done + '/' + total))
    assert.deepStrictEqual(steps, ['1/2', '2/2'])
  })
}
