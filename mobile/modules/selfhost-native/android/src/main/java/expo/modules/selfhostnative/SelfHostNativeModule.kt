package expo.modules.selfhostnative

import android.media.audiofx.Equalizer
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import expo.modules.audio.AudioPlayer
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.roundToInt

@OptIn(markerClass = [UnstableApi::class])
class SelfHostNativeModule : Module() {
  // Keyed by audio session: each playback deck has its own session, so each gets its own equalizer.
  private val equalizers = mutableMapOf<Int, Equalizer>()

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

    OnDestroy {
      equalizers.values.forEach { it.release() }
      equalizers.clear()
    }
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
}
