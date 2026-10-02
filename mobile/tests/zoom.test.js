// The zoom arithmetic of the photo viewer: what stays under the fingers, and that the picture can't be lost.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')

const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message || ''} ${a} vs ${b}`)
const BOX = { width: 400, height: 800 }

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'zoom.ts')
  fs.writeFileSync(entry, "export * from '@/services/zoomMath'" + String.fromCharCode(10))
  const z = require(await bundle(entry, {}, path.join(bundle.OUT, 'zoom.js')))
  const tests = []
  const test = (name, fn) => tests.push([name, fn])

  test('a picture is fitted whole into the box, and an unknown size takes the box', () => {
    assert.deepStrictEqual(z.fitSize({ width: 4000, height: 3000 }, BOX), { width: 400, height: 300 })
    assert.deepStrictEqual(z.fitSize({ width: 1000, height: 4000 }, BOX), { width: 200, height: 800 })
    assert.deepStrictEqual(z.fitSize(null, BOX), BOX)
    assert.deepStrictEqual(z.fitSize({ width: 0, height: 10 }, BOX), BOX)
  })

  test('the point under the fingers stays under the fingers while zooming', () => {
    const start = { scale: 1, x: 0, y: 0 }
    const shown = { width: 400, height: 800 }
    for (const [fx, fy, factor] of [[100, -200, 2], [-150, 300, 3], [0, 0, 1.7], [190, 390, 2.2]]) {
      const view = z.pinchTo(start, factor, { x: fx, y: fy }, { x: fx, y: fy }, shown, BOX)
      // The content point under the finger before: p = (f - offset) / scale. After: it must be at the same place.
      const px = (fx - start.x) / start.scale
      const py = (fy - start.y) / start.scale
      near(view.x + view.scale * px, fx, 'x of ' + [fx, fy, factor])
      near(view.y + view.scale * py, fy, 'y of ' + [fx, fy, factor])
    }
  })

  test('the picture follows the fingers as they move while pinching', () => {
    const shown = BOX
    const start = { scale: 2, x: 0, y: 0 }
    // Fingers spread by 1.5 and their middle moves from (100, 100) to (130, 90): the point first under them goes along.
    const view = z.pinchTo(start, 1.5, { x: 100, y: 100 }, { x: 130, y: 90 }, shown, BOX)
    const px = (100 - start.x) / start.scale
    const py = (100 - start.y) / start.scale
    near(view.x + view.scale * px, 130, 'x follows')
    near(view.y + view.scale * py, 90, 'y follows')
    // Same scale, middle only moving: a plain drag.
    const drag = z.pinchTo(start, 1, { x: 100, y: 100 }, { x: 130, y: 90 }, shown, BOX)
    assert.deepStrictEqual([drag.x, drag.y], [30, -10])
  })

  test('the scale stays between fit and five times', () => {
    const shown = BOX
    const o = { x: 0, y: 0 }
    assert.strictEqual(z.pinchTo({ scale: 1, x: 0, y: 0 }, 0.3, o, o, shown, BOX).scale, 1)
    assert.strictEqual(z.pinchTo({ scale: 1, x: 0, y: 0 }, 40, o, o, shown, BOX).scale, 5)
    assert.strictEqual(z.pinchTo({ scale: 4, x: 0, y: 0 }, 2, o, o, shown, BOX).scale, 5)
    assert.strictEqual(z.pinchTo({ scale: 2, x: 0, y: 0 }, 0.1, o, o, shown, BOX).scale, 1)
  })

  test('the picture can never be dragged so far that a gap shows', () => {
    const shown = { width: 400, height: 300 } // a landscape photo letterboxed in the box
    // Scale 2: 800 wide in a 400 box -> 200 each way; 600 high in an 800 box -> none (still smaller than the box).
    const dragged = z.panTo({ scale: 2, x: 0, y: 0 }, 5000, -5000, shown, BOX)
    assert.deepStrictEqual([dragged.x, dragged.y], [200, 0])
    const back = z.panTo({ scale: 2, x: 200, y: 0 }, -5000, 5000, shown, BOX)
    assert.deepStrictEqual([back.x, back.y], [-200, 0])
    const small = z.panTo({ scale: 1, x: 0, y: 0 }, 50, 50, shown, BOX)
    assert.deepStrictEqual([small.x, small.y], [0, 0], 'not zoomed: nothing to drag')
  })

  test('zooming out re-centres a picture that no longer fills the box', () => {
    const shown = BOX
    const f = { x: 150, y: 250 }
    const zoomed = z.pinchTo({ scale: 1, x: 0, y: 0 }, 3, f, f, shown, BOX)
    assert.ok(zoomed.x !== 0 || zoomed.y !== 0)
    const out = z.pinchTo(zoomed, 1 / 3, f, f, shown, BOX)
    near(out.scale, 1)
    near(out.x, 0)
    near(out.y, 0)
  })

  test('a double tap zooms in on the spot, and a second one goes back to fit', () => {
    const fit = { scale: 1, x: 0, y: 0 }
    const shown = BOX
    const zoomed = z.doubleTapTo(fit, 100, 200, shown, BOX)
    assert.strictEqual(zoomed.scale, z.DOUBLE_TAP_SCALE)
    near(zoomed.x + zoomed.scale * 100, 100, 'x stays under the tap')
    near(zoomed.y + zoomed.scale * 200, 200, 'y stays under the tap')
    assert.deepStrictEqual(z.doubleTapTo(zoomed, 0, 0, shown, BOX), { scale: 1, x: 0, y: 0 })
    assert.strictEqual(z.doubleTapScale(1.01), z.DOUBLE_TAP_SCALE, 'barely zoomed counts as fit')
    assert.strictEqual(z.doubleTapScale(1.5), 1)
  })

  test('a double tap near the edge keeps the picture inside the box', () => {
    const shown = { width: 400, height: 300 }
    const view = z.doubleTapTo({ scale: 1, x: 0, y: 0 }, 195, 0, shown, BOX)
    const limit = z.maxOffset(shown.width, view.scale, BOX.width)
    assert.ok(Math.abs(view.x) <= limit + 1e-9, `${view.x} beyond ${limit}`)
  })

  test('bad input does not produce NaN', () => {
    assert.strictEqual(z.offsetAfterZoom(10, 10, 5, 0, 2), 0)
    const view = z.pinchTo({ scale: 1, x: 0, y: 0 }, 1, { x: 0, y: 0 }, { x: 0, y: 0 }, z.fitSize(null, BOX), BOX)
    assert.ok(Number.isFinite(view.x) && Number.isFinite(view.y) && Number.isFinite(view.scale))
  })

  let failed = 0
  for (const [name, fn] of tests) {
    try {
      fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + '\n     ' + (err && err.message ? err.message : err))
    }
  }
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' zoom tests passed')
  process.exit(failed ? 1 : 0)
})()
