package com.selfhosthub.wear.core

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun sample(name: String): String =
    checkNotNull(PhoneSampleTest::class.java.getResourceAsStream("/$name")) { "the shared sample $name is missing" }
        .bufferedReader().use { it.readText() }.trim()

/**
 * The sample files in core/src/test/resources are what both apps are held to. The phone's tests
 * (mobile/tests/watchsync.test.js and watchlink.test.js) assert that the phone writes exactly these files, and these
 * tests assert that the watch reads them, and writes its commands the way the phone expects. If either side changes a
 * format, one of the two fails.
 */
class PhoneSampleTest {
    @Test
    fun `the watch reads the setup the phone sends`() {
        val setup = SetupCodec.decode(sample("phone-setup.json"))
        assertEquals(WatchSetup(NavidromeLogin("https://music.example.org", "maxime", "c19b2d", "26719a1196d2a940705a59634eb18eab")), setup)
    }

    @Test
    fun `and writes it back the same way`() {
        val text = sample("phone-setup.json")
        assertEquals(JsonParser.parseString(text), JsonParser.parseString(SetupCodec.encode(SetupCodec.decode(text))))
    }

    @Test
    fun `the token in the sample is the one a login with that salt makes from the password`() {
        val login = SetupCodec.decode(sample("phone-setup.json")).navidrome
        assertEquals(SubsonicAuth.token("sesame", login.salt), login.token)
    }

    @Test
    fun `the watch reads the snapshot the phone sends`() {
        val snapshot = (LinkCodec.parse(LinkProtocol.SNAPSHOT_PATH, sample("phone-snapshot.json")) as LinkMessage.Snap).snapshot
        assertEquals("Galaxy S25 Ultra", snapshot.phoneName)
        assertEquals(PcLink(PcState.CONNECTED, "PC de Maxime", null), snapshot.pc)
        assertEquals(
            listOf(
                DeviceSummary(LinkProtocol.PHONE_ID, "Galaxy S25 Ultra", "mobile"),
                DeviceSummary(LinkProtocol.HUB_ID, "PC de Maxime", "desktop"),
                DeviceSummary("tablet-1", "Tablette salon", "mobile")
            ),
            snapshot.devices
        )

        val phone = snapshot.states.getValue(LinkProtocol.PHONE_ID)
        assertEquals(RemoteSong("s-4412", "Nuits blanches", "Les Phares", "Courants", "al-77", "al-77", 243.5), phone.song)
        assertTrue(phone.isPlaying)
        assertEquals(61.25, phone.currentTime, 0.0)
        assertEquals(243.5, phone.duration, 0.0)
        assertEquals(RepeatMode.OFF, phone.repeatMode)
        assertEquals(0.8, phone.volume, 1e-9)

        val pc = snapshot.states.getValue(LinkProtocol.HUB_ID)
        assertEquals("Ligne claire", pc.song?.title)
        assertEquals(false, pc.isPlaying)
        assertTrue(pc.shuffle)
        assertEquals(RepeatMode.ALL, pc.repeatMode)
        assertEquals(0.5, pc.volume, 1e-9)

        assertNull(snapshot.states.getValue("tablet-1").song)
    }

    @Test
    fun `the commands the watch writes are the ones in the sample file`() {
        val samples = JsonParser.parseString(sample("watch-commands.json")).asJsonObject
        fun expected(name: String): JsonObject = samples.getAsJsonObject(name)
        fun written(target: String, command: PlayerCommand): JsonObject = JsonParser.parseString(LinkCodec.command(target, command)).asJsonObject

        assertEquals(expected("toggle"), written("local", PlayerCommand.Toggle))
        assertEquals(expected("next"), written("hub", PlayerCommand.Next))
        assertEquals(expected("prev"), written("hub", PlayerCommand.Prev))
        assertEquals(expected("toggleShuffle"), written("local", PlayerCommand.ToggleShuffle))
        assertEquals(expected("seek"), written("hub", PlayerCommand.Seek(95.5)))
        assertEquals(expected("setVolume"), written("hub", PlayerCommand.SetVolume(0.64)))
        assertEquals(expected("setRepeatMode"), written("local", PlayerCommand.SetRepeatMode(RepeatMode.ALL)))
        assertEquals(expected("playAlbum"), written("local", PlayerCommand.PlayMedia(MediaKind.ALBUM, "al-77", songId = "s-4412", mode = PlayMode.NOW)))
        assertEquals(expected("playSongNext"), written("local", PlayerCommand.PlayMedia(MediaKind.SONG, "s-9001", mode = PlayMode.NEXT)))
        assertEquals("every command of the sample file is covered", 9, samples.size())
    }
}
