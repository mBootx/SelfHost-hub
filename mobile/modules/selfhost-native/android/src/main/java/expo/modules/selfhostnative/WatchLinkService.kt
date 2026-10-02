package expo.modules.selfhostnative

import android.util.Log
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService

/**
 * What the watch sends over the Wear OS data layer: a request for the state of the players, and commands. The data
 * layer only delivers them from the watch app of the same package signed with the same key (see WatchBridge), so
 * nothing here has to ask who is sending.
 *
 * They are handed to the app's JavaScript, which is what talks to the PC (services/watchLink.ts). When the app's
 * process is running without any JavaScript (the app was swiped away but something else keeps the process), the watch
 * is told so at once, instead of leaving it to give up after its timeout.
 */
class WatchLinkService : WearableListenerService() {
  override fun onMessageReceived(event: MessageEvent) {
    if (event.path != WatchBridge.REQUEST_PATH && event.path != WatchBridge.COMMAND_PATH) return
    val module = SelfHostNativeModule.live
    if (module != null) {
      module.watchMessage(event.sourceNodeId, event.path, String(event.data, Charsets.UTF_8))
      return
    }
    Wearable.getMessageClient(this)
      .sendMessage(event.sourceNodeId, WatchBridge.CLOSED_PATH, CLOSED.toByteArray(Charsets.UTF_8))
      .addOnFailureListener { Log.w(TAG, "Could not tell the watch that the app is not running: ${it.message}") }
  }

  private companion object {
    const val TAG = "WatchLink"
    const val CLOSED = "{\"v\":1}"
  }
}
