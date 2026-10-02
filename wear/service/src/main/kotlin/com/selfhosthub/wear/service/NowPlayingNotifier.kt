package com.selfhosthub.wear.service

import android.content.Context
import com.selfhosthub.wear.core.WatchPrefs
import com.selfhosthub.wear.service.link.LinkUiState

/**
 * Shows what is playing as an Ongoing Activity while a player is going, and takes it down when nothing is. Only what
 * is displayed (the song, play or pause, which player) triggers a redraw, not the progress of the song.
 *
 * It is how the watch "opens" the player when music starts: Android does not let an app open its own screen from the
 * background, so the offer is the chip on the watch face, one tap from the app. The state it reacts to is pushed by
 * the phone, so it works with the watch app closed.
 */
class NowPlayingNotifier(private val context: Context, private val prefs: WatchPrefs) {
    private data class Shown(val songId: String, val playing: Boolean, val player: String?)

    @Volatile private var shown: Shown? = null

    // A chip put up by an earlier run of the process is still there: the first time nothing is playing, it is taken down.
    @Volatile private var cleared = false

    fun update(state: LinkUiState) {
        val snapshot = state.target
        val song = snapshot?.state?.song
        if (!prefs.autoLaunch || !state.connected || snapshot == null || song == null) {
            hide()
            return
        }
        val now = Shown(song.id, snapshot.state.isPlaying, state.targetName)
        if (now == shown) return
        shown = now
        cleared = false
        Notifications.notifyIfAllowed(context, Notifications.ID_PLAYING, Notifications.playing(context, snapshot, state.targetName))
    }

    fun hide() {
        if (shown == null && cleared) return
        shown = null
        cleared = true
        Notifications.cancel(context, Notifications.ID_PLAYING)
    }
}
