package com.selfhosthub.wear.service

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.service.link.LinkTransport
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The data layer as a test sees it: the phones that are "connected", every message handed over, and a hook for the
 * test to play the phone's answers.
 */
class FakeTransport : LinkTransport {
    data class Sent(val nodeId: String, val path: String, val text: String)

    val sent = CopyOnWriteArrayList<Sent>()
    @Volatile var nodes: List<String> = listOf("phone-1")
    @Volatile var nodesError: Exception? = null
    @Volatile var sendError: Exception? = null

    /** Called after each message is handed over, on the sender's thread. */
    @Volatile var onSend: ((Sent) -> Unit)? = null

    override suspend fun phones(): List<String> {
        nodesError?.let { throw it }
        return nodes
    }

    override suspend fun send(nodeId: String, path: String, data: ByteArray) {
        sendError?.let { throw it }
        val message = Sent(nodeId, path, String(data, Charsets.UTF_8))
        sent += message
        onSend?.invoke(message)
    }

    fun requests(): List<Sent> = sent.filter { it.path == LinkProtocol.REQUEST_PATH }

    fun commands(): List<JsonObject> = sent.filter { it.path == LinkProtocol.COMMAND_PATH }.map { JsonParser.parseString(it.text).asJsonObject }
}
