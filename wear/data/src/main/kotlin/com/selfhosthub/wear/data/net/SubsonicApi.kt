package com.selfhosthub.wear.data.net

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.selfhosthub.wear.core.NavidromeLogin
import com.selfhosthub.wear.core.PrivateAddress
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/** Navidrome is not set up on the watch yet. */
class NotConfiguredException : IOException("Navidrome n'est pas configuré")

/** The server answered, but not with what was asked for. `code` is Subsonic's own error code when it gave one. */
class SubsonicException(message: String, val code: Int?, val httpStatus: Int?) : IOException(message) {
    /** The account or the token is not accepted (Subsonic code 40, 41 or 44, or an HTTP 401). */
    val isAuthFailure: Boolean get() = code == 40 || code == 41 || code == 44 || httpStatus == 401
}

data class ApiArtist(val id: String, val name: String, val albumCount: Int, val coverArt: String?)

data class ApiAlbum(
    val id: String,
    val name: String,
    val artist: String,
    val artistId: String?,
    val coverArt: String?,
    val songCount: Int,
    val duration: Int,
    val year: Int?,
    val created: String?
)

data class ApiSong(
    val id: String,
    val title: String,
    val artist: String,
    val album: String?,
    val albumId: String?,
    val coverArt: String?,
    val duration: Int,
    val track: Int?
)

data class ApiPlaylist(val id: String, val name: String, val songCount: Int, val changed: String?, val coverArt: String?)

data class ArtistIndex(val artists: List<ApiArtist>, val lastModified: Long?)
data class AlbumDetail(val album: ApiAlbum, val songs: List<ApiSong>)
data class PlaylistDetail(val playlist: ApiPlaylist, val songs: List<ApiSong>)
data class SearchResults(val artists: List<ApiArtist>, val albums: List<ApiAlbum>, val songs: List<ApiSong>)
data class PingInfo(val version: String?, val latencyMs: Long)

/** A song someone is playing right now on any of their devices, as the server sees it. */
data class NowPlayingEntry(val song: ApiSong, val username: String, val minutesAgo: Int, val playerName: String?)

/**
 * The part of the Subsonic API (as Navidrome serves it) that the watch uses. Every call signs itself with the
 * current login, so a login that changes (the phone sent another one) is picked up by the next request.
 *
 * `homeClient` is used for a server on the home network (see PrivateAddress), `client` for any other.
 */
class SubsonicApi(
    private val client: OkHttpClient,
    private val homeClient: OkHttpClient = client,
    private val login: () -> NavidromeLogin?
) {

    suspend fun ping(): PingInfo {
        val started = System.nanoTime()
        val body = call("ping")
        return PingInfo(body.string("serverVersion") ?: body.string("version"), (System.nanoTime() - started) / 1_000_000)
    }

    suspend fun artists(): ArtistIndex {
        val artists = call("getArtists").objectOrNull("artists")
        val list = mutableListOf<ApiArtist>()
        for (group in artists.children("index")) {
            for (item in group.children("artist")) list += item.toArtist() ?: continue
        }
        return ArtistIndex(list, artists?.long("lastModified"))
    }

    /** Subsonic's `getArtist`: the albums of one artist. */
    suspend fun albumsByArtist(artistId: String): List<ApiAlbum> =
        call("getArtist", "id" to artistId).objectOrNull("artist").children("album").mapNotNull { it.toAlbum() }

    /** One page of `getAlbumList2`. `type` is one of alphabeticalByName, newest, recent, frequent, random... */
    suspend fun albumList(type: String, size: Int, offset: Int = 0): List<ApiAlbum> =
        call("getAlbumList2", "type" to type, "size" to size.toString(), "offset" to offset.toString())
            .objectOrNull("albumList2").children("album").mapNotNull { it.toAlbum() }

    /** Subsonic's `getAlbum`: the album and its songs. */
    suspend fun songsOfAlbum(albumId: String): AlbumDetail {
        val album = call("getAlbum", "id" to albumId).objectOrNull("album")
            ?: throw SubsonicException("Album introuvable", 70, null)
        return AlbumDetail(album.toAlbum() ?: throw SubsonicException("Album illisible", null, null), album.children("song").mapNotNull { it.toSong() })
    }

    suspend fun playlists(): List<ApiPlaylist> =
        call("getPlaylists").objectOrNull("playlists").children("playlist").mapNotNull { it.toPlaylist() }

    suspend fun songsOfPlaylist(playlistId: String): PlaylistDetail {
        val playlist = call("getPlaylist", "id" to playlistId).objectOrNull("playlist")
            ?: throw SubsonicException("Playlist introuvable", 70, null)
        return PlaylistDetail(playlist.toPlaylist() ?: throw SubsonicException("Playlist illisible", null, null), playlist.children("entry").mapNotNull { it.toSong() })
    }

    suspend fun search(query: String, artistCount: Int = 8, albumCount: Int = 8, songCount: Int = 20): SearchResults {
        val result = call(
            "search3",
            "query" to query,
            "artistCount" to artistCount.toString(),
            "albumCount" to albumCount.toString(),
            "songCount" to songCount.toString()
        ).objectOrNull("searchResult3")
        return SearchResults(
            result.children("artist").mapNotNull { it.toArtist() },
            result.children("album").mapNotNull { it.toAlbum() },
            result.children("song").mapNotNull { it.toSong() }
        )
    }

    suspend fun nowPlaying(): List<NowPlayingEntry> =
        call("getNowPlaying").objectOrNull("nowPlaying").children("entry").mapNotNull { entry ->
            val song = entry.toSong() ?: return@mapNotNull null
            NowPlayingEntry(song, entry.string("username").orEmpty(), entry.int("minutesAgo") ?: 0, entry.string("playerName"))
        }

    /** A cover, resized by the server to `size` pixels square. */
    suspend fun coverArt(coverId: String, size: Int): ByteArray {
        val current = login() ?: throw NotConfiguredException()
        val url = urlFor(current, "getCoverArt", "id" to coverId, "size" to size.toString())
        val reply = execute(Request.Builder().url(url).build())
        if (!reply.isSuccessful) throw SubsonicException("Requête échouée (${reply.code})", null, reply.code)
        // A cover that does not exist comes back as a 200 with an error document instead of an image.
        if (!reply.contentType.startsWith("image/") || reply.body.isEmpty()) throw SubsonicException("Pas de pochette", null, reply.code)
        return reply.body
    }

    /** The address of a call, for the tests and for anything that needs to load it itself. */
    fun urlFor(login: NavidromeLogin, method: String, vararg params: Pair<String, String>): okhttp3.HttpUrl {
        val base = login.baseUrl.toHttpUrlOrNull() ?: throw SubsonicException("Adresse Navidrome invalide", null, null)
        val builder = base.newBuilder().addPathSegments("rest/$method.view")
        for ((key, value) in login.queryParameters()) builder.addQueryParameter(key, value)
        for ((key, value) in params) builder.addQueryParameter(key, value)
        return builder.build()
    }

    private suspend fun call(method: String, vararg params: Pair<String, String>): JsonObject {
        val current = login() ?: throw NotConfiguredException()
        val reply = execute(Request.Builder().url(urlFor(current, method, *params)).build())
        if (!reply.isSuccessful) throw SubsonicException("Requête échouée (${reply.code})", null, reply.code)
        val root = try {
            JsonParser.parseString(reply.text)
        } catch (_: Exception) {
            throw SubsonicException("Réponse Navidrome invalide", null, reply.code)
        }
        val body = root.takeIf { it.isJsonObject }?.asJsonObject?.objectOrNull("subsonic-response")
            ?: throw SubsonicException("Réponse Navidrome invalide", null, reply.code)
        if (body.string("status") == "failed") {
            val error = body.objectOrNull("error")
            throw SubsonicException(error?.string("message") ?: "Erreur Navidrome", error?.int("code"), reply.code)
        }
        return body
    }

    /** What the server answered, read in full: nothing is left holding a connection that someone has to close. */
    private class Reply(val code: Int, val contentType: String, val body: ByteArray) {
        val isSuccessful: Boolean get() = code in 200..299
        val text: String get() = String(body, Charsets.UTF_8)
    }

    private suspend fun execute(request: Request): Reply = suspendCancellableCoroutine { continuation ->
        val call: Call = (if (PrivateAddress.isPrivate(request.url.host)) homeClient else client).newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                // Read here, on OkHttp's own thread, and closed whatever happens next. A response handed across to a
                // coroutine that was cancelled in the meantime would never be closed (cancelling the call does not
                // release it): its connection stays held until a garbage collection notices, and OkHttp reports it as
                // "A connection to ... was leaked". A screen of covers being left while they load can do that.
                val reply = try {
                    response.use { Reply(it.code, it.header("Content-Type").orEmpty(), it.body?.bytes() ?: ByteArray(0)) }
                } catch (e: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(e)
                    return
                }
                if (continuation.isActive) continuation.resume(reply)
            }
        })
    }
}

// --- Reading the JSON: tolerant of missing fields, and of the single-element object that some servers send instead of an array ---

private fun JsonElement?.objectOrNull(): JsonObject? = if (this != null && isJsonObject) asJsonObject else null

private fun JsonObject?.objectOrNull(name: String): JsonObject? = this?.get(name).objectOrNull()

private fun JsonObject?.children(name: String): List<JsonObject> {
    val element = this?.get(name) ?: return emptyList()
    return when {
        element is JsonArray -> element.mapNotNull { it.objectOrNull() }
        element.isJsonObject -> listOf(element.asJsonObject)
        else -> emptyList()
    }
}

private fun JsonObject.string(name: String): String? {
    val element = get(name)
    return if (element != null && element.isJsonPrimitive) element.asString.ifEmpty { null } else null
}

private fun JsonObject.int(name: String): Int? {
    val element = get(name)
    if (element == null || !element.isJsonPrimitive) return null
    return try {
        element.asDouble.toInt()
    } catch (_: NumberFormatException) {
        null
    }
}

private fun JsonObject.long(name: String): Long? {
    val element = get(name)
    if (element == null || !element.isJsonPrimitive) return null
    return try {
        element.asDouble.toLong()
    } catch (_: NumberFormatException) {
        null
    }
}

private fun JsonObject.toArtist(): ApiArtist? {
    val id = string("id") ?: return null
    return ApiArtist(id, string("name") ?: "?", int("albumCount") ?: 0, string("coverArt"))
}

private fun JsonObject.toAlbum(): ApiAlbum? {
    val id = string("id") ?: return null
    return ApiAlbum(
        id = id,
        name = string("name") ?: string("title") ?: "?",
        artist = string("artist") ?: "",
        artistId = string("artistId"),
        coverArt = string("coverArt"),
        songCount = int("songCount") ?: 0,
        duration = int("duration") ?: 0,
        year = int("year")?.takeIf { it > 0 },
        created = string("created")
    )
}

private fun JsonObject.toSong(): ApiSong? {
    val id = string("id") ?: return null
    return ApiSong(
        id = id,
        title = string("title") ?: "?",
        artist = string("artist") ?: "",
        album = string("album"),
        albumId = string("albumId"),
        coverArt = string("coverArt"),
        duration = int("duration") ?: 0,
        track = int("track")?.takeIf { it > 0 }
    )
}

private fun JsonObject.toPlaylist(): ApiPlaylist? {
    val id = string("id") ?: return null
    return ApiPlaylist(id, string("name") ?: "?", int("songCount") ?: 0, string("changed"), string("coverArt"))
}
