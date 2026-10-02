package com.selfhosthub.wear.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.selfhosthub.wear.data.db.AlbumEntity
import com.selfhosthub.wear.data.db.ArtworkEntity
import com.selfhosthub.wear.data.db.WatchDatabase
import com.selfhosthub.wear.data.net.SubsonicApi
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LibraryRepositoryTest {
    private val navidrome = FakeNavidrome()
    private lateinit var server: MockWebServer
    private lateinit var db: WatchDatabase
    private lateinit var repository: LibraryRepository
    private var clock = 5_000L

    @Before
    fun start() {
        server = MockWebServer().apply {
            dispatcher = navidrome
            start()
        }
        db = WatchDatabase.inMemory(ApplicationProvider.getApplicationContext<Context>())
        val login = navidrome.login(server)
        repository = LibraryRepository(db, SubsonicApi(OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()) { login }, now = { clock })

        navidrome.artists += FakeNavidrome.Artist("ar-1", "Alt-J", 2)
        navidrome.albums += FakeNavidrome.Album(
            "al-1", "An Awesome Wave", "Alt-J", "ar-1", 2012,
            songs = listOf(
                FakeNavidrome.Song("so-2", "Tessellate", "Alt-J", 2, 183),
                FakeNavidrome.Song("so-1", "Intro", "Alt-J", 1, 168)
            )
        )
        navidrome.albums += FakeNavidrome.Album("al-2", "100% (Live)", "Alt-J", "ar-1", 2017, songs = listOf(FakeNavidrome.Song("so-3", "3WW", "Alt-J")))
    }

    @After
    fun stop() {
        db.close()
        server.shutdown()
    }

    @Test
    fun `an artist's albums are read once, then served from the watch`() = runBlocking {
        db.library().upsertArtists(listOf(com.selfhosthub.wear.data.db.ArtistEntity("ar-1", "Alt-J", 2, null, 1)))
        assertEquals(LoadResult.Fetched, repository.ensureAlbumsOfArtist("ar-1"))
        assertEquals(LoadResult.Cached, repository.ensureAlbumsOfArtist("ar-1"))
        assertEquals(1, navidrome.callsTo("getArtist"))
        val albums = repository.albumsOfArtist("ar-1").first()
        // Newest first.
        assertEquals(listOf("al-2", "al-1"), albums.map { it.id })
    }

    @Test
    fun `an album's songs are read once and shown in track order`() = runBlocking {
        assertEquals(LoadResult.Fetched, repository.ensureTracksOfAlbum("al-1"))
        assertEquals(LoadResult.Cached, repository.ensureTracksOfAlbum("al-1"))
        assertEquals(1, navidrome.callsTo("getAlbum"))
        val tracks = repository.tracksOfAlbum("al-1").first()
        assertEquals(listOf("Intro", "Tessellate"), tracks.map { it.title })
        assertEquals(168L, tracks.first().duration)
        assertEquals("al-1", tracks.first().coverId)
    }

    @Test
    fun `an album with fewer songs stored than it has is read again`() = runBlocking {
        repository.ensureTracksOfAlbum("al-1")
        db.library().deleteTracksOfAlbum("al-1")
        db.library().upsertTracks(listOf(com.selfhosthub.wear.data.db.TrackEntity("so-1", "Intro", "Alt-J", "x", "al-1", 168, null, 1, 1)))
        assertEquals(LoadResult.Fetched, repository.ensureTracksOfAlbum("al-1"))
        assertEquals(2, db.library().trackCountOfAlbum("al-1"))
    }

    @Test
    fun `offline, what is stored is still there and the loader says the server is unavailable`() = runBlocking {
        repository.ensureTracksOfAlbum("al-1")
        server.shutdown()
        db.library().upsertAlbums(listOf(AlbumEntity("al-2", "Autre", "X", null, null, null, 5, null, 1)))
        val result = repository.ensureTracksOfAlbum("al-2") as LoadResult.Unavailable
        assertFalse(result.authFailure)
        assertEquals(2, repository.tracksOfAlbum("al-1").first().size)
    }

    @Test
    fun `a refused account is reported as such by the loaders`() = runBlocking {
        navidrome.failure = { FakeNavidrome.authFailure() }
        val result = repository.ensureTracksOfAlbum("al-1") as LoadResult.Unavailable
        assertTrue(result.authFailure)
    }

    @Test
    fun `a playlist's songs keep their order`() = runBlocking {
        navidrome.playlists += FakeNavidrome.Playlist(
            "pl-1", "Route", "2026-01-01T00:00:00Z",
            listOf(FakeNavidrome.Song("so-9", "Zèbre", "Z"), FakeNavidrome.Song("so-1", "Intro", "Alt-J", albumId = "al-1"), FakeNavidrome.Song("so-5", "Alpha", "A"))
        )
        db.library().upsertPlaylists(listOf(com.selfhosthub.wear.data.db.PlaylistEntity("pl-1", "Route", 3, "2026-01-01T00:00:00Z", null, 1)))
        assertEquals(LoadResult.Fetched, repository.ensureTracksOfPlaylist("pl-1"))
        assertEquals(LoadResult.Cached, repository.ensureTracksOfPlaylist("pl-1"))
        assertEquals(listOf("Zèbre", "Intro", "Alpha"), repository.tracksOfPlaylist("pl-1").first().map { it.title })
    }

    @Test
    fun `search asks the server`() = runBlocking {
        val result = repository.search("tess")
        assertTrue(result.fromServer)
        assertEquals(listOf("Tessellate"), result.tracks.map { it.title })
    }

    @Test
    fun `search falls back to what is stored when the server does not answer`() = runBlocking {
        repository.ensureTracksOfAlbum("al-1")
        db.library().upsertAlbums(listOf(AlbumEntity("al-1", "An Awesome Wave", "Alt-J", "ar-1", null, 2012, 2, null, 1)))
        server.shutdown()
        val result = repository.search("tess", serverTimeoutMs = 2_000)
        assertFalse(result.fromServer)
        assertEquals(listOf("Tessellate"), result.tracks.map { it.title })
    }

    @Test
    fun `local search treats percent and underscore as plain characters`() = runBlocking {
        db.library().upsertAlbums(
            listOf(
                AlbumEntity("a", "100% (Live)", "X", null, null, null, 1, null, 1),
                AlbumEntity("b", "1000 Forms of Fear", "X", null, null, null, 1, null, 1),
                AlbumEntity("c", "snake_case", "X", null, null, null, 1, null, 1),
                AlbumEntity("d", "snakeXcase", "X", null, null, null, 1, null, 1)
            )
        )
        server.shutdown()
        assertEquals(listOf("a"), repository.search("100%", serverTimeoutMs = 1_000).albums.map { it.id })
        assertEquals(listOf("c"), repository.search("snake_", serverTimeoutMs = 1_000).albums.map { it.id })
    }

    @Test
    fun `an empty search is empty`() = runBlocking {
        assertTrue(repository.search("   ").isEmpty)
        assertEquals(0, navidrome.callsTo("search3"))
    }

    @Test
    fun `clearing forgets the library`() = runBlocking {
        repository.ensureTracksOfAlbum("al-1")
        repository.clear()
        assertEquals(0, repository.stats().tracks)
        assertEquals(0, repository.stats().albums)
    }

    @Test
    fun `like patterns escape the wildcards`() {
        assertEquals("%100\\%%", LibraryRepository.likePattern("100%"))
        assertEquals("%a\\_b%", LibraryRepository.likePattern("a_b"))
        assertEquals("%a\\\\b%", LibraryRepository.likePattern("a\\b"))
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ArtworkRepositoryTest {
    private val navidrome = FakeNavidrome()
    private lateinit var server: MockWebServer
    private lateinit var db: WatchDatabase
    private lateinit var artwork: ArtworkRepository
    private var clock = 10L

    @Before
    fun start() {
        server = MockWebServer().apply {
            dispatcher = navidrome
            start()
        }
        db = WatchDatabase.inMemory(ApplicationProvider.getApplicationContext<Context>())
        val login = navidrome.login(server)
        artwork = ArtworkRepository(db.artwork(), SubsonicApi(OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()) { login }, now = { clock })
    }

    @After
    fun stop() {
        db.close()
        server.shutdown()
    }

    private fun sizesAsked(): List<String> {
        val sizes = mutableListOf<String>()
        while (true) {
            val request = server.takeRequest(50, TimeUnit.MILLISECONDS) ?: break
            sizes += request.requestUrl!!.queryParameter("size").orEmpty()
        }
        return sizes
    }

    @Test
    fun `a thumbnail is downloaded once and then served from the watch`() = runBlocking {
        val first = artwork.get("al-1", ArtworkSize.THUMBNAIL)
        val second = artwork.get("al-1", ArtworkSize.THUMBNAIL)
        assertArrayEquals(navidrome.coverBytes, first)
        assertArrayEquals(navidrome.coverBytes, second)
        assertEquals(listOf("160"), sizesAsked())
    }

    @Test
    fun `the large cover comes with a thumbnail, and each size is asked for once`() = runBlocking {
        artwork.get("al-1", ArtworkSize.LARGE)
        artwork.get("al-1", ArtworkSize.LARGE)
        artwork.get("al-1", ArtworkSize.THUMBNAIL)
        assertEquals(listOf("160", "640"), sizesAsked())
        val stored = db.artwork().get("al-1")!!
        assertTrue(stored.large != null && stored.medium == null)
    }

    @Test
    fun `a cover the server does not have gives nothing`() = runBlocking {
        navidrome.missingCovers += "al-404"
        assertNull(artwork.get("al-404", ArtworkSize.THUMBNAIL))
        assertNull(db.artwork().get("al-404"))
    }

    @Test
    fun `offline, a smaller stored cover stands in for the one that was asked for`() = runBlocking {
        artwork.get("al-1", ArtworkSize.THUMBNAIL)
        server.shutdown()
        assertArrayEquals(navidrome.coverBytes, artwork.get("al-1", ArtworkSize.LARGE))
        assertNull(artwork.get("al-2", ArtworkSize.THUMBNAIL))
    }

    @Test
    fun `the cache is measured, trimmed oldest first, and cleared`() = runBlocking {
        db.artwork().upsert(ArtworkEntity("old", ByteArray(100), updatedAt = 1))
        db.artwork().upsert(ArtworkEntity("mid", ByteArray(100), ByteArray(50), updatedAt = 2))
        db.artwork().upsert(ArtworkEntity("new", ByteArray(100), updatedAt = 3))
        assertEquals(350L, artwork.cacheBytes())

        artwork.trimTo(250)
        assertNull(db.artwork().get("old"))
        assertTrue(db.artwork().get("mid") != null && db.artwork().get("new") != null)
        assertEquals(250L, artwork.cacheBytes())

        artwork.clear()
        assertEquals(0L, artwork.cacheBytes())
    }

    @Test
    fun `large covers are dropped when they are old, thumbnails stay`() = runBlocking {
        clock = 100_000
        db.artwork().upsert(ArtworkEntity("a", ByteArray(10), large = ByteArray(1000), updatedAt = 1_000))
        db.artwork().upsert(ArtworkEntity("b", ByteArray(10), large = ByteArray(1000), updatedAt = 99_000))
        artwork.dropOldLarge(maxAgeMs = 50_000)
        assertNull(db.artwork().get("a")!!.large)
        assertTrue(db.artwork().get("a")!!.thumbnail.isNotEmpty())
        assertTrue(db.artwork().get("b")!!.large != null)
    }
}
