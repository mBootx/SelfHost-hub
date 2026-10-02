const assert = require('assert')
const BS = String.fromCharCode(92)
const NUL = String.fromCharCode(0)

module.exports = async (v, test) => {
  const refused = (fn) => {
    try {
      fn()
    } catch (err) {
      assert.strictEqual(err.code, 'forbidden-path', 'wrong error: ' + err.message)
      return
    }
    assert.fail('was accepted')
  }

  await test('ordinary account names are left alone', () => {
    assert.strictEqual(v.sanitizeUsername('alice'), 'alice')
    assert.strictEqual(v.sanitizeUsername('john.doe'), 'john.doe')
    assert.strictEqual(v.sanitizeUsername('Jean Dupont'), 'Jean Dupont')
    assert.strictEqual(v.sanitizeUsername('marie-claire_2@mail.fr'), 'marie-claire_2@mail.fr')
    assert.strictEqual(v.sanitizeUsername('Éloïse'), 'Éloïse')
    assert.strictEqual(v.sanitizeUsername('日本語'), '日本語')
    assert.strictEqual(v.sanitizeUsername('  alice  '), 'alice')
  })

  await test('hostile account names cannot become a path component that escapes', () => {
    for (const name of ['..', '.', '../bob', 'a/b', 'a' + BS + 'b', '.hidden', 'trailing.', ' ', '~', 'a~b', 'x' + NUL + 'y', '/etc/passwd', '😀']) {
      let cleaned
      try {
        cleaned = v.sanitizeUsername(name)
      } catch (err) {
        assert.strictEqual(err.code, 'forbidden-path')
        continue
      }
      assert.ok(cleaned !== '.' && cleaned !== '..' && cleaned !== '', 'dot name from ' + JSON.stringify(name))
      assert.ok(!cleaned.includes('/') && !cleaned.includes(BS) && !cleaned.includes(NUL), 'separator left in ' + JSON.stringify(cleaned))
      assert.ok(!cleaned.startsWith('.'), 'hidden folder from ' + JSON.stringify(name))
    }
    refused(() => v.sanitizeUsername(''))
    refused(() => v.sanitizeUsername('x'.repeat(200)))
  })

  await test('two different accounts never share a folder', () => {
    const names = ['a/b', 'a_b', 'a~2f~b', 'a.b', 'a b', 'A/B', '../x', '~2e~~2e~/x']
    const seen = new Map()
    for (const name of names) {
      const cleaned = v.sanitizeUsername(name)
      assert.ok(!seen.has(cleaned), JSON.stringify(name) + ' collides with ' + JSON.stringify(seen.get(cleaned)))
      seen.set(cleaned, name)
    }
  })

  await test('the backup folder is built from the setting and the account', () => {
    assert.strictEqual(v.vaultRootFor(v.DEFAULT_BACKUP_FOLDER, 'alice'), '/backups/photos/alice')
    assert.strictEqual(v.vaultRootFor('/Sauvegardes/{user}/photos', 'bob'), '/Sauvegardes/bob/photos')
    assert.strictEqual(v.vaultRootFor('/Appareil photo', 'bob'), '/Appareil photo')
    assert.strictEqual(v.vaultRootFor('backups//photos/{user}/', 'alice'), '/backups/photos/alice')
    // a hostile account name stays one folder inside the central one
    const root = v.vaultRootFor(v.DEFAULT_BACKUP_FOLDER, '../bob')
    assert.ok(v.isInside('/backups/photos', root) && root.split('/').length === 4, root)
  })

  await test('a setting that tries to leave is refused', () => {
    refused(() => v.vaultRootFor('/backups/../etc/{user}', 'alice'))
    refused(() => v.vaultRootFor('/backups' + BS + 'photos/{user}', 'alice'))
    refused(() => v.vaultRootFor('/backups/%2e%2e/{user}', 'alice'))
    refused(() => v.vaultRootFor('/backups/photos/{user}' + NUL, 'alice'))
  })

  await test('the central folder is only known when the setting is organised by account', () => {
    assert.strictEqual(v.centralFolderOf(v.DEFAULT_BACKUP_FOLDER), '/backups/photos')
    assert.strictEqual(v.centralFolderOf('/a/{user}'), '/a')
    assert.strictEqual(v.centralFolderOf('/{user}'), null)
    assert.strictEqual(v.centralFolderOf('/Appareil photo'), null)
    assert.strictEqual(v.centralFolderOf('/a/{user}/b'), null)
  })

  const root = '/backups/photos/alice'

  await test('paths inside the folder are accepted and cleaned', () => {
    assert.strictEqual(v.resolveInside(root, root), root)
    assert.strictEqual(v.resolveInside(root, root + '/2026/09/IMG_1.jpg'), root + '/2026/09/IMG_1.jpg')
    assert.strictEqual(v.resolveInside(root, '//backups//photos/alice/./2026/'), root + '/2026')
    assert.strictEqual(v.resolveInside('/', '/anything/at/all'), '/anything/at/all')
  })

  await test('every way out of the folder is refused', () => {
    const attempts = [
      root + '/../bob/2026/x.jpg',
      root + '/2026/../../bob/x.jpg',
      '/backups/photos/bob/x.jpg',
      '/backups/photos',
      '/backups/photos/alicebob/x.jpg',
      '/backups/photos/alice2',
      '/backups/photos/ALICE/x.jpg',
      '/etc/passwd',
      '/',
      root + '/%2e%2e/bob',
      root + '/%2E%2E/bob',
      root + '/..%2fbob',
      root + '/2026%2f..%2f..%2fbob',
      root + '/%2e%2e%2fbob',
      '/backups/photos/alice%2f..%2fbob/x.jpg',
      root + '/2026' + BS + '..' + BS + 'bob',
      root + BS + '..' + BS + 'bob',
      root + '/x' + NUL + '.jpg',
      root + '/line' + String.fromCharCode(10) + 'break.jpg',
      root + '/' + 'a'.repeat(300)
    ]
    for (const attempt of attempts) {
      try {
        const resolved = v.resolveInside(root, attempt)
        assert.fail('accepted ' + JSON.stringify(attempt) + ' as ' + resolved)
      } catch (err) {
        assert.strictEqual(err.code, 'forbidden-path', JSON.stringify(attempt) + ' -> ' + err.message)
      }
    }
    assert.strictEqual(v.isInside(root, '/backups/photos/bob'), false)
    assert.strictEqual(v.isInside(root, root + '/2026/x.jpg'), true)
    assert.strictEqual(v.isInside(root, 42), false)
  })

  await test('photo and video extensions', () => {
    for (const name of ['a.jpg', 'A.JPG', 'b.jpeg', 'c.png', 'd.webp', 'e.heic', 'f.HEIF', 'g.gif', 'h.avif', 'i.bmp']) assert.ok(v.isPhotoName(name), name)
    for (const name of ['a.mp4', 'b.MOV', 'c.3gp', 'd.webm']) assert.ok(v.isVideoName(name) && !v.isPhotoName(name), name)
    for (const name of ['notes.txt', 'noext', '.jpg', 'jpg', 'a.jpg.exe', 'a.pdf']) assert.ok(!v.isPhotoName(name) && !v.isVideoName(name), name)
  })
}
