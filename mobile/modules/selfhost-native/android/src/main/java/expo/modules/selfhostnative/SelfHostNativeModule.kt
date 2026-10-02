package expo.modules.selfhostnative

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.media.audiofx.Equalizer
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.OpenableColumns
import android.provider.Settings
import android.view.WindowManager
import android.webkit.MimeTypeMap
import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import expo.modules.audio.AudioPlayer
import expo.modules.audio.service.NowPlayingArtwork
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
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

  // A share that arrived while the app was already running, kept until JS asks for it.
  private var pendingShare: Intent? = null

  // The sleep timer: the wait, then the fade. Both are posts on the main thread's handler.
  private var sleepWait: Runnable? = null
  private var sleepFade: Runnable? = null
  private var sleepLevels: Map<ExoPlayer, Float>? = null

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
    // Each song has its own ceiling (the volume setting times its loudness factor), so the two ramps differ.
    Function("startCrossfade") { outgoing: AudioPlayer, incoming: AudioPlayer, durationMs: Double, outgoingLevel: Double, incomingLevel: Double ->
      val fromPlayer = outgoing.ref
      val toPlayer = incoming.ref
      val length = durationMs.toLong().coerceAtLeast(1L)
      val fromLevel = outgoingLevel.toFloat().coerceIn(0f, 1f)
      val toLevel = incomingLevel.toFloat().coerceIn(0f, 1f)
      mainHandler.post { runCrossfade(fromPlayer, toPlayer, length, fromLevel, toLevel) }
      true
    }

    // Stops the ramp where it is; the caller sets the volumes it wants afterwards.
    Function("cancelCrossfade") { ->
      mainHandler.post { stopCrossfade() }
      Unit
    }

    // With the app lock on, the recents screen must not show the last screen of the app. Android 13 can turn the
    // preview off by itself; before that the whole window is marked secure, which also blocks screenshots.
    Function("setPrivacyScreen") { enabled: Boolean ->
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread {
        try {
          if (Build.VERSION.SDK_INT >= 33) {
            activity.setRecentsScreenshotEnabled(!enabled)
          } else if (enabled) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
          } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
          }
        } catch (e: RuntimeException) {
          // The activity is going away: nothing left to protect.
        }
      }
      true
    }

    // A clock that setting the date on the phone does not move: milliseconds since the phone started, and which
    // start that was (the count grows at every reboot, after which the first number begins again from zero).
    Function("getClock") { ->
      val resolver = appContext.reactContext?.contentResolver
      mapOf(
        "elapsed" to SystemClock.elapsedRealtime().toDouble(),
        "boot" to (if (resolver != null) Settings.Global.getInt(resolver, Settings.Global.BOOT_COUNT, -1) else -1)
      )
    }

    // The sleep timer. It waits on the main thread's clock - a JS timer stops whenever the app is off screen, which
    // is exactly when someone is falling asleep to it - then fades out whatever is playing over [fadeMs] and pauses.
    // JS is told when it is over (onSleepTimerEnded).
    Function("startSleepTimer") { first: AudioPlayer, second: AudioPlayer, durationMs: Double, fadeMs: Double ->
      val players = listOf(first.ref, second.ref)
      val fade = fadeMs.toLong().coerceAtLeast(0L)
      val wait = (durationMs.toLong() - fade).coerceAtLeast(0L)
      mainHandler.post { scheduleSleep(players, wait, fade) }
      true
    }

    Function("cancelSleepTimer") { ->
      mainHandler.post { cancelSleep() }
      Unit
    }

    // Files and text that other apps send here through Android's share sheet (the activity-alias in this
    // module's AndroidManifest.xml). JS is told when one arrives while the app is running, and asks for what
    // the app was started with. The files are copied into the cache at once - the right to read them ends with
    // the intent - which can take a while for a video, so that runs off the main thread.
    Events("onShareReceived", "onSleepTimerEnded", "onWidgetAction")

    OnCreate { live = this@SelfHostNativeModule }

    // The home-screen widget shows what JS saves here (the song playing); its buttons come back as onWidgetAction.
    Function("updateWidget") { title: String, artist: String, coverUrl: String, playing: Boolean ->
      val context = appContext.reactContext ?: return@Function false
      PlayerWidgetProvider.save(context, title, artist, coverUrl, playing)
      // Drawing the widget talks to the launcher: not on the JS thread.
      mainHandler.post { PlayerWidgetProvider.refresh(context) }
      true
    }

    OnNewIntent { intent ->
      if (isShare(intent)) {
        pendingShare = intent
        sendEvent("onShareReceived", mapOf<String, Any?>())
      }
    }

    AsyncFunction("consumeSharedContent") { ->
      val activity = appContext.currentActivity
      val intent = pendingShare ?: activity?.intent
      pendingShare = null
      if (intent == null || !isShare(intent)) return@AsyncFunction null
      // Handled: an activity that is recreated must not hand the same share over again.
      activity?.runOnUiThread { activity.intent = Intent(Intent.ACTION_MAIN) }
      readShare(intent)
    }

    // Deletes the copies made for shares (all of them, or the ones named).
    Function("clearSharedContent") { ->
      appContext.reactContext?.let { sharedDir(it).deleteRecursively() }
      Unit
    }

    Function("isCharging") { ->
      val manager = appContext.reactContext?.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
      manager?.isCharging ?: false
    }

    // Network I/O: stays on the module's background queue.
    AsyncFunction("sendWakeOnLan") { mac: String, broadcast: String -> sendMagicPacket(mac, broadcast) }

    OnDestroy {
      if (live === this@SelfHostNativeModule) live = null
      mainHandler.post {
        stopCrossfade()
        cancelSleep()
      }
      equalizers.values.forEach { it.release() }
      equalizers.clear()
    }
  }

  /** A widget button was pressed: the app's JavaScript does what the same button on the player would. */
  fun widgetAction(name: String) {
    sendEvent("onWidgetAction", mapOf("action" to name))
  }

  private fun isShare(intent: Intent?): Boolean =
    intent != null && (intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE)

  private fun sharedDir(context: Context): File = File(context.cacheDir, "shared-in")

  private fun streamOf(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)

  private fun streamsOf(intent: Intent): List<Uri> =
    (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()

  /** A name that is safe as a file name on the phone and on the server. */
  private fun cleanName(raw: String): String {
    val replaced = raw.map { if (it.code < 32 || "/\\:*?\"<>|".indexOf(it) >= 0) '_' else it }.joinToString("").trim()
    if (replaced.isEmpty() || replaced == "." || replaced == "..") return "fichier"
    if (replaced.length <= MAX_SHARED_NAME) return replaced
    val dot = replaced.lastIndexOf('.')
    val extension = if (dot > 0 && replaced.length - dot <= 12) replaced.substring(dot) else ""
    return replaced.substring(0, MAX_SHARED_NAME - extension.length) + extension
  }

  /** Copies one shared file into the cache. Null when it can't be read (the sender took its permission back, say). */
  private fun copyShared(context: Context, dir: File, uri: Uri, index: Int): Map<String, Any?>? {
    return try {
      val resolver = context.contentResolver
      var name: String? = null
      if (uri.scheme == "content") {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst() && !cursor.isNull(0)) name = cursor.getString(0)
        }
      }
      val mime = resolver.getType(uri)
      var clean = cleanName(name ?: uri.lastPathSegment ?: "fichier")
      if (!clean.contains('.')) {
        MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { clean = "$clean.$it" }
      }
      dir.mkdirs()
      val target = File(dir, "${System.currentTimeMillis()}-$index-$clean")
      val input = resolver.openInputStream(uri) ?: return null
      input.use { source -> FileOutputStream(target).use { sink -> source.copyTo(sink, 64 * 1024) } }
      mapOf("uri" to Uri.fromFile(target).toString(), "name" to clean, "size" to target.length().toDouble(), "mime" to mime)
    } catch (e: Exception) {
      null
    }
  }

  private fun readShare(intent: Intent): Map<String, Any?> {
    val context = appContext.reactContext
      ?: return mapOf("files" to emptyList<Any>(), "text" to null, "unreadable" to 0)
    val dir = sharedDir(context)
    // Copies left by shares that were never finished (the app was killed) go after a day.
    val limit = System.currentTimeMillis() - SHARED_KEEP_MS
    dir.listFiles()?.forEach { if (it.lastModified() < limit) it.delete() }

    val uris = if (intent.action == Intent.ACTION_SEND_MULTIPLE) streamsOf(intent) else listOfNotNull(streamOf(intent))
    val files = ArrayList<Map<String, Any?>>()
    uris.take(MAX_SHARED_FILES).forEachIndexed { index, uri -> copyShared(context, dir, uri, index)?.let { files.add(it) } }
    return mapOf(
      "files" to files,
      "text" to intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(),
      "unreadable" to (uris.size - files.size)
    )
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
   * Equal-power ramps (the perceived loudness stays flat through the middle): [incoming] rises to
   * [incomingLevel] while [outgoing] falls from [outgoingLevel] to silence, then the outgoing player is
   * paused. Main thread only.
   */
  private fun runCrossfade(outgoing: ExoPlayer, incoming: ExoPlayer, durationMs: Long, outgoingLevel: Float, incomingLevel: Float) {
    stopCrossfade()
    val startedAt = SystemClock.uptimeMillis()
    val step = object : Runnable {
      override fun run() {
        val progress = ((SystemClock.uptimeMillis() - startedAt).toFloat() / durationMs).coerceIn(0f, 1f)
        try {
          incoming.volume = incomingLevel * sin(progress * HALF_PI)
          outgoing.volume = outgoingLevel * cos(progress * HALF_PI)
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

  private fun scheduleSleep(players: List<ExoPlayer>, waitMs: Long, fadeMs: Long) {
    cancelSleep()
    val start = Runnable { runSleepFade(players, fadeMs) }
    sleepWait = start
    mainHandler.postDelayed(start, waitMs)
  }

  /** Stops the timer, and puts the volumes back where they were if it was part-way through its fade. */
  private fun cancelSleep() {
    sleepWait?.let { mainHandler.removeCallbacks(it) }
    sleepWait = null
    sleepFade?.let { mainHandler.removeCallbacks(it) }
    sleepFade = null
    sleepLevels?.forEach { (player, level) ->
      try {
        player.volume = level
      } catch (e: RuntimeException) {
        // The player was released meanwhile.
      }
    }
    sleepLevels = null
  }

  /** Fades what is playing (both decks, during a crossfade) down to silence, pauses it, and puts the volume back for next time. */
  private fun runSleepFade(players: List<ExoPlayer>, fadeMs: Long) {
    sleepWait = null
    stopCrossfade()
    val playing = HashMap<ExoPlayer, Float>()
    for (player in players) {
      try {
        if (player.playWhenReady && player.playbackState != Player.STATE_IDLE && player.playbackState != Player.STATE_ENDED) {
          playing[player] = player.volume
        }
      } catch (e: RuntimeException) {
        // Released: nothing to fade.
      }
    }
    sleepLevels = playing
    val startedAt = SystemClock.uptimeMillis()
    val step = object : Runnable {
      override fun run() {
        val progress = if (fadeMs <= 0L) 1f else ((SystemClock.uptimeMillis() - startedAt).toFloat() / fadeMs).coerceIn(0f, 1f)
        try {
          for ((player, level) in playing) player.volume = level * (1f - progress)
          if (progress >= 1f) {
            for ((player, level) in playing) {
              player.pause()
              player.volume = level
            }
            sleepFade = null
            sleepLevels = null
            sendEvent("onSleepTimerEnded", mapOf<String, Any?>())
            return
          }
        } catch (e: RuntimeException) {
          // A player was released while fading: nothing left to ramp.
          sleepFade = null
          sleepLevels = null
          return
        }
        mainHandler.postDelayed(this, FADE_STEP_MS)
      }
    }
    sleepFade = step
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

  companion object {
    /** The running module, so the widget's buttons can reach the app's JavaScript; null when the app is not running. */
    @Volatile
    var live: SelfHostNativeModule? = null

    private const val MAX_SHARED_FILES = 200
    private const val MAX_SHARED_NAME = 120
    private const val SHARED_KEEP_MS = 24L * 60 * 60 * 1000
    /** Small enough that the ramp is smooth to the ear (the audio track smooths each change as well). */
    const val FADE_STEP_MS = 30L
    const val HALF_PI = 1.5707964f
  }
}
