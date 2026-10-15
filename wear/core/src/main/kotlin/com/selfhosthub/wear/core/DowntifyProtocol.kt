package com.selfhosthub.wear.core

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Looking for a song to download with Downtify, from the watch. The watch never talks to Downtify (it has no address or
 * login for it): it asks the phone, which has them, over the same Wear OS data layer as the rest of the link.
 *
 * - the watch sends `search` with a request id and the words; the phone answers `results` with the same id, the songs
 *   found (a few, with what is needed to tell them apart) or why there are none;
 * - the watch sends `download` with a request id and one song's id from the last results; the phone answers `queued`
 *   as soon as Downtify has been asked (the download itself goes on without the watch).
 *
 * The phone's side is mobile/src/services/watchDowntify.ts; both read the sample files in core/src/test/resources.
 */
object DowntifyProtocol {
    const val VERSION = 1
    const val PREFIX = "/selfhost/downtify"
    const val SEARCH_PATH = "/selfhost/downtify/search"
    const val RESULTS_PATH = "/selfhost/downtify/results"
    const val DOWNLOAD_PATH = "/selfhost/downtify/download"
    const val QUEUED_PATH = "/selfhost/downtify/queued"

    /** The most songs the phone sends back: a small screen has no use for more, and a message is small. */
    const val MAX_RESULTS = 12
}

/** A song Downtify found, as the watch shows it. */
data class DowntifySong(
    val id: String,
    val title: String,
    val artist: String,
    val album: String?,
    /** Seconds; 0 when Downtify did not say. */
    val duration: Double
)

sealed interface DowntifyReply {
    val requestId: String

    data class Results(override val requestId: String, val songs: List<DowntifySong>) : DowntifyReply

    /** The phone could not search: Downtify is not connected there, or did not answer. */
    data class Failure(override val requestId: String, val message: String) : DowntifyReply

    /** Downtify was asked for the song (`ok`), or the phone says why it was not. */
    data class Queued(override val requestId: String, val songId: String, val ok: Boolean, val message: String?) : DowntifyReply
}

object DowntifyCodec {
    fun searchRequest(requestId: String, query: String): String = JsonObject().apply {
        addProperty("v", DowntifyProtocol.VERSION)
        addProperty("id", requestId)
        addProperty("query", query.trim().take(120))
    }.toString()

    fun downloadRequest(requestId: String, songId: String): String = JsonObject().apply {
        addProperty("v", DowntifyProtocol.VERSION)
        addProperty("id", requestId)
        addProperty("songId", songId)
    }.toString()

    /** Reads what the phone sent on `path`; null for anything that is not a well-formed answer of ours. */
    fun parse(path: String, text: String): DowntifyReply? {
        if (path != DowntifyProtocol.RESULTS_PATH && path != DowntifyProtocol.QUEUED_PATH) return null
        val obj = try {
            JsonParser.parseString(text).asObjectOrNull()
        } catch (_: Exception) {
            null
        } ?: return null
        if (obj.int("v") != DowntifyProtocol.VERSION) return null
        val id = obj.string("id")?.takeIf { it.isNotEmpty() } ?: return null
        if (path == DowntifyProtocol.QUEUED_PATH) {
            val songId = obj.string("songId") ?: return null
            return DowntifyReply.Queued(id, songId, obj.bool("ok"), obj.string("message"))
        }
        if (!obj.bool("ok")) return DowntifyReply.Failure(id, obj.string("error") ?: "Recherche impossible")
        val songs = obj.get("songs").let { list ->
            if (list != null && list.isJsonArray) {
                list.asJsonArray.mapNotNull { element ->
                    val song = element.asObjectOrNull() ?: return@mapNotNull null
                    val songId = song.string("id")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    DowntifySong(songId, song.string("title") ?: "", song.string("artist") ?: "", song.string("album")?.takeIf { it.isNotEmpty() }, song.double("duration"))
                }
            } else {
                emptyList()
            }
        }
        return DowntifyReply.Results(id, songs.take(DowntifyProtocol.MAX_RESULTS))
    }
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = if (this != null && this.isJsonObject) this.asJsonObject else null

private fun JsonObject.string(name: String): String? {
    val element = get(name)
    return if (element != null && element.isJsonPrimitive) element.asString else null
}

private fun JsonObject.int(name: String): Int? {
    val element = get(name)
    if (element == null || !element.isJsonPrimitive) return null
    return try {
        element.asInt
    } catch (_: NumberFormatException) {
        null
    }
}

private fun JsonObject.bool(name: String): Boolean {
    val element = get(name)
    return element != null && element.isJsonPrimitive && element.asJsonPrimitive.isBoolean && element.asBoolean
}

private fun JsonObject.double(name: String): Double {
    val element = get(name)
    if (element == null || !element.isJsonPrimitive) return 0.0
    return try {
        val value = element.asDouble
        if (value.isNaN() || value.isInfinite()) 0.0 else value.coerceAtLeast(0.0)
    } catch (_: NumberFormatException) {
        0.0
    }
}
