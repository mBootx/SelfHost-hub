package com.selfhosthub.wear.ui

import com.selfhosthub.wear.ui.common.CoverOutline
import com.selfhosthub.wear.ui.nowplaying.NowPlayingPage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val W = 40
private const val H = 40
private const val BLACK = 0xFF000000.toInt()
private const val WHITE = 0xFFFFFFFF.toInt()

private fun picture(pixel: (x: Int, y: Int) -> Int) = IntArray(W * H) { pixel(it % W, it / W) }
private fun IntArray.alphaAt(x: Int, y: Int) = (this[y * W + x] ushr 24) and 0xFF

class CoverOutlineTest {
    @Test
    fun `a flat cover has no outlines, whatever its colour`() {
        for (colour in listOf(BLACK, WHITE, 0xFF336699.toInt())) {
            assertTrue(CoverOutline.edges(picture { _, _ -> colour }, W, H, binary = false).all { it == 0 })
        }
    }

    @Test
    fun `an edge between a dark and a light half is outlined where it is and nowhere else`() {
        val edges = CoverOutline.edges(picture { x, _ -> if (x < W / 2) BLACK else WHITE }, W, H, binary = false)
        // On the boundary, away from the picture's own border: fully lit.
        for (y in 5 until H - 5) assertTrue("row $y at the boundary", edges.alphaAt(W / 2, y) > 200 || edges.alphaAt(W / 2 - 1, y) > 200)
        // Far from it, nothing is lit: a black pixel that is black stays off.
        for (y in 0 until H) {
            assertEquals(0, edges.alphaAt(5, y))
            assertEquals(0, edges.alphaAt(W - 6, y))
        }
    }

    @Test
    fun `the outlines are white, so on black they are the only thing lit`() {
        val edges = CoverOutline.edges(picture { x, _ -> if (x < W / 2) BLACK else WHITE }, W, H, binary = false)
        assertTrue(edges.filter { it != 0 }.all { (it and 0xFFFFFF) == 0xFFFFFF })
    }

    @Test
    fun `a low-bit display gets lines that are lit or not, with no shades`() {
        val gradient = picture { x, y -> val v = (x * 6 + (y % 7) * 3).coerceIn(0, 255); (0xFF shl 24) or (v shl 16) or (v shl 8) or v }
        val edges = CoverOutline.edges(gradient, W, H, binary = true)
        assertTrue(edges.all { (it ushr 24) == 0 || (it ushr 24) == 255 })
        assertTrue("something is drawn", edges.any { it != 0 })
    }

    @Test
    fun `a faint cover still shows its shapes, because the strongest edge sets the scale`() {
        val faint = CoverOutline.edges(picture { x, _ -> if (x < W / 2) 0xFF101010.toInt() else 0xFF303030.toInt() }, W, H, binary = false)
        assertTrue(faint.alphaAt(W / 2, 20) > 200 || faint.alphaAt(W / 2 - 1, 20) > 200)
    }

    @Test
    fun `a picture of the wrong size is refused and one too small has nothing to find`() {
        assertTrue(runCatching { CoverOutline.edges(IntArray(10), W, H, false) }.isFailure)
        assertFalse(CoverOutline.edges(IntArray(4), 2, 2, false).any { it != 0 })
    }

    @Test
    fun `the pages of Now Playing are the clock above the player above the options`() {
        assertEquals(listOf(0, 1, 2), listOf(NowPlayingPage.CLOCK, NowPlayingPage.PLAYER, NowPlayingPage.OPTIONS))
        assertEquals(3, NowPlayingPage.COUNT)
        assertEquals(NowPlayingPage.PLAYER, NowPlayingPage.current)
    }
}
