package com.selfhosthub.wear.service.sync

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.selfhosthub.wear.data.SyncOutcome
import com.selfhosthub.wear.service.WatchGraphProvider
import java.util.concurrent.TimeUnit

/**
 * Keeps the stored library fresh in the background: the work runs about every hour, when the watch has a connection
 * (its own Wi-Fi, or the phone's), and not at all when the battery is low. It is a WorkManager job rather than a
 * long-running service because that is how Android lets an app wake itself regularly without costing the battery.
 */
class LibrarySyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = (applicationContext as? WatchGraphProvider)?.graph ?: return Result.failure()
        if (graph.setup.value?.navidrome == null) return Result.success()
        val outcome = graph.sync.run()
        Log.i(TAG, "Library sync: $outcome")
        return when (outcome) {
            is SyncOutcome.Success, SyncOutcome.Busy -> Result.success()
            // Retrying cannot help a refused account or a missing setup; the settings screen says so.
            is SyncOutcome.Failed -> if (outcome.authFailure || outcome.notConfigured) Result.success() else Result.retry()
        }
    }
}

private const val TAG = "LibrarySyncWorker"

/**
 * When opening the app is a reason to read the library again, on top of the hourly job: the library is old (or never
 * came), and nothing was tried a moment ago. A server that is down, or an account that is refused, is not asked at every
 * opening, only now and then.
 */
object RefreshPolicy {
    const val STALE_AFTER_MS = 30 * 60_000L
    const val RETRY_AFTER_MS = 5 * 60_000L

    fun due(lastAttemptAt: Long?, lastSuccessAt: Long?, now: Long): Boolean {
        val stale = lastSuccessAt == null || now - lastSuccessAt > STALE_AFTER_MS
        val justTried = lastAttemptAt != null && now - lastAttemptAt < RETRY_AFTER_MS
        return stale && !justTried
    }
}

object LibrarySyncService {
    const val PERIODIC_WORK = "library-sync-hourly"
    const val SOON_WORK = "library-sync-now"

    private val constraints: Constraints
        get() = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build()

    /** The hourly job. Safe to call at every start: an existing schedule is kept as it is. */
    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<LibrarySyncWorker>(1, TimeUnit.HOURS)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /**
     * One run as soon as the watch has a connection. For a new setup (`replace`) it takes the place of one already
     * waiting or running; for the refresh when the app is opened it leaves one that is already there alone.
     */
    fun syncSoon(context: Context, replace: Boolean = true) {
        val request = OneTimeWorkRequestBuilder<LibrarySyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(SOON_WORK, if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, request)
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_WORK)
        WorkManager.getInstance(context).cancelUniqueWork(SOON_WORK)
    }
}
