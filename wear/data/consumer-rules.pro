# Room generates its own code for the database and the DAOs; the entities are only read through it.
-keep class * extends androidx.room.RoomDatabase
-dontwarn androidx.room.paging.**
