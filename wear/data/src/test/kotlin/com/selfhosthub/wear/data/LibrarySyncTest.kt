package com.selfhosthub.wear.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.selfhosthub.wear.data.db.SyncLogEntity
import com.selfhosthub.wear.data.db.WatchDatabase
import com.selfhosthub.wear.data.net.SubsonicApi
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LibrarySyncTest {
    private val navidrome = FakeNavidrome()
    private lateinit var server: MockWebServer
    private lateinit var db: WatchDatabase
    private lateinit var sync: LibrarySync
    private var clock = 1_000_000L

    @Before
    fun start() {
        server = MockWebServer().apply {
            dispatcher = navidrome
            start()
        }
        db = WatchDatabase.inMemory(ApplicationProvider.getApplicationContext<Context>())
        val login = navidrome.login(server)
        val api = SubsonicApi(OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()) { login }
        sync = LibrarySync(api, db, now = { clock }, pageSize = 2)

        navidrome.artists += FakeNavidrome.Artist("ar-1", "Alt-J", 2)
        navidrome.artists += FakeNavidrome.Artist("ar-2", "Björk", 1)
        navidrome.albums += FakeNavidrome.Album("al-1", "An Awesome Wave", "Alt-J", "ar-1", created = "2024-01-01T00:00:00Z", songs = listOf(FakeNavidrome.Song("so-1", "Intro", "Alt-J")))
        navidrome.albums += FakeNavidrome.Album("al-2", "Relaxer", "Alt-J", "ar-1", created = "2024-02-01T00:00:00Z")
        navidrome.albums += FakeNavidrome.Album("al-3", "Homogenic", "Björk", "ar-2", created = "2024-03-01T00:00:00Z")
        navidrome.playlists += FakeNavidrome.Playlist("pl-1", "Route", "2026-01-01T00:00:00Z", listOf(FakeNavidrome.Song("so-1", "Intro", "Alt-J", albumId = "al-1")))
    }

    @After
    fun stop() {
        db.close()
        server.shutdown()
    }

    private fun repository() = LibraryRepository(db, SubsonicApi(OkHttpClient()) { navidrome.login(server) }, now = { clock })

    @Test
    fun `the first sync reads everything, artists then every page of albums then playlists`() = runBlocking {
        val outcome = sync.run() as SyncOutcome.Success
        assertEquals(SyncLogEntity.FULL, outcome.kind)
        assertEquals(2, outcome.artists)
        assertEquals(3, outcome.albums)
        assertEquals(1, outcome.playlists)
        assertEquals(3, db.library().albumCount())
        assertEquals(2, db.library().artistCount())
        assertEquals(1, db.library().playlistCount())
        // Three albums with a page of two: a second page was needed, and it was the short one that ended the loop.
        assertEquals(2, navidrome.callsTo("getAlbumList2?type=alphabeticalByName"))
        assertEquals(1_000L, db.syncLog().latestSuccess()!!.libraryModified)
        assertEquals(SyncLogEntity.SUCCESS, db.syncLog().latest()!!.status)
    }

    @Test
    fun `when the library has not changed the next sync only looks for the newest albums`() = runBlocking {
        sync.run()
        navidrome.calls.clear()
        clock += TimeUnit.HOURS.toMillis(1)
        navidrome.albums += FakeNavidrome.Album("al-4", "Neu", "Alt-J", "ar-1", created = "2024-06-01T00:00:00Z")

        val outcome = sync.run() as SyncOutcome.Success

        assertEquals(SyncLogEntity.INCREMENTAL, outcome.kind)
        assertEquals(0, navidrome.callsTo("getAlbumList2?type=alphabeticalByName"))
        assertEquals(1, navidrome.callsTo("getAlbumList2?type=newest"))
        // The new album is there, found through the newest list.
        assertEquals(4, db.library().albumCount())
        assertEquals("Neu", db.library().album("al-4")!!.name)
    }

    @Test
    fun `a moved library stamp makes a full sync, which removes what the server dropped`() = runBlocking {
        sync.run()
        clock += TimeUnit.HOURS.toMillis(1)
        navidrome.lastModified = 2_000L
        navidrome.albums.removeAll { it.id == "al-2" }
        navidrome.artists.removeAll { it.id == "ar-2" }
        navidrome.albums.removeAll { it.id == "al-3" }
        navidrome.calls.clear()

        val outcome = sync.run() as SyncOutcome.Success

        assertEquals(SyncLogEntity.FULL, outcome.kind)
        assertEquals(listOf("al-1"), listOf("al-1", "al-2", "al-3").filter { db.library().album(it) != null })
        assertNull(db.library().artist("ar-2"))
    }

    @Test
    fun `a full sync is also done once a day whatever the stamp says`() = runBlocking {
        sync.run()
        clock += TimeUnit.HOURS.toMillis(25)
        navidrome.calls.clear()
        val outcome = sync.run() as SyncOutcome.Success
        assertEquals(SyncLogEntity.FULL, outcome.kind)
    }

    @Test
    fun `force makes a full sync`() = runBlocking {
        sync.run()
        clock += 1000
        assertEquals(SyncLogEntity.FULL, (sync.run(force = true) as SyncOutcome.Success).kind)
    }

    @Test
    fun `a server with no stamp is read in full only once a day`() = runBlocking {
        navidrome.lastModified = null
        sync.run()
        clock += TimeUnit.HOURS.toMillis(2)
        navidrome.calls.clear()
        assertEquals(SyncLogEntity.INCREMENTAL, (sync.run() as SyncOutcome.Success).kind)
    }

    @Test
    fun `a failure in the middle of the albums removes nothing`() = runBlocking {
        sync.run()
        clock += TimeUnit.HOURS.toMillis(1)
        navidrome.lastModified = 2_000L
        navidrome.albums.removeAll { it.id == "al-3" }
        // The second page of albums fails: the first one was read, so the old rows would look unconfirmed.
        navidrome.failOnly = setOf("getAlbumList2")
        var calls = 0
        navidrome.failure = { if (++calls >= 2) FakeNavidrome.serverError() else okEmptyAlbumsPage() }

        val outcome = sync.run()

        assertTrue(outcome is SyncOutcome.Failed)
        assertEquals(3, db.library().albumCount())
        assertEquals(SyncLogEntity.FAILED, db.syncLog().latest()!!.status)
    }

    private fun okEmptyAlbumsPage() = okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json").setBody(
        """{"subsonic-response":{"status":"ok","version":"1.16.1","albumList2":{"album":[{"id":"al-1","name":"An Awesome Wave","artist":"Alt-J","artistId":"ar-1","songCount":1},{"id":"al-2","name":"Relaxer","artist":"Alt-J","artistId":"ar-1","songCount":0}]}}}"""
    )

    @Test
    fun `an account the server refuses is reported as such and nothing is lost`() = runBlocking {
        sync.run()
        clock += 1000
        navidrome.failure = { FakeNavidrome.authFailure() }
        val outcome = sync.run() as SyncOutcome.Failed
        assertTrue(outcome.authFailure)
        assertEquals(3, db.library().albumCount())
        assertEquals("Compte refusé par Navidrome", db.syncLog().latest()!!.message)
    }

    @Test
    fun `no login at all is reported as not configured`() = runBlocking {
        val unconfigured = LibrarySync(SubsonicApi(OkHttpClient()) { null }, db)
        val outcome = unconfigured.run() as SyncOutcome.Failed
        assertTrue(outcome.notConfigured)
    }

    @Test
    fun `a playlist that changed has to be read again, one that did not keeps its songs`() = runBlocking {
        sync.run()
        val repository = repository()
        repository.ensureTracksOfPlaylist("pl-1")
        assertEquals(1, db.library().trackCountOfPlaylist("pl-1"))

        clock += TimeUnit.HOURS.toMillis(1)
        sync.run()
        assertEquals("unchanged: songs kept", 1, db.library().trackCountOfPlaylist("pl-1"))

        clock += TimeUnit.HOURS.toMillis(1)
        navidrome.playlists[0] = navidrome.playlists[0].copy(changed = "2026-02-02T00:00:00Z")
        sync.run()
        assertEquals("changed: songs dropped to be read again", 0, db.library().trackCountOfPlaylist("pl-1"))
    }

    @Test
    fun `a playlist deleted on the server goes, with its entries`() = runBlocking {
        sync.run()
        repository().ensureTracksOfPlaylist("pl-1")
        clock += TimeUnit.HOURS.toMillis(1)
        navidrome.playlists.clear()
        sync.run()
        assertEquals(0, db.library().playlistCount())
        assertEquals(0, db.library().trackCountOfPlaylist("pl-1"))
    }

    @Test
    fun `only one sync runs at a time`() = runBlocking {
        val gate = java.util.concurrent.CountDownLatch(1)
        navidrome.gate = gate
        val first = async(kotlinx.coroutines.Dispatchers.IO) { sync.run() }
        // Wait until the first sync is really in flight, held up by the server.
        val deadline = System.currentTimeMillis() + 5_000
        while (navidrome.callsTo("ping") == 0 && System.currentTimeMillis() < deadline) kotlinx.coroutines.delay(10)

        assertTrue("the second one is turned away", sync.run() is SyncOutcome.Busy)

        gate.countDown()
        assertTrue(first.await() is SyncOutcome.Success)
        // And once the first has finished, a new one can start.
        assertTrue(sync.run() is SyncOutcome.Success)
    }

    @Test
    fun `the log keeps only the latest attempts`() = runBlocking {
        repeat(25) {
            clock += 1000
            sync.run(force = true)
        }
        val count = db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM sync_log").use { it.moveToFirst(); it.getInt(0) }
        assertEquals(LibrarySync.KEEP_LOG, count)
    }
}
