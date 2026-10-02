package com.selfhosthub.wear.service.sync

import com.selfhosthub.wear.data.LibrarySync
import com.selfhosthub.wear.data.SyncOutcome
import com.selfhosthub.wear.data.db.SyncLogEntity
import com.selfhosthub.wear.data.db.WatchDatabase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

data class SyncUiState(
    val running: Boolean = false,
    /** When the library was last read from the server in full or in part. */
    val lastSuccessAt: Long? = null,
    /** How the latest attempt ended, if badly. */
    val lastError: String? = null,
    val lastKind: String? = null
)

/** One door to the synchronisation, so the hourly job and the "Synchroniser" button show the same state. */
class SyncCoordinator(
    private val sync: LibrarySync,
    private val db: WatchDatabase,
    scope: CoroutineScope
) {
    private val running = MutableStateFlow(false)

    val state: StateFlow<SyncUiState> = combine(running, db.syncLog().observeLatest(), db.syncLog().observeLatestSuccess()) { isRunning, latest, success ->
        SyncUiState(
            running = isRunning,
            lastSuccessAt = success?.lastSyncTime,
            lastError = latest?.takeIf { it.status == SyncLogEntity.FAILED }?.message,
            lastKind = success?.kind
        )
    }.stateIn(scope, SharingStarted.Eagerly, SyncUiState())

    suspend fun run(force: Boolean = false): SyncOutcome {
        running.value = true
        try {
            return sync.run(force)
        } finally {
            running.value = false
        }
    }
}
