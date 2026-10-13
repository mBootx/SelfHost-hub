package expo.modules.selfhostnative

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.wear.remote.interactions.RemoteActivityHelper
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService

/**
 * What the watch sends over the Wear OS data layer: a request for the state of the players, commands, and what it says
 * about an update of its app. The data layer only delivers them from the watch app of the same package signed with the
 * same key (see WatchBridge), so nothing here has to ask who is sending.
 *
 * They are handed to the app's JavaScript, which is what talks to the PC (services/watchLink.ts) and what runs the
 * update (services/watchUpdate.ts). When the app's process is running without any JavaScript (the app was swiped away
 * but something else keeps the process), the watch is told so at once, instead of leaving it to give up after its
 * timeout; what it says about an update, with nobody to hear it, is dropped.
 *
 * One request is answered here, without the JavaScript: the watch asking to have its player opened because music
 * started. A watch app may not open its own screen from the background, but the phone may open it there, through the
 * Wear OS companion (RemoteActivityHelper).
 */
class WatchLinkService : WearableListenerService() {
  override fun onMessageReceived(event: MessageEvent) {
    val module = SelfHostNativeModule.live
    when (event.path) {
      WatchBridge.OPEN_PATH -> openOnWatch(event.sourceNodeId)
      WatchBridge.UPDATE_STATUS_PATH -> module?.watchMessage(event.sourceNodeId, event.path, String(event.data, Charsets.UTF_8))
      WatchBridge.REQUEST_PATH, WatchBridge.COMMAND_PATH -> {
        if (module != null) {
          module.watchMessage(event.sourceNodeId, event.path, String(event.data, Charsets.UTF_8))
          return
        }
        Wearable.getMessageClient(this)
          .sendMessage(event.sourceNodeId, WatchBridge.CLOSED_PATH, CLOSED.toByteArray(Charsets.UTF_8))
          .addOnFailureListener { Log.w(TAG, "Could not tell the watch that the app is not running: ${it.message}") }
      }
    }
  }

  private fun openOnWatch(nodeId: String) {
    val intent = Intent(Intent.ACTION_VIEW)
      .addCategory(Intent.CATEGORY_BROWSABLE)
      .setData(Uri.parse(WatchBridge.OPEN_URI))
    try {
      val future = RemoteActivityHelper(this).startRemoteActivity(intent, nodeId)
      future.addListener({
        try {
          future.get()
        } catch (e: Exception) {
          Log.w(TAG, "The watch's player could not be opened: ${e.message}")
        }
      }, Runnable::run)
    } catch (e: Exception) {
      Log.w(TAG, "The watch's player could not be opened: ${e.message}")
    }
  }

  private companion object {
    const val TAG = "WatchLink"
    const val CLOSED = "{\"v\":1}"
  }
}
