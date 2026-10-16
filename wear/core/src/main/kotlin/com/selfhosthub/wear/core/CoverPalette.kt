package com.selfhosthub.wear.core

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * The colours of the Now Playing screen for one cover, worked out from a small copy of it (the same reading as the
 * phone's player, mobile/src/services/coverColor.ts): the controls take another colourful colour of the cover when it
 * has one, else its own most vivid colour, lifted until it stands out on the dark screen; a black and white cover gets
 * white controls. Also how dark the veil over the blurred cover behind must be for white text to stay readable.
 *
 * Colours are ARGB ints, as android.graphics.Color and Compose's Color(Int) take them. Pure Kotlin: checked on the JVM.
 */
data class CoverColors(
    /** The controls: play button, seek bar, what is switched on. */
    val accent: Int,
    /** Icons on the accent: black or white, whichever reads better. */
    val onAccent: Int,
    /** True for a cover with no colour to speak of. */
    val grey: Boolean,
    /** How opaque (0 to 1) the black veil over the cover behind must be: the brighter the cover (its bright parts), the darker. */
    val veil: Float
)

object CoverPalette {
    private const val HUE_BINS = 24
    private const val MIN_COLOURED = 0.06
    private const val MIN_ACCENT = 0.02
    private const val OTHER_ACCENT_VIVID = 0.35
    private const val HUE_GAP = 45.0

    /** What the controls stand out against: the veiled cover, at its darkest about this. */
    private val BACKDROP = rgb(20, 20, 20)
    private val WHITE = rgb(255, 255, 255)
    private val BLACK = rgb(0, 0, 0)
    private val GREY_ACCENT = rgb(242, 242, 242)

    /** The colours for a cover from its pixels (ARGB, a 32 by 32 copy is plenty); null for no pixels. */
    fun from(pixels: IntArray): CoverColors? {
        if (pixels.isEmpty()) return null
        val count = DoubleArray(HUE_BINS)
        val weight = DoubleArray(HUE_BINS)
        val red = DoubleArray(HUE_BINS)
        val green = DoubleArray(HUE_BINS)
        val blue = DoubleArray(HUE_BINS)
        val vivid = DoubleArray(HUE_BINS)
        var coloured = 0
        for (pixel in pixels) {
            val r = (pixel shr 16) and 0xFF
            val g = (pixel shr 8) and 0xFF
            val b = pixel and 0xFF
            val hi = max(r, max(g, b)) / 255.0
            val lo = min(r, min(g, b)) / 255.0
            val saturation = if (hi == 0.0) 0.0 else (hi - lo) / hi
            if (saturation < 0.2 || hi < 0.15) continue
            coloured++
            val bin = (floor(hue(r, g, b) / (360.0 / HUE_BINS)).toInt()).mod(HUE_BINS)
            val w = 0.05 + saturation * hi
            count[bin] += 1.0
            weight[bin] += w
            red[bin] += r * w
            green[bin] += g * w
            blue[bin] += b * w
            vivid[bin] += saturation * hi
        }
        val total = pixels.size.toDouble()
        val veil = veilFor(brightLuminance(pixels))

        // Each hue with its two neighbours: one colour often straddles two bins.
        data class Group(val share: Double, val vivid: Double, val colour: Int, val hue: Double)
        val groups = (0 until HUE_BINS).map { i ->
            val prev = (i + HUE_BINS - 1) % HUE_BINS
            val next = (i + 1) % HUE_BINS
            val n = count[prev] + count[i] + count[next]
            val w = weight[prev] + weight[i] + weight[next]
            val colour = if (w > 0) rgb(
                ((red[prev] + red[i] + red[next]) / w).toInt(),
                ((green[prev] + green[i] + green[next]) / w).toInt(),
                ((blue[prev] + blue[i] + blue[next]) / w).toInt()
            ) else BLACK
            val v = vivid[prev] + vivid[i] + vivid[next]
            Group(n / total, if (n > 0) v / n else 0.0, colour, hue(colour))
        }
        fun striking(g: Group) = g.vivid * sqrt(g.share)
        val mostStriking = groups.filter { it.share >= MIN_ACCENT }.maxByOrNull(::striking)

        if (coloured / total < MIN_COLOURED) {
            val accent = mostStriking?.let { lifted(it.colour) } ?: GREY_ACCENT
            return CoverColors(accent, onColour(accent), grey = true, veil = veil)
        }
        val base = groups.maxBy { it.share * (0.25 + it.vivid) }
        val other = groups
            .filter { it.share >= MIN_ACCENT && it.vivid >= OTHER_ACCENT_VIVID && hueDistance(it.hue, base.hue) >= HUE_GAP }
            .maxByOrNull(::striking)
        val accent = lifted((other ?: mostStriking ?: base).colour)
        return CoverColors(accent, onColour(accent), grey = false, veil = veil)
    }

    /** The colour made vivid and light enough to stand out (3:1) on the dark screen, its hue kept. */
    fun lifted(colour: Int): Int {
        val (h, s, _) = hsl(colour)
        if (s < 0.15) return GREY_ACCENT
        val saturation = s.coerceIn(0.5, 0.95)
        var lightness = 0.6
        var result = fromHsl(h, saturation, lightness)
        while (contrast(result, BACKDROP) < 3.1 && lightness < 0.85) {
            lightness += 0.03
            result = fromHsl(h, saturation, lightness)
        }
        return result
    }

    fun onColour(colour: Int): Int = if (contrast(colour, BLACK) >= contrast(colour, WHITE)) BLACK else WHITE

    /**
     * How opaque the black veil over a cover this bright (see brightLuminance) must be for white text on it to keep 4.5:1:
     * never under half (the cover stays a backdrop, not the subject), never over 90 % (it must still show).
     */
    fun veilFor(luminance: Double): Float {
        // White on (1 - a) * L needs (1.05) / ((1 - a) * L + 0.05) >= 4.5, so (1 - a) * L <= 0.1833.
        val needed = if (luminance <= 0.0) 0.0 else 1.0 - 0.1833 / luminance
        return needed.coerceIn(0.5, 0.9).toFloat()
    }

    /**
     * How bright the bright parts of a cover are: the luminance 90 % of its pixels stay under. The text sits on any part
     * of it (a sun in the middle, say), so the average is not enough; the brightest tenth is left out, so that a small
     * white logo does not darken the whole screen.
     */
    fun brightLuminance(pixels: IntArray): Double {
        if (pixels.isEmpty()) return 0.0
        val lums = DoubleArray(pixels.size) { luminance(pixels[it]) }
        java.util.Arrays.sort(lums)
        return lums[((lums.size - 1) * 0.9).toInt()]
    }

    // --- Colour maths ---

    fun rgb(r: Int, g: Int, b: Int): Int = (0xFF shl 24) or (r.coerceIn(0, 255) shl 16) or (g.coerceIn(0, 255) shl 8) or b.coerceIn(0, 255)

    fun luminance(colour: Int): Double {
        fun channel(c: Int): Double {
            val v = c / 255.0
            return if (v <= 0.03928) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel((colour shr 16) and 0xFF) + 0.7152 * channel((colour shr 8) and 0xFF) + 0.0722 * channel(colour and 0xFF)
    }

    fun contrast(a: Int, b: Int): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    fun hueDistance(a: Double, b: Double): Double {
        val d = abs(a - b) % 360
        return if (d > 180) 360 - d else d
    }

    private fun hue(colour: Int): Double = hue((colour shr 16) and 0xFF, (colour shr 8) and 0xFF, colour and 0xFF)

    private fun hue(r: Int, g: Int, b: Int): Double = hsl(rgb(r, g, b)).first

    /** Hue in degrees, saturation and lightness from 0 to 1. */
    fun hsl(colour: Int): Triple<Double, Double, Double> {
        val r = ((colour shr 16) and 0xFF) / 255.0
        val g = ((colour shr 8) and 0xFF) / 255.0
        val b = (colour and 0xFF) / 255.0
        val hi = max(r, max(g, b))
        val lo = min(r, min(g, b))
        val l = (hi + lo) / 2
        if (hi == lo) return Triple(0.0, 0.0, l)
        val d = hi - lo
        val s = if (l > 0.5) d / (2 - hi - lo) else d / (hi + lo)
        val h = when (hi) {
            r -> (g - b) / d + (if (g < b) 6 else 0)
            g -> (b - r) / d + 2
            else -> (r - g) / d + 4
        }
        return Triple(h * 60, s, l)
    }

    fun fromHsl(h: Double, s: Double, l: Double): Int {
        val c = (1 - abs(2 * l - 1)) * s
        val x = c * (1 - abs((h / 60) % 2 - 1))
        val m = l - c / 2
        val (r, g, b) = when {
            h < 60 -> Triple(c, x, 0.0)
            h < 120 -> Triple(x, c, 0.0)
            h < 180 -> Triple(0.0, c, x)
            h < 240 -> Triple(0.0, x, c)
            h < 300 -> Triple(x, 0.0, c)
            else -> Triple(c, 0.0, x)
        }
        return rgb(Math.round((r + m) * 255).toInt(), Math.round((g + m) * 255).toInt(), Math.round((b + m) * 255).toInt())
    }
}
