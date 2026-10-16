package com.selfhosthub.wear.ui.common

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.sqrt

/**
 * A cover reduced to its outlines, for the always-on screen: an OLED pixel that is black is off, and a picture is a lot
 * of lit pixels all night. Only the edges of the cover (where it changes brightness) are drawn, thin and white on black,
 * inside a frame the shape of the thumbnail, so what is lit is a few lines and not an area.
 */
object CoverOutline {
    /** The edge image works on this many pixels a side: more would only find the cover's grain. */
    const val SIZE = 96

    /**
     * Sobel edges of an ARGB picture `w` by `h`: the result is white, its alpha is how strong the edge is (0 where the
     * picture is flat). `binary` (a low-bit display, with no shades) makes every edge fully lit or not lit at all.
     * The strongest edges set the scale, so a faint cover still shows its shapes and a busy one is not a white mass.
     */
    fun edges(argb: IntArray, w: Int, h: Int, binary: Boolean): IntArray {
        require(argb.size == w * h) { "a ${w}x$h picture has ${w * h} pixels, not ${argb.size}" }
        val out = IntArray(w * h)
        if (w < 3 || h < 3) return out
        val luma = FloatArray(w * h) { i ->
            val c = argb[i]
            (0.299f * ((c shr 16) and 0xFF) + 0.587f * ((c shr 8) and 0xFF) + 0.114f * (c and 0xFF)) / 255f
        }
        val magnitude = FloatArray(w * h)
        var strongest = 0f
        for (y in 1 until h - 1) {
            for (x in 1 until w - 1) {
                val i = y * w + x
                val gx = -luma[i - w - 1] - 2 * luma[i - 1] - luma[i + w - 1] + luma[i - w + 1] + 2 * luma[i + 1] + luma[i + w + 1]
                val gy = -luma[i - w - 1] - 2 * luma[i - w] - luma[i - w + 1] + luma[i + w - 1] + 2 * luma[i + w] + luma[i + w + 1]
                val m = sqrt(gx * gx + gy * gy)
                magnitude[i] = m
                strongest = max(strongest, m)
            }
        }
        // A flat picture has no edges to find, and its noise must not be stretched into some.
        if (strongest < MIN_STRENGTH) return out
        for (i in magnitude.indices) {
            val relative = magnitude[i] / strongest
            val alpha = if (binary) {
                if (relative >= BINARY_THRESHOLD) 255 else 0
            } else {
                // Below the floor nothing is drawn; above it the line grows to full strength.
                ((relative - FLOOR) / (FULL - FLOOR)).coerceIn(0f, 1f).let { (it * 255).toInt() }
            }
            if (alpha > 0) out[i] = (alpha shl 24) or 0xFFFFFF
        }
        return out
    }

    /** The edge picture of a cover, `SIZE` pixels a side. */
    fun of(cover: ImageBitmap, binary: Boolean): ImageBitmap {
        val androidBitmap = cover.asAndroidBitmap()
        val softwareBitmap = if (androidBitmap.config == Bitmap.Config.HARDWARE) {
            androidBitmap.copy(Bitmap.Config.ARGB_8888, false)
        } else {
            androidBitmap
        }
        val small = Bitmap.createScaledBitmap(softwareBitmap, SIZE, SIZE, true)
        val pixels = IntArray(SIZE * SIZE)
        small.getPixels(pixels, 0, SIZE, 0, 0, SIZE, SIZE)
        if (softwareBitmap !== androidBitmap) softwareBitmap.recycle()
        if (small !== androidBitmap && small !== softwareBitmap) small.recycle()
        val lines = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
        lines.setPixels(edges(pixels, SIZE, SIZE, binary), 0, SIZE, 0, 0, SIZE, SIZE)
        return lines.asImageBitmap()
    }

    private const val MIN_STRENGTH = 0.05f
    private const val BINARY_THRESHOLD = 0.3f
    private const val FLOOR = 0.12f
    private const val FULL = 0.6f
}

/**
 * The cover of the song as outlines inside a thin frame of the same shape: what the always-on screen shows of it. With
 * burn-in protection it is dimmer still.
 */
@Composable
fun OutlineCover(cover: ImageBitmap?, size: Dp, modifier: Modifier = Modifier, lowBit: Boolean = false, dim: Boolean = false) {
    var lines by remember(cover, lowBit) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(cover, lowBit) {
        lines = if (cover == null) null else withContext(Dispatchers.Default) { CoverOutline.of(cover, lowBit) }
    }
    val shape = RoundedCornerShape(size * 0.18f)
    Box(modifier.size(size).border(1.dp, Color(0xFF8A8A8A), shape)) {
        lines?.let {
            Image(
                bitmap = it,
                contentDescription = null,
                contentScale = ContentScale.FillBounds,
                filterQuality = if (lowBit) androidx.compose.ui.graphics.FilterQuality.None else androidx.compose.ui.graphics.FilterQuality.Medium,
                modifier = Modifier.fillMaxSize().alpha(if (dim) 0.65f else 1f)
            )
        }
    }
}
