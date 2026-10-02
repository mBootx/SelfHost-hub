const assert = require('assert')
const { createFake } = require('./fake')
const { ROOT, vaultTree } = require('./fixture')

const BIN = ROOT + '/Corbeille'
const TODAY = new Date(2026, 9, 2, 14, 30) // 2 October 2026, local time
const DAY = '2026-10-02'

const only = (fake, op) => fake.requested.filter((r) => r[0] === op)

function treeWithAlbum() {
  const t = vaultTree()
  t.backups.photos.alice.Screenshots = { 2026: { '09': { 'shot.png': 40 } } }
  return t
}

module.exports = async (v, test) => {
  await test('bin: a deleted photo moves into a day folder of the bin, keeping its place in year/month', async () => {
    const fake = createFake(vaultTree())
    const report = await v.trashPhotos(fake, ROOT, [ROOT + '/2026/09/a.jpg', ROOT + '/2025/12/e.jpg'], { today: TODAY })
    assert.deepStrictEqual(report.moved, [
      { from: ROOT + '/2026/09/a.jpg', to: `${BIN}/${DAY}/2026/09/a.jpg` },
      { from: ROOT + '/2025/12/e.jpg', to: `${BIN}/${DAY}/2025/12/e.jpg` }
    ])
    assert.strictEqual(report.failed.length, 0)
    const left = fake.dump()
    assert.ok(!left.includes(ROOT + '/2026/09/a.jpg') && left.includes(`${BIN}/${DAY}/2026/09/a.jpg`))
    assert.ok(left.includes(ROOT + '/2026/09/b.HEIC'), 'the others stay')
    assert.strictEqual(only(fake, 'remove').length, 0, 'nothing is deleted for good')
  })

  await test('bin: photos of an album keep their album folder in the bin', async () => {
    const fake = createFake(treeWithAlbum())
    const report = await v.trashPhotos(fake, ROOT, [ROOT + '/Screenshots/2026/09/shot.png'], { today: TODAY })
    assert.strictEqual(report.moved[0].to, `${BIN}/${DAY}/Screenshots/2026/09/shot.png`)
  })

  await test('bin: a name already in the bin that day is not overwritten', async () => {
    const t = vaultTree()
    t.backups.photos.alice.Corbeille = { [DAY]: { 2026: { '09': { 'a.jpg': 1 } } } }
    const fake = createFake(t)
    const report = await v.trashPhotos(fake, ROOT, [ROOT + '/2026/09/a.jpg'], { today: TODAY })
    assert.strictEqual(report.moved[0].to, `${BIN}/${DAY}/2026/09/a (2).jpg`)
    assert.ok(fake.dump().includes(`${BIN}/${DAY}/2026/09/a.jpg`), 'the first one is still there')
  })

  await test('bin: two photos with the same name from one folder do not clash either', async () => {
    const t = vaultTree()
    t.backups.photos.alice['Appareil photo'] = {}
    const fake = createFake(t)
    // Same relative path in the account's folder and in an older folder.
    fake.root.children.set('Appareil photo', createFake({ 2026: { '09': { 'a.jpg': 11 } } }).root)
    const report = await v.trashPhotos(fake, [ROOT, '/Appareil photo'], [ROOT + '/2026/09/a.jpg', '/Appareil photo/2026/09/a.jpg'], { today: TODAY })
    assert.deepStrictEqual(report.moved.map((m) => m.to), [`${BIN}/${DAY}/2026/09/a.jpg`, `${BIN}/${DAY}/2026/09/a (2).jpg`])
    assert.strictEqual(report.failed.length, 0)
  })

  await test("bin: refuses other accounts' photos, folders, other files, the folder itself and what is already in the bin", async () => {
    const t = vaultTree()
    t.backups.photos.alice.Corbeille = { [DAY]: { 'binned.jpg': 1 } }
    const fake = createFake(t)
    const targets = [
      '/backups/photos/bob/2026/09/secret.jpg',
      ROOT + '/../bob/2026/09/secret.jpg',
      ROOT + '/2026',
      ROOT + '/2026/09/notes.txt',
      ROOT,
      '/',
      `${BIN}/${DAY}/binned.jpg`
    ]
    const before = fake.dump()
    const report = await v.trashPhotos(fake, ROOT, targets, { today: TODAY })
    assert.strictEqual(report.moved.length, 0)
    assert.strictEqual(report.failed.length, targets.length)
    assert.deepStrictEqual(fake.dump(), before)
    assert.strictEqual(only(fake, 'rename').length, 0, 'a move reached the server')
  })

  await test('bin: a lost session stops the run; a missing file does not', async () => {
    const fake = createFake(vaultTree())
    fake.failures.rename[ROOT + '/2026/09/b.HEIC'] = 401
    const report = await v.trashPhotos(fake, ROOT, [ROOT + '/2026/09/ghost.jpg', ROOT + '/2026/09/b.HEIC', ROOT + '/2026/08/d.png'], { today: TODAY })
    assert.strictEqual(report.moved.length, 0)
    assert.strictEqual(report.failed.length, 3)
    assert.strictEqual(only(fake, 'rename').length, 2, 'stops after the 401')
    const fine = createFake(vaultTree())
    const ok = await v.trashPhotos(fine, ROOT, [ROOT + '/2026/09/ghost.jpg', ROOT + '/2026/08/d.png'], { today: TODAY })
    assert.deepStrictEqual(ok.moved.map((m) => m.from), [ROOT + '/2026/08/d.png'])
    assert.strictEqual(ok.failed.length, 1)
  })

  await test('bin: progress is reported', async () => {
    const fake = createFake(vaultTree())
    const steps = []
    await v.trashPhotos(fake, ROOT, [ROOT + '/2026/09/a.jpg', ROOT + '/2026/08/d.png'], { today: TODAY, onEach: (done, total) => steps.push(done + '/' + total) })
    assert.deepStrictEqual(steps, ['1/2', '2/2'])
  })

  await test('bin: lists what was deleted, newest day first, with where each photo came from', async () => {
    const t = vaultTree()
    t.backups.photos.alice.Corbeille = {
      '2026-09-20': { 2026: { '09': { 'old.jpg': 3, 'clip.mp4': 4 } } },
      '2026-10-01': { Screenshots: { 2026: { '09': { 'shot.png': 5 } } } },
      'notes.txt': 1,
      misc: { 'stray.jpg': 1 }
    }
    const listing = await v.loadTrash(createFake(t), ROOT)
    assert.deepStrictEqual(listing.items.map((i) => i.trashedOn + ' ' + i.name), ['2026-10-01 shot.png', '2026-09-20 clip.mp4', '2026-09-20 old.jpg'])
    const shot = listing.items[0]
    assert.strictEqual(shot.originalPath, ROOT + '/Screenshots/2026/09/shot.png')
    assert.strictEqual(shot.path, `${BIN}/2026-10-01/Screenshots/2026/09/shot.png`)
    assert.deepStrictEqual(listing.items.map((i) => i.kind), ['photo', 'video', 'photo'])
    assert.strictEqual(listing.incomplete, false)
  })

  await test('bin: no bin yet is an empty bin; a lost session is an error', async () => {
    const empty = await v.loadTrash(createFake(vaultTree()), ROOT)
    assert.deepStrictEqual(empty, { items: [], incomplete: false })
    const fake = createFake(vaultTree())
    fake.failures.list[BIN] = 401
    await assert.rejects(() => v.loadTrash(fake, ROOT), (err) => err.code === 'unauthorized')
  })

  await test('bin: a day folder that cannot be read marks the list incomplete', async () => {
    const t = vaultTree()
    t.backups.photos.alice.Corbeille = { '2026-09-20': { 'a.jpg': 1 }, '2026-10-01': { 'b.jpg': 1 } }
    const fake = createFake(t)
    fake.failures.list[`${BIN}/2026-09-20`] = 500
    const listing = await v.loadTrash(fake, ROOT)
    assert.strictEqual(listing.incomplete, true)
    assert.deepStrictEqual(listing.items.map((i) => i.name), ['b.jpg'])
  })

  await test('bin: restoring puts a photo back, making its folders again if they are gone', async () => {
    const fake = createFake(vaultTree())
    const trashed = await v.trashPhotos(fake, ROOT, [ROOT + '/2025/12/e.jpg'], { today: TODAY })
    await fake.remove(ROOT + '/2025') // the year folder went when its last photo did
    const report = await v.restoreTrashed(fake, ROOT, [trashed.moved[0].to])
    assert.deepStrictEqual(report.restored, [{ from: trashed.moved[0].to, to: ROOT + '/2025/12/e.jpg' }])
    assert.ok(fake.dump().includes(ROOT + '/2025/12/e.jpg'))
    assert.ok(!fake.dump().includes(`${BIN}/${DAY}/2025/12/e.jpg`))
  })

  await test('bin: a restored photo never replaces one that took its name meanwhile', async () => {
    const fake = createFake(vaultTree())
    const trashed = await v.trashPhotos(fake, ROOT, [ROOT + '/2026/09/a.jpg'], { today: TODAY })
    fake.find(ROOT + '/2026/09').children.set('a.jpg', { dir: false, size: 555, modified: '2026-09-30T10:00:00Z' })
    const report = await v.restoreTrashed(fake, ROOT, [trashed.moved[0].to])
    assert.strictEqual(report.restored[0].to, ROOT + '/2026/09/a (2).jpg')
    assert.strictEqual(fake.find(ROOT + '/2026/09/a.jpg').size, 555, 'the newer file is untouched')
  })

  await test('bin: only files of the bin can be restored', async () => {
    const t = vaultTree()
    t.backups.photos.alice.Corbeille = { [DAY]: { 'a.jpg': 1 }, 'loose.jpg': 1 }
    const fake = createFake(t)
    const before = fake.dump()
    const targets = [ROOT + '/2026/09/a.jpg', `${BIN}/loose.jpg`, `${BIN}/${DAY}`, `${BIN}/not-a-day/x.jpg`, '/backups/photos/bob/2026/09/secret.jpg', `${BIN}/${DAY}/../../2026/09/a.jpg`, BIN]
    const report = await v.restoreTrashed(fake, ROOT, targets)
    assert.strictEqual(report.restored.length, 0)
    assert.strictEqual(report.failed.length, targets.length)
    assert.deepStrictEqual(fake.dump(), before)
  })

  await test('bin: trash then restore leaves every photo where it was', async () => {
    const fake = createFake(treeWithAlbum())
    const names = (await v.loadPhotos(fake, ROOT)).photos.map((p) => p.path).sort()
    const trashed = await v.trashPhotos(fake, ROOT, names, { today: TODAY })
    assert.strictEqual(trashed.failed.length, 0)
    assert.strictEqual((await v.loadPhotos(fake, ROOT)).photos.length, 0, 'the gallery is empty')
    const inBin = await v.loadTrash(fake, ROOT)
    assert.strictEqual(inBin.items.length, names.length)
    const restored = await v.restoreTrashed(fake, ROOT, inBin.items.map((i) => i.path))
    assert.strictEqual(restored.failed.length, 0)
    assert.deepStrictEqual((await v.loadPhotos(fake, ROOT)).photos.map((p) => p.path).sort(), names)
  })

  await test('bin: emptying deletes the day folders and nothing else in the bin', async () => {
    const t = vaultTree()
    t.backups.photos.alice.Corbeille = { '2026-09-01': { 'a.jpg': 1 }, '2026-10-01': { 'b.jpg': 1 }, 'keep.txt': 1, 'not-a-day': { 'c.jpg': 1 } }
    const fake = createFake(t)
    const result = await v.emptyTrash(fake, ROOT, { today: TODAY })
    assert.deepStrictEqual(result, { removed: 2, failed: 0 })
    const left = fake.dump()
    assert.ok(left.includes(`${BIN}/keep.txt`) && left.includes(`${BIN}/not-a-day/c.jpg`))
    assert.ok(!left.some((p) => p.startsWith(`${BIN}/2026-`)))
    assert.ok(left.includes(ROOT + '/2026/09/a.jpg'), 'live photos are not touched')
    assert.deepStrictEqual(await v.emptyTrash(createFake(vaultTree()), ROOT), { removed: 0, failed: 0 }, 'no bin, nothing to do')
  })

  await test('bin: photos are deleted for good only after 30 days', async () => {
    const t = vaultTree()
    t.backups.photos.alice.Corbeille = {
      '2026-09-02': { 'exactly30.jpg': 1 }, // 30 days before 2 October
      '2026-09-03': { 'day29.jpg': 1 },
      '2026-08-01': { 'older.jpg': 1 },
      '2026-10-02': { 'today.jpg': 1 },
      '2026-11-15': { 'future.jpg': 1 } // a clock that was wrong: never purged early
    }
    const fake = createFake(t)
    const result = await v.purgeExpiredTrash(fake, ROOT, TODAY)
    assert.deepStrictEqual(result, { removed: 2, failed: 0 })
    const left = (await v.loadTrash(fake, ROOT)).items.map((i) => i.name).sort()
    assert.deepStrictEqual(left, ['day29.jpg', 'future.jpg', 'today.jpg'])
  })

  await test('bin: a failing delete is counted and a lost session stops the purge', async () => {
    const t = vaultTree()
    t.backups.photos.alice.Corbeille = { '2026-07-01': { 'a.jpg': 1 }, '2026-07-02': { 'b.jpg': 1 }, '2026-07-03': { 'c.jpg': 1 } }
    const fake = createFake(t)
    fake.failures.remove[`${BIN}/2026-07-01`] = 500
    const result = await v.purgeExpiredTrash(fake, ROOT, TODAY)
    assert.deepStrictEqual(result, { removed: 2, failed: 1 })
    const stopped = createFake(t)
    stopped.failures.remove[`${BIN}/2026-07-02`] = 401
    const second = await v.purgeExpiredTrash(stopped, ROOT, TODAY)
    assert.strictEqual(second.removed, 1)
    assert.strictEqual(second.failed, 1)
    assert.strictEqual(only(stopped, 'remove').length, 2, 'stops after the 401')
  })

  await test('bin: day stamps and ages', () => {
    assert.strictEqual(v.dayStamp(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
    assert.strictEqual(v.dayStamp(TODAY), DAY)
    assert.strictEqual(v.daysInBin('2026-10-02', TODAY), 0)
    assert.strictEqual(v.daysInBin('2026-09-02', TODAY), 30)
    assert.strictEqual(v.daysInBin('2025-10-02', TODAY), 365)
    assert.strictEqual(v.daysInBin('2026-10-05', TODAY), -3)
    assert.strictEqual(v.daysInBin('hello', TODAY), null)
    assert.strictEqual(v.daysInBin('2026-1-2', TODAY), null)
    assert.strictEqual(v.TRASH_DAYS, 30)
  })
}
