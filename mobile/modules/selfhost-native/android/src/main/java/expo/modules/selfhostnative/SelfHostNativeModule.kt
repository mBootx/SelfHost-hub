package expo.modules.selfhostnative

import android.graphics.Bitmap
import android.graphics.Color
import android.media.audiofx.Equalizer
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import expo.modules.audio.AudioPlayer
import expo.modules.audio.service.NowPlayingArtwork
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

@OptIn(markerClass = [UnstableApi::class])
class SelfHostNativeModule : Module() {
  // Keyed by audio session: each playback deck has its own session, so each gets its own equalizer.
  private val equalizers = mutableMapOf<Int, Equalizer>()

  // The crossfade ticks on the main thread's own handler, never on a JS timer (see startCrossfade below).
  private val mainHandler = Handler(Looper.getMainLooper())
  private var fadeStep: Runnable? = null

  override fun definition() = ModuleDefinition {
    Name("SelfHostNative")

    // The device's band layout: count and centre frequencies vary by phone (often 5 bands).
    AsyncFunction("getEqualizerBands") { player: AudioPlayer ->
      val equalizer = equalizerFor(player) ?: return@AsyncFunction null
      val range = equalizer.bandLevelRange
      mapOf(
        "frequencies" to (0 until equalizer.numberOfBands).map { equalizer.getCenterFreq(it.toShort()) / 1000.0 },
        "minDb" to range[0] / 100.0,
        "maxDb" to range[1] / 100.0
      )
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setEqualizer") { player: AudioPlayer, enabled: Boolean, gainsDb: List<Double> ->
      val equalizer = equalizerFor(player) ?: return@AsyncFunction false
      val range = equalizer.bandLevelRange
      gainsDb.forEachIndexed { band, db ->
        if (band < equalizer.numberOfBands) {
          val level = (db * 100).roundToInt().coerceIn(range[0].toInt(), range[1].toInt())
          equalizer.setBandLevel(band.toShort(), level.toShort())
        }
      }
      equalizer.enabled = enabled
      true
    }.runOnQueue(Queues.MAIN)

    // Loads a cover into the cache the Now Bar reads from, so the skip that brings that track up shows its
    // picture at once instead of after a download.
    Function("prefetchArtwork") { url: String -> NowPlayingArtwork.prefetch(url) }

    // The dominant colour of a cover ("#rrggbb", or null), for the Now Playing background. It goes through the
    // cover cache the Now Bar fills for the same URL, so the picture is usually already downloaded.
    AsyncFunction("getCoverColor") { url: String, promise: Promise ->
      NowPlayingArtwork.request(url) { art -> promise.resolve(art?.let { dominantColor(it.bitmap) }) }
    }

    // The volume ramp of a crossfade runs here, on the main thread's clock. As a JS setInterval it stopped
    // whenever the app was off screen (React Native pauses its timers then): with the screen off nothing
    // faded, and the new song sat silent until the old one ended, then came in at full volume part-way through.
    Function("startCrossfade") { outgoing: AudioPlayer, incoming: AudioPlayer, durationMs: Double, volume: Double ->
      val fromPlayer = outgoing.ref
      val toPlayer = incoming.ref
      val length = durationMs.toLong().coerceAtLeast(1L)
      val level = volume.toFloat().coerceIn(0f, 1f)
      mainHandler.post { runCrossfade(fromPlayer, toPlayer, length, level) }
      true
    }

    // Stops the ramp where it is; the caller sets the volumes it wants afterwards.
    Function("cancelCrossfade") { ->
      mainHandler.post { stopCrossfade() }
      Unit
    }

    // Network I/O: stays on the module's background queue.
    AsyncFunction("sendWakeOnLan") { mac: String, broadcast: String -> sendMagicPacket(mac, broadcast) }

    OnDestroy {
      mainHandler.post { stopCrossfade() }
      equalizers.values.forEach { it.release() }
      equalizers.clear()
    }
  }

  /**
   * Wakes a sleeping machine on the local network: the "magic packet" (6 bytes of 0xFF, then its MAC
   * address 16 times) sent as a UDP broadcast. Answers like the desktop app: { ok, error? }.
   */
  private fun sendMagicPacket(mac: String, broadcast: String): Map<String, Any> {
    val hex = mac.replace(Regex("""[\s:.-]"""), "")
    if (!Regex("[0-9a-fA-F]{12}").matches(hex)) return mapOf("ok" to false, "error" to "Adresse MAC invalide")
    val macBytes = ByteArray(6) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    val packet = ByteArray(6 + 16 * 6) { if (it < 6) 0xFF.toByte() else macBytes[(it - 6) % 6] }
    return try {
      val address = InetAddress.getByName(broadcast.trim().ifEmpty { "255.255.255.255" })
      DatagramSocket().use { socket ->
        socket.broadcast = true
        socket.send(DatagramPacket(packet, packet.size, address, 9))
      }
      mapOf("ok" to true)
    } catch (e: Exception) {
      mapOf("ok" to false, "error" to (e.message ?: e.javaClass.simpleName))
    }
  }

  /**
   * Equal-power ramps (the perceived loudness stays flat through the middle): [incoming] rises to [volume]
   * while [outgoing] falls to silence, then the outgoing player is paused. Main thread only.
   */
  private fun runCrossfade(outgoing: ExoPlayer, incoming: ExoPlayer, durationMs: Long, volume: Float) {
    stopCrossfade()
    val startedAt = SystemClock.uptimeMillis()
    val step = object : Runnable {
      override fun run() {
        val progress = ((SystemClock.uptimeMillis() - startedAt).toFloat() / durationMs).coerceIn(0f, 1f)
        try {
          incoming.volume = volume * sin(progress * HALF_PI)
          outgoing.volume = volume * cos(progress * HALF_PI)
          if (progress >= 1f) {
            fadeStep = null
            outgoing.pause()
            return
          }
        } catch (e: RuntimeException) {
          // A player was released while fading: nothing left to ramp.
          fadeStep = null
          return
        }
        mainHandler.postDelayed(this, FADE_STEP_MS)
      }
    }
    fadeStep = step
    step.run()
  }

  private fun stopCrossfade() {
    fadeStep?.let { mainHandler.removeCallbacks(it) }
    fadeStep = null
  }

  /**
   * What a cover is mostly "about": pixels fall into buckets of 4 bits per channel and each counts by how vivid
   * it is, so the coloured part of a cover beats the black or white around it (a dark cover with a tiny bright
   * logo still comes out dark). Returns "#rrggbb", or null when there is nothing but near-black.
   */
  private fun dominantColor(source: Bitmap): String? {
    val side = 32
    val small = Bitmap.createScaledBitmap(source, side, side, true)
    val pixels = IntArray(side * side)
    small.getPixels(pixels, 0, side, 0, 0, side, side)
    // The source is shared with the notification: only a copy made here may be recycled.
    if (small !== source) small.recycle()

    val weight = FloatArray(4096)
    val red = FloatArray(4096)
    val green = FloatArray(4096)
    val blue = FloatArray(4096)
    val hsv = FloatArray(3)
    for (pixel in pixels) {
      val r = Color.red(pixel)
      val g = Color.green(pixel)
      val b = Color.blue(pixel)
      Color.RGBToHSV(r, g, b, hsv)
      if (hsv[2] < 0.1f) continue
      val w = 0.05f + hsv[1] * hsv[2]
      val bucket = ((r shr 4) shl 8) or ((g shr 4) shl 4) or (b shr 4)
      weight[bucket] += w
      red[bucket] += r * w
      green[bucket] += g * w
      blue[bucket] += b * w
    }
    var best = -1
    for (i in weight.indices) if (weight[i] > 0f && (best < 0 || weight[i] > weight[best])) best = i
    if (best < 0) return null
    return String.format(
      "#%02x%02x%02x",
      (red[best] / weight[best]).roundToInt(),
      (green[best] / weight[best]).roundToInt(),
      (blue[best] / weight[best]).roundToInt()
    )
  }

  // ExoPlayer must be read on its own (main) thread, hence Queues.MAIN on the functions above.
  private fun equalizerFor(player: AudioPlayer): Equalizer? {
    val session = player.ref.audioSessionId
    if (session == 0) return null
    equalizers[session]?.let { return it }
    return try {
      Equalizer(0, session).also { equalizers[session] = it }
    } catch (e: RuntimeException) {
      // No equalizer effect available on this device or for this session.
      null
    }
  }

  private companion object {
    /** Small enough that the ramp is smooth to the ear (the audio track smooths each change as well). */
    const val FADE_STEP_MS = 30L
    const val HALF_PI = 1.5707964f
  }
}
