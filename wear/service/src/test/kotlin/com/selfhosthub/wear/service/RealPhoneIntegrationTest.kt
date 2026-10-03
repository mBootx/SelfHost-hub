package com.selfhosthub.wear.service

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.selfhosthub.wear.core.AppVersion
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.core.MediaKind
import com.selfhosthub.wear.core.MemoryWatchPrefs
import com.selfhosthub.wear.core.PcState
import com.selfhosthub.wear.core.PlayMode
import com.selfhosthub.wear.core.PlayerCommand
import com.selfhosthub.wear.core.RepeatMode
import com.selfhosthub.wear.core.UpdateRefusal
import com.selfhosthub.wear.core.UpdateState
import com.selfhosthub.wear.core.UpdateStatus
import com.selfhosthub.wear.service.link.LinkStatus
import com.selfhosthub.wear.service.link.LinkTransport
import com.selfhosthub.wear.service.link.PhoneLink
import com.selfhosthub.wear.service.update.FakeUpdateHost
import com.selfhosthub.wear.service.update.WatchUpdates
import java.io.BufferedWriter
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * The watch's link against the phone app's real code: the phone's `watchLink.ts` runs under Node (testing/real-phone.js)
 * with its stores and native module stubbed, and the two are wired to each other the way the data layer wires the
 * watch and the phone. This is what checks that the two languages agree on every message, beyond the shared sample
 * files. Skipped when Node is not installed; fails when Node is there and the phone code does not run.
 */
class RealPhoneIntegrationTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val phones = mutableListOf<Phone>()

    @After
    fun tearDown() {
        phones.forEach { it.close() }
        scope.coroutineContext[Job]?.cancel()
    }

    /** The phone app's watch link, as a process that talks JSON lines. */
    private class Phone : AutoCloseable {
        val events = CopyOnWriteArrayList<JsonObject>()
        @Volatile var onPushed: ((path: String, json: String) -> Unit)? = null
        @Volatile var ready: JsonObject? = null
        private val process: Process
        private val writer: BufferedWriter

        init {
            val script = File("../testing/real-phone.js").absoluteFile.normalize()
            process = ProcessBuilder("node", script.path).redirectErrorStream(true).start()
            writer = process.outputStream.bufferedWriter()
            Thread {
                process.inputStream.bufferedReader().forEachLine { line ->
                    val event = try {
                        JsonParser.parseString(line).asJsonObject
                    } catch (_: Exception) {
                        return@forEachLine
                    }
                    if (event.has("ready")) ready = event
                    events += event
                    event.getAsJsonObject("pushed")?.let { onPushed?.invoke(it.get("path").asString, it.get("json").asString) }
                }
            }.apply { isDaemon = true }.start()
        }

        fun send(command: JsonObject) {
            synchronized(writer) {
                writer.write(command.toString())
                writer.newLine()
                writer.flush()
            }
        }

        fun message(path: String, data: String) = send(obj("cmd" to "message", "path" to path, "data" to data))

        fun waitReady(): Phone {
            await("the phone harness to start") { ready != null }
            assertTrue("the phone harness failed: $ready", ready!!.get("ready").asBoolean)
            return this
        }

        /** The events with this key, in order (their content is an object). */
        fun all(key: String): List<JsonObject> = events.filter { it.has(key) }.map { it.getAsJsonObject(key) }

        /** What the phone queued from its Navidrome, in order: [what, songs, start]. */
        fun queued(): List<JsonArray> = events.filter { it.has("queued") }.map { it.getAsJsonArray("queued") }

        override fun close() {
            try {
                send(obj("cmd" to "stop"))
            } catch (_: Exception) {
            }
            process.waitFor(2, TimeUnit.SECONDS)
            process.destroyForcibly()
        }
    }

    /** The data layer between the watch and the phone harness: what the watch sends is delivered to the phone. */
    private class PipeTransport(private val phone: Phone) : LinkTransport {
        override suspend fun phones(): List<String> = listOf("phone-1")

        override suspend fun send(nodeId: String, path: String, data: ByteArray) {
            phone.message(path, String(data, Charsets.UTF_8))
        }
    }

    private fun startPhone(): Phone {
        assumeTrue("Node is needed to run the phone's code", nodeIsThere())
        return Phone().also { phones += it }.waitReady()
    }

    private fun linkTo(phone: Phone, app: AppVersion? = null): PhoneLink {
        val link = PhoneLink(PipeTransport(phone), scope, MemoryWatchPrefs(), answerTimeoutMs = 4_000, refreshEveryMs = 60_000, appVersion = { app })
        phone.onPushed = { path, json -> link.onMessage(path, json.toByteArray(Charsets.UTF_8)) }
        return link
    }

    private fun playerState(vararg fields: Pair<String, Any?>): JsonObject = obj("cmd" to "player", "state" to obj(*fields))

    private val playing = playerState(
        "queue" to JsonParser.parseString("""[{"id":"s-1","title":"Nuits blanches","artist":"Les Phares","album":"Courants","albumId":"al-77","coverArt":"al-77","duration":243.5}]"""),
        "queueIndex" to 0,
        "isPlaying" to true,
        "currentTime" to 61.25,
        "duration" to 243.5,
        "volume" to 0.8
    )

    private fun remoteWithPc(): JsonObject = obj(
        "cmd" to "remote",
        "state" to obj(
            "enabled" to true,
            "pairing" to obj("hubId" to "h1", "code" to "C"),
            "status" to "connected",
            "client" to true,
            "deviceList" to JsonParser.parseString(
                """[{"deviceId":"hub","deviceName":"PC du salon","platform":"desktop"},{"deviceId":"phone-real-id","deviceName":"Galaxy","platform":"mobile"},{"deviceId":"tablet-1","deviceName":"Tablette","platform":"mobile"}]"""
            ),
            "devices" to JsonParser.parseString(
                """{"hub":{"song":{"id":"s-9","title":"Ligne claire","artist":"Atlas Vert","duration":187},"isPlaying":false,"currentTime":12,"duration":187,"shuffle":true,"repeatMode":"all","volume":0.5},
                    "tablet-1":{"song":null,"isPlaying":false,"currentTime":0,"duration":0,"shuffle":false,"repeatMode":"off","volume":1}}"""
            )
        )
    )

    @Test
    fun `the watch asks the real phone code and reads what it answers`() {
        val phone = startPhone()
        val link = linkTo(phone)
        link.start()

        await("the phone's answer") { link.state.value.connected }
        val state = link.state.value
        assertEquals("Galaxy S25", state.phoneName)
        assertEquals(listOf("local"), state.devices.map { it.deviceId })
        assertEquals(PcState.OFF, state.pc?.state)
        assertEquals("local", state.targetId)
        assertNotNull(state.target)
    }

    @Test
    fun `what plays on the phone shows on the watch without the watch asking`() {
        val phone = startPhone()
        val link = linkTo(phone)
        link.start()
        await("the phone's answer") { link.state.value.connected }

        phone.send(playing)
        await("the phone's push") { link.state.value.target?.state?.song?.title == "Nuits blanches" }
        val player = link.state.value.target!!.state
        assertTrue(player.isPlaying)
        assertEquals(61.25, player.currentTime, 1e-9)
        assertEquals(243.5, player.duration, 1e-9)
        assertEquals(0.8, player.volume, 1e-9)
        assertEquals("al-77", player.song!!.coverArt)
        assertEquals("Les Phares", player.song!!.artist)
    }

    @Test
    fun `the PC and the other players come through the phone, the phone's own entry apart`() {
        val phone = startPhone()
        val link = linkTo(phone)
        link.start()
        await("the phone's answer") { link.state.value.connected }
        phone.send(playing)
        phone.send(remoteWithPc())

        await("the PC") { link.state.value.devices.map { it.deviceId } == listOf("local", "hub", "tablet-1") }
        val state = link.state.value
        assertEquals(PcState.CONNECTED, state.pc?.state)
        assertEquals("PC du salon", state.pc?.name)
        assertEquals("the PC's player", "Ligne claire", state.players.getValue("hub").state.song?.title)
        assertEquals(RepeatMode.ALL, state.players.getValue("hub").state.repeatMode)
        assertTrue(state.players.getValue("hub").state.shuffle)
        assertEquals("the phone plays, so the controls follow it", "local", state.targetId)
        assertFalse("the phone's real id at the hub is not shown", state.devices.any { it.deviceId == "phone-real-id" })
    }

    @Test
    fun `a command for the phone's player is applied by the real phone code`() {
        val phone = startPhone()
        val link = linkTo(phone)
        link.start()
        await("the phone's answer") { link.state.value.connected }
        phone.send(playing)
        await("the phone's push") { link.state.value.target?.state?.isPlaying == true }

        link.send(PlayerCommand.Toggle)
        link.send(PlayerCommand.SetVolume(0.25))
        link.send(PlayerCommand.Seek(95.5))
        link.send(PlayerCommand.ToggleShuffle)
        link.send(PlayerCommand.SetRepeatMode(RepeatMode.ONE))

        await("the phone to apply the commands") { phone.all("local").size >= 5 }
        val applied = phone.all("local")
        assertEquals(listOf("toggle", "setVolume", "seek", "toggleShuffle", "setRepeatMode"), applied.map { it.get("action").asString })
        assertEquals(0.25, applied[1].getAsJsonObject("payload").get("volume").asDouble, 1e-9)
        assertEquals(95.5, applied[2].getAsJsonObject("payload").get("seconds").asDouble, 1e-9)
        assertEquals("one", applied[4].getAsJsonObject("payload").get("mode").asString)
    }

    @Test
    fun `a command for the PC is forwarded by the real phone code through its hub link`() {
        val phone = startPhone()
        val link = linkTo(phone)
        link.start()
        await("the phone's answer") { link.state.value.connected }
        phone.send(remoteWithPc())
        await("the PC") { link.state.value.devices.any { it.deviceId == "hub" } }

        link.selectTarget("hub")
        link.send(PlayerCommand.Next)
        link.send(PlayerCommand.SetVolume(0.3))
        link.send(PlayerCommand.Seek(30.0))

        await("the phone to forward the commands") { phone.all("forwarded").size >= 3 }
        val forwarded = phone.all("forwarded")
        assertEquals(listOf("hub", "hub", "hub"), forwarded.map { it.get("target").asString })
        assertEquals(listOf("next", "setVolume", "seek"), forwarded.map { it.get("action").asString })
        assertEquals(0.3, forwarded[1].getAsJsonObject("payload").get("volume").asDouble, 1e-9)
        assertEquals(30.0, forwarded[2].getAsJsonObject("payload").get("seconds").asDouble, 1e-9)
        assertTrue("and none of it touched the phone's own player", phone.all("local").isEmpty())
    }

    @Test
    fun `something to play is played by the phone, whichever player the watch was showing`() {
        val phone = startPhone()
        val link = linkTo(phone)
        link.start()
        await("the phone's answer") { link.state.value.connected }
        phone.send(remoteWithPc())
        await("the PC") { link.state.value.devices.any { it.deviceId == "hub" } }
        link.selectTarget("hub")

        link.send(PlayerCommand.PlayMedia(MediaKind.ALBUM, "al-77", songId = "al-77-2", mode = PlayMode.NOW))
        link.send(PlayerCommand.PlayMedia(MediaKind.SONG, "s-42", mode = PlayMode.LAST))

        await("the phone to queue it") { phone.queued().size >= 2 }
        val queued = phone.queued()
        assertEquals("playQueue", queued[0][0].asString)
        assertEquals(listOf("al-77-1", "al-77-2", "al-77-3"), queued[0][1].asJsonArray.map { it.asString })
        assertEquals(1, queued[0][2].asInt)
        assertEquals("addToQueue", queued[1][0].asString)
        assertEquals(listOf("s-42"), queued[1][1].asJsonArray.map { it.asString })
        assertTrue("the PC was not asked to play anything", phone.all("forwarded").isEmpty())
    }

    @Test
    fun `the phone answers a command it cannot carry out with how things really are`() {
        val phone = startPhone()
        // No link to the PC at all, and a command for it anyway (the watch has not heard yet that it is gone).
        phone.message(
            LinkProtocol.COMMAND_PATH,
            """{"v":1,"targetId":"hub","action":"toggle"}"""
        )
        await("the phone's correction") { phone.all("pushed").size >= 2 }
        val last = JsonParser.parseString(phone.all("pushed").last().get("json").asString).asJsonObject
        assertEquals(listOf("local"), last.getAsJsonArray("devices").map { it.asJsonObject.get("deviceId").asString })
        assertTrue("and nothing was done to the phone's player", phone.all("local").isEmpty())
    }

    @Test
    fun `garbage from the watch is dropped by the real phone code`() {
        val phone = startPhone()
        phone.message(LinkProtocol.COMMAND_PATH, "definitely not json")
        phone.message(LinkProtocol.COMMAND_PATH, """{"v":1,"targetId":"local","action":"rm -rf"}""")
        phone.message(LinkProtocol.COMMAND_PATH, """{"v":1,"targetId":"local","action":"seek","payload":{"seconds":-4}}""")
        Thread.sleep(600)
        assertTrue(phone.all("local").isEmpty())
        // And it still answers.
        val link = linkTo(phone)
        link.start()
        await("the phone's answer") { link.state.value.connected }
        assertEquals(LinkStatus.CONNECTED, link.state.value.status)
    }

    @Test
    fun `the real phone code learns which version the watch app is from the watch's own request`() {
        val phone = startPhone()
        val link = linkTo(phone, AppVersion("2.5.2", 20502))
        link.start()
        await("the phone's answer") { link.state.value.connected }

        await("the phone to know the version") { phone.all("watchApp").any { it.getAsJsonObject("watch")?.get("code")?.asLong == 20502L } }
        val watch = phone.all("watchApp").last().getAsJsonObject("watch")
        assertEquals("watch-1", watch.get("nodeId").asString)
        assertEquals("2.5.2", watch.get("version").asString)
        assertTrue("and the request was answered all the same", link.state.value.connected)
    }

    @Test
    fun `a watch app that says no version leaves the phone not knowing, and still answered`() {
        val phone = startPhone()
        val link = linkTo(phone)
        link.start()
        await("the phone's answer") { link.state.value.connected }
        Thread.sleep(300)
        assertTrue(phone.all("watchApp").none { it.get("watch")?.isJsonNull == false })
    }

    @Test
    fun `what the watch says about its version and about an update is understood by the real phone code`() {
        val phone = startPhone()
        val dir = java.nio.file.Files.createTempDirectory("real-phone-update").toFile()
        try {
            val host = FakeUpdateHost(File(dir, "update")).apply { installed = AppVersion("2.5.3", 20503) }
            val updates = WatchUpdates(host, PipeTransport(phone))

            kotlinx.coroutines.runBlocking { updates.announceVersion() }
            await("the phone to know the version") { phone.all("watchApp").any { it.getAsJsonObject("watch")?.get("version")?.asString == "2.5.3" } }

            // A refusal and a failure while nothing is under way are no news to the phone: its phase stays idle.
            kotlinx.coroutines.runBlocking {
                updates.report(UpdateStatus(UpdateState.REFUSED, "2.5.3", 20503, UpdateRefusal.NOT_ALLOWED, "x"))
                updates.report(UpdateStatus(UpdateState.FAILED, message = "x"))
            }
            Thread.sleep(300)
            assertTrue(phone.all("watchApp").all { it.get("phase").asString == "idle" })
        } finally {
            dir.deleteRecursively()
        }
    }

    // --- Helpers ---

    private fun nodeIsThere(): Boolean =
        try {
            val node = ProcessBuilder("node", "--version").redirectErrorStream(true).start()
            node.waitFor(10, TimeUnit.SECONDS) && node.exitValue() == 0
        } catch (_: Exception) {
            false
        }
}

private fun obj(vararg fields: Pair<String, Any?>): JsonObject {
    val result = JsonObject()
    for ((key, value) in fields) {
        when (value) {
            null -> result.add(key, com.google.gson.JsonNull.INSTANCE)
            is com.google.gson.JsonElement -> result.add(key, value)
            is Boolean -> result.addProperty(key, value)
            is Number -> result.addProperty(key, value)
            else -> result.addProperty(key, value.toString())
        }
    }
    return result
}

/** Waits until `condition` holds, failing with `what` after `timeoutMs`. */
private fun await(what: String, timeoutMs: Long = 8_000, condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
        if (condition()) return
        Thread.sleep(25)
    }
    throw AssertionError("timed out waiting for $what")
}
