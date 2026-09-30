package expo.modules.selfhostnative

import android.media.audiofx.Equalizer
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import expo.modules.audio.AudioPlayer
import expo.modules.audio.service.NowPlayingArtwork
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
