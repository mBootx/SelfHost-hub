package com.selfhosthub.wear.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.selfhosthub.wear.core.UpdateCodec
import com.selfhosthub.wear.core.UpdateHeader
import com.selfhosthub.wear.core.UpdateStatus
import com.selfhosthub.wear.service.update.UpdateReceiver
import com.selfhosthub.wear.service.watchGraph
import java.io.ByteArrayInputStream
import java.io.File
import java.io.SequenceInputStream
import java.security.MessageDigest
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking

/**
 * DEBUG BUILDS ONLY (this file is in the debug source set). Feeds an APK that is already on the watch through the very
 * receiver the phone's channel feeds, as if the phone had sent it: the header is made from the file itself. What the
 * receiver says is logged under the tag "DebugUpdate" (and sent to the phone, as it would be). The file has to be one
 * the app can read: put it in the app's files folder with
 * `adb exec-in run-as com.selfhosthub.mobile sh -c "cat > files/update-test.apk" < app.apk`, then
 * `adb shell am broadcast -n com.selfhosthub.mobile/com.selfhosthub.wear.debug.DebugUpdateReceiver --es path files/update-test.apk [--ez reinstall true]`.
 */
class DebugUpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val given = intent.getStringExtra("path") ?: return
        val reinstall = intent.getBooleanExtra("reinstall", false)
        val file = if (File(given).isAbsolute) File(given) else File(context.filesDir, given.removePrefix("files/"))
        val pending: PendingResult? = goAsync()
        val graph = context.watchGraph()
        thread(name = "debug-update") {
            try {
                val host = graph.updates.host
                val info = host.inspect(file) ?: error("${file.path} is not an APK the package manager can read")
                val digest = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
                val header = UpdateCodec.header(UpdateHeader(info.versionName ?: "0.0.0", info.versionCode, file.length(), digest, reinstall))
                Log.i(TAG, "feeding ${file.path} (${file.length()} bytes), header $header; installed is ${host.installed}, may install: ${host.mayInstall()}, free: ${host.freeBytes()}")
                val stream = SequenceInputStream(ByteArrayInputStream((header + "\n").toByteArray()), file.inputStream())
                UpdateReceiver(host) { status: UpdateStatus ->
                    Log.i(TAG, "status: ${UpdateCodec.status(status)}")
                    runBlocking { graph.updates.report(status) }
                }.receive(stream)
                Log.i(TAG, "the receiver returned")
            } catch (e: Throwable) {
                Log.e(TAG, "the debug update failed", e)
            } finally {
                pending?.finish()
            }
        }
    }

    private companion object {
        const val TAG = "DebugUpdate"
    }
}
