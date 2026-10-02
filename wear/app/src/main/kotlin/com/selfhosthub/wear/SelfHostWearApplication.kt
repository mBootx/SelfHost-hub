package com.selfhosthub.wear

import android.app.Application
import com.selfhosthub.wear.service.DefaultWatchGraph
import com.selfhosthub.wear.service.Notifications
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.service.WatchGraphProvider
import com.selfhosthub.wear.service.sync.LibrarySyncService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class SelfHostWearApplication : Application(), WatchGraphProvider {
    override val graph: WatchGraph by lazy { DefaultWatchGraph(this) }

    override fun onCreate() {
        super.onCreate()
        Notifications.ensureChannels(this)
        // Reading the secret store waits for the Android keystore: not something to do before the first frame.
        graph.scope.launch(Dispatchers.IO) {
            if (graph.setup.value?.navidrome != null) LibrarySyncService.schedule(this@SelfHostWearApplication)
        }
    }
}
