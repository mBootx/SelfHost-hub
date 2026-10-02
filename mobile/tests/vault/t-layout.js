const assert = require('assert')

const photo = (name, year, month, size = 100, modified = 0) => ({ path: '/r/' + name, name, size, modified, year, month })
const names = (list) => list.map((p) => p.name)

module.exports = async (v, test) => {
  const sample = () => [
    photo('b.jpg', 2026, 8, 300, 5),
    photo('a.jpg', 2026, 9, 100, 1),
    photo('c.jpg', 2025, 12, 200, 9),
    photo('d.jpg', 2026, 9, 500, 7),
    photo('stray.jpg', null, null, 50, 99)
  ]

  await test('newest first follows the month folders, then time, and puts strays last', () => {
    assert.deepStrictEqual(names(v.sortPhotos(sample(), 'newest')), ['d.jpg', 'a.jpg', 'b.jpg', 'c.jpg', 'stray.jpg'])
  })

  await test('oldest first is the exact reverse', () => {
    assert.deepStrictEqual(names(v.sortPhotos(sample(), 'oldest')), ['stray.jpg', 'c.jpg', 'b.jpg', 'a.jpg', 'd.jpg'])
  })

  await test('names sort the way people count: IMG_2 before IMG_10', () => {
    const list = ['IMG_10.jpg', 'IMG_2.jpg', 'img_1.jpg', 'Ébène.jpg', 'zèbre.jpg'].map((n) => photo(n, 2026, 1))
    assert.deepStrictEqual(names(v.sortPhotos(list, 'name-asc')), ['Ébène.jpg', 'img_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg', 'zèbre.jpg'])
    assert.deepStrictEqual(names(v.sortPhotos(list, 'name-desc')).reverse(), names(v.sortPhotos(list, 'name-asc')))
  })

  await test('by size, both ways, and the input is left alone', () => {
    const input = sample()
    const before = names(input)
    assert.deepStrictEqual(names(v.sortPhotos(input, 'largest')).slice(0, 2), ['d.jpg', 'b.jpg'])
    assert.deepStrictEqual(names(v.sortPhotos(input, 'smallest')).slice(0, 2), ['stray.jpg', 'a.jpg'])
    assert.deepStrictEqual(names(input), before)
  })

  await test('search matches every word, ignoring case and accents', () => {
    const list = ['Été_plage.jpg', 'ete_montagne.jpg', 'hiver_plage.jpg', 'IMG_0001.jpg'].map((n) => photo(n, 2026, 1))
    assert.deepStrictEqual(names(v.filterPhotos(list, 'ete')), ['Été_plage.jpg', 'ete_montagne.jpg'])
    assert.deepStrictEqual(names(v.filterPhotos(list, 'PLAGE ÉTÉ')), ['Été_plage.jpg'])
    assert.deepStrictEqual(names(v.filterPhotos(list, 'nothing')), [])
    assert.strictEqual(v.filterPhotos(list, '   '), list)
  })

  await test('the grid groups by month under headers, three to a row', () => {
    const list = v.sortPhotos(sample().concat([photo('e.jpg', 2026, 9), photo('f.jpg', 2026, 9)]), 'newest')
    const rows = v.buildRows(list, 3, true)
    const summary = rows.map((r) => (r.kind === 'header' ? r.title + ' (' + r.count + ')' : r.photos.length + '@' + r.firstIndex))
    assert.deepStrictEqual(summary, ['Septembre 2026 (4)', '3@0', '1@3', 'Août 2026 (1)', '1@4', 'Décembre 2025 (1)', '1@5', 'Autres photos (1)', '1@6'])
    const keys = rows.map((r) => r.key)
    assert.strictEqual(new Set(keys).size, keys.length, 'row keys must be unique')
  })

  await test('any other order is one plain run with no headers', () => {
    const rows = v.buildRows(v.sortPhotos(sample(), 'name-asc'), 2, false)
    assert.ok(rows.every((r) => r.kind === 'photos'))
    assert.deepStrictEqual(rows.map((r) => r.photos.length), [2, 2, 1])
    assert.deepStrictEqual(rows.map((r) => r.firstIndex), [0, 2, 4])
    assert.deepStrictEqual(v.buildRows([], 3, true), [])
  })

  await test('sizes are readable', () => {
    assert.strictEqual(v.formatSize(0), '-')
    assert.strictEqual(v.formatSize(512), '512 o')
    assert.strictEqual(v.formatSize(2048), '2.0 Ko')
    assert.strictEqual(v.formatSize(5 * 1024 * 1024 + 300000), '5.3 Mo')
  })
}
