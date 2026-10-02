const assert = require('assert')
const { createFake } = require('./fake')
const { ROOT } = require('./fixture')
const { LEGACY, legacyTree } = require('./legacy')

module.exports = async (v, test) => {
  await test('moves old backups into the account folder, merging with what is there', async () => {
    const fake = createFake(legacyTree())
    const report = await v.migrateBackups(fake, LEGACY, ROOT)
    assert.strictEqual(report.total, 4)
    assert.strictEqual(report.moved, 3)
    assert.strictEqual(report.skipped, 1)
    assert.strictEqual(report.failed, 0)
    assert.strictEqual(report.cancelled, false)
    const tree = fake.dump()
    for (const moved of ['/2026/08/a.jpg', '/2026/08/v.mp4', '/2025/12/old.jpg']) assert.ok(tree.includes(ROOT + moved), 'missing ' + moved)
    assert.ok(tree.includes(ROOT + '/2026/09/z.jpg'), 'what was already there is gone')
    // the clashing photo stays where it was, and so does the file that is not a photo
    assert.ok(tree.includes(LEGACY + '/2026/09/b.jpg') && tree.includes(LEGACY + '/2026/09/notes.txt'))
    assert.strictEqual(fake.find(ROOT + '/2026/09/b.jpg').size, 99, 'the file already there was overwritten')
    // emptied folders go, the rest stays
    assert.ok(!tree.includes(LEGACY + '/2026/08/') && !tree.includes(LEGACY + '/2025/12/') && !tree.includes(LEGACY + '/2025/'))
    assert.ok(tree.includes(LEGACY + '/2026/') && tree.includes(LEGACY + '/'))
    assert.strictEqual(report.removedFolders, 3)
    assert.ok(tree.includes('/backups/photos/bob/2026/09/secret.jpg'))
  })

  await test('only ever touches the old folder and the account folder', async () => {
    const fake = createFake(legacyTree())
    await v.migrateBackups(fake, LEGACY, ROOT)
    for (const [op, a, b] of fake.requested) {
      if (op === 'rename') assert.ok(v.isInside(LEGACY, a) && v.isInside(ROOT, b), op + ' ' + a + ' -> ' + b)
      else assert.ok(v.isInside(LEGACY, a) || v.isInside(ROOT, a) || a === '/backups' || a === '/backups/photos', op + ' ' + a)
    }
  })

  await test('can be run again: nothing moves twice, nothing is lost', async () => {
    const fake = createFake(legacyTree())
    await v.migrateBackups(fake, LEGACY, ROOT)
    const before = fake.dump()
    const again = await v.migrateBackups(fake, LEGACY, ROOT)
    assert.strictEqual(again.moved, 0)
    assert.strictEqual(again.skipped, 1)
    assert.strictEqual(again.removedFolders, 0)
    assert.deepStrictEqual(fake.dump(), before)
  })

  await test('creates the account folder when it does not exist yet', async () => {
    const fake = createFake({ 'Appareil photo': { 2026: { '05': { 'p.jpg': 1 } } } })
    const report = await v.migrateBackups(fake, LEGACY, ROOT)
    assert.strictEqual(report.moved, 1)
    assert.ok(fake.dump().includes(ROOT + '/2026/05/p.jpg'))
  })

  await test('reports progress', async () => {
    const fake = createFake(legacyTree())
    const steps = []
    await v.migrateBackups(fake, LEGACY, ROOT, { onProgress: (done, total) => steps.push(done + '/' + total) })
    assert.deepStrictEqual(steps, ['1/4', '2/4', '3/4', '4/4'])
  })
}
