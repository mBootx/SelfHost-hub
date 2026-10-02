package com.selfhosthub.wear.service.sync

import android.content.Context
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
        return when (val outcome = graph.sync.run()) {
            is SyncOutcome.Success, SyncOutcome.Busy -> Result.success()
            // Retrying cannot help a refused account or a missing setup; the settings screen says so.
            is SyncOutcome.Failed -> if (outcome.authFailure || outcome.notConfigured) Result.success() else Result.retry()
        }
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

    /** One run as soon as the watch has a connection, for a new setup. */
    fun syncSoon(context: Context) {
        val request = OneTimeWorkRequestBuilder<LibrarySyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(SOON_WORK, ExistingWorkPolicy.REPLACE, request)
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_WORK)
        WorkManager.getInstance(context).cancelUniqueWork(SOON_WORK)
    }
}
