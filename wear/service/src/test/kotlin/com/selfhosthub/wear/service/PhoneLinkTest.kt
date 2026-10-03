package com.selfhosthub.wear.service

import com.selfhosthub.wear.core.AppVersion
import com.selfhosthub.wear.core.DeviceState
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.core.MediaKind
import com.selfhosthub.wear.core.MemoryWatchPrefs
import com.selfhosthub.wear.core.PcState
import com.selfhosthub.wear.core.PlayMode
import com.selfhosthub.wear.core.PlayerCommand
import com.selfhosthub.wear.core.RemoteSong
import com.selfhosthub.wear.core.RepeatMode
import com.selfhosthub.wear.core.WatchPrefs
import com.selfhosthub.wear.service.link.LinkStatus
import com.selfhosthub.wear.service.link.PhoneLink
import com.selfhosthub.wear.service.link.PlayerSnapshot
import java.io.IOException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun song(id: String, title: String) = """{"id":"$id","title":"$title","artist":"Artiste","duration":200}"""

private fun state(song: String?, playing: Boolean, position: Double = 0.0) =
    """{"song":${song ?: "null"},"isPlaying":$playing,"currentTime":$position,"duration":200,"shuffle":false,"repeatMode":"off","volume":0.5}"""

/** What the phone sends: itself first, then the PC if `hub` is given, then any other player by id. */
private fun snapshot(phone: String = state(null, false), hub: String? = null, others: Map<String, String> = emptyMap(), pc: String = "connected"): String {
    val devices = buildList {
        add("""{"deviceId":"local","deviceName":"Pixel","platform":"mobile"}""")
        if (hub != null) add("""{"deviceId":"hub","deviceName":"PC","platform":"desktop"}""")
        others.keys.forEach { add("""{"deviceId":"$it","deviceName":"$it","platform":"mobile"}""") }
    }
    val states = buildList {
        add("\"local\":$phone")
        if (hub != null) add("\"hub\":$hub")
        others.forEach { (id, s) -> add("\"$id\":$s") }
    }
    return """{"v":1,"phone":"Pixel","pc":{"state":"$pc","name":"PC"},"devices":[${devices.joinToString(",")}],"states":{${states.joinToString(",")}}}"""
}

@OptIn(ExperimentalCoroutinesApi::class)
class PhoneLinkTest {
    private fun TestScope.newLink(transport: FakeTransport, prefs: WatchPrefs = MemoryWatchPrefs()) =
        PhoneLink(transport, backgroundScope, prefs, clock = { 1_000_000 + currentTime }, answerTimeoutMs = 6_000, refreshEveryMs = 30_000)

    private fun PhoneLink.hear(json: String) = onMessage(LinkProtocol.SNAPSHOT_PATH, json.toByteArray())

    /** A phone that answers every request with `reply`. */
    private fun FakeTransport.answeringWith(link: () -> PhoneLink, reply: () -> String) {
        onSend = { if (it.path == LinkProtocol.REQUEST_PATH) link().hear(reply()) }
    }

    @Test
    fun `started, it asks the phone and shows what the phone answers`() = runTest {
        val transport = FakeTransport()
        lateinit var link: PhoneLink
        link = newLink(transport)
        transport.answeringWith({ link }) { snapshot(phone = state(song("s1", "Titre"), true, 12.0)) }

        link.start()
        runCurrent()

        val s = link.state.value
        assertTrue(s.connected)
        assertEquals("Pixel", s.phoneName)
        assertEquals(PcState.CONNECTED, s.pc?.state)
        assertEquals("local", s.targetId)
        assertEquals("Titre", s.target!!.state.song!!.title)
        assertEquals(1, transport.requests().size)
        assertEquals("""{"v":1}""", transport.requests().single().text)
    }

    @Test
    fun `every request says which version of the app asks, so that the phone can offer an update`() = runTest {
        val transport = FakeTransport()
        lateinit var link: PhoneLink
        link = PhoneLink(transport, backgroundScope, MemoryWatchPrefs(), clock = { 1_000_000 + currentTime }, appVersion = { AppVersion("2.5.2", 20502) })
        transport.answeringWith({ link }) { snapshot() }

        link.start()
        runCurrent()
        link.refresh()
        runCurrent()

        assertEquals(2, transport.requests().size)
        for (request in transport.requests()) assertEquals("""{"v":1,"app":{"name":"2.5.2","code":20502}}""", request.text)
    }

    @Test
    fun `it asks again every half minute while started, and no more once stopped`() = runTest {
        val transport = FakeTransport()
        lateinit var link: PhoneLink
        link = newLink(transport)
        transport.answeringWith({ link }) { snapshot() }

        link.start()
        link.start() // twice does not ask twice
        runCurrent()
        assertEquals(1, transport.requests().size)
        advanceTimeBy(30_001)
        runCurrent()
        assertEquals(2, transport.requests().size)

        link.stop()
        advanceTimeBy(120_000)
        runCurrent()
        assertEquals(2, transport.requests().size)
    }

    @Test
    fun `with no phone connected it says so and knows nothing`() = runTest {
        val transport = FakeTransport().apply { nodes = emptyList() }
        val link = newLink(transport)
        link.start()
        runCurrent()
        assertEquals(LinkStatus.NO_PHONE, link.state.value.status)
        assertTrue(link.state.value.devices.isEmpty())
        assertNull(link.state.value.targetId)
    }

    @Test
    fun `a data layer that fails is the same as no phone`() = runTest {
        val broken = FakeTransport().apply { nodesError = IOException("services Google absents") }
        val link = newLink(broken)
        link.start()
        runCurrent()
        assertEquals(LinkStatus.NO_PHONE, link.state.value.status)

        val refusing = FakeTransport().apply { sendError = IOException("refus") }
        val other = newLink(refusing)
        other.start()
        runCurrent()
        assertEquals(LinkStatus.NO_PHONE, other.state.value.status)
    }

    @Test
    fun `a phone that does not answer in time has a closed app`() = runTest {
        val transport = FakeTransport() // connected, but nobody replies
        val link = newLink(transport)
        link.start()
        runCurrent()
        assertEquals("still waiting", LinkStatus.CONNECTING, link.state.value.status)
        advanceTimeBy(6_001)
        runCurrent()
        assertEquals(LinkStatus.PHONE_APP_CLOSED, link.state.value.status)
        assertNull(link.state.value.targetId)
    }

    @Test
    fun `the phone saying its app is closed is believed at once`() = runTest {
        val link = newLink(FakeTransport())
        link.hear(snapshot(phone = state(song("s1", "T"), true)))
        assertTrue(link.state.value.connected)
        link.onMessage(LinkProtocol.CLOSED_PATH, """{"v":1}""".toByteArray())
        assertEquals(LinkStatus.PHONE_APP_CLOSED, link.state.value.status)
        assertTrue("what was known is not true any more", link.state.value.players.isEmpty())
    }

    @Test
    fun `a snapshot of another version asks for an update, and a good one brings it back`() = runTest {
        val link = newLink(FakeTransport())
        link.onMessage(LinkProtocol.SNAPSHOT_PATH, """{"v":9,"devices":[],"states":{}}""".toByteArray())
        assertEquals(LinkStatus.VERSION_MISMATCH, link.state.value.status)
        link.hear(snapshot())
        assertEquals(LinkStatus.CONNECTED, link.state.value.status)
    }

    @Test
    fun `what the phone pushes is taken in without asking`() = runTest {
        val transport = FakeTransport()
        val link = newLink(transport)
        link.hear(snapshot(phone = state(song("s1", "Un"), true)))
        assertEquals("Un", link.state.value.target!!.state.song!!.title)
        link.hear(snapshot(phone = state(song("s2", "Deux"), true)))
        assertEquals("Deux", link.state.value.target!!.state.song!!.title)
        assertTrue(transport.sent.isEmpty())
    }

    @Test
    fun `things that are not snapshots change nothing`() = runTest {
        val link = newLink(FakeTransport())
        link.hear(snapshot(phone = state(song("s1", "T"), true)))
        val before = link.state.value
        link.onMessage(LinkProtocol.SNAPSHOT_PATH, "not json".toByteArray())
        link.onMessage("/selfhost/link/other", """{"v":1}""".toByteArray())
        assertEquals(before, link.state.value)
    }

    @Test
    fun `the phone going away empties what is known but keeps the player picked by hand`() = runTest {
        val transport = FakeTransport()
        lateinit var link: PhoneLink
        link = newLink(transport)
        transport.answeringWith({ link }) { snapshot(hub = state(song("s1", "T"), false)) }
        link.start()
        runCurrent()
        link.selectTarget("hub")
        assertEquals("hub", link.state.value.targetId)

        transport.nodes = emptyList()
        advanceTimeBy(30_001)
        runCurrent()
        assertEquals(LinkStatus.NO_PHONE, link.state.value.status)
        assertTrue(link.state.value.players.isEmpty())
        assertEquals("hub", link.state.value.manualTargetId)
    }

    @Test
    fun `a state for a player that is not listed is dropped`() = runTest {
        val link = newLink(FakeTransport())
        val json = snapshot().replace("""}}""", """},"ghost":${state(song("g", "Fantôme"), true)}}""")
        link.hear(json)
        assertEquals(setOf("local"), link.state.value.players.keys)
    }

    // --- Which player the controls act on ---

    @Test
    fun `the controls follow the player that plays, and the one that started last`() = runTest {
        val link = newLink(FakeTransport())
        link.hear(snapshot(phone = state(song("a", "A"), true), hub = state(null, false)))
        assertEquals("local", link.state.value.targetId)

        advanceTimeBy(10_000)
        link.hear(snapshot(phone = state(song("a", "A"), true), hub = state(song("b", "B"), true)))
        assertEquals("the PC started after the phone", "hub", link.state.value.targetId)
        assertFalse(link.state.value.manualTargetId != null)

        advanceTimeBy(10_000)
        link.hear(snapshot(phone = state(song("a", "A"), true), hub = state(song("b", "B"), false)))
        assertEquals("the PC paused: the phone is the one that plays", "local", link.state.value.targetId)
    }

    @Test
    fun `with nothing playing it comes back to the last player used, else the phone`() = runTest {
        val prefs = MemoryWatchPrefs()
        val link = newLink(FakeTransport(), prefs)
        link.hear(snapshot(hub = state(null, false)))
        assertEquals("the phone itself, not the PC", "local", link.state.value.targetId)

        link.hear(snapshot(hub = state(song("b", "B"), true)))
        assertEquals("hub", link.state.value.targetId)
        assertEquals("hub", prefs.lastTargetId)
        link.hear(snapshot(hub = state(song("b", "B"), false)))
        assertEquals("the one that played last", "hub", link.state.value.targetId)
    }

    @Test
    fun `a player picked by hand stays the one until it leaves, and the choice is remembered`() = runTest {
        val prefs = MemoryWatchPrefs()
        val link = newLink(FakeTransport(), prefs)
        link.hear(snapshot(phone = state(song("a", "A"), true), hub = state(null, false)))
        link.selectTarget("hub")
        assertEquals("hub", link.state.value.targetId)
        assertEquals("hub", prefs.manualTargetId)

        link.hear(snapshot(phone = state(song("a", "A"), true)))
        assertEquals("the PC left: back to what plays", "local", link.state.value.targetId)
        assertEquals("the choice is not forgotten, the PC may come back", "hub", prefs.manualTargetId)
        link.hear(snapshot(phone = state(song("a", "A"), true), hub = state(null, false)))
        assertEquals("hub", link.state.value.targetId)

        link.selectTarget(null)
        assertEquals("local", link.state.value.targetId)
        assertNull(prefs.manualTargetId)
    }

    // --- Commands ---

    @Test
    fun `a command goes to the player the controls act on, and its effect shows at once`() = runTest {
        val transport = FakeTransport()
        val link = newLink(transport)
        link.hear(snapshot(phone = state(song("a", "A"), true, 30.0), hub = state(song("b", "B"), false)))
        assertEquals("local", link.state.value.targetId)

        val answering = link.send(PlayerCommand.Toggle)
        runCurrent()
        assertTrue(answering)
        val sent = transport.commands().single()
        assertEquals("local", sent.get("targetId").asString)
        assertEquals("toggle", sent.get("action").asString)
        assertEquals("paused on the watch already", false, link.state.value.players.getValue("local").state.isPlaying)

        link.selectTarget("hub")
        link.send(PlayerCommand.SetVolume(0.9))
        link.send(PlayerCommand.Seek(120.0))
        link.send(PlayerCommand.ToggleShuffle)
        link.send(PlayerCommand.SetRepeatMode(RepeatMode.ONE))
        runCurrent()
        val pc: DeviceState = link.state.value.players.getValue("hub").state
        assertEquals(0.9, pc.volume, 1e-9)
        assertEquals(120.0, pc.currentTime, 1e-9)
        assertTrue(pc.shuffle)
        assertEquals(RepeatMode.ONE, pc.repeatMode)
        assertEquals(listOf("local", "hub", "hub", "hub", "hub"), transport.commands().map { it.get("targetId").asString })
        assertEquals(0.9, transport.commands()[1].getAsJsonObject("payload").get("volume").asDouble, 1e-9)
    }

    @Test
    fun `something to play is always asked of the phone, and then the watch follows it`() = runTest {
        val transport = FakeTransport()
        val prefs = MemoryWatchPrefs()
        val link = newLink(transport, prefs)
        link.hear(snapshot(phone = state(null, false), hub = state(song("b", "B"), true)))
        link.selectTarget("hub")

        link.send(PlayerCommand.PlayMedia(MediaKind.ALBUM, "al-1", songId = "s2", mode = PlayMode.NOW))
        runCurrent()
        val sent = transport.commands().single()
        assertEquals("local", sent.get("targetId").asString)
        assertEquals("playMedia", sent.get("action").asString)
        assertEquals("al-1", sent.getAsJsonObject("payload").get("id").asString)
        assertNull("no longer pinned to the PC", link.state.value.manualTargetId)
        assertNull(prefs.manualTargetId)
    }

    @Test
    fun `something to play leaves a player picked on the phone as it is`() = runTest {
        val link = newLink(FakeTransport())
        link.hear(snapshot(phone = state(null, false), hub = state(null, false)))
        link.selectTarget("local")
        link.send(PlayerCommand.PlayMedia(MediaKind.SONG, "s1", mode = PlayMode.LAST))
        assertEquals("local", link.state.value.manualTargetId)
    }

    @Test
    fun `a command with no phone around is reported false and says no phone`() = runTest {
        val transport = FakeTransport().apply { nodes = emptyList() }
        val link = newLink(transport)
        link.hear(snapshot(phone = state(song("a", "A"), true)))

        val answering = link.send(PlayerCommand.Next)
        runCurrent()
        assertTrue("it answered a moment ago", answering)
        assertEquals(LinkStatus.NO_PHONE, link.state.value.status)
        assertFalse("and now it does not", link.send(PlayerCommand.Next))
    }

    @Test
    fun `a command from a button can be waited for until the data layer has it`() = runTest {
        val transport = FakeTransport()
        val link = newLink(transport)
        link.hear(snapshot(phone = state(song("a", "A"), true)))
        assertTrue(link.sendAndWait(PlayerCommand.Next))
        assertEquals(1, transport.commands().size)

        transport.nodes = emptyList()
        assertFalse(link.sendAndWait(PlayerCommand.Next))
        assertEquals(1, transport.commands().size)
    }

    @Test
    fun `with no player known a command is still sent to the phone`() = runTest {
        val transport = FakeTransport()
        val link = newLink(transport)
        link.send(PlayerCommand.Toggle)
        runCurrent()
        assertEquals("local", transport.commands().single().get("targetId").asString)
    }

    @Test
    fun `a command to several phones goes to each`() = runTest {
        val transport = FakeTransport().apply { nodes = listOf("phone-1", "phone-2") }
        val link = newLink(transport)
        link.send(PlayerCommand.Next)
        runCurrent()
        assertEquals(listOf("phone-1", "phone-2"), transport.sent.map { it.nodeId })
    }

    @Test
    fun `refreshing asks now, not at the next round`() = runTest {
        val transport = FakeTransport()
        lateinit var link: PhoneLink
        link = newLink(transport)
        transport.answeringWith({ link }) { snapshot() }
        link.refresh()
        runCurrent()
        assertEquals(1, transport.requests().size)
        assertTrue(link.state.value.connected)
    }
}

class PlayerSnapshotTest {
    private val song = RemoteSong("s", "T", "A", null, null, null, 200.0)
    private fun player(playing: Boolean, position: Double, duration: Double = 200.0) =
        PlayerSnapshot(DeviceState(song, playing, position, duration, false, RepeatMode.OFF, 1.0), receivedAt = 10_000)

    @Test
    fun `a playing song moves on with the clock, a paused one does not`() {
        assertEquals(40.0, player(true, 30.0).positionAt(20_000), 1e-9)
        assertEquals(30.0, player(false, 30.0).positionAt(20_000), 1e-9)
    }

    @Test
    fun `it stops at the end of the song, and never goes back with a clock that is behind`() {
        assertEquals(200.0, player(true, 190.0).positionAt(60_000), 1e-9)
        assertEquals(30.0, player(true, 30.0).positionAt(5_000), 1e-9)
    }

    @Test
    fun `a song of unknown length is not cut`() {
        assertEquals(90.0, player(true, 30.0, duration = 0.0).positionAt(70_000), 1e-9)
    }
}
