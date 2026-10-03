package com.selfhosthub.wear.service

import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import com.google.android.gms.wearable.MessageEvent
import com.selfhosthub.wear.core.AppVersion
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.core.MemoryWatchPrefs
import com.selfhosthub.wear.core.SetupProtocol
import com.selfhosthub.wear.core.UpdateProtocol
import com.selfhosthub.wear.core.WatchPrefs
import com.selfhosthub.wear.core.WatchSetup
import com.selfhosthub.wear.data.ArtworkRepository
import com.selfhosthub.wear.data.LibraryRepository
import com.selfhosthub.wear.data.db.WatchDatabase
import com.selfhosthub.wear.data.net.SubsonicApi
import com.selfhosthub.wear.service.link.LinkLeases
import com.selfhosthub.wear.service.link.LinkStatus
import com.selfhosthub.wear.service.link.PhoneLink
import com.selfhosthub.wear.service.sync.SyncCoordinator
import com.selfhosthub.wear.service.update.FakeUpdateHost
import com.selfhosthub.wear.service.update.WatchUpdates
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Application of these tests: a graph with just a link over a fake data layer, and a record of the setups taken in. */
class TestApplication : Application(), WatchGraphProvider {
    val transport = FakeTransport()
    val appliedSetups = CopyOnWriteArrayList<WatchSetup>()
    internal val testScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    internal val testPrefs = MemoryWatchPrefs()
    val phoneLink: PhoneLink by lazy { PhoneLink(transport, testScope, testPrefs) }
    val updateHost = FakeUpdateHost(java.io.File(System.getProperty("java.io.tmpdir"), "wear-update-test"))
    val watchUpdates: WatchUpdates by lazy { WatchUpdates(updateHost, transport) }

    override val graph: WatchGraph by lazy { FakeGraph(this) }
}

private class FakeGraph(private val app: TestApplication) : WatchGraph {
    override val context: Context get() = app
    override val scope: CoroutineScope get() = app.testScope
    override val prefs: WatchPrefs get() = app.testPrefs
    override val setup: StateFlow<WatchSetup?> = MutableStateFlow(null)
    override val api: SubsonicApi get() = error("not used by these tests")
    override val database: WatchDatabase get() = error("not used by these tests")
    override val library: LibraryRepository get() = error("not used by these tests")
    override val artwork: ArtworkRepository get() = error("not used by these tests")
    override val sync: SyncCoordinator get() = error("not used by these tests")
    override val link: PhoneLink get() = app.phoneLink
    override val linkLeases: LinkLeases get() = error("not used by these tests")
    override val updates: WatchUpdates get() = app.watchUpdates

    override suspend fun applySetup(incoming: WatchSetup) {
        app.appliedSetups += incoming
    }

    override suspend fun refreshLibraryIfDue() = Unit

    override suspend fun clearCache() = Unit

    override suspend fun reset() = Unit
}

private class Event(private val path: String, private val data: ByteArray, private val node: String = "phone-1") : MessageEvent {
    override fun getRequestId(): Int = 1
    override fun getPath(): String = path
    override fun getData(): ByteArray = data
    override fun getSourceNodeId(): String = node
}

private const val SNAPSHOT =
    """{"v":1,"phone":"Pixel","pc":{"state":"off"},"devices":[{"deviceId":"local","deviceName":"Pixel","platform":"mobile"}],""" +
        """"states":{"local":{"song":{"id":"s1","title":"Titre","artist":"A","duration":200},"isPlaying":true,"currentTime":5,"duration":200,"shuffle":false,"repeatMode":"off","volume":1}}}"""

private const val SETUP = """{"v":1,"navidrome":{"url":"https://music.example.org","username":"maxime","salt":"c19b2d","token":"26719a1196d2a940705a59634eb18eab"}}"""

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApplication::class)
class ListenersTest {
    private val app: TestApplication get() = ApplicationProvider.getApplicationContext()
    private fun service() = Robolectric.setupService(WatchListenerService::class.java)

    @Test
    fun `a snapshot the phone pushes reaches the link, with the app closed or not`() {
        service().onMessageReceived(Event(LinkProtocol.SNAPSHOT_PATH, SNAPSHOT.toByteArray()))
        val state = app.phoneLink.state.value
        assertEquals(LinkStatus.CONNECTED, state.status)
        assertEquals("Titre", state.target!!.state.song!!.title)
    }

    @Test
    fun `the phone saying its app is closed reaches the link too`() {
        service().onMessageReceived(Event(LinkProtocol.SNAPSHOT_PATH, SNAPSHOT.toByteArray()))
        service().onMessageReceived(Event(LinkProtocol.CLOSED_PATH, """{"v":1}""".toByteArray()))
        assertEquals(LinkStatus.PHONE_APP_CLOSED, app.phoneLink.state.value.status)
    }

    @Test
    fun `a setup from the phone is taken in`() {
        service().onMessageReceived(Event(SetupProtocol.SETUP_PATH, SETUP.toByteArray()))
        assertEquals(1, app.appliedSetups.size)
        assertEquals("maxime", app.appliedSetups[0].navidrome.username)
    }

    @Test
    fun `a setup that is not right is refused whole`() {
        service().onMessageReceived(Event(SetupProtocol.SETUP_PATH, """{"v":1,"navidrome":{"url":"ftp://x","username":"u","salt":"s","token":"t"}}""".toByteArray()))
        service().onMessageReceived(Event(SetupProtocol.SETUP_PATH, "garbage".toByteArray()))
        assertTrue(app.appliedSetups.isEmpty())
    }

    @Test
    fun `the phone asking which version of the app this is gets the answer`() {
        app.updateHost.installed = AppVersion("2.5.2", 20502)
        service().onMessageReceived(Event(UpdateProtocol.ASK_PATH, """{"v":1}""".toByteArray()))
        val said = app.transport.sent.single { it.path == UpdateProtocol.STATUS_PATH }
        assertEquals("phone-1", said.nodeId)
        assertEquals("""{"v":1,"state":"version","versionName":"2.5.2","versionCode":20502}""", said.text)
    }

    @Test
    fun `other paths are ignored`() {
        service().onMessageReceived(Event("/something/else", SNAPSHOT.toByteArray()))
        assertEquals(LinkStatus.CONNECTING, app.phoneLink.state.value.status)
        assertTrue(app.appliedSetups.isEmpty())
    }

    @Test
    fun `the buttons of the notification send their command to the phone`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        for (name in listOf(PlaybackActionReceiver.PREVIOUS, PlaybackActionReceiver.TOGGLE, PlaybackActionReceiver.NEXT)) {
            PlaybackActionReceiver().onReceive(context, Intent(PlaybackActionReceiver.PREFIX + name))
        }
        PlaybackActionReceiver().onReceive(context, Intent(PlaybackActionReceiver.PREFIX + "format-disk"))
        PlaybackActionReceiver().onReceive(context, Intent("something else"))

        val deadline = System.currentTimeMillis() + 5_000
        while (app.transport.commands().size < 3 && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertEquals(setOf("prev", "toggle", "next"), app.transport.commands().map { it.get("action").asString }.toSet())
        assertEquals(3, app.transport.commands().size)
    }
}
