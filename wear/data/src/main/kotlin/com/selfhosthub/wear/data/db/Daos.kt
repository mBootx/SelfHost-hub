package com.selfhosthub.wear.data.db

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface LibraryDao {
    // --- What the screens show ---

    @Query("SELECT * FROM artists ORDER BY name COLLATE NOCASE")
    fun observeArtists(): Flow<List<ArtistEntity>>

    @Query("SELECT * FROM albums WHERE artistId = :artistId ORDER BY year DESC, name COLLATE NOCASE")
    fun observeAlbumsOfArtist(artistId: String): Flow<List<AlbumEntity>>

    @Query("SELECT * FROM albums ORDER BY name COLLATE NOCASE")
    fun observeAlbums(): Flow<List<AlbumEntity>>

    @Query("SELECT * FROM tracks WHERE albumId = :albumId ORDER BY track, title COLLATE NOCASE")
    fun observeTracksOfAlbum(albumId: String): Flow<List<TrackEntity>>

    @Query("SELECT * FROM playlists ORDER BY name COLLATE NOCASE")
    fun observePlaylists(): Flow<List<PlaylistEntity>>

    @Query(
        "SELECT t.* FROM tracks t INNER JOIN playlist_tracks p ON p.trackId = t.id " +
            "WHERE p.playlistId = :playlistId ORDER BY p.position"
    )
    fun observePlaylistTracks(playlistId: String): Flow<List<TrackEntity>>

    @Query("SELECT * FROM artists WHERE id = :id")
    suspend fun artist(id: String): ArtistEntity?

    @Query("SELECT * FROM albums WHERE id = :id")
    suspend fun album(id: String): AlbumEntity?

    @Query("SELECT * FROM playlists WHERE id = :id")
    suspend fun playlist(id: String): PlaylistEntity?

    @Query("SELECT * FROM playlists")
    suspend fun playlists(): List<PlaylistEntity>

    @Query("SELECT * FROM tracks WHERE id = :id")
    suspend fun track(id: String): TrackEntity?

    @Query("SELECT COUNT(*) FROM albums WHERE artistId = :artistId")
    suspend fun albumCountOfArtist(artistId: String): Int

    @Query("SELECT COUNT(*) FROM tracks WHERE albumId = :albumId")
    suspend fun trackCountOfAlbum(albumId: String): Int

    @Query("SELECT COUNT(*) FROM playlist_tracks WHERE playlistId = :playlistId")
    suspend fun trackCountOfPlaylist(playlistId: String): Int

    // --- Search in what is stored ---

    @Query("SELECT * FROM artists WHERE name LIKE :pattern ESCAPE '\\' ORDER BY name COLLATE NOCASE LIMIT :limit")
    suspend fun searchArtists(pattern: String, limit: Int): List<ArtistEntity>

    @Query("SELECT * FROM albums WHERE name LIKE :pattern ESCAPE '\\' OR artist LIKE :pattern ESCAPE '\\' ORDER BY name COLLATE NOCASE LIMIT :limit")
    suspend fun searchAlbums(pattern: String, limit: Int): List<AlbumEntity>

    @Query("SELECT * FROM tracks WHERE title LIKE :pattern ESCAPE '\\' OR artist LIKE :pattern ESCAPE '\\' ORDER BY title COLLATE NOCASE LIMIT :limit")
    suspend fun searchTracks(pattern: String, limit: Int): List<TrackEntity>

    // --- Writing what the server said ---

    @Upsert
    suspend fun upsertArtists(artists: List<ArtistEntity>)

    @Upsert
    suspend fun upsertAlbums(albums: List<AlbumEntity>)

    @Upsert
    suspend fun upsertTracks(tracks: List<TrackEntity>)

    @Upsert
    suspend fun upsertPlaylists(playlists: List<PlaylistEntity>)

    @Upsert
    suspend fun upsertPlaylistTracks(entries: List<PlaylistTrackEntity>)

    @Query("DELETE FROM playlist_tracks WHERE playlistId = :playlistId")
    suspend fun clearPlaylistTracks(playlistId: String)

    @Query("DELETE FROM tracks WHERE albumId = :albumId")
    suspend fun deleteTracksOfAlbum(albumId: String)

    // --- Removing what the server no longer has ---

    @Query("SELECT id FROM albums WHERE syncedAt < :cutoff")
    suspend fun albumIdsOlderThan(cutoff: Long): List<String>

    @Query("DELETE FROM albums WHERE syncedAt < :cutoff")
    suspend fun deleteAlbumsOlderThan(cutoff: Long): Int

    @Query("DELETE FROM artists WHERE syncedAt < :cutoff")
    suspend fun deleteArtistsOlderThan(cutoff: Long): Int

    @Query("SELECT id FROM playlists WHERE syncedAt < :cutoff")
    suspend fun playlistIdsOlderThan(cutoff: Long): List<String>

    @Query("DELETE FROM playlists WHERE syncedAt < :cutoff")
    suspend fun deletePlaylistsOlderThan(cutoff: Long): Int

    /** Gone from the server: the album, its tracks, and the playlist entries that pointed at those tracks stay harmless. */
    @Transaction
    suspend fun deleteAlbumsAndTracksOlderThan(cutoff: Long): Int {
        for (id in albumIdsOlderThan(cutoff)) deleteTracksOfAlbum(id)
        return deleteAlbumsOlderThan(cutoff)
    }

    @Transaction
    suspend fun deletePlaylistsAndEntriesOlderThan(cutoff: Long): Int {
        for (id in playlistIdsOlderThan(cutoff)) clearPlaylistTracks(id)
        return deletePlaylistsOlderThan(cutoff)
    }

    // --- Sizes, and wiping ---

    @Query("SELECT COUNT(*) FROM artists")
    suspend fun artistCount(): Int

    @Query("SELECT COUNT(*) FROM albums")
    suspend fun albumCount(): Int

    @Query("SELECT COUNT(*) FROM tracks")
    suspend fun trackCount(): Int

    @Query("SELECT COUNT(*) FROM playlists")
    suspend fun playlistCount(): Int

    @Query("DELETE FROM artists")
    suspend fun clearArtists()

    @Query("DELETE FROM albums")
    suspend fun clearAlbums()

    @Query("DELETE FROM tracks")
    suspend fun clearTracks()

    @Query("DELETE FROM playlists")
    suspend fun clearPlaylists()

    @Query("DELETE FROM playlist_tracks")
    suspend fun clearAllPlaylistTracks()

    @Transaction
    suspend fun clearLibrary() {
        clearAllPlaylistTracks()
        clearPlaylists()
        clearTracks()
        clearAlbums()
        clearArtists()
    }
}

@Dao
interface ArtworkDao {
    @Query("SELECT * FROM artwork WHERE coverId = :coverId")
    suspend fun get(coverId: String): ArtworkEntity?

    @Upsert
    suspend fun upsert(artwork: ArtworkEntity)

    /** What the stored covers weigh, for the "cache" line of the settings. */
    @Query("SELECT COALESCE(SUM(LENGTH(thumbnail) + COALESCE(LENGTH(medium), 0) + COALESCE(LENGTH(large), 0)), 0) FROM artwork")
    suspend fun totalBytes(): Long

    @Query("SELECT COUNT(*) FROM artwork")
    suspend fun count(): Int

    /** The oldest covers first, to make room. */
    @Query("SELECT coverId, LENGTH(thumbnail) + COALESCE(LENGTH(medium), 0) + COALESCE(LENGTH(large), 0) AS bytes FROM artwork ORDER BY updatedAt ASC")
    suspend fun sizesOldestFirst(): List<ArtworkSize>

    @Query("DELETE FROM artwork WHERE coverId = :coverId")
    suspend fun delete(coverId: String)

    /** Large covers are only for the song playing: they are dropped once they are older than `cutoff`. */
    @Query("UPDATE artwork SET large = NULL WHERE large IS NOT NULL AND updatedAt < :cutoff")
    suspend fun dropLargeOlderThan(cutoff: Long)

    @Query("DELETE FROM artwork")
    suspend fun clear()
}

data class ArtworkSize(val coverId: String, val bytes: Long)

@Dao
interface SyncLogDao {
    @Upsert
    suspend fun upsert(entry: SyncLogEntity)

    @Query("SELECT * FROM sync_log WHERE status = 'success' ORDER BY lastSyncTime DESC LIMIT 1")
    suspend fun latestSuccess(): SyncLogEntity?

    @Query("SELECT * FROM sync_log WHERE status = 'success' AND kind = 'full' ORDER BY lastSyncTime DESC LIMIT 1")
    suspend fun latestFullSuccess(): SyncLogEntity?

    @Query("SELECT * FROM sync_log ORDER BY lastSyncTime DESC LIMIT 1")
    suspend fun latest(): SyncLogEntity?

    @Query("SELECT * FROM sync_log ORDER BY lastSyncTime DESC LIMIT 1")
    fun observeLatest(): Flow<SyncLogEntity?>

    @Query("SELECT * FROM sync_log WHERE status = 'success' ORDER BY lastSyncTime DESC LIMIT 1")
    fun observeLatestSuccess(): Flow<SyncLogEntity?>

    /** Keeps the last few attempts; the log is for the settings screen, not an archive. */
    @Query("DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM sync_log ORDER BY lastSyncTime DESC LIMIT :keep)")
    suspend fun prune(keep: Int)

    @Query("DELETE FROM sync_log")
    suspend fun clear()
}
