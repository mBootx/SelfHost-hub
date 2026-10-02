package com.selfhosthub.wear.data

import androidx.room.withTransaction
import com.selfhosthub.wear.data.db.AlbumEntity
import com.selfhosthub.wear.data.db.ArtistEntity
import com.selfhosthub.wear.data.db.PlaylistEntity
import com.selfhosthub.wear.data.db.PlaylistTrackEntity
import com.selfhosthub.wear.data.db.TrackEntity
import com.selfhosthub.wear.data.db.WatchDatabase
import com.selfhosthub.wear.data.net.SubsonicApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withTimeoutOrNull

/** What a screen finds when it asks for something to be loaded. */
sealed interface LoadResult {
    /** Already stored, nothing to ask the server. */
    data object Cached : LoadResult

    /** Read from the server just now. */
    data object Fetched : LoadResult

    /** The server could not be reached or refused: the screen shows what is stored, if anything. */
    data class Unavailable(val message: String, val authFailure: Boolean = false) : LoadResult
}

data class LibrarySearchResult(
    val artists: List<ArtistEntity>,
    val albums: List<AlbumEntity>,
    val tracks: List<TrackEntity>,
    /** False when the server did not answer in time and only what is stored on the watch was searched. */
    val fromServer: Boolean
) {
    val isEmpty: Boolean get() = artists.isEmpty() && albums.isEmpty() && tracks.isEmpty()
}

data class LibraryStats(val artists: Int, val albums: Int, val tracks: Int, val playlists: Int)

/**
 * What the screens read: the library as stored (always available, even offline), and the loaders that fill in what
 * is missing when a screen opens an artist, an album or a playlist for the first time.
 */
class LibraryRepository(
    private val db: WatchDatabase,
    private val api: SubsonicApi,
    private val now: () -> Long = System::currentTimeMillis
) {
    private val dao get() = db.library()

    val artists: Flow<List<ArtistEntity>> get() = dao.observeArtists()
    val albums: Flow<List<AlbumEntity>> get() = dao.observeAlbums()
    val playlists: Flow<List<PlaylistEntity>> get() = dao.observePlaylists()
    fun albumsOfArtist(artistId: String): Flow<List<AlbumEntity>> = dao.observeAlbumsOfArtist(artistId)
    fun tracksOfAlbum(albumId: String): Flow<List<TrackEntity>> = dao.observeTracksOfAlbum(albumId)
    fun tracksOfPlaylist(playlistId: String): Flow<List<TrackEntity>> = dao.observePlaylistTracks(playlistId)

    suspend fun artist(id: String): ArtistEntity? = dao.artist(id)
    suspend fun album(id: String): AlbumEntity? = dao.album(id)
    suspend fun playlist(id: String): PlaylistEntity? = dao.playlist(id)

    /** The albums of an artist, read from the server when none is stored yet. */
    suspend fun ensureAlbumsOfArtist(artistId: String): LoadResult {
        val stored = dao.artist(artistId)
        val have = dao.albumCountOfArtist(artistId)
        if (stored != null && have >= stored.albumCount && have > 0) return LoadResult.Cached
        return guarded {
            val at = now()
            val albums = api.albumsByArtist(artistId)
            dao.upsertAlbums(albums.map { it.copy(artistId = it.artistId ?: artistId).toEntity(at) })
            LoadResult.Fetched
        }
    }

    /** The songs of an album, read from the server when the stored ones are missing or fewer than the album has. */
    suspend fun ensureTracksOfAlbum(albumId: String): LoadResult {
        val stored = dao.album(albumId)
        val have = dao.trackCountOfAlbum(albumId)
        if (stored != null && have > 0 && have >= stored.songCount) return LoadResult.Cached
        return guarded {
            val at = now()
            val detail = api.songsOfAlbum(albumId)
            db.withTransaction {
                dao.upsertAlbums(listOf(detail.album.toEntity(at)))
                dao.upsertTracks(detail.songs.map { it.copy(albumId = it.albumId ?: albumId).toEntity(at) })
            }
            LoadResult.Fetched
        }
    }

    /** The songs of a playlist, read again from the server when it is new or changed since it was stored. */
    suspend fun ensureTracksOfPlaylist(playlistId: String): LoadResult {
        val stored = dao.playlist(playlistId)
        val have = dao.trackCountOfPlaylist(playlistId)
        if (stored != null && have > 0 && have >= stored.songCount) return LoadResult.Cached
        return guarded {
            val at = now()
            val detail = api.songsOfPlaylist(playlistId)
            db.withTransaction {
                dao.upsertPlaylists(listOf(detail.playlist.toEntity(at)))
                dao.upsertTracks(detail.songs.map { it.toEntity(at) })
                dao.clearPlaylistTracks(playlistId)
                dao.upsertPlaylistTracks(detail.songs.mapIndexed { position, song -> PlaylistTrackEntity(playlistId, position, song.id) })
            }
            LoadResult.Fetched
        }
    }

    /**
     * Looks for `query` on the server (which sees the whole library) and falls back to what is stored when it does
     * not answer within `serverTimeoutMs`. Nothing found by the server is kept: it only fills the list on screen.
     */
    suspend fun search(query: String, serverTimeoutMs: Long = 6_000): LibrarySearchResult {
        val text = query.trim()
        if (text.isEmpty()) return LibrarySearchResult(emptyList(), emptyList(), emptyList(), fromServer = false)
        val remote = withTimeoutOrNull(serverTimeoutMs) {
            try {
                api.search(text)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
        }
        if (remote != null) {
            val at = now()
            return LibrarySearchResult(
                remote.artists.map { it.toEntity(at) },
                remote.albums.map { it.toEntity(at) },
                remote.songs.map { it.toEntity(at) },
                fromServer = true
            )
        }
        val pattern = likePattern(text)
        return LibrarySearchResult(
            dao.searchArtists(pattern, LOCAL_LIMIT),
            dao.searchAlbums(pattern, LOCAL_LIMIT),
            dao.searchTracks(pattern, LOCAL_LIMIT),
            fromServer = false
        )
    }

    suspend fun stats(): LibraryStats = LibraryStats(dao.artistCount(), dao.albumCount(), dao.trackCount(), dao.playlistCount())

    /** Forgets the stored library (the covers and the sync history are separate). */
    suspend fun clear() = dao.clearLibrary()

    private suspend fun guarded(block: suspend () -> LoadResult): LoadResult = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: com.selfhosthub.wear.data.net.SubsonicException) {
        LoadResult.Unavailable(if (e.isAuthFailure) "Compte refusé par Navidrome" else e.message ?: "Erreur Navidrome", e.isAuthFailure)
    } catch (e: Exception) {
        LoadResult.Unavailable(e.message ?: "Serveur injoignable")
    }

    companion object {
        const val LOCAL_LIMIT = 30

        /** `%query%` with the characters that mean something to LIKE made literal (the DAO declares `\` as the escape). */
        fun likePattern(query: String): String {
            val escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            return "%$escaped%"
        }
    }
}
