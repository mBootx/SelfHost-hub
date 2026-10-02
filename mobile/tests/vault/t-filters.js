const assert = require('assert')

const photo = (name, album, kind = 'photo') => ({ name, path: `/r/${album ?? ''}/${name}`, album, kind, year: 2026, month: 9, modified: 1, size: 1 })

module.exports = async (v, test) => {
  const all = [photo('a.jpg', null), photo('b.jpg', null), photo('c.mp4', null, 'video'), photo('s.png', 'Screenshots'), photo('w.jpg', 'WhatsApp Images'), photo('r.mp4', 'Screenshots', 'video')]

  await test('filters: photos, videos or both', () => {
    assert.strictEqual(v.filterByKind(all, 'all').length, 6)
    assert.deepStrictEqual(v.filterByKind(all, 'photo').map((p) => p.name), ['a.jpg', 'b.jpg', 's.png', 'w.jpg'])
    assert.deepStrictEqual(v.filterByKind(all, 'video').map((p) => p.name), ['c.mp4', 'r.mp4'])
  })

  await test('filters: one album, the camera alone, or all', () => {
    assert.strictEqual(v.filterByAlbum(all, v.ALL_ALBUMS).length, 6)
    assert.deepStrictEqual(v.filterByAlbum(all, v.CAMERA_ALBUM).map((p) => p.name), ['a.jpg', 'b.jpg', 'c.mp4'])
    assert.deepStrictEqual(v.filterByAlbum(all, 'Screenshots').map((p) => p.name), ['s.png', 'r.mp4'])
    assert.deepStrictEqual(v.filterByAlbum(all, 'Nothing'), [])
  })

  await test('filters: album chips list the camera first and the others by name, with their counts', () => {
    const chips = v.albumChips(all)
    assert.deepStrictEqual(chips.map((c) => [c.label, c.count]), [['Tous les albums', 6], ['Appareil photo', 3], ['Screenshots', 2], ['WhatsApp Images', 1]])
    assert.deepStrictEqual(chips.map((c) => c.id), [v.ALL_ALBUMS, v.CAMERA_ALBUM, 'Screenshots', 'WhatsApp Images'])
  })

  await test('filters: no album chips while everything is in one place', () => {
    assert.deepStrictEqual(v.albumChips(all.filter((p) => p.album === null)), [])
    assert.deepStrictEqual(v.albumChips(all.filter((p) => p.album === 'Screenshots')), [])
    assert.deepStrictEqual(v.albumChips([]), [])
    // An account that only backs up an album (no camera photos) with another one still gets chips, without a camera chip.
    const chips = v.albumChips(all.filter((p) => p.album !== null))
    assert.deepStrictEqual(chips.map((c) => c.label), ['Tous les albums', 'Screenshots', 'WhatsApp Images'])
  })

  await test('filters: the count says photos and videos, leaving out what there is none of', () => {
    assert.strictEqual(v.countLabel(all), '4 photos · 2 vidéos')
    assert.strictEqual(v.countLabel(all.slice(0, 1)), '1 photo')
    assert.strictEqual(v.countLabel([all[2]]), '1 vidéo')
    assert.strictEqual(v.countLabel(all.filter((p) => p.kind === 'video')), '2 vidéos')
    assert.strictEqual(v.countLabel([]), '0 photo')
    assert.strictEqual(v.countLabel([all[0], all[2], all[5]]), '1 photo · 2 vidéos')
  })

  await test('filters: the search still works on top of the others', () => {
    const found = v.filterPhotos(v.filterByKind(all, 'video'), 'R.MP4')
    assert.deepStrictEqual(found.map((p) => p.name), ['r.mp4'])
  })

  await test('bin grid: a header per day, then its files in rows, indexes counted over the whole list', () => {
    const item = (name, trashedOn) => ({ name, trashedOn, path: '/b/' + trashedOn + '/' + name, kind: 'photo', size: 1, modified: 1, originalPath: '/r/' + name })
    const items = [item('a', '2026-10-01'), item('b', '2026-10-01'), item('c', '2026-10-01'), item('d', '2026-09-20')]
    const rows = v.buildTrashRows(items, 2)
    assert.deepStrictEqual(rows.map((r) => r.kind), ['header', 'items', 'items', 'header', 'items'])
    assert.deepStrictEqual(rows.filter((r) => r.kind === 'items').map((r) => [r.firstIndex, r.items.map((i) => i.name)]), [[0, ['a', 'b']], [2, ['c']], [3, ['d']]])
    assert.deepStrictEqual(rows.filter((r) => r.kind === 'header').map((r) => [r.day, r.count]), [['2026-10-01', 3], ['2026-09-20', 1]])
    assert.strictEqual(new Set(rows.map((r) => r.key)).size, rows.length, 'row keys are unique')
    assert.deepStrictEqual(v.buildTrashRows([], 3), [])
  })

  await test('bin grid: days are written and counted down for the user', () => {
    const today = new Date(2026, 9, 2)
    assert.strictEqual(v.formatBinDay('2026-10-01'), '01/10/2026')
    assert.strictEqual(v.binTimeLeft('2026-10-02', today), 'il reste 30 jours')
    assert.strictEqual(v.binTimeLeft('2026-09-04', today), 'il reste 2 jours')
    assert.strictEqual(v.binTimeLeft('2026-09-03', today), 'il reste 1 jour')
    assert.strictEqual(v.binTimeLeft('2026-09-02', today), 'sera supprimé très bientôt')
    assert.strictEqual(v.binTimeLeft('2026-01-01', today), 'sera supprimé très bientôt')
    assert.strictEqual(v.binTimeLeft('garbage', today), '')
  })
}
