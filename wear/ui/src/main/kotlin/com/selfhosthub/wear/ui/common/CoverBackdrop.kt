package com.selfhosthub.wear.ui.common

import android.graphics.Bitmap
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.wear.compose.material.MaterialTheme
import com.selfhosthub.wear.core.CoverColors
import com.selfhosthub.wear.core.CoverPalette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.min

/** A cover made ready to sit behind the player: a blurred copy of it, and the colours the controls take from it. */
class CoverLook(val blurred: ImageBitmap, val colours: CoverColors)

/** The side of the copy the colours are read from. */
private const val SAMPLE = 32
private const val BLUR_SIZE = 64
private const val BLUR_RADIUS = 7

/**
 * Three passes of a horizontal + vertical box filter on a 64x64 ARGB buffer, which converges to a smooth Gaussian blur
 * with no blocky bilinear grid lines and runs in well under a millisecond on any Wear OS version.
 */
private fun boxBlur(src: IntArray, dst: IntArray, w: Int, h: Int, radius: Int) {
    val div = 2 * radius + 1
    for (y in 0 until h) {
        val row = y * w
        var rSum = 0
        var gSum = 0
        var bSum = 0
        for (i in -radius..radius) {
            val p = src[row + i.coerceIn(0, w - 1)]
            rSum += (p ushr 16) and 0xFF
            gSum += (p ushr 8) and 0xFF
            bSum += p and 0xFF
        }
        for (x in 0 until w) {
            dst[row + x] = (0xFF shl 24) or ((rSum / div) shl 16) or ((gSum / div) shl 8) or (bSum / div)
            val outPx = src[row + (x - radius).coerceIn(0, w - 1)]
            val inPx = src[row + (x + radius + 1).coerceIn(0, w - 1)]
            rSum += ((inPx ushr 16) and 0xFF) - ((outPx ushr 16) and 0xFF)
            gSum += ((inPx ushr 8) and 0xFF) - ((outPx ushr 8) and 0xFF)
            bSum += (inPx and 0xFF) - (outPx and 0xFF)
        }
    }
    for (x in 0 until w) {
        var rSum = 0
        var gSum = 0
        var bSum = 0
        for (i in -radius..radius) {
            val p = dst[i.coerceIn(0, h - 1) * w + x]
            rSum += (p ushr 16) and 0xFF
            gSum += (p ushr 8) and 0xFF
            bSum += p and 0xFF
        }
        for (y in 0 until h) {
            src[y * w + x] = (0xFF shl 24) or ((rSum / div) shl 16) or ((gSum / div) shl 8) or (bSum / div)
            val outPx = dst[(y - radius).coerceIn(0, h - 1) * w + x]
            val inPx = dst[(y + radius + 1).coerceIn(0, h - 1) * w + x]
            rSum += ((inPx ushr 16) and 0xFF) - ((outPx ushr 16) and 0xFF)
            gSum += ((inPx ushr 8) and 0xFF) - ((outPx ushr 8) and 0xFF)
            bSum += (inPx and 0xFF) - (outPx and 0xFF)
        }
    }
}

/**
 * Works out the look of a cover: its colours from a small copy, and a smooth Gaussian-like blur made by running three
 * separable box-blur passes on a 64x64 copy, which costs under a millisecond and works on every Wear OS version.
 */
fun coverLookOf(image: ImageBitmap): CoverLook? {
    val bitmap = image.asAndroidBitmap()
    if (bitmap.width <= 0 || bitmap.height <= 0) return null
    val sample = Bitmap.createScaledBitmap(bitmap, SAMPLE, SAMPLE, true)
    val pixels = IntArray(SAMPLE * SAMPLE)
    sample.getPixels(pixels, 0, SAMPLE, 0, 0, SAMPLE, SAMPLE)
    if (sample !== bitmap) sample.recycle()
    val colours = CoverPalette.from(pixels) ?: return null
    val scaled = Bitmap.createScaledBitmap(bitmap, BLUR_SIZE, BLUR_SIZE, true)
    val buf = IntArray(BLUR_SIZE * BLUR_SIZE)
    val tmp = IntArray(BLUR_SIZE * BLUR_SIZE)
    scaled.getPixels(buf, 0, BLUR_SIZE, 0, 0, BLUR_SIZE, BLUR_SIZE)
    if (scaled !== bitmap) scaled.recycle()
    repeat(3) { boxBlur(buf, tmp, BLUR_SIZE, BLUR_SIZE, BLUR_RADIUS) }
    val blurred = Bitmap.createBitmap(buf, BLUR_SIZE, BLUR_SIZE, Bitmap.Config.ARGB_8888)
    return CoverLook(blurred.asImageBitmap(), colours)
}

/**
 * The look of the cover of the song playing. While the next song's cover is on its way the last look stays, so the
 * screen does not flash black between two songs; a song with no cover (`hasCover` false) has none.
 */
@Composable
fun rememberCoverLook(cover: ImageBitmap?, hasCover: Boolean): CoverLook? {
    val look by produceState<CoverLook?>(initialValue = null, cover, hasCover) {
        when {
            !hasCover -> value = null
            cover != null -> value = withContext(Dispatchers.Default) { runCatching { coverLookOf(cover) }.getOrNull() }
        }
    }
    return look
}

/**
 * The cover behind the whole screen, blurred, under a black veil as dark as it needs to be for white text to read
 * (darker towards the edge of the round screen), fading from one song's to the next. Black without a cover.
 */
@Composable
fun CoverBackdrop(look: CoverLook?, modifier: Modifier = Modifier) {
    Crossfade(targetState = look, animationSpec = tween(600), label = "cover-backdrop", modifier = modifier) { current ->
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            if (current != null) {
                Image(
                    bitmap = current.blurred,
                    contentDescription = null,
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Crop,
                    filterQuality = FilterQuality.High
                )
                val veil = current.colours.veil
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(Brush.radialGradient(0f to Color.Black.copy(alpha = veil), 1f to Color.Black.copy(alpha = min(0.95f, veil + 0.2f))))
                )
            }
        }
    }
}

/** The controls inside take the cover's colour (the theme's primary), or the app's green without one. */
@Composable
fun CoverTheme(colours: CoverColors?, content: @Composable () -> Unit) {
    if (colours == null) {
        content()
        return
    }
    val base = MaterialTheme.colors
    val accent = Color(colours.accent)
    val onAccent = Color(colours.onAccent)
    MaterialTheme(
        // On a cover the muted grey is too dim: secondary text (the artist, the times) is a light grey instead.
        colors = base.copy(
            primary = accent,
            primaryVariant = accent,
            secondary = accent,
            secondaryVariant = accent,
            onPrimary = onAccent,
            onSecondary = onAccent,
            onSurfaceVariant = Color(0xFFDDDDDD)
        ),
        typography = MaterialTheme.typography,
        shapes = MaterialTheme.shapes,
        content = content
    )
}
