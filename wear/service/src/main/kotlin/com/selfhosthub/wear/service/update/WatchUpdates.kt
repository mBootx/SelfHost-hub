package com.selfhosthub.wear.service.update

import android.content.pm.PackageInstaller
import android.util.Log
import com.selfhosthub.wear.core.UpdateCodec
import com.selfhosthub.wear.core.UpdateProtocol
import com.selfhosthub.wear.core.UpdateState
import com.selfhosthub.wear.core.UpdateStatus
import com.selfhosthub.wear.service.link.LinkTransport
import java.io.InputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking

/**
 * The watch's side of updating itself from the phone (see UpdateProtocol): takes in the APK the phone sends, and tells
 * the phone how it goes, whichever way it goes. One per process, owned by the graph.
 */
class WatchUpdates(val host: UpdateHost, private val transport: LinkTransport) {
    private val receiver = UpdateReceiver(host) { status -> reportBlocking(status) }

    /** An APK arriving on a channel. Blocking: the data layer's worker thread is the one to call it. */
    fun receive(input: InputStream) = receiver.receive(input)

    /** The new version is running: the phone, which may be waiting for this, is told which one it is. */
    suspend fun announceInstalled() = announce(UpdateState.INSTALLED)

    /** The phone asked which version of the app this is. */
    suspend fun announceVersion() = announce(UpdateState.VERSION)

    private suspend fun announce(state: UpdateState) {
        val version = host.installed
        report(UpdateStatus(state, version.name, version.code))
    }

    /** Tells every phone that is connected. Nothing here may throw: a status nobody receives changes nothing on the watch. */
    suspend fun report(status: UpdateStatus) {
        val text = UpdateCodec.status(status)
        Log.i(TAG, "Update status for the phone: $text")
        val body = text.toByteArray(Charsets.UTF_8)
        val phones = try {
            transport.phones()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
        for (phone in phones) {
            try {
                transport.send(phone, UpdateProtocol.STATUS_PATH, body)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The phone went away: it will ask again when it comes back.
            }
        }
    }

    private fun reportBlocking(status: UpdateStatus) = runBlocking { report(status) }

    private companion object {
        const val TAG = "WatchUpdate"
    }
}

object InstallOutcomes {
    /** What Android's installer said (see InstallResultReceiver), as what the phone is told; null when there is nothing to tell. */
    fun statusOf(code: Int, systemMessage: String?): UpdateStatus? {
        val detail = systemMessage?.takeIf { it.isNotBlank() }?.let { " ($it)" }.orEmpty()
        return when (code) {
            PackageInstaller.STATUS_SUCCESS -> null // the new version announces itself when it starts
            PackageInstaller.STATUS_PENDING_USER_ACTION -> UpdateStatus(UpdateState.CONFIRM, message = "Confirmez la mise à jour sur la montre")
            PackageInstaller.STATUS_FAILURE_ABORTED -> UpdateStatus(UpdateState.FAILED, message = "Mise à jour annulée sur la montre$detail")
            PackageInstaller.STATUS_FAILURE_BLOCKED ->
                UpdateStatus(UpdateState.FAILED, message = "Installation bloquée par la montre (installation d’applications non autorisée ?)$detail")
            PackageInstaller.STATUS_FAILURE_CONFLICT -> UpdateStatus(UpdateState.FAILED, message = "La montre refuse cette version (conflit)$detail")
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> UpdateStatus(UpdateState.FAILED, message = "Cette version n’est pas compatible avec la montre$detail")
            PackageInstaller.STATUS_FAILURE_INVALID -> UpdateStatus(UpdateState.FAILED, message = "Fichier d’installation invalide$detail")
            PackageInstaller.STATUS_FAILURE_STORAGE -> UpdateStatus(UpdateState.FAILED, message = "Pas assez de place sur la montre pour installer$detail")
            else -> UpdateStatus(UpdateState.FAILED, message = "L’installation a échoué$detail")
        }
    }
}
