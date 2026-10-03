package expo.modules.selfhostnative

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import java.io.File
import java.io.IOException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import org.json.JSONObject

/**
 * The phone's side of the Wear OS data layer. For the "Montre" setting: which watches are connected and which of them
 * have the SelfHost Hub watch app, and one message that hands such a watch its setup (Navidrome's login, built by JS).
 * For the live link: the snapshots of the players that JS pushes to the watches (what the watch sends back is
 * received by WatchLinkService). The data layer is the phone and watch's own encrypted Bluetooth link; it delivers a
 * message only to an app of the same package signed with the same key, so nothing else on the watch can receive it.
 * The watch answers a setup with an acknowledgement, which is waited for here so that the screen can say how it went.
 */
class WatchBridge(private val context: Context) {
  data class Watch(val id: String, val name: String, val nearby: Boolean, val hasApp: Boolean)

  /** One watch's answer to a setup. */
  data class Outcome(val id: String, val name: String, val ok: Boolean, val error: String?)

  private val handler = Handler(Looper.getMainLooper())

  /** The watches connected to this phone, each marked with whether it has the app. */
  fun watches(onResult: (List<Watch>?, String?) -> Unit) {
    val nodes = Wearable.getNodeClient(context)
    val capabilities = Wearable.getCapabilityClient(context)
    nodes.connectedNodes
      .addOnSuccessListener { connected ->
        capabilities.getCapability(CAPABILITY, CapabilityClient.FILTER_ALL)
          .addOnSuccessListener { info ->
            val withApp = info.nodes.map { it.id }.toSet()
            onResult(connected.map { Watch(it.id, it.displayName, it.isNearby, it.id in withApp) }, null)
          }
          // The capability could not be read: the watches are still listed, with the app unknown.
          .addOnFailureListener { onResult(connected.map { Watch(it.id, it.displayName, it.isNearby, false) }, null) }
      }
      .addOnFailureListener { onResult(null, describe(it)) }
  }

  /**
   * Sends `setupJson` to every connected watch that has the app, then waits up to `timeoutMs` for each to say it took it.
   * Reports one outcome per watch; the error is set when the watch refused the setup or never answered.
   */
  fun sendSetup(setupJson: String, timeoutMs: Long, onResult: (List<Outcome>, String?) -> Unit) {
    val capabilities = Wearable.getCapabilityClient(context)
    val messages = Wearable.getMessageClient(context)
    capabilities.getCapability(CAPABILITY, CapabilityClient.FILTER_REACHABLE)
      .addOnSuccessListener { info ->
        val targets = info.nodes.toList()
        if (targets.isEmpty()) {
          onResult(emptyList(), null)
          return@addOnSuccessListener
        }
        val pending = targets.associateBy { it.id }.toMutableMap()
        val outcomes = mutableListOf<Outcome>()
        var finished = false

        lateinit var listener: MessageClient.OnMessageReceivedListener
        lateinit var timeout: Runnable

        fun finish() {
          if (finished) return
          finished = true
          handler.removeCallbacks(timeout)
          messages.removeListener(listener)
          // Whoever has not answered by now is reported as such.
          for (node in pending.values) outcomes += Outcome(node.id, node.displayName, false, "La montre n'a pas répondu")
          onResult(outcomes, null)
        }

        listener = MessageClient.OnMessageReceivedListener { event: MessageEvent ->
          if (event.path != ACK_PATH) return@OnMessageReceivedListener
          val node = pending.remove(event.sourceNodeId) ?: return@OnMessageReceivedListener
          val body = try {
            JSONObject(String(event.data, Charsets.UTF_8))
          } catch (_: Exception) {
            JSONObject()
          }
          outcomes += Outcome(node.id, node.displayName, body.optBoolean("ok", false), body.optString("error").ifEmpty { null })
          if (pending.isEmpty()) finish()
        }
        timeout = Runnable { finish() }

        messages.addListener(listener)
        handler.postDelayed(timeout, timeoutMs)

        for (node in targets) {
          messages.sendMessage(node.id, SETUP_PATH, setupJson.toByteArray(Charsets.UTF_8))
            .addOnFailureListener { error ->
              if (pending.remove(node.id) != null) {
                outcomes += Outcome(node.id, node.displayName, false, describe(error))
                if (pending.isEmpty()) finish()
              }
            }
        }
      }
      .addOnFailureListener { onResult(emptyList(), describe(it)) }
  }

  /**
   * Sends one message of the live link (a snapshot of the players, see services/watchLink.ts) to every watch that has
   * the app. `onResult` gets how many watches it was handed to (0 when none is connected), or why it could not go.
   * The watches are looked up through Google's services at most every few seconds, not at every message: a snapshot
   * can follow another within a second while a song plays.
   */
  fun push(path: String, json: String, onResult: (Int, String?) -> Unit) {
    val known = targets
    if (known != null && SystemClock.elapsedRealtime() - targetsAt < TARGETS_KEPT_MS) {
      deliver(known, path, json, onResult)
      return
    }
    Wearable.getCapabilityClient(context).getCapability(CAPABILITY, CapabilityClient.FILTER_REACHABLE)
      .addOnSuccessListener { info ->
        val ids = info.nodes.map { it.id }
        targets = ids
        targetsAt = SystemClock.elapsedRealtime()
        deliver(ids, path, json, onResult)
      }
      .addOnFailureListener { onResult(0, describe(it)) }
  }

  private fun deliver(ids: List<String>, path: String, json: String, onResult: (Int, String?) -> Unit) {
    if (ids.isEmpty()) {
      onResult(0, null)
      return
    }
    val messages = Wearable.getMessageClient(context)
    val bytes = json.toByteArray(Charsets.UTF_8)
    for (id in ids) {
      // A watch that went away since the lookup is dropped from the list: the next message looks again.
      messages.sendMessage(id, path, bytes).addOnFailureListener { targets = null }
    }
    onResult(ids.size, null)
  }

  /**
   * Sends the APK of an update to one watch, over a data layer channel: `header` (one line of JSON, built by JS, see
   * services/watchUpdateProtocol.ts) and then the file. The watch checks the header before keeping a byte, and may close
   * the channel; the watch tells how it went in messages (see WatchLinkService). Blocking: call it off the main thread.
   * Throws with a sentence when the watch cannot be reached or goes away.
   */
  fun sendUpdate(nodeId: String, file: File, header: String, onProgress: (sent: Long, total: Long) -> Unit) {
    val channels = Wearable.getChannelClient(context)
    try {
      val channel = Tasks.await(channels.openChannel(nodeId, UPDATE_APK_PATH), CHANNEL_TIMEOUT_S, TimeUnit.SECONDS)
      try {
        val total = file.length().coerceAtLeast(1)
        var sent = 0L
        var reported = -1L
        Tasks.await(channels.getOutputStream(channel), CHANNEL_TIMEOUT_S, TimeUnit.SECONDS).use { out ->
          out.write(header.toByteArray(Charsets.UTF_8))
          out.write('\n'.code)
          file.inputStream().buffered(CHUNK).use { input ->
            val buffer = ByteArray(CHUNK)
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              out.write(buffer, 0, read)
              sent += read
              // About a hundred reports for the whole file, not one per chunk.
              if (sent * 100 / total != reported) {
                reported = sent * 100 / total
                onProgress(sent, total)
              }
            }
          }
          out.flush()
        }
        onProgress(total, total)
      } catch (e: Exception) {
        runCatching { channels.close(channel) }
        throw e
      }
      // The watch closes the channel when it has everything. This closes it if it never does, a while from now.
      handler.postDelayed({ runCatching { channels.close(channel) } }, CHANNEL_KEPT_MS)
    } catch (e: ExecutionException) {
      throw IOException(describe(e.cause as? Exception ?: e), e)
    } catch (e: TimeoutException) {
      throw IOException("La montre n'a pas répondu", e)
    } catch (e: IOException) {
      // Writing to a channel the watch closed (it refused the update, or went away).
      throw IOException("La montre a interrompu le transfert", e)
    }
  }

  private fun describe(error: Exception): String =
    if (error is ApiException && error.statusCode == 17) "Les services Google pour les montres ne sont pas disponibles sur ce téléphone"
    else error.message ?: error.javaClass.simpleName

  companion object {
    /** Declared by the watch app; see SetupProtocol in wear/core. */
    const val CAPABILITY = "selfhost_watch"
    const val SETUP_PATH = "/selfhost/setup"
    const val ACK_PATH = "/selfhost/setup/ack"

    // The live link; see LinkProtocol in wear/core. The watch asks (request) and commands; the phone answers with snapshots.
    const val LINK_PREFIX = "/selfhost/link"
    const val REQUEST_PATH = "/selfhost/link/request"
    const val COMMAND_PATH = "/selfhost/link/command"
    const val CLOSED_PATH = "/selfhost/link/closed"

    // Updating the watch app; see UpdateProtocol in wear/core. The phone sends the APK on a channel and asks the version;
    // the watch answers with statuses.
    const val UPDATE_PREFIX = "/selfhost/update"
    const val UPDATE_APK_PATH = "/selfhost/update/apk"
    const val UPDATE_STATUS_PATH = "/selfhost/update/status"

    private const val CHANNEL_TIMEOUT_S = 30L
    private const val CHANNEL_KEPT_MS = 3 * 60_000L
    private const val CHUNK = 16 * 1024

    private const val TARGETS_KEPT_MS = 20_000L

    /** The watches that had the app the last time they were looked up; null when that has to be done again. */
    @Volatile
    private var targets: List<String>? = null

    @Volatile
    private var targetsAt = 0L
  }
}
