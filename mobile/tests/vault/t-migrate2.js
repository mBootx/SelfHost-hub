const assert = require('assert')
const { createFake } = require('./fake')
const { ROOT } = require('./fixture')
const { LEGACY, legacyTree } = require('./legacy')

module.exports = async (v, test) => {
  await test('stopping part-way leaves everything consistent and cleans nothing up', async () => {
    const fake = createFake(legacyTree())
    let moves = 0
    const report = await v.migrateBackups(fake, LEGACY, ROOT, { onProgress: () => moves++, isCancelled: () => moves >= 1 })
    assert.strictEqual(report.cancelled, true)
    assert.strictEqual(report.moved, 1)
    assert.strictEqual(fake.requested.filter((r) => r[0] === 'remove').length, 0)
    const finished = await v.migrateBackups(fake, LEGACY, ROOT)
    assert.strictEqual(finished.moved + 1, 3)
  })

  await test('one file failing does not stop the others', async () => {
    const fake = createFake(legacyTree())
    fake.failures.rename[LEGACY + '/2026/08/a.jpg'] = 500
    const report = await v.migrateBackups(fake, LEGACY, ROOT)
    assert.strictEqual(report.failed, 1)
    assert.strictEqual(report.moved, 2)
    assert.ok(report.errors[0].includes('a.jpg'))
    assert.ok(fake.dump().includes(LEGACY + '/2026/08/a.jpg'), 'the file that failed must stay where it was')
  })

  await test('a lost session stops the run and removes nothing', async () => {
    const fake = createFake(legacyTree())
    for (const path of ['/2026/08/a.jpg', '/2026/08/v.mp4', '/2026/09/b.jpg', '/2025/12/old.jpg']) fake.failures.rename[LEGACY + path] = 401
    const report = await v.migrateBackups(fake, LEGACY, ROOT)
    assert.ok(report.failed >= 1 && report.moved === 0)
    assert.strictEqual(fake.requested.filter((r) => r[0] === 'rename').length, 1, 'should stop at the first 401')
    assert.strictEqual(fake.requested.filter((r) => r[0] === 'remove').length, 0)
  })

  await test('folders that overlap are refused before anything is touched', async () => {
    for (const [from, to] of [['/', ROOT], [LEGACY, LEGACY], ['/backups', ROOT], [LEGACY, LEGACY + '/new'], [LEGACY, LEGACY + '/../x']]) {
      const fake = createFake(legacyTree())
      const before = fake.dump()
      try {
        await v.migrateBackups(fake, from, to)
        assert.fail('accepted ' + from + ' -> ' + to)
      } catch (err) {
        assert.strictEqual(err.code, 'forbidden-path', from + ' -> ' + to + ': ' + err.message)
      }
      assert.deepStrictEqual(fake.dump(), before)
      assert.strictEqual(fake.requested.length, 0)
    }
  })

  await test('an old folder that is not there is nothing to do', async () => {
    const fake = createFake({ backups: { photos: { alice: {} } } })
    const report = await v.migrateBackups(fake, LEGACY, ROOT)
    assert.deepStrictEqual([report.total, report.moved, report.failed], [0, 0, 0])
  })

  await test('names that lead out of the old folder are never followed', async () => {
    const tree = legacyTree()
    tree['Appareil photo']['..'] = { 'loot.jpg': 1 }
    tree['Appareil photo']['a/b.jpg'] = 1
    const fake = createFake(tree)
    const report = await v.migrateBackups(fake, LEGACY, ROOT)
    assert.strictEqual(report.total, 4)
    for (const [, a, b] of fake.requested) assert.ok(!String(a).includes('..') && !String(b || '').includes('..'), 'asked for ' + a)
  })

  await test('finds out whether an old folder has backups in it', async () => {
    assert.strictEqual(await v.hasBackups(createFake(legacyTree()), LEGACY), true)
    assert.strictEqual(await v.hasBackups(createFake({}), LEGACY), false)
    assert.strictEqual(await v.hasBackups(createFake({ 'Appareil photo': {} }), LEGACY), false)
    const broken = createFake(legacyTree())
    broken.failures.list[LEGACY] = 500
    assert.strictEqual(await v.hasBackups(broken, LEGACY), false)
  })
}
