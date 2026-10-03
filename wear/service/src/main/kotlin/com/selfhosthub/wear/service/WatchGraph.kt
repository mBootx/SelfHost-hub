package com.selfhosthub.wear.service

import android.content.Context
import com.selfhosthub.wear.core.EncryptedSetupStore
import com.selfhosthub.wear.core.SetupStore
import com.selfhosthub.wear.core.SharedPreferencesWatchPrefs
import com.selfhosthub.wear.core.WatchPrefs
import com.selfhosthub.wear.core.WatchSetup
import com.selfhosthub.wear.core.WifiSocketFactory
import com.selfhosthub.wear.data.ArtworkRepository
import com.selfhosthub.wear.data.LibraryRepository
import com.selfhosthub.wear.data.LibrarySync
import com.selfhosthub.wear.data.db.WatchDatabase
import com.selfhosthub.wear.data.net.SubsonicApi
import com.selfhosthub.wear.service.link.LinkLeases
import com.selfhosthub.wear.service.link.PhoneLink
import com.selfhosthub.wear.service.link.WearLinkTransport
import com.selfhosthub.wear.service.sync.LibrarySyncService
import com.selfhosthub.wear.service.sync.RefreshPolicy
import com.selfhosthub.wear.service.sync.SyncCoordinator
import com.selfhosthub.wear.service.update.AndroidUpdateHost
import com.selfhosthub.wear.service.update.UpdateHost
import com.selfhosthub.wear.service.update.WatchUpdates
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

/**
 * Everything the screens and the background services share: the setup the phone gave, the stored library, the
 * covers, the synchronisation, and the seat at the phone app. There is one per process, owned by the Application.
 */
interface WatchGraph {
    val context: Context
    val scope: CoroutineScope
    val prefs: WatchPrefs

    /** What the phone configured: Navidrome's login. Null until the first setup. */
    val setup: StateFlow<WatchSetup?>
    val api: SubsonicApi
    val database: WatchDatabase
    val library: LibraryRepository
    val artwork: ArtworkRepository
    val sync: SyncCoordinator

    /** The players, through the phone app: the only way the watch reaches them (and the PC). */
    val link: PhoneLink

    /** Keeps in touch with the phone for whoever needs it (the screen while it is shown). */
    val linkLeases: LinkLeases

    /** Updating this app from the phone: the APK it sends, and how it goes. */
    val updates: WatchUpdates

    /** Takes in what the phone sent. Another account replaces the old one, with everything that was stored for it. */
    suspend fun applySetup(incoming: WatchSetup)

    /** Reads the library again if it is old, or never came, and nothing was tried a moment ago (see RefreshPolicy). */
    suspend fun refreshLibraryIfDue()

    /** Forgets the library and the covers kept on the watch, but not the setup. */
    suspend fun clearCache()

    /** Back to a watch that was never set up. */
    suspend fun reset()
}

/** Implemented by the Application. */
interface WatchGraphProvider {
    val graph: WatchGraph
}

fun Context.watchGraph(): WatchGraph = (applicationContext as WatchGraphProvider).graph

class DefaultWatchGraph(appContext: Context) : WatchGraph {
    override val context: Context = appContext.applicationContext
    override val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override val prefs: WatchPrefs by lazy { SharedPreferencesWatchPrefs(context) }
    private val store: SetupStore by lazy { EncryptedSetupStore(context) }

    private val setupState: MutableStateFlow<WatchSetup?> by lazy { MutableStateFlow(store.load()) }
    override val setup: StateFlow<WatchSetup?> get() = setupState.asStateFlow()

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .callTimeout(40, TimeUnit.SECONDS)
            .build()
    }

    // A Navidrome on the home network is reached on the watch's Wi-Fi when it has one (see WifiSocketFactory).
    private val homeHttp: OkHttpClient by lazy { http.newBuilder().socketFactory(WifiSocketFactory.forContext(context)).build() }

    override val api: SubsonicApi by lazy { SubsonicApi(http, homeHttp) { setupState.value?.navidrome } }
    override val database: WatchDatabase by lazy { WatchDatabase.open(context) }
    override val library: LibraryRepository by lazy { LibraryRepository(database, api) }
    override val artwork: ArtworkRepository by lazy { ArtworkRepository(database.artwork(), api) }
    override val sync: SyncCoordinator by lazy { SyncCoordinator(LibrarySync(api, database), database, scope) }

    private val notifier: NowPlayingNotifier by lazy { NowPlayingNotifier(context, prefs) }

    private val updateHost: UpdateHost by lazy { AndroidUpdateHost(context) }

    override val updates: WatchUpdates by lazy { WatchUpdates(updateHost, WearLinkTransport(context)) }

    override val link: PhoneLink by lazy {
        PhoneLink(WearLinkTransport(context), scope, prefs, appVersion = { runCatching { updateHost.installed }.getOrNull() }).also { phone ->
            // What the phone pushes puts up (or takes down) the chip of the song playing, with or without a screen.
            scope.launch { phone.state.collect { notifier.update(it) } }
        }
    }

    override val linkLeases: LinkLeases by lazy { LinkLeases(link, scope) }

    override suspend fun applySetup(incoming: WatchSetup) = withContext(Dispatchers.IO) {
        val oldLogin = setupState.value?.navidrome
        if (oldLogin != null && !oldLogin.sameAccount(incoming.navidrome)) {
            library.clear()
            database.artwork().clear()
            database.syncLog().clear()
        }
        store.save(incoming)
        setupState.value = incoming
        LibrarySyncService.schedule(context)
        LibrarySyncService.syncSoon(context)
    }

    override suspend fun refreshLibraryIfDue() = withContext(Dispatchers.IO) {
        if (setupState.value?.navidrome == null) return@withContext
        val log = database.syncLog()
        if (RefreshPolicy.due(log.latest()?.lastSyncTime, log.latestSuccess()?.lastSyncTime, System.currentTimeMillis())) {
            LibrarySyncService.syncSoon(context, replace = false)
        }
    }

    override suspend fun clearCache() = withContext(Dispatchers.IO) {
        library.clear()
        database.artwork().clear()
        database.syncLog().clear()
    }

    override suspend fun reset() = withContext(Dispatchers.IO) {
        LibrarySyncService.cancel(context)
        store.clear()
        setupState.value = null
        link.selectTarget(null)
        prefs.forgetPlayers()
        database.clearAllTables()
    }
}
