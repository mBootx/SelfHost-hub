package com.selfhosthub.wear.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status
import com.selfhosthub.wear.core.PlayerCommand
import com.selfhosthub.wear.service.link.PlayerSnapshot
import kotlinx.coroutines.launch

object Notifications {
    const val CHANNEL_PLAYING = "playing"
    const val ID_PLAYING = 42
    const val CHANNEL_UPDATE = "update"
    const val ID_UPDATE = 43

    /** A chip nobody refreshes goes away by itself: at the end of the song at the latest, or after this long when paused. */
    private const val PAUSED_LIFETIME_MS = 10 * 60_000L
    private const val END_GRACE_MS = 60_000L

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_PLAYING, context.getString(R.string.channel_playing), NotificationManager.IMPORTANCE_LOW).apply {
                description = context.getString(R.string.channel_playing_description)
                setShowBadge(false)
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_UPDATE, context.getString(R.string.channel_update), NotificationManager.IMPORTANCE_HIGH).apply {
                description = context.getString(R.string.channel_update_description)
                setShowBadge(false)
            }
        )
    }

    /**
     * Android wants the person wearing the watch to confirm the update the phone sent: this is how it gets to them.
     * `confirm` is the screen Android's installer handed over for that.
     */
    fun updateConfirm(context: Context, confirm: Intent) {
        ensureChannels(context)
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val tap = PendingIntent.getActivity(context, ID_UPDATE, confirm, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNEL_UPDATE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.update_confirm_title))
            .setContentText(context.getString(R.string.update_confirm_text))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()
        notifyIfAllowed(context, ID_UPDATE, notification)
    }

    /** The app's own screen, from a tap on a notification. */
    fun openApp(context: Context): PendingIntent {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: Intent(Intent.ACTION_MAIN).setPackage(context.packageName)
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun action(context: Context, name: String, label: Int, icon: Int, requestCode: Int): NotificationCompat.Action {
        val intent = Intent(context, PlaybackActionReceiver::class.java).setAction(PlaybackActionReceiver.PREFIX + name).setPackage(context.packageName)
        val pending = PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Action.Builder(icon, context.getString(label), pending).build()
    }

    /** How long the chip may stay if nothing refreshes it, given what the player is doing. */
    fun lifetimeMs(snapshot: PlayerSnapshot, now: Long): Long {
        if (!snapshot.state.isPlaying) return PAUSED_LIFETIME_MS
        val duration = snapshot.state.duration
        if (duration <= 0) return PAUSED_LIFETIME_MS
        val remaining = ((duration - snapshot.positionAt(now)).coerceAtLeast(0.0) * 1000).toLong()
        return remaining + END_GRACE_MS
    }

    /**
     * What is playing, as an Ongoing Activity: Wear OS shows it as a chip on the watch face and in the recents, one
     * tap from the app. Returns the notification and applies the ongoing-activity extras to it.
     */
    fun playing(context: Context, snapshot: PlayerSnapshot, playerName: String?): Notification {
        val song = snapshot.state.song
        val title = song?.title?.ifBlank { null } ?: "SelfHost Hub"
        val artist = song?.artist?.ifBlank { null } ?: context.getString(R.string.playing_idle)
        val open = openApp(context)

        val builder = NotificationCompat.Builder(context, CHANNEL_PLAYING)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(if (playerName != null) "$artist · $playerName" else artist)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setTimeoutAfter(lifetimeMs(snapshot, System.currentTimeMillis()))
            .setContentIntent(open)
            .addAction(action(context, PlaybackActionReceiver.PREVIOUS, R.string.action_previous, android.R.drawable.ic_media_previous, 1))
            .addAction(
                if (snapshot.state.isPlaying) action(context, PlaybackActionReceiver.TOGGLE, R.string.action_pause, android.R.drawable.ic_media_pause, 2)
                else action(context, PlaybackActionReceiver.TOGGLE, R.string.action_play, android.R.drawable.ic_media_play, 2)
            )
            .addAction(action(context, PlaybackActionReceiver.NEXT, R.string.action_next, android.R.drawable.ic_media_next, 3))

        val status = Status.Builder().addTemplate("#title#").addPart("title", Status.TextPart(title)).build()
        OngoingActivity.Builder(context, ID_PLAYING, builder)
            .setStaticIcon(R.drawable.ic_notification)
            .setTouchIntent(open)
            .setStatus(status)
            .build()
            .apply(context)
        return builder.build()
    }

    fun notifyIfAllowed(context: Context, id: Int, notification: Notification) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        try {
            manager.notify(id, notification)
        } catch (_: SecurityException) {
            // The notification permission was withdrawn between the check and the call.
        }
    }

    fun cancel(context: Context, id: Int) {
        NotificationManagerCompat.from(context).cancel(id)
    }
}

/** The buttons of the playing notification: they act on whichever player the watch is controlling, through the phone. */
class PlaybackActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val name = intent.action?.removePrefix(PREFIX) ?: return
        val command = when (name) {
            PREVIOUS -> PlayerCommand.Prev
            TOGGLE -> PlayerCommand.Toggle
            NEXT -> PlayerCommand.Next
            else -> return
        }
        // The process may end as soon as this returns: the command is handed to the data layer first.
        val pending: PendingResult? = goAsync()
        val graph = context.watchGraph()
        graph.scope.launch {
            try {
                graph.link.sendAndWait(command)
            } finally {
                pending?.finish()
            }
        }
    }

    companion object {
        const val PREFIX = "com.selfhosthub.wear.action."
        const val PREVIOUS = "previous"
        const val TOGGLE = "toggle"
        const val NEXT = "next"
    }
}
