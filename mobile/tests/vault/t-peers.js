const assert = require('assert')

module.exports = async (v, test) => {
  const folder = (name) => ({ name, path: '/backups/photos/' + name, size: 0, isDir: true, modified: '' })
  const items = [folder('alice'), folder('bob'), folder('carol'), { name: 'readme.txt', path: '/backups/photos/readme.txt', size: 3, isDir: false, modified: '' }]
  const names = (list) => list.map((i) => i.name)

  await test('inside the central folder an account sees only its own folder', () => {
    assert.deepStrictEqual(names(v.hidePeerFolders(items, '/backups/photos', v.DEFAULT_BACKUP_FOLDER, 'alice')), ['alice', 'readme.txt'])
    assert.deepStrictEqual(names(v.hidePeerFolders(items, '/backups/photos/', v.DEFAULT_BACKUP_FOLDER, 'bob')), ['bob', 'readme.txt'])
  })

  await test('nothing is hidden anywhere else', () => {
    assert.strictEqual(v.hidePeerFolders(items, '/backups', v.DEFAULT_BACKUP_FOLDER, 'alice'), items)
    assert.strictEqual(v.hidePeerFolders(items, '/backups/photos/alice', v.DEFAULT_BACKUP_FOLDER, 'alice'), items)
    assert.strictEqual(v.hidePeerFolders(items, '/backups/photos', '/Appareil photo', 'alice'), items)
    assert.strictEqual(v.hidePeerFolders(items, '/', '/{user}', 'alice'), items)
  })

  await test('a name that cannot be a folder hides nothing and breaks nothing', () => {
    assert.strictEqual(v.hidePeerFolders(items, '/backups/photos', v.DEFAULT_BACKUP_FOLDER, ''), items)
    assert.strictEqual(v.hidePeerFolders(items, '/backups/photos', '/a/../{user}', 'alice'), items)
  })
}
