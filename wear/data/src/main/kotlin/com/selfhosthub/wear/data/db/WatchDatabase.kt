package com.selfhosthub.wear.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration

@Database(
    entities = [
        ArtistEntity::class,
        AlbumEntity::class,
        TrackEntity::class,
        PlaylistEntity::class,
        PlaylistTrackEntity::class,
        ArtworkEntity::class,
        SyncLogEntity::class
    ],
    version = WatchDatabase.VERSION,
    exportSchema = true
)
abstract class WatchDatabase : RoomDatabase() {
    abstract fun library(): LibraryDao
    abstract fun artwork(): ArtworkDao
    abstract fun syncLog(): SyncLogDao

    companion object {
        const val VERSION = 1
        const val NAME = "selfhost_wear.db"

        fun open(context: Context): WatchDatabase =
            Room.databaseBuilder(context.applicationContext, WatchDatabase::class.java, NAME)
                .addMigrations(*Migrations.ALL)
                .build()

        /** For tests: a database that lives and dies with the process. */
        fun inMemory(context: Context): WatchDatabase =
            Room.inMemoryDatabaseBuilder(context.applicationContext, WatchDatabase::class.java)
                .allowMainThreadQueries()
                .build()
    }
}

/**
 * Every step from an older schema to the next, in order. There are none yet: version 1 is the first one shipped.
 * The day the schema changes, bump [WatchDatabase.VERSION], add the step here (and keep the exported schema JSON
 * of the old version in `data/schemas`, which Room writes at build time, to test it against).
 *
 * The library on the watch is only a cache of the server, so a migration that goes wrong is never worth losing
 * the user's setup over: wiping the database and syncing again is always a correct fallback, and the secrets are
 * not kept in it.
 */
object Migrations {
    val ALL: Array<Migration> = emptyArray()
}
