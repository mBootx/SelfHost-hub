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

/**
 * Works out the look of a cover: its colours from a small copy, and a blur made by shrinking it to a few pixels and
 * stretching it back with smoothing, which costs next to nothing and works on every Wear OS version (a real blur
 * effect needs Android 12).
 */
fun coverLookOf(image: ImageBitmap): CoverLook? {
    val bitmap = image.asAndroidBitmap()
    if (bitmap.width <= 0 || bitmap.height <= 0) return null
    val sample = Bitmap.createScaledBitmap(bitmap, SAMPLE, SAMPLE, true)
    val pixels = IntArray(SAMPLE * SAMPLE)
    sample.getPixels(pixels, 0, SAMPLE, 0, 0, SAMPLE, SAMPLE)
    val colours = CoverPalette.from(pixels) ?: return null
    val tiny = Bitmap.createScaledBitmap(bitmap, 10, 10, true)
    val blurred = Bitmap.createScaledBitmap(tiny, 80, 80, true)
    if (sample !== bitmap) sample.recycle()
    if (tiny !== bitmap) tiny.recycle()
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
