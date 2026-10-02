package com.selfhosthub.wear.service

import android.os.Build
import android.util.Log
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import com.google.gson.JsonObject
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.core.SetupCodec
import com.selfhosthub.wear.core.SetupFormatException
import com.selfhosthub.wear.core.SetupProtocol
import kotlinx.coroutines.runBlocking

/**
 * Receives what the phone sends over the Wear OS data layer, with the app open or not: its setup (from the "Montre"
 * setting: Navidrome's login) and the state of the players, which it pushes whenever something changes. The data layer
 * is the phone and watch's own encrypted link, and only the same app (same package, same signing key) on the other
 * side can address this service, so nothing here has to ask who is sending.
 *
 * A setup is checked whole before anything is stored, and the phone is told how it went. A state is handed to the
 * link, whose observers put up (or take down) the chip of the song playing.
 */
class WatchListenerService : WearableListenerService() {

    override fun onMessageReceived(event: MessageEvent) {
        when {
            event.path == SetupProtocol.SETUP_PATH -> onSetup(event)
            event.path.startsWith(LinkProtocol.PREFIX) -> watchGraph().link.onMessage(event.path, event.data)
        }
    }

    private fun onSetup(event: MessageEvent) {
        val graph = watchGraph()
        val setup = try {
            SetupCodec.decode(String(event.data, Charsets.UTF_8))
        } catch (e: SetupFormatException) {
            Log.w(TAG, "Setup refused: ${e.message}")
            reply(event.sourceNodeId, ok = false, error = e.message)
            return
        }
        // This callback runs on a worker thread: finishing here keeps the process from being stopped half way.
        runBlocking { graph.applySetup(setup) }
        reply(event.sourceNodeId, ok = true, error = null)
    }

    private fun reply(nodeId: String, ok: Boolean, error: String?) {
        val body = JsonObject().apply {
            addProperty("ok", ok)
            addProperty("device", Build.MODEL)
            if (error != null) addProperty("error", error)
        }
        Wearable.getMessageClient(this)
            .sendMessage(nodeId, SetupProtocol.ACK_PATH, body.toString().toByteArray(Charsets.UTF_8))
            .addOnFailureListener { Log.w(TAG, "Could not tell the phone how the setup went: ${it.message}") }
    }

    private companion object {
        const val TAG = "WatchListener"
    }
}
