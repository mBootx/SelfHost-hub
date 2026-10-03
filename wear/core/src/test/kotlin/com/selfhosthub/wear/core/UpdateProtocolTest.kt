package com.selfhosthub.wear.core

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

private fun sample(name: String): String =
    checkNotNull(UpdateProtocolTest::class.java.getResourceAsStream("/$name")) { "the shared sample $name is missing" }
        .bufferedReader().use { it.readText() }.trim()

private const val SHA = "a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"

class UpdateProtocolTest {
    private val header = UpdateHeader("2.5.2", 20502, 3_562_118, SHA)

    @Test
    fun `a header is written and read back the same`() {
        assertEquals(header, UpdateCodec.decodeHeader(UpdateCodec.header(header)))
        assertEquals(header.copy(reinstall = true), UpdateCodec.decodeHeader(UpdateCodec.header(header.copy(reinstall = true))))
    }

    @Test
    fun `the header the phone writes is read (shared sample)`() {
        assertEquals(header, UpdateCodec.decodeHeader(sample("phone-update-header.json")))
    }

    @Test
    fun `the header the watch writes is the sample the phone is held to`() {
        assertEquals(JsonParser.parseString(sample("phone-update-header.json")), JsonParser.parseString(UpdateCodec.header(header)))
    }

    @Test
    fun `an upper-case digest is read as lower case, and a missing reinstall is false`() {
        val read = UpdateCodec.decodeHeader("""{"v":1,"versionName":"2.5.2","versionCode":20502,"size":10,"sha256":"${SHA.uppercase()}"}""")
        assertEquals(SHA, read.sha256)
        assertFalse(read.reinstall)
    }

    @Test
    fun `headers that are not exactly right are refused`() {
        val good = """"v":1,"versionName":"2.5.2","versionCode":20502,"size":10,"sha256":"$SHA""""
        val bad = listOf(
            "",
            "garbage",
            "[]",
            "{$good}".replace(""""v":1""", """"v":2"""),
            "{$good}".replace(""""v":1,""", ""),
            "{$good}".replace("2.5.2", "2.5"),
            "{$good}".replace("2.5.2", "2.5.2-beta"),
            "{$good}".replace("2.5.2", "10000.0.0"),
            "{$good}".replace("20502", "0"),
            "{$good}".replace("20502", "3000000000"),
            "{$good}".replace("20502", "20502.5"),
            "{$good}".replace("20502", "\"20502\""),
            "{$good}".replace(""""size":10""", """"size":0"""),
            "{$good}".replace(""""size":10""", """"size":-5"""),
            "{$good}".replace(""""size":10""", """"size":${UpdateProtocol.MAX_APK_BYTES + 1}"""),
            "{$good}".replace(SHA, SHA.dropLast(1)),
            "{$good}".replace(SHA, "z".repeat(64))
        )
        for (text in bad) assertThrows(text, UpdateFormatException::class.java) { UpdateCodec.decodeHeader(text) }
    }

    @Test
    fun `the status messages the watch writes are the ones in the sample file`() {
        val samples = JsonParser.parseString(sample("watch-update-statuses.json")).asJsonObject
        fun written(status: UpdateStatus) = JsonParser.parseString(UpdateCodec.status(status))
        assertEquals(samples["received"], written(UpdateStatus(UpdateState.RECEIVED, "2.5.2", 20502)))
        assertEquals(samples["confirm"], written(UpdateStatus(UpdateState.CONFIRM, message = "Confirmez la mise à jour sur la montre")))
        assertEquals(samples["installed"], written(UpdateStatus(UpdateState.INSTALLED, "2.5.2", 20502)))
        assertEquals(samples["version"], written(UpdateStatus(UpdateState.VERSION, "2.5.2", 20502)))
        assertEquals(
            samples["refusedNotAllowed"],
            written(UpdateStatus(UpdateState.REFUSED, "2.5.2", 20502, UpdateRefusal.NOT_ALLOWED, "L’application n’a pas le droit d’installer des applications sur la montre"))
        )
        assertEquals(samples["failed"], written(UpdateStatus(UpdateState.FAILED, "2.5.2", 20502, message = "Fichier endommagé pendant le transfert")))
        assertEquals("every message of the sample file is covered", 6, samples.size())
    }

    @Test
    fun `a status message is cut to a length that fits a message`() {
        val text = JsonParser.parseString(UpdateCodec.status(UpdateStatus(UpdateState.FAILED, message = "x".repeat(5_000)))).asJsonObject["message"].asString
        assertEquals(300, text.length)
    }

    @Test
    fun `the states and reasons go over the wire under the names the phone knows`() {
        assertEquals(listOf("received", "confirm", "installed", "version", "refused", "failed"), UpdateState.entries.map { it.wire })
        assertEquals(listOf("up-to-date", "not-allowed", "no-space", "bad-header", "busy"), UpdateRefusal.entries.map { it.wire })
        assertEquals(UpdateState.REFUSED, UpdateState.fromWire("refused"))
        assertNull(UpdateState.fromWire("exploded"))
    }

    @Test
    fun `the request tells the phone which version of the app asks (shared sample)`() {
        assertEquals(JsonParser.parseString(sample("watch-request.json")), JsonParser.parseString(LinkCodec.request(AppVersion("2.5.2", 20502))))
        assertEquals(JsonParser.parseString("""{"v":1}"""), JsonParser.parseString(LinkCodec.request()))
    }

    // --- What the watch will take ---

    private fun refusal(code: Long = 20502, reinstall: Boolean = false, installed: Long = 20500, free: Long = 100_000_000, may: Boolean = true) =
        UpdatePolicy.refusal(header.copy(versionCode = code, reinstall = reinstall), installed, free, may)

    @Test
    fun `a newer version is taken`() {
        assertNull(refusal())
    }

    @Test
    fun `the same or an older version is not, unless it is a reinstall of the same one`() {
        assertEquals(UpdateRefusal.UP_TO_DATE, refusal(code = 20500))
        assertEquals(UpdateRefusal.UP_TO_DATE, refusal(code = 20400))
        assertEquals(UpdateRefusal.UP_TO_DATE, refusal(code = 20400, reinstall = true))
        assertNull(refusal(code = 20500, reinstall = true))
    }

    @Test
    fun `without the right to install, or room for the file twice, it is not taken`() {
        assertEquals(UpdateRefusal.NOT_ALLOWED, refusal(may = false))
        assertEquals(UpdateRefusal.NO_SPACE, refusal(free = header.size * 2 - 1))
        assertNull(refusal(free = header.size * 2))
    }

    @Test
    fun `being up to date is said before anything about permission or room`() {
        assertEquals(UpdateRefusal.UP_TO_DATE, refusal(code = 20500, may = false, free = 0))
        assertEquals(UpdateRefusal.NOT_ALLOWED, refusal(may = false, free = 0))
    }

    @Test
    fun `the protocol paths sit under the prefix the manifests listen on`() {
        assertTrue(UpdateProtocol.APK_PATH.startsWith(UpdateProtocol.PREFIX))
        assertTrue(UpdateProtocol.STATUS_PATH.startsWith(UpdateProtocol.PREFIX))
        assertTrue(UpdateProtocol.ASK_PATH.startsWith(UpdateProtocol.PREFIX))
    }
}
