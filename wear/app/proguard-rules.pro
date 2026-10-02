# OkHttp and Okio ship their own rules; these only silence the warnings for the optional TLS providers.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Room generates the database and the DAOs; the abstract classes are found by their annotations.
-keep class * extends androidx.room.RoomDatabase
-dontwarn androidx.room.paging.**

# Keeps useful stack traces in a crash report.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# WorkManager stores the name of the worker class with a job it has scheduled. The hourly sync is scheduled with
# "keep the existing one", so a name that changes from one release to the next would leave the old job failing
# for good: workers keep their names.
-keepnames class * extends androidx.work.ListenableWorker
