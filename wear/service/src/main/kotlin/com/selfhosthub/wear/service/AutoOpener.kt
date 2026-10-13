package com.selfhosthub.wear.service

import android.util.Log
import com.selfhosthub.wear.core.AutoOpenPolicy
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.core.WatchPrefs
import com.selfhosthub.wear.service.link.LinkTransport
import com.selfhosthub.wear.service.link.LinkUiState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Opens the player on the watch when music starts (see AutoOpenPolicy). Android does not let an app open its own screen
 * from the background, so the watch asks the phone, which may (through the Wear OS companion), and the phone opens this
 * app's player on the watch with LinkProtocol.OPEN_URI. A phone app that does not know the request ignores it; the
 * chip on the watch face (NowPlayingNotifier) is still there.
 */
class AutoOpener(
    prefs: WatchPrefs,
    private val transport: LinkTransport,
    private val scope: CoroutineScope,
    private val appVisible: () -> Boolean,
    private val now: () -> Long = System::currentTimeMillis
) {
    private val policy = AutoOpenPolicy(prefs)

    fun update(state: LinkUiState) {
        val playing = state.connected && state.players.values.any { it.state.isPlaying }
        if (!policy.onState(playing, now(), appVisible())) return
        scope.launch {
            try {
                val phone = transport.phones().firstOrNull() ?: return@launch
                transport.send(phone, LinkProtocol.OPEN_PATH, OPEN_BODY)
            } catch (e: Exception) {
                Log.w(TAG, "Could not ask the phone to open the player: ${e.message}")
            }
        }
    }

    private companion object {
        const val TAG = "AutoOpener"
        val OPEN_BODY = "{\"v\":${LinkProtocol.VERSION}}".toByteArray(Charsets.UTF_8)
    }
}
