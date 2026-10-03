package com.selfhosthub.wear.data

import android.util.Log
import com.selfhosthub.wear.data.db.AlbumEntity
import com.selfhosthub.wear.data.db.ArtistEntity
import com.selfhosthub.wear.data.db.PlaylistEntity
import com.selfhosthub.wear.data.db.SyncLogEntity
import com.selfhosthub.wear.data.db.TrackEntity
import com.selfhosthub.wear.data.db.WatchDatabase
import com.selfhosthub.wear.data.net.ApiAlbum
import com.selfhosthub.wear.data.net.ApiArtist
import com.selfhosthub.wear.data.net.ApiPlaylist
import com.selfhosthub.wear.data.net.ApiSong
import com.selfhosthub.wear.data.net.NotConfiguredException
import com.selfhosthub.wear.data.net.SubsonicApi
import com.selfhosthub.wear.data.net.SubsonicException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext

fun ApiArtist.toEntity(syncedAt: Long) = ArtistEntity(id, name, albumCount, coverArt, syncedAt)

fun ApiAlbum.toEntity(syncedAt: Long) = AlbumEntity(id, name, artist, artistId, coverArt, year, songCount, created, syncedAt)

fun ApiSong.toEntity(syncedAt: Long) = TrackEntity(id, title, artist, album, albumId, duration.toLong(), coverArt, track, syncedAt)

fun ApiPlaylist.toEntity(syncedAt: Long) = PlaylistEntity(id, name, songCount, changed, coverArt, syncedAt)

sealed interface SyncOutcome {
    data class Success(val kind: String, val artists: Int, val albums: Int, val playlists: Int) : SyncOutcome

    /** `authFailure`: the server does not accept the account; `notConfigured`: there is nothing to sync with yet. */
    data class Failed(val message: String, val authFailure: Boolean = false, val notConfigured: Boolean = false) : SyncOutcome

    /** Another synchronisation is already running. */
    data object Busy : SyncOutcome
}

/**
 * Keeps the library on the watch in step with Navidrome, reading as little as it can.
 *
 * Artists come in one request, and it carries the server's "library last modified" stamp. When that stamp has not
 * moved since the last full sync the albums are not read again: only the newest ones are (a new album is what
 * changes between two syncs most of the time). A full sync, which also removes what the server no longer has,
 * happens when the stamp moved, when there never was one, or once a day whatever the stamp says.
 * Songs are not part of it: an album's or a playlist's songs are read when it is opened, then kept.
 */
class LibrarySync(
    private val api: SubsonicApi,
    private val db: WatchDatabase,
    private val now: () -> Long = System::currentTimeMillis,
    private val pageSize: Int = PAGE_SIZE
) {
    private val running = Mutex()

    suspend fun run(force: Boolean = false): SyncOutcome {
        if (!running.tryLock()) return SyncOutcome.Busy
        try {
            return sync(force)
        } finally {
            running.unlock()
        }
    }

    private suspend fun sync(force: Boolean): SyncOutcome {
        val library = db.library()
        val log = db.syncLog()
        val started = now()
        val attempt = SyncLogEntity(lastSyncTime = started, status = SyncLogEntity.PENDING)
        log.upsert(attempt)
        try {
            api.ping()
            val index = api.artists()
            val lastFull = log.latestFullSuccess()

            val full = force ||
                lastFull == null ||
                started - lastFull.lastSyncTime > FULL_SYNC_EVERY_MS ||
                (index.lastModified != null && index.lastModified > (lastFull.libraryModified ?: 0L))

            library.upsertArtists(index.artists.map { it.toEntity(started) })

            var albumsSeen = 0
            if (full) {
                var offset = 0
                var pages = 0
                while (pages < MAX_PAGES) {
                    val page = api.albumList("alphabeticalByName", pageSize, offset)
                    library.upsertAlbums(page.map { it.toEntity(started) })
                    albumsSeen += page.size
                    if (page.size < pageSize) break
                    offset += pageSize
                    pages++
                }
                // Only now, with every page read, is what was not confirmed known to be gone.
                library.deleteAlbumsAndTracksOlderThan(started)
                library.deleteArtistsOlderThan(started)
            } else {
                val newest = api.albumList("newest", NEWEST_COUNT)
                library.upsertAlbums(newest.map { it.toEntity(started) })
                albumsSeen = newest.size
            }

            val playlists = api.playlists()
            val known = library.playlists().associateBy { it.id }
            for (playlist in playlists) {
                val before = known[playlist.id]
                // A playlist that changed has its songs read again when it is next opened.
                if (before != null && (before.changed != playlist.changed || before.songCount != playlist.songCount)) {
                    library.clearPlaylistTracks(playlist.id)
                }
            }
            library.upsertPlaylists(playlists.map { it.toEntity(started) })
            library.deletePlaylistsAndEntriesOlderThan(started)

            val kind = if (full) SyncLogEntity.FULL else SyncLogEntity.INCREMENTAL
            // The stamp is written with every attempt; only a full one is compared with it next time.
            log.upsert(attempt.copy(status = SyncLogEntity.SUCCESS, kind = kind, libraryModified = index.lastModified))
            log.prune(KEEP_LOG)
            return SyncOutcome.Success(kind, index.artists.size, albumsSeen, playlists.size)
        } catch (e: CancellationException) {
            withContext(NonCancellable) { log.upsert(attempt.copy(status = SyncLogEntity.FAILED, message = "interrompue")) }
            throw e
        } catch (e: NotConfiguredException) {
            log.upsert(attempt.copy(status = SyncLogEntity.FAILED, message = e.message))
            return SyncOutcome.Failed(e.message ?: "Navidrome n'est pas configuré", notConfigured = true)
        } catch (e: Exception) {
            Log.w(TAG, "The synchronisation failed", e)
            val auth = e is SubsonicException && e.isAuthFailure
            val message = if (auth) "Compte refusé par Navidrome" else describe(e)
            log.upsert(attempt.copy(status = SyncLogEntity.FAILED, message = message))
            log.prune(KEEP_LOG)
            return SyncOutcome.Failed(message, authFailure = auth)
        }
    }

    /** Why it failed, in a few words: the server's or the network's own sentence, else at least what kind of failure it was. */
    private fun describe(e: Exception): String =
        e.message?.takeIf { it.isNotBlank() } ?: "Synchronisation impossible (${e.javaClass.simpleName})"

    companion object {
        private const val TAG = "LibrarySync"
        const val PAGE_SIZE = 500
        const val MAX_PAGES = 400
        const val NEWEST_COUNT = 60
        const val KEEP_LOG = 20
        val FULL_SYNC_EVERY_MS: Long = TimeUnit.HOURS.toMillis(24)
    }
}
