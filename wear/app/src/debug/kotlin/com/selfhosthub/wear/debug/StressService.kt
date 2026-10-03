package com.selfhosthub.wear.debug

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import com.selfhosthub.wear.data.SyncOutcome
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.service.watchGraph
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch

/**
 * DEBUG BUILDS ONLY (this file is in the debug source set). Reproduces what leaving a screen full of covers does to the
 * connection, without a screen: many cover requests are started, all of them are cancelled the moment the first answer
 * arrives (while the others are arriving), and forced synchronisations run in the middle of it. What happens is logged
 * under the tag "Stress"; run it with
 * `adb shell am start-foreground-service -n com.selfhosthub.mobile/com.selfhosthub.wear.debug.StressService`.
 *
 * It is a foreground service because a watch that is lying still with its screen off is in deep sleep, where the system
 * gives an app in the background no network at all (every request ends in "Unable to resolve host").
 */
class StressService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Stress test (debug)", NotificationManager.IMPORTANCE_LOW))
        val notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Stress test")
            .build()
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)

        val graph = watchGraph()
        scope.launch {
            try {
                run(graph)
            } catch (e: Throwable) {
                Log.e(TAG, "the stress run failed", e)
            } finally {
                stopSelf(startId)
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun run(graph: WatchGraph) = coroutineScope {
        val covers = graph.database.library().searchAlbums("%", 600).mapNotNull { it.coverId }.distinct()
        Log.i(TAG, "start: ${covers.size} album covers to ask for")
        val arrived = AtomicInteger(0)
        val cancelled = AtomicInteger(0)
        val failed = AtomicInteger(0)
        val outcomes = mutableListOf<String>()
        val deadline = SystemClock.elapsedRealtime() + BUDGET_MS

        for (wave in 0 until WAVES) {
            if (SystemClock.elapsedRealtime() > deadline) {
                Log.i(TAG, "stopping early: no time left for wave $wave")
                break
            }
            val batch = covers.shuffled().take(BATCH)
            val before = arrived.get()
            val jobs = batch.map { id ->
                launch {
                    try {
                        graph.api.coverArt(id, 160)
                        arrived.incrementAndGet()
                    } catch (e: CancellationException) {
                        cancelled.incrementAndGet()
                        throw e
                    } catch (e: Exception) {
                        if (failed.incrementAndGet() <= 3) Log.w(TAG, "a cover failed: ${e.javaClass.simpleName}: ${e.message}")
                    }
                }
            }
            // A synchronisation in the middle of the storm, as the "Synchroniser" button would do.
            val sync = if (wave % 3 == 1) async { graph.sync.run(force = true) } else null
            // The screen is left as soon as the first cover is there.
            var waited = 0
            while (arrived.get() == before && waited < 3_000) {
                delay(1)
                waited++
            }
            jobs.forEach { it.cancel() }
            jobs.joinAll()
            sync?.await()?.let { outcome ->
                outcomes += if (outcome is SyncOutcome.Failed) "FAILED(${outcome.message})" else outcome.toString()
                Log.i(TAG, "wave $wave sync: $outcome")
            }
            delay(200)
        }

        // Garbage collection is what notices a connection that was never given back.
        repeat(3) {
            System.gc()
            System.runFinalization()
            delay(700)
        }
        Log.i(TAG, "done: arrived=${arrived.get()} cancelled=${cancelled.get()} failed=${failed.get()} syncs=$outcomes")
    }

    private companion object {
        const val TAG = "Stress"
        const val CHANNEL = "stress"
        const val NOTIFICATION_ID = 4242
        const val WAVES = 9
        const val BATCH = 40
        const val BUDGET_MS = 90_000L
    }
}
