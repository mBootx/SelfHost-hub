package expo.modules.selfhostnative

import android.app.Activity
import android.content.Context
import android.content.pm.ActivityInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioManager
import android.os.SystemClock
import android.view.WindowManager

/**
 * What the car mode does to the phone around the screen: keeps it awake, turns it the way the mount holds it, lights it
 * up in the sun, reads the light sensor for that, and moves the media volume like the phone's own buttons. Everything
 * it changes on the window is put back by [restore] when the car mode closes.
 */
object CarScreen {
  /** The orientation the activity had before the car mode turned it; null while the car mode has not touched it. */
  private var savedOrientation: Int? = null

  /** Main thread. */
  fun keepScreenOn(activity: Activity, on: Boolean) {
    if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  /** Main thread. [level] from 0 to 1, or below 0 for the phone's own brightness (automatic or not). */
  fun setBrightness(activity: Activity, level: Double) {
    val attributes = activity.window.attributes
    attributes.screenBrightness =
      if (level < 0) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE else level.toFloat().coerceIn(0.01f, 1f)
    activity.window.attributes = attributes
  }

  /** Main thread. "portrait", "landscape" (either way up, by the sensor), "auto", or "app" for what the app had before. */
  fun setOrientation(activity: Activity, mode: String) {
    if (mode == "app") {
      savedOrientation?.let { activity.requestedOrientation = it }
      savedOrientation = null
      return
    }
    if (savedOrientation == null) savedOrientation = activity.requestedOrientation
    activity.requestedOrientation = when (mode) {
      "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
      "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      else -> ActivityInfo.SCREEN_ORIENTATION_FULL_USER
    }
  }

  /** Main thread. Puts the window back as it was before the car mode. */
  fun restore(activity: Activity) {
    keepScreenOn(activity, false)
    setBrightness(activity, -1.0)
    setOrientation(activity, "app")
  }

  /**
   * One step of the media volume up (+1) or down (-1), showing the phone's volume panel the way its buttons do. Returns
   * the volume after the step, from 0 to 1, or -1 without an audio service.
   */
  fun stepMediaVolume(context: Context, direction: Int): Double {
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return -1.0
    audio.adjustStreamVolume(
      AudioManager.STREAM_MUSIC,
      if (direction > 0) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER,
      AudioManager.FLAG_SHOW_UI
    )
    val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    return if (max > 0) audio.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / max else -1.0
  }

  /** The ambient light sensor, at most twice a second, in lux. */
  class LightSensor(context: Context, private val onLux: (Double) -> Unit) : SensorEventListener {
    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private val sensor = sensors?.getDefaultSensor(Sensor.TYPE_LIGHT)
    private var lastSentAt = 0L

    /** False when the phone has no light sensor. */
    fun start(): Boolean {
      val manager = sensors ?: return false
      val light = sensor ?: return false
      lastSentAt = 0L
      return manager.registerListener(this, light, SensorManager.SENSOR_DELAY_NORMAL)
    }

    fun stop() {
      sensors?.unregisterListener(this)
    }

    override fun onSensorChanged(event: SensorEvent) {
      val now = SystemClock.uptimeMillis()
      if (now - lastSentAt < 500) return
      lastSentAt = now
      onLux(event.values.firstOrNull()?.toDouble() ?: return)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
  }
}
