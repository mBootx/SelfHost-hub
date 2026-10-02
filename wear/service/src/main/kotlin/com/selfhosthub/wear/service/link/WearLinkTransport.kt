package com.selfhosthub.wear.service.link

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.android.gms.wearable.Wearable
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * The Wear OS data layer, seen from the watch: the phones connected now, and one message to one of them. The data
 * layer is the phone and watch's own encrypted link, and delivers a message only to the app of the same package
 * signed with the same key on the other side, so a node that does not have the app simply never hears it.
 */
class WearLinkTransport(private val context: Context) : LinkTransport {
    override suspend fun phones(): List<String> =
        Wearable.getNodeClient(context).connectedNodes.await().map { it.id }

    override suspend fun send(nodeId: String, path: String, data: ByteArray) {
        Wearable.getMessageClient(context).sendMessage(nodeId, path, data).await()
    }
}

/** Waits for a Google Play services task without blocking a thread. */
internal suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
    addOnSuccessListener { value -> if (continuation.isActive) continuation.resume(value) }
    addOnFailureListener { error -> if (continuation.isActive) continuation.resumeWithException(error) }
    addOnCanceledListener { continuation.cancel() }
}
