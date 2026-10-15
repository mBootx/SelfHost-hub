// Picking several songs in a list (store/selectionStore.ts): the order they were picked in, "Tout sélectionner", and
// the selection ending when asked to.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')

const NL = String.fromCharCode(10)
const tests = []
const test = (name, fn) => tests.push([name, fn])
let store

const song = (id) => ({ id, title: 'Titre ' + id, artist: 'A', duration: 200 })
const ids = () => store.getState().picked.map((s) => s.id)
const fresh = () => {
  store.getState().clear()
  store.getState().setPool([])
}

test('starting with a song picks it and turns the selection on; starting empty only turns it on', () => {
  fresh()
  store.getState().start(song('a'))
  assert.deepStrictEqual([store.getState().active, ids()], [true, ['a']])
  fresh()
  store.getState().start()
  assert.deepStrictEqual([store.getState().active, ids()], [true, []])
})

test('a tap picks, a second tap unpicks, and the order is the order of picking', () => {
  fresh()
  store.getState().start()
  for (const id of ['c', 'a', 'b']) store.getState().toggle(song(id))
  assert.deepStrictEqual(ids(), ['c', 'a', 'b'])
  store.getState().toggle(song('a'))
  assert.deepStrictEqual(ids(), ['c', 'b'])
  assert.strictEqual(store.getState().ids.a, undefined)
  assert.strictEqual(store.getState().ids.c, true)
})

test('unpicking the last song leaves the selection on, so the bar stays for picking more', () => {
  fresh()
  store.getState().start(song('a'))
  store.getState().toggle(song('a'))
  assert.deepStrictEqual([store.getState().active, ids()], [true, []])
})

test('select all adds the rest of the list after what was already picked, each song once', () => {
  fresh()
  store.getState().setPool(['a', 'b', 'c', 'd'].map(song))
  store.getState().start(song('c'))
  store.getState().selectAll()
  assert.deepStrictEqual(ids(), ['c', 'a', 'b', 'd'])
  store.getState().selectAll()
  assert.deepStrictEqual(ids(), ['c', 'a', 'b', 'd'])
})

test('select all from a bare "Sélectionner" starts the selection too', () => {
  fresh()
  store.getState().setPool(['a', 'b'].map(song))
  store.getState().selectAll()
  assert.deepStrictEqual([store.getState().active, ids()], [true, ['a', 'b']])
})

test('clearing ends the selection and forgets what was picked, but not the list on screen', () => {
  fresh()
  store.getState().setPool(['a', 'b'].map(song))
  store.getState().start(song('a'))
  store.getState().clear()
  assert.deepStrictEqual([store.getState().active, ids(), Object.keys(store.getState().ids)], [false, [], []])
  assert.strictEqual(store.getState().pool.length, 2)
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'selection.ts')
  fs.writeFileSync(entry, "export { useSelectionStore } from '@/store/selectionStore'" + NL)
  store = require(await bundle(entry, {}, path.join(bundle.OUT, 'selection.js'))).useSelectionStore
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + NL + '     ' + String(err && err.stack ? err.stack : err).split(NL).slice(0, 6).join(NL + '     '))
    }
  }
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' selection tests passed')
  process.exit(failed ? 1 : 0)
})()
