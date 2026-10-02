package com.selfhosthub.wear.data

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.selfhosthub.wear.core.NavidromeLogin
import com.selfhosthub.wear.core.SubsonicAuth
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer

/** A small stand-in for Navidrome's Subsonic API, enough for the watch's calls, that records what it was asked. */
class FakeNavidrome : Dispatcher() {
    data class Artist(val id: String, val name: String, val albumCount: Int = 1, val coverArt: String? = "ar-$id")
    data class Song(val id: String, val title: String, val artist: String, val track: Int = 1, val duration: Int = 200, val albumId: String? = null)
    data class Album(
        val id: String,
        val name: String,
        val artist: String,
        val artistId: String,
        val year: Int? = 2020,
        val created: String = "2024-01-01T00:00:00Z",
        val songs: List<Song> = emptyList()
    )
    data class Playlist(val id: String, val name: String, val changed: String, val songs: List<Song>)

    val artists = mutableListOf<Artist>()
    val albums = mutableListOf<Album>()
    val playlists = mutableListOf<Playlist>()
    var lastModified: Long? = 1_000L
    var nowPlaying: List<Pair<Song, String>> = emptyList()
    val missingCovers = mutableSetOf<String>()
    var coverBytes: ByteArray = byteArrayOf(0x42, 0x13, 0x37)

    /** Every request as "method" or "method?type=..." in arrival order. */
    val calls = mutableListOf<String>()
    val authParameters = mutableListOf<Map<String, String>>()

    /** When set, answers every request (except the ones in `failOnly`, if non-empty) with this instead. */
    var failure: (() -> MockResponse)? = null
    var failOnly: Set<String> = emptySet()
    var gate: java.util.concurrent.CountDownLatch? = null

    fun callsTo(method: String): Int = calls.count { it == method || it.startsWith("$method?") }

    override fun dispatch(request: RecordedRequest): MockResponse {
        val url = request.requestUrl ?: return MockResponse().setResponseCode(400)
        val method = url.pathSegments.last().removeSuffix(".view")
        val type = url.queryParameter("type")
        synchronized(calls) {
            calls += if (type != null) "$method?type=$type" else method
            authParameters += listOf("u", "t", "s", "v", "c", "f").associateWith { url.queryParameter(it).orEmpty() }
        }
        // Lets a test hold a request up, to have two overlap.
        if (method == "getArtists") gate?.await(5, java.util.concurrent.TimeUnit.SECONDS)
        val fail = failure
        if (fail != null && (failOnly.isEmpty() || method in failOnly)) return fail()
        return when (method) {
            "ping" -> ok()
            "getArtists" -> ok(
                "artists",
                JsonObject().apply {
                    lastModified?.let { addProperty("lastModified", it) }
                    add(
                        "index",
                        JsonArray().apply {
                            artists.groupBy { it.name.first().uppercaseChar() }.toSortedMap().forEach { (letter, group) ->
                                add(JsonObject().apply {
                                    addProperty("name", letter.toString())
                                    add("artist", JsonArray().apply { group.sortedBy { it.name.lowercase() }.forEach { add(artistJson(it)) } })
                                })
                            }
                        }
                    )
                }
            )
            "getArtist" -> {
                val artist = artists.firstOrNull { it.id == url.queryParameter("id") } ?: return error(70, "Artist not found")
                ok("artist", artistJson(artist).apply {
                    add("album", JsonArray().apply { albums.filter { it.artistId == artist.id }.forEach { add(albumJson(it)) } })
                })
            }
            "getAlbumList2" -> {
                val size = url.queryParameter("size")?.toInt() ?: 10
                val offset = url.queryParameter("offset")?.toInt() ?: 0
                val sorted = if (type == "newest") albums.sortedByDescending { it.created } else albums.sortedBy { it.name.lowercase() }
                ok("albumList2", JsonObject().apply { add("album", JsonArray().apply { sorted.drop(offset).take(size).forEach { add(albumJson(it)) } }) })
            }
            "getAlbum" -> {
                val album = albums.firstOrNull { it.id == url.queryParameter("id") } ?: return error(70, "Album not found")
                ok("album", albumJson(album).apply { add("song", JsonArray().apply { album.songs.forEach { add(songJson(it, album.id)) } }) })
            }
            "getPlaylists" -> ok("playlists", JsonObject().apply { add("playlist", JsonArray().apply { playlists.forEach { add(playlistJson(it)) } }) })
            "getPlaylist" -> {
                val playlist = playlists.firstOrNull { it.id == url.queryParameter("id") } ?: return error(70, "Playlist not found")
                ok("playlist", playlistJson(playlist).apply { add("entry", JsonArray().apply { playlist.songs.forEach { add(songJson(it, it.albumId)) } }) })
            }
            "search3" -> {
                val q = url.queryParameter("query").orEmpty().lowercase()
                ok(
                    "searchResult3",
                    JsonObject().apply {
                        add("artist", JsonArray().apply { artists.filter { q in it.name.lowercase() }.forEach { add(artistJson(it)) } })
                        add("album", JsonArray().apply { albums.filter { q in it.name.lowercase() }.forEach { add(albumJson(it)) } })
                        add("song", JsonArray().apply { albums.flatMap { a -> a.songs.map { it to a.id } }.filter { q in it.first.title.lowercase() }.forEach { add(songJson(it.first, it.second)) } })
                    }
                )
            }
            "getNowPlaying" -> ok(
                "nowPlaying",
                JsonObject().apply {
                    add("entry", JsonArray().apply {
                        nowPlaying.forEach { (song, user) -> add(songJson(song, song.albumId).apply { addProperty("username", user); addProperty("minutesAgo", 2); addProperty("playerName", "Phone") }) }
                    })
                }
            )
            "getCoverArt" -> {
                val id = url.queryParameter("id").orEmpty()
                if (id in missingCovers) MockResponse().setHeader("Content-Type", "application/json").setBody("""{"subsonic-response":{"status":"failed","version":"1.16.1","error":{"code":70,"message":"Cover not found"}}}""")
                else MockResponse().setHeader("Content-Type", "image/jpeg").setBody(Buffer().write(coverBytes))
            }
            else -> error(0, "Unknown method $method")
        }
    }

    fun login(server: MockWebServer, password: String = "sesame", salt: String = "c19b2d") =
        NavidromeLogin(server.url("/").toString(), "maxime", salt, SubsonicAuth.token(password, salt))

    // --- JSON ---

    private fun artistJson(a: Artist) = JsonObject().apply {
        addProperty("id", a.id)
        addProperty("name", a.name)
        addProperty("albumCount", a.albumCount)
        a.coverArt?.let { addProperty("coverArt", it) }
    }

    private fun albumJson(a: Album) = JsonObject().apply {
        addProperty("id", a.id)
        addProperty("name", a.name)
        addProperty("artist", a.artist)
        addProperty("artistId", a.artistId)
        addProperty("coverArt", a.id)
        addProperty("songCount", a.songs.size)
        addProperty("duration", a.songs.sumOf { it.duration })
        a.year?.let { addProperty("year", it) }
        addProperty("created", a.created)
    }

    private fun songJson(s: Song, albumId: String?) = JsonObject().apply {
        addProperty("id", s.id)
        addProperty("title", s.title)
        addProperty("artist", s.artist)
        addProperty("track", s.track)
        addProperty("duration", s.duration)
        if (albumId != null) {
            addProperty("albumId", albumId)
            addProperty("album", albums.firstOrNull { it.id == albumId }?.name ?: "Album")
            addProperty("coverArt", albumId)
        }
    }

    private fun playlistJson(p: Playlist) = JsonObject().apply {
        addProperty("id", p.id)
        addProperty("name", p.name)
        addProperty("songCount", p.songs.size)
        addProperty("changed", p.changed)
    }

    private fun ok(key: String? = null, payload: JsonObject? = null): MockResponse {
        val body = JsonObject().apply {
            addProperty("status", "ok")
            addProperty("version", "1.16.1")
            addProperty("serverVersion", "0.54.5")
            if (key != null && payload != null) add(key, payload)
        }
        return MockResponse().setHeader("Content-Type", "application/json").setBody(JsonObject().apply { add("subsonic-response", body) }.toString())
    }

    private fun error(code: Int, message: String): MockResponse {
        val body = JsonObject().apply {
            addProperty("status", "failed")
            addProperty("version", "1.16.1")
            add("error", JsonObject().apply { addProperty("code", code); addProperty("message", message) })
        }
        return MockResponse().setHeader("Content-Type", "application/json").setBody(JsonObject().apply { add("subsonic-response", body) }.toString())
    }

    companion object {
        fun authFailure() = MockResponse().setHeader("Content-Type", "application/json")
            .setBody("""{"subsonic-response":{"status":"failed","version":"1.16.1","error":{"code":40,"message":"Wrong username or password"}}}""")

        fun serverError() = MockResponse().setResponseCode(500).setBody("boom")
    }
}
