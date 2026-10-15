package com.selfhosthub.wear.service.link

import com.selfhosthub.wear.core.DowntifyCodec
import com.selfhosthub.wear.core.DowntifyProtocol
import com.selfhosthub.wear.core.DowntifyReply
import com.selfhosthub.wear.core.DowntifySong
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/** What a search through the phone came to. */
sealed interface DowntifySearch {
    data class Found(val songs: List<DowntifySong>) : DowntifySearch

    /** In words for the screen: nobody to ask, Downtify not connected on the phone, no answer. */
    data class Failed(val message: String) : DowntifySearch
}

/** What asking for a download came to. */
data class DowntifyDownload(val ok: Boolean, val message: String?)

/**
 * Downtify, through the phone (see DowntifyProtocol): a question goes out with a number, and the answer that comes
 * back with the same number completes it. Nothing is kept once a question is answered or has timed out, and an answer
 * nobody waits for any more (a screen that was left) is dropped.
 */
class DowntifyLink(
    private val transport: LinkTransport,
    /** How long the phone gets to answer a search: it asks Downtify, which can take a few seconds. */
    private val searchTimeoutMs: Long = 30_000,
    private val downloadTimeoutMs: Long = 20_000,
    private val newId: () -> String = { UUID.randomUUID().toString().take(8) }
) {
    private val waiting = ConcurrentHashMap<String, CompletableDeferred<DowntifyReply>>()

    suspend fun search(query: String): DowntifySearch {
        val words = query.trim()
        if (words.isEmpty()) return DowntifySearch.Found(emptyList())
        val id = newId()
        return when (val reply = ask(id, DowntifyProtocol.SEARCH_PATH, DowntifyCodec.searchRequest(id, words), searchTimeoutMs)) {
            is DowntifyReply.Results -> DowntifySearch.Found(reply.songs)
            is DowntifyReply.Failure -> DowntifySearch.Failed(reply.message)
            is DowntifyReply.Queued -> DowntifySearch.Failed("Réponse inattendue du téléphone")
            null -> DowntifySearch.Failed(NO_ANSWER)
        }
    }

    suspend fun download(songId: String): DowntifyDownload {
        val id = newId()
        return when (val reply = ask(id, DowntifyProtocol.DOWNLOAD_PATH, DowntifyCodec.downloadRequest(id, songId), downloadTimeoutMs)) {
            is DowntifyReply.Queued -> DowntifyDownload(reply.ok, reply.message)
            is DowntifyReply.Failure -> DowntifyDownload(false, reply.message)
            is DowntifyReply.Results -> DowntifyDownload(false, "Réponse inattendue du téléphone")
            null -> DowntifyDownload(false, NO_ANSWER)
        }
    }

    /** From the service that receives the data layer's messages. */
    fun onMessage(path: String, data: ByteArray) {
        val reply = DowntifyCodec.parse(path, String(data, Charsets.UTF_8)) ?: return
        waiting[reply.requestId]?.complete(reply)
    }

    private suspend fun ask(id: String, path: String, body: String, timeoutMs: Long): DowntifyReply? {
        val phones = try {
            transport.phones()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
        if (phones.isEmpty()) return DowntifyReply.Failure(id, NO_PHONE)
        val answer = CompletableDeferred<DowntifyReply>()
        waiting[id] = answer
        try {
            var sent = false
            for (phone in phones) {
                try {
                    transport.send(phone, path, body.toByteArray(Charsets.UTF_8))
                    sent = true
                    break
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Another phone may take it.
                }
            }
            if (!sent) return DowntifyReply.Failure(id, NOT_SENT)
            return withTimeoutOrNull(timeoutMs) { answer.await() }
        } finally {
            waiting.remove(id)
        }
    }

    companion object {
        const val NO_PHONE = "Pas de téléphone connecté"
        const val NOT_SENT = "La demande n’a pas pu partir"
        const val NO_ANSWER = "Le téléphone n’a pas répondu"
    }
}
