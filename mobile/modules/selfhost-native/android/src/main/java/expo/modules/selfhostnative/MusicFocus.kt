package expo.modules.selfhostnative

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * The app's audio focus: how Android decides whose sound has the floor. It is held for the music as a whole, from the
 * first play until the queue is cleared, whichever deck is playing, and the playback engine (services/playbackEngine)
 * is told what other apps do with it.
 *
 * expo-audio's own handling (switched off with interruptionMode "mixWithOthers") was made for a single short sound,
 * and cut the music: it asked for focus as a *temporary* sound; it gave focus up whenever no player happened to be
 * playing, which is every time a stream rebuffers, a seek lands or the next song takes over, so the music played on
 * without it; and when another sound came, a notification included, it paused every player and started them again
 * after, which the app took for the person pressing pause and play.
 *
 * Here:
 *  - focus is asked for as a lasting gain, for music (USAGE_MEDIA), and kept while paused;
 *  - a short sound that only needs the music lowered (a notification) is handled by Android, which lowers the music
 *    for its length: nothing is paused, nothing is cut;
 *  - a call, a voice message, an assistant (a temporary loss) pauses the music, which comes back by itself after;
 *  - another app starting its own playback (a lasting loss) pauses the music for good, as the person expects.
 */
object MusicFocus {
  private const val TAG = "MusicFocus"

  /** What the engine is told: "interrupt", "resume" or "lost". Set by the running module. */
  @Volatile
  var onChange: ((String) -> Unit)? = null

  private enum class State {
    /** Not asked for, given back, or lost to another app's playback. */
    NONE,
    /** The music has it. */
    HELD,
    /** Asked for during a call: Android grants it once the call ends. */
    WAITING,
    /** Another app has it for a moment; it comes back. */
    INTERRUPTED
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private var state = State.NONE
  private var audioManager: AudioManager? = null
  private var request: AudioFocusRequest? = null

  private val listener = AudioManager.OnAudioFocusChangeListener { change -> onFocusChange(change) }

  /**
   * Asks for focus before the music plays: "granted", "delayed" (a call is on: the music waits, and "resume" comes when
   * it ends) or "failed" (Android refused; the music plays anyway, as it did before).
   */
  @Synchronized
  fun request(context: Context): String {
    when (state) {
      State.HELD -> return "granted"
      State.WAITING -> return "delayed"
      else -> Unit
    }
    val manager = managerFor(context) ?: return "failed"
    val result = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        manager.requestAudioFocus(focusRequest())
      } else {
        @Suppress("DEPRECATION")
        manager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
      }
    } catch (e: RuntimeException) {
      Log.w(TAG, "Audio focus request failed", e)
      AudioManager.AUDIOFOCUS_REQUEST_FAILED
    }
    return when (result) {
      AudioManager.AUDIOFOCUS_REQUEST_GRANTED -> {
        state = State.HELD
        "granted"
      }
      AudioManager.AUDIOFOCUS_REQUEST_DELAYED -> {
        state = State.WAITING
        "delayed"
      }
      else -> "failed"
    }
  }

  /** Gives focus back: nothing is left to play (the queue was cleared, the app is closing). */
  @Synchronized
  fun abandon() {
    if (state == State.NONE) return
    state = State.NONE
    giveBack()
  }

  @Synchronized
  private fun onFocusChange(change: Int) {
    when (change) {
      AudioManager.AUDIOFOCUS_GAIN -> {
        val was = state
        state = State.HELD
        // Back after a call or a voice message, or granted once a call ended.
        if (was == State.INTERRUPTED || was == State.WAITING) notify("resume")
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        if (state == State.HELD) {
          state = State.INTERRUPTED
          notify("interrupt")
        }
      }
      // A short sound that only needs the music lower. Android lowers it by itself for the sound's length (the
      // request does not ask to pause instead), and only tells the app when it can't; the music then just carries
      // on. Pausing here, as expo-audio did, is what cut the music on every notification.
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> Unit
      AudioManager.AUDIOFOCUS_LOSS -> {
        if (state != State.NONE) {
          state = State.NONE
          giveBack()
          notify("lost")
        }
      }
    }
  }

  private fun notify(change: String) {
    try {
      onChange?.invoke(change)
    } catch (e: RuntimeException) {
      Log.w(TAG, "Failed to tell the app about an audio focus change", e)
    }
  }

  private fun giveBack() {
    val manager = audioManager ?: return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        request?.let { manager.abandonAudioFocusRequest(it) }
      } else {
        @Suppress("DEPRECATION")
        manager.abandonAudioFocus(listener)
      }
    } catch (e: RuntimeException) {
      Log.w(TAG, "Failed to give audio focus back", e)
    }
  }

  /** The one to ask now, remembered for giving the focus back when Android takes it (no context there). */
  private fun managerFor(context: Context): AudioManager? =
    (context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.also { audioManager = it }

  /** One request, always the same object: Android matches the one given back to it. */
  private fun focusRequest(): AudioFocusRequest =
    request ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
          .build()
      )
      .setAcceptsDelayedFocusGain(true)
      .setWillPauseWhenDucked(false)
      .setOnAudioFocusChangeListener(listener, mainHandler)
      .build()
      .also { request = it }
}
