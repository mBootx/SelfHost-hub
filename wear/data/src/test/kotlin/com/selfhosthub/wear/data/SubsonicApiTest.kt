package com.selfhosthub.wear.data

import com.selfhosthub.wear.core.NavidromeLogin
import com.selfhosthub.wear.data.net.NotConfiguredException
import com.selfhosthub.wear.data.net.SubsonicApi
import com.selfhosthub.wear.data.net.SubsonicException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SubsonicApiTest {
    private val navidrome = FakeNavidrome()
    private lateinit var server: MockWebServer
    private lateinit var api: SubsonicApi
    private lateinit var login: NavidromeLogin

    @Before
    fun start() {
        server = MockWebServer().apply {
            dispatcher = navidrome
            start()
        }
        login = navidrome.login(server)
        api = SubsonicApi(OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()) { login }
        navidrome.artists += FakeNavidrome.Artist("ar-1", "Alt-J", 2)
        navidrome.artists += FakeNavidrome.Artist("ar-2", "Björk", 1)
        navidrome.artists += FakeNavidrome.Artist("ar-3", "Air", 1)
        navidrome.albums += FakeNavidrome.Album(
            "al-1", "An Awesome Wave", "Alt-J", "ar-1", 2012,
            songs = listOf(FakeNavidrome.Song("so-1", "Intro", "Alt-J", 1, 168), FakeNavidrome.Song("so-2", "Tessellate", "Alt-J", 2, 183))
        )
        navidrome.albums += FakeNavidrome.Album("al-2", "Relaxer", "Alt-J", "ar-1", 2017, songs = listOf(FakeNavidrome.Song("so-3", "3WW", "Alt-J", 1, 340)))
        navidrome.albums += FakeNavidrome.Album("al-3", "Homogenic", "Björk", "ar-2", 1997, songs = listOf(FakeNavidrome.Song("so-4", "Hunter", "Björk", 1, 252)))
    }

    @After
    fun stop() {
        server.shutdown()
    }

    @Test
    fun `every call is signed with the user, the token and the salt, and asks for json`() = runBlocking {
        api.ping()
        val sent = navidrome.authParameters.single()
        assertEquals("maxime", sent["u"])
        assertEquals(login.token, sent["t"])
        assertEquals("c19b2d", sent["s"])
        assertEquals("1.16.1", sent["v"])
        assertEquals("SelfHostHubWear", sent["c"])
        assertEquals("json", sent["f"])
        // The password itself is never part of the request.
        assertFalse(server.takeRequest().requestUrl.toString().contains("sesame"))
    }

    @Test
    fun `ping reports the server version`() = runBlocking {
        assertEquals("0.54.5", api.ping().version)
    }

    @Test
    fun `artists come flat out of the alphabetical index, with the library stamp`() = runBlocking {
        val index = api.artists()
        assertEquals(listOf("Air", "Alt-J", "Björk"), index.artists.map { it.name })
        assertEquals(2, index.artists.first { it.id == "ar-1" }.albumCount)
        assertEquals(1_000L, index.lastModified)
    }

    @Test
    fun `a server that sends no stamp gives none`() = runBlocking {
        navidrome.lastModified = null
        assertNull(api.artists().lastModified)
    }

    @Test
    fun `the albums of an artist`() = runBlocking {
        val albums = api.albumsByArtist("ar-1")
        assertEquals(listOf("al-1", "al-2"), albums.map { it.id })
        assertEquals(2012, albums.first().year)
        assertEquals("ar-1", albums.first().artistId)
        assertEquals(2, albums.first().songCount)
    }

    @Test
    fun `album lists are paged and sorted the way they were asked`() = runBlocking {
        assertEquals(listOf("An Awesome Wave", "Homogenic"), api.albumList("alphabeticalByName", 2, 0).map { it.name })
        assertEquals(listOf("Relaxer"), api.albumList("alphabeticalByName", 2, 2).map { it.name })
        assertEquals(2, navidrome.callsTo("getAlbumList2"))
    }

    @Test
    fun `the songs of an album`() = runBlocking {
        val detail = api.songsOfAlbum("al-1")
        assertEquals("An Awesome Wave", detail.album.name)
        assertEquals(listOf("Intro", "Tessellate"), detail.songs.map { it.title })
        assertEquals(168, detail.songs.first().duration)
        assertEquals("al-1", detail.songs.first().albumId)
        assertEquals("al-1", detail.songs.first().coverArt)
    }

    @Test
    fun `an album that does not exist is a Subsonic error`() {
        val e = assertThrows(SubsonicException::class.java) { runBlocking { api.songsOfAlbum("nope") } }
        assertEquals(70, e.code)
        assertFalse(e.isAuthFailure)
    }

    @Test
    fun `playlists and their entries`() = runBlocking {
        navidrome.playlists += FakeNavidrome.Playlist("pl-1", "Route", "2026-01-01T10:00:00Z", listOf(FakeNavidrome.Song("so-9", "Titre", "Quelqu'un", albumId = "al-1")))
        val list = api.playlists()
        assertEquals("Route", list.single().name)
        assertEquals("2026-01-01T10:00:00Z", list.single().changed)
        val detail = api.songsOfPlaylist("pl-1")
        assertEquals(listOf("so-9"), detail.songs.map { it.id })
    }

    @Test
    fun `search gives artists, albums and songs`() = runBlocking {
        val result = api.search("a")
        assertTrue(result.artists.isNotEmpty() && result.albums.isNotEmpty() && result.songs.isNotEmpty())
        val songs = api.search("hunt").songs
        assertEquals(listOf("so-4"), songs.map { it.id })
    }

    @Test
    fun `now playing lists what others are playing`() = runBlocking {
        navidrome.nowPlaying = listOf(FakeNavidrome.Song("so-1", "Intro", "Alt-J", albumId = "al-1") to "alice")
        val entry = api.nowPlaying().single()
        assertEquals("Intro", entry.song.title)
        assertEquals("alice", entry.username)
        assertEquals("Phone", entry.playerName)
    }

    @Test
    fun `a cover comes back as bytes`() = runBlocking {
        assertArrayEquals(byteArrayOf(0x42, 0x13, 0x37), api.coverArt("al-1", 160))
        val request = server.takeRequest()
        assertEquals("160", request.requestUrl!!.queryParameter("size"))
        assertEquals("al-1", request.requestUrl!!.queryParameter("id"))
    }

    @Test
    fun `a missing cover is an error, not an image`() {
        navidrome.missingCovers += "al-9"
        assertThrows(SubsonicException::class.java) { runBlocking { api.coverArt("al-9", 160) } }
    }

    @Test
    fun `wrong credentials are an authentication failure`() {
        navidrome.failure = { FakeNavidrome.authFailure() }
        val e = assertThrows(SubsonicException::class.java) { runBlocking { api.artists() } }
        assertEquals(40, e.code)
        assertTrue(e.isAuthFailure)
    }

    @Test
    fun `an http error carries its status`() {
        navidrome.failure = { FakeNavidrome.serverError() }
        val e = assertThrows(SubsonicException::class.java) { runBlocking { api.ping() } }
        assertEquals(500, e.httpStatus)
    }

    @Test
    fun `something that is not a Subsonic answer is refused`() {
        navidrome.failure = { MockResponse().setBody("<html>proxy error</html>") }
        assertThrows(SubsonicException::class.java) { runBlocking { api.ping() } }
    }

    @Test
    fun `an unreachable server is an io error`() {
        server.shutdown()
        assertThrows(java.io.IOException::class.java) { runBlocking { api.ping() } }
    }

    @Test
    fun `without a login nothing is sent`() {
        val unconfigured = SubsonicApi(OkHttpClient()) { null }
        assertThrows(NotConfiguredException::class.java) { runBlocking { unconfigured.ping() } }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `the login is read at every call, so a new one takes effect at once`() = runBlocking {
        var current: NavidromeLogin? = null
        val changing = SubsonicApi(OkHttpClient()) { current }
        assertThrows(NotConfiguredException::class.java) { runBlocking { changing.ping() } }
        current = login
        changing.ping()
        assertEquals(1, navidrome.callsTo("ping"))
    }

    @Test
    fun `a server on the home network is reached with the home client, any other with the ordinary one`() = runBlocking {
        val used = mutableListOf<String>()
        fun counting(name: String) = OkHttpClient.Builder().addInterceptor { chain ->
            used += name
            chain.proceed(chain.request())
        }.build()

        // "localhost" is a name without a dot: a home name. 127.0.0.1 is no address of a home network.
        SubsonicApi(counting("ordinary"), counting("home")) { login.copy(url = "http://localhost:${server.port}") }.ping()
        SubsonicApi(counting("ordinary"), counting("home")) { login.copy(url = "http://127.0.0.1:${server.port}") }.ping()
        assertEquals(listOf("home", "ordinary"), used)
    }

    @Test
    fun `a single object where an array is expected is read as a list of one`() = runBlocking {
        navidrome.failure = {
            MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{"subsonic-response":{"status":"ok","version":"1.16.1","playlists":{"playlist":{"id":"pl-1","name":"Seule","songCount":1}}}}"""
            )
        }
        assertEquals(listOf("Seule"), api.playlists().map { it.name })
    }
}
