package com.selfhosthub.wear.core

import android.content.Context
import android.content.SharedPreferences

/** The watch's own settings and small memories: nothing in here is a secret. */
interface WatchPrefs {
    /** The player the user picked by hand; null while the watch follows whichever one is playing. */
    var manualTargetId: String?

    /** The player that was being controlled last, to come back to it. */
    var lastTargetId: String?

    /** Offer the player when music starts (the notification chip on the watch face). */
    var autoLaunch: Boolean

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

    override var lastTargetId: String?
        get() = prefs.getString("lastTargetId", null)
        set(value) = prefs.edit().putString("lastTargetId", value).apply()

    override var autoLaunch: Boolean
        get() = prefs.getBoolean("autoLaunch", true)
        set(value) = prefs.edit().putBoolean("autoLaunch", value).apply()
}

class MemoryWatchPrefs(
    override var manualTargetId: String? = null,
    override var lastTargetId: String? = null,
    override var autoLaunch: Boolean = true
) : WatchPrefs
