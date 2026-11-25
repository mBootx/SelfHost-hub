package com.selfhosthub.wear.service.update

import android.content.Intent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.getAndUpdate

/**
 * The installer's "confirm this update" screen, kept until it is shown. A notification is not enough to get it to the
 * person: notifications of the app may be off (the permission is refused, withdrawn, or the channel muted), and then
 * nothing tells them an update waits. So the screen is also kept here, the phone is asked to open the app, and the
 * app's activity shows it as soon as it is in front (see MainActivity).
 */
object PendingConfirm {
    private val pending = MutableStateFlow<Intent?>(null)

    val intent: StateFlow<Intent?> get() = pending

    fun offer(confirm: Intent) {
        pending.value = confirm
    }

    /** The screen to show, once: whoever takes it shows it. */
    fun take(): Intent? = pending.getAndUpdate { null }

    fun clear() {
        pending.value = null
    }
}
