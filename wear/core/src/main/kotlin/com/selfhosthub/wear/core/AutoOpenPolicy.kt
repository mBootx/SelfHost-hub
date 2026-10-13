package com.selfhosthub.wear.core

/**
 * When the watch opens its player by itself: music starts (any player the phone reports going from silent to playing)
 * after at least [quietMs] without music, the setting is on, and the app is not already on screen. A pause and a
 * resume a minute later, or a skip, do not open it again; a song already playing when the app process starts does not
 * either (what was playing is remembered in the preferences, not in memory).
 */
class AutoOpenPolicy(private val prefs: WatchPrefs, private val quietMs: Long = DEFAULT_QUIET_MS) {

    /** Called with every state heard; true when the player should be opened now. */
    fun onState(playing: Boolean, now: Long, appVisible: Boolean): Boolean {
        val wasPlaying = prefs.wasPlaying
        val lastPlayingAt = prefs.lastPlayingAt
        val started = playing && !wasPlaying
        val quietLongEnough = lastPlayingAt == 0L || now - lastPlayingAt >= quietMs
        // Playing now, or playing until this moment: either way music was heard just now.
        if (playing || wasPlaying) prefs.lastPlayingAt = now
        if (playing != wasPlaying) prefs.wasPlaying = playing
        return started && quietLongEnough && prefs.autoLaunch && !appVisible
    }

    companion object {
        const val DEFAULT_QUIET_MS = 3 * 60_000L
    }
}
