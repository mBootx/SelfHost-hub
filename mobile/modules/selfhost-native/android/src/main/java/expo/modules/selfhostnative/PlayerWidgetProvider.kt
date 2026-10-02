package expo.modules.selfhostnative

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.widget.RemoteViews
import expo.modules.audio.service.NowPlayingArtwork

/**
 * The home-screen widget: the song playing, its cover, and previous / play-pause / next.
 *
 * What it shows is written by the app (SelfHostNative.updateWidget) into a small preferences file, so it can be
 * drawn at any time - after a reboot, or when the app is not running - without the app. The buttons send the
 * command back to the app's JavaScript (the same store actions as the buttons on the player), which is running
 * whenever music is; if it is not, a tap just opens the app.
 */
class PlayerWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
    refresh(context)
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    val action = intent.action ?: return
    if (!action.startsWith(ACTION_PREFIX)) return
    val live = SelfHostNativeModule.live
    if (live != null) live.widgetAction(action.removePrefix(ACTION_PREFIX)) else openApp(context)
  }

  companion object {
    private const val PREFS = "selfhost_widget"
    private const val ACTION_PREFIX = "expo.modules.selfhostnative.widget."
    private const val COVER_SIDE_PX = 256

    /** Keeps what the widget shows; an empty title means nothing is playing. */
    fun save(context: Context, title: String, artist: String, coverUrl: String, playing: Boolean) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putString("title", title)
        .putString("artist", artist)
        .putString("cover", coverUrl)
        .putBoolean("playing", playing)
        .apply()
    }

    private fun ids(context: Context): IntArray {
      val manager = AppWidgetManager.getInstance(context)
      return manager.getAppWidgetIds(ComponentName(context, PlayerWidgetProvider::class.java))
    }

    private fun openApp(context: Context) {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(launch)
    }

    private fun command(context: Context, name: String, requestCode: Int): PendingIntent {
      val intent = Intent(context, PlayerWidgetProvider::class.java).setAction(ACTION_PREFIX + name)
      return PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Redraws every widget on the home screen from what was last saved. */
    fun refresh(context: Context) {
      val ids = ids(context)
      if (ids.isEmpty()) return
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val title = prefs.getString("title", "") ?: ""
      val artist = prefs.getString("artist", "") ?: ""
      val cover = prefs.getString("cover", "") ?: ""
      val playing = prefs.getBoolean("playing", false)

      val manager = AppWidgetManager.getInstance(context)
      val views = RemoteViews(context.packageName, R.layout.player_widget)
      views.setTextViewText(R.id.widget_title, if (title.isEmpty()) "SelfHost Hub" else title)
      views.setTextViewText(R.id.widget_artist, if (title.isEmpty()) "Aucune lecture en cours" else artist)
      views.setImageViewResource(R.id.widget_toggle, if (playing) R.drawable.ic_widget_pause else R.drawable.ic_widget_play)
      views.setOnClickPendingIntent(R.id.widget_toggle, command(context, "toggle", 1))
      views.setOnClickPendingIntent(R.id.widget_next, command(context, "next", 2))
      views.setOnClickPendingIntent(R.id.widget_previous, command(context, "previous", 3))
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
      if (open != null) {
        views.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
      }
      manager.updateAppWidget(ids, views)

      // The cover comes in later (it may need downloading); a second update puts it in.
      if (cover.isNotEmpty() && title.isNotEmpty()) {
        NowPlayingArtwork.request(cover) { art ->
          if (art == null) return@request
          val side = COVER_SIDE_PX
          val scaled = Bitmap.createScaledBitmap(art.bitmap, side, side, true)
          views.setImageViewBitmap(R.id.widget_cover, scaled)
          manager.updateAppWidget(ids(context), views)
        }
      } else {
        views.setImageViewResource(R.id.widget_cover, R.drawable.widget_cover_placeholder)
        manager.updateAppWidget(ids, views)
      }
    }
  }
}
