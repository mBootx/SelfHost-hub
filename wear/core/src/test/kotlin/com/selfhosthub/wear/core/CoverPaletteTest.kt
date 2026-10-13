package com.selfhosthub.wear.core

import com.selfhosthub.wear.core.CoverPalette.contrast
import com.selfhosthub.wear.core.CoverPalette.hsl
import com.selfhosthub.wear.core.CoverPalette.hueDistance
import com.selfhosthub.wear.core.CoverPalette.rgb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** A 32 by 32 cover made of colours in the given shares. */
private fun cover(vararg parts: Pair<Int, Double>): IntArray {
    val total = 32 * 32
    val out = ArrayList<Int>(total)
    parts.forEachIndexed { i, (colour, share) ->
        val n = if (i == parts.lastIndex) total - out.size else Math.round(total * share).toInt()
        repeat(n) { out.add(colour) }
    }
    return out.toIntArray()
}

private fun hueOf(colour: Int) = hsl(colour).first

private val RED = rgb(200, 30, 40)
private val TEAL = rgb(31, 138, 158)
private val YELLOW = rgb(242, 209, 107)
private val BROWN = rgb(90, 70, 60)
private val BLACK = rgb(8, 8, 10)
private val WHITE = rgb(245, 245, 245)
private val BACKDROP = rgb(20, 20, 20)

class CoverPaletteTest {
    @Test
    fun `a red cover gets red controls`() {
        val colours = CoverPalette.from(cover(RED to 0.8, BLACK to 0.1, WHITE to 0.1))!!
        assertTrue(hueDistance(hueOf(colours.accent), 356.0) < 12)
        assertFalse(colours.grey)
    }

    @Test
    fun `a teal cover with a yellow sun gets yellow controls, the other colour of the cover`() {
        val colours = CoverPalette.from(cover(TEAL to 0.65, YELLOW to 0.3, WHITE to 0.05))!!
        assertTrue("accent ${Integer.toHexString(colours.accent)}", hueDistance(hueOf(colours.accent), hueOf(YELLOW)) < 12)
    }

    @Test
    fun `a dull second colour does not take the controls`() {
        val colours = CoverPalette.from(cover(TEAL to 0.6, BROWN to 0.35, WHITE to 0.05))!!
        assertTrue(hueDistance(hueOf(colours.accent), hueOf(TEAL)) < 12)
    }

    @Test
    fun `black and white is grey, with near white controls and black icons on them`() {
        val colours = CoverPalette.from(cover(BLACK to 0.6, WHITE to 0.4))!!
        assertTrue(colours.grey)
        assertEquals(rgb(242, 242, 242), colours.accent)
        assertEquals(rgb(0, 0, 0), colours.onAccent)
    }

    @Test
    fun `a dark cover with a small red logo stays grey but the logo gives the controls their colour`() {
        val colours = CoverPalette.from(cover(BLACK to 0.96, RED to 0.04))!!
        assertTrue(colours.grey)
        assertTrue(hueDistance(hueOf(colours.accent), 356.0) < 12)
    }

    @Test
    fun `no pixels, no colours`() {
        assertNull(CoverPalette.from(IntArray(0)))
    }

    @Test
    fun `whatever the cover, the controls stand out on the dark screen and their icons on them`() {
        val random = Random(7)
        repeat(400) {
            val colour = { rgb(random.nextInt(256), random.nextInt(256), random.nextInt(256)) }
            val colours = CoverPalette.from(cover(colour() to 0.5, colour() to 0.3, colour() to 0.2))!!
            assertTrue("accent ${Integer.toHexString(colours.accent)}", contrast(colours.accent, BACKDROP) >= 3)
            assertTrue("icons on ${Integer.toHexString(colours.accent)}", contrast(colours.onAccent, colours.accent) >= 4.5)
        }
    }

    @Test
    fun `the veil keeps white text readable on any cover, and the cover still shows`() {
        for (luminance in listOf(0.0, 0.05, 0.2, 0.4, 0.7, 1.0)) {
            val veil = CoverPalette.veilFor(luminance)
            assertTrue(veil in 0.5f..0.9f)
            val behind = (1 - veil) * luminance
            assertTrue("luminance $luminance veil $veil", 1.05 / (behind + 0.05) >= 4.5 || veil == 0.9f)
        }
        assertEquals(0.5f, CoverPalette.veilFor(0.1))
        assertTrue(CoverPalette.veilFor(1.0) > CoverPalette.veilFor(0.4))
    }

    @Test
    fun `a white cover gets the darkest veil, a black one the lightest`() {
        val white = CoverPalette.from(cover(rgb(255, 255, 255) to 1.0))!!
        val black = CoverPalette.from(cover(rgb(0, 0, 0) to 1.0))!!
        // Pure white needs about 82 % for 4.5:1, which is the darkest any cover needs.
        assertEquals(0.8167f, white.veil, 0.001f)
        assertEquals(0.5f, black.veil)
    }

    @Test
    fun `a bright sun behind the title darkens the veil, a small white logo does not`() {
        val sun = CoverPalette.from(cover(TEAL to 0.65, YELLOW to 0.35))!!
        val skyAlone = CoverPalette.from(cover(TEAL to 1.0))!!
        assertTrue("sun ${sun.veil} vs sky ${skyAlone.veil}", sun.veil > skyAlone.veil + 0.1f)
        // White text over the sun itself, veiled: still 4.5:1.
        val behind = (1 - sun.veil) * CoverPalette.luminance(YELLOW)
        assertTrue(1.05 / (behind + 0.05) >= 4.5)
        val logo = CoverPalette.from(cover(TEAL to 0.95, rgb(255, 255, 255) to 0.05))!!
        assertEquals(skyAlone.veil, logo.veil, 0.001f)
    }

    @Test
    fun `lifting keeps the hue and reaches 3 to 1 on the dark screen`() {
        for (colour in listOf(rgb(20, 10, 90), rgb(90, 10, 10), rgb(10, 60, 10), rgb(240, 220, 40))) {
            val lifted = CoverPalette.lifted(colour)
            assertTrue(hueDistance(hueOf(lifted), hueOf(colour)) < 10)
            assertTrue(contrast(lifted, BACKDROP) >= 3)
        }
    }
}
