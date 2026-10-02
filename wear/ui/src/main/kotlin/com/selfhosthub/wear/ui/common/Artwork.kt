package com.selfhosthub.wear.ui.common

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Icon
import com.selfhosthub.wear.data.ArtworkSize
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.ui.theme.WatchColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The covers already decoded, so a list that scrolls back does not decode them again. */
object ArtworkMemory {
    private val cache = LruCache<String, ImageBitmap>(48)

    fun get(key: String): ImageBitmap? = cache.get(key)

    fun put(key: String, bitmap: ImageBitmap) {
        cache.put(key, bitmap)
    }

    fun clear() = cache.evictAll()
}

/** Decodes a cover, scaled down by the largest power of two that keeps it at least `targetPixels` wide. */
fun decodeCover(bytes: ByteArray, targetPixels: Int): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0) return null
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= targetPixels) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
}

/** The cover for `coverId` at `size`: what is already decoded, else what is stored, else a download. Null while loading or without one. */
@Composable
fun rememberCover(graph: WatchGraph?, coverId: String?, size: ArtworkSize): ImageBitmap? {
    val key = coverId?.let { "$it@${size.pixels}" }
    var image by remember(key) { mutableStateOf(key?.let { ArtworkMemory.get(it) }) }
    LaunchedEffect(key, graph) {
        if (key == null || coverId == null || graph == null || image != null) return@LaunchedEffect
        val bytes = graph.artwork.get(coverId, size) ?: return@LaunchedEffect
        val decoded = withContext(Dispatchers.Default) { decodeCover(bytes, size.pixels) } ?: return@LaunchedEffect
        ArtworkMemory.put(key, decoded)
        image = decoded
    }
    return image
}

/** A cover in a rounded box, with a music note while there is none. */
@Composable
fun CoverBox(
    image: ImageBitmap?,
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(8.dp),
    grayscale: Boolean = false,
    contentDescription: String? = null
) {
    Box(modifier.clip(shape).background(WatchColors.SurfaceRaised), contentAlignment = Alignment.Center) {
        if (image != null) {
            Image(
                bitmap = image,
                contentDescription = contentDescription,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
                colorFilter = if (grayscale) ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) }) else null
            )
        } else {
            Icon(Icons.Filled.MusicNote, contentDescription = null, tint = WatchColors.OnSurfaceMuted, modifier = Modifier.fillMaxSize(0.5f))
        }
    }
}

@Composable
fun CoverBox(graph: WatchGraph?, coverId: String?, size: ArtworkSize, modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(8.dp)) {
    CoverBox(rememberCover(graph, coverId, size), modifier, shape)
}
