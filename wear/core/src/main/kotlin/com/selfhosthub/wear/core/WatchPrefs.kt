package com.selfhosthub.wear.core

import android.content.Context
import android.content.SharedPreferences

/** The watch's own settings and small memories: nothing in here is a secret. */
interface WatchPrefs {
    /** The player the user picked by hand; null while the watch follows whichever one is playing. */
    var manualTargetId: String?

    /** When it was picked (ms): a player that starts playing after that is followed instead (see PhoneLink). */
    var manualTargetAt: Long

    /** The player that was being controlled last, to come back to it. */
    var lastTargetId: String?

    /** Open the player when music starts after a quiet spell (and offer it as a chip on the watch face). */
    var autoLaunch: Boolean

    /** When something was last heard playing (ms; 0: never), so a restart of the app does not reopen it mid-song. */
    var lastPlayingAt: Long

    /** Whether something was playing in the last state heard. */
    var wasPlaying: Boolean

    /** Forgets the players the watch had been using (the settings that are not choices of the user). */
    fun forgetPlayers() {
        manualTargetId = null
        lastTargetId = null
    }
}

class SharedPreferencesWatchPrefs(context: Context) : WatchPrefs {
    private val prefs: SharedPreferences = context.getSharedPreferences("selfhost_wear", Context.MODE_PRIVATE)

    override var manualTargetId: String?
        get() = prefs.getString("manualTargetId", null)
        set(value) = prefs.edit().putString("manualTargetId", value).apply()

    override var manualTargetAt: Long
        get() = prefs.getLong("manualTargetAt", 0L)
        set(value) = prefs.edit().putLong("manualTargetAt", value).apply()

    override var lastTargetId: String?
        get() = prefs.getString("lastTargetId", null)
        set(value) = prefs.edit().putString("lastTargetId", value).apply()

    override var autoLaunch: Boolean
        get() = prefs.getBoolean("autoLaunch", true)
        set(value) = prefs.edit().putBoolean("autoLaunch", value).apply()

    override var lastPlayingAt: Long
        get() = prefs.getLong("lastPlayingAt", 0L)
        set(value) = prefs.edit().putLong("lastPlayingAt", value).apply()

    override var wasPlaying: Boolean
        get() = prefs.getBoolean("wasPlaying", false)
        set(value) = prefs.edit().putBoolean("wasPlaying", value).apply()
}

class MemoryWatchPrefs(
    override var manualTargetId: String? = null,
    override var manualTargetAt: Long = 0L,
    override var lastTargetId: String? = null,
    override var autoLaunch: Boolean = true,
    override var lastPlayingAt: Long = 0L,
    override var wasPlaying: Boolean = false
) : WatchPrefs
