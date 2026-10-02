package com.selfhosthub.wear.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import java.util.UUID

/*
 * The library as the watch keeps it, so it can be browsed without the server answering. `syncedAt` is when the
 * row was last confirmed by the server: whatever a full sync did not confirm is gone from the server and is removed.
 */

@Entity(tableName = "artists")
data class ArtistEntity(
    @PrimaryKey val id: String,
    val name: String,
    val albumCount: Int,
    val coverId: String?,
    val syncedAt: Long
)

@Entity(tableName = "albums", indices = [Index("artistId")])
data class AlbumEntity(
    @PrimaryKey val id: String,
    val name: String,
    val artist: String,
    val artistId: String?,
    val coverId: String?,
    val year: Int?,
    val songCount: Int,
    /** When the server added the album (an ISO date), which is what "new since the last sync" is read from. */
    val createdAt: String?,
    val syncedAt: Long
)

@Entity(tableName = "tracks", indices = [Index("albumId")])
data class TrackEntity(
    @PrimaryKey val id: String,
    val title: String,
    val artist: String,
    val album: String?,
    val albumId: String?,
    /** In seconds. */
    val duration: Long,
    val coverId: String?,
    val track: Int?,
    val syncedAt: Long
)

@Entity(tableName = "playlists")
data class PlaylistEntity(
    @PrimaryKey val id: String,
    val name: String,
    val songCount: Int,
    /** The server's own "last changed" stamp: a playlist whose stamp moved has its songs fetched again. */
    val changed: String?,
    val coverId: String?,
    val syncedAt: Long
)

/** Which tracks a playlist holds, in order. The tracks themselves are rows of `tracks`. */
@Entity(tableName = "playlist_tracks", primaryKeys = ["playlistId", "position"], indices = [Index("trackId")])
data class PlaylistTrackEntity(
    val playlistId: String,
    val position: Int,
    val trackId: String
)

/**
 * A cover at the sizes it was needed at: the thumbnail (160 px) for every list, the medium one (320 px) when asked
 * for, the large one (640 px) only for the song playing.
 */
@Entity(tableName = "artwork")
data class ArtworkEntity(
    @PrimaryKey val coverId: String,
    @ColumnInfo(typeAffinity = ColumnInfo.BLOB) val thumbnail: ByteArray,
    @ColumnInfo(typeAffinity = ColumnInfo.BLOB) val medium: ByteArray? = null,
    @ColumnInfo(typeAffinity = ColumnInfo.BLOB) val large: ByteArray? = null,
    val updatedAt: Long = 0L
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ArtworkEntity) return false
        return coverId == other.coverId &&
            thumbnail.contentEquals(other.thumbnail) &&
            java.util.Arrays.equals(medium, other.medium) &&
            java.util.Arrays.equals(large, other.large) &&
            updatedAt == other.updatedAt
    }

    override fun hashCode(): Int {
        var result = coverId.hashCode()
        result = 31 * result + thumbnail.contentHashCode()
        result = 31 * result + (medium?.contentHashCode() ?: 0)
        result = 31 * result + (large?.contentHashCode() ?: 0)
        result = 31 * result + updatedAt.hashCode()
        return result
    }
}

/** One synchronisation attempt: when, how it ended, and the server's "library last modified" stamp it saw. */
@Entity(tableName = "sync_log")
data class SyncLogEntity(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val lastSyncTime: Long,
    /** 'success' | 'pending' | 'failed' */
    val status: String,
    /** 'full' | 'incremental' */
    val kind: String = "full",
    val libraryModified: Long? = null,
    val message: String? = null
) {
    companion object {
        const val SUCCESS = "success"
        const val PENDING = "pending"
        const val FAILED = "failed"
        const val FULL = "full"
        const val INCREMENTAL = "incremental"
    }
}
