package expo.modules.audio.service

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Cover art for the lock screen, the media notification and Samsung's Now Bar.
 *
 * Media3 can fetch an artwork URL by itself, but it publishes the track without a cover first and adds
 * the picture whenever its own download ends, which is too late for a card that was already drawn. Covers
 * are loaded here instead and kept for a while: one that is in memory goes out together with the title,
 * so a song is never shown next to the previous song's picture, or none. [prefetch] warms the cover of
 * the track that comes next, which makes a skip show its cover straight away.
 *
 * Every cover is scaled to at most [MAX_SIDE_PX] and re-encoded, so what reaches the system is small and
 * in a format Android is sure to decode, whatever the server sent.
 */
object NowPlayingArtwork {
  /** A cover ready to hand to the system: [bytes] for the media session, [bitmap] for the notification. */
  class Art(val bytes: ByteArray, val bitmap: Bitmap)

  private const val MAX_ENTRIES = 8
  private const val MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024
  /** Plenty for a notification or the Now Bar, and keeps the cache to a few MB of bitmaps. */
  private const val MAX_SIDE_PX = 512
  private const val CONNECT_TIMEOUT_MS = 8_000
  private const val READ_TIMEOUT_MS = 15_000
  /** After a failed download the same URL isn't tried again for this long. */
  private const val RETRY_AFTER_MS = 15_000L

  private val mainHandler = Handler(Looper.getMainLooper())
  private val executor = Executors.newFixedThreadPool(2) { task ->
    Thread(task, "NowPlayingArtwork").apply { isDaemon = true }
  }

  // Everything below is touched from the main thread only.
  private val cache = object : LinkedHashMap<String, Art>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Art>?): Boolean = size > MAX_ENTRIES
  }
  private val waiting = HashMap<String, MutableList<(Art?) -> Unit>>()
  private val failedAt = HashMap<String, Long>()

  /** The cover if it is already in memory. Main thread only. */
  fun peek(url: String): Art? = cache[url]

  /**
   * Calls [callback] on the main thread with the cover, or null if it can't be had. Downloads it unless it
   * is cached or already on its way; asking again while it downloads shares that one download.
   */
  fun request(url: String, callback: ((Art?) -> Unit)? = null) {
    runOnMain {
      val cached = cache[url]
      if (cached != null) {
        callback?.invoke(cached)
        return@runOnMain
      }
      val pending = waiting[url]
      if (pending != null) {
        if (callback != null) pending.add(callback)
        return@runOnMain
      }
      val failure = failedAt[url]
      if (failure != null && SystemClock.elapsedRealtime() - failure < RETRY_AFTER_MS) {
        callback?.invoke(null)
        return@runOnMain
      }
      waiting[url] = if (callback != null) mutableListOf(callback) else mutableListOf()
      executor.execute {
        val art = try {
          download(url)
        } catch (e: Throwable) {
          // Network trouble, or a picture too big to decode: no cover is better than a crash.
          null
        }
        mainHandler.post { finish(url, art) }
      }
    }
  }

  /** Starts loading a cover nobody is waiting for yet. Safe to call from any thread. */
  fun prefetch(url: String) = request(url, null)

  private fun finish(url: String, art: Art?) {
    if (art != null) {
      cache[url] = art
      failedAt.remove(url)
    } else {
      failedAt[url] = SystemClock.elapsedRealtime()
    }
    waiting.remove(url)?.forEach { it(art) }
  }

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post { block() }
  }

  private fun download(address: String): Art? {
    val connection = URL(address).openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = CONNECT_TIMEOUT_MS
      connection.readTimeout = READ_TIMEOUT_MS
      connection.setRequestProperty("Accept", "image/*")
      if (connection.responseCode != HttpURLConnection.HTTP_OK) return null
      val raw = connection.inputStream.use { readBounded(it) } ?: return null
      return decode(raw)
    } finally {
      connection.disconnect()
    }
  }

  private fun readBounded(stream: InputStream): ByteArray? {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(16 * 1024)
    var total = 0
    while (true) {
      val read = stream.read(buffer)
      if (read < 0) break
      total += read
      if (total > MAX_DOWNLOAD_BYTES) return null
      out.write(buffer, 0, read)
    }
    return out.toByteArray()
  }

  private fun decode(raw: ByteArray): Art? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    // Decode at a power-of-two fraction that stays at or above the target, then scale the last bit exactly.
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= MAX_SIDE_PX && bounds.outHeight / (sample * 2) >= MAX_SIDE_PX) sample *= 2
    val decoded = BitmapFactory.decodeByteArray(raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample })
      ?: return null

    val scale = MAX_SIDE_PX.toFloat() / max(decoded.width, decoded.height)
    val bitmap = if (scale < 1f) {
      val width = (decoded.width * scale).roundToInt().coerceAtLeast(1)
      val height = (decoded.height * scale).roundToInt().coerceAtLeast(1)
      Bitmap.createScaledBitmap(decoded, width, height, true).also { if (it !== decoded) decoded.recycle() }
    } else {
      decoded
    }

    val out = ByteArrayOutputStream()
    val format = if (bitmap.hasAlpha()) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
    if (!bitmap.compress(format, 90, out)) return null
    return Art(out.toByteArray(), bitmap)
  }
}
