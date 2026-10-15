package expo.modules.selfhostnative

import android.os.Handler
import android.os.Looper
import expo.modules.splashscreen.SplashScreenManager

/**
 * A safety net for the startup logo. expo-splash-screen keeps the logo up until React reports that content appeared,
 * a one-time marker: when the app's process was already alive without a screen (a background task, the watch link or
 * the media service started it) and the screen is opened afterwards, that marker may already have gone by, and the
 * logo then stays up for good. Whatever the reason, a logo still showing seconds after the screen came to the
 * foreground is taken down. (The JavaScript side asks for it too, as soon as the first screen is mounted.)
 */
object SplashSafety {
  private const val AFTER_MS = 8_000L
  private val main = Handler(Looper.getMainLooper())
  private val hide = Runnable { runCatching { SplashScreenManager.hide() } }

  /** Called each time the activity comes to the foreground: starts the countdown afresh. */
  fun arm() {
    main.removeCallbacks(hide)
    main.postDelayed(hide, AFTER_MS)
  }

  fun disarm() {
    main.removeCallbacks(hide)
  }
}
