package com.selfhosthub.wear.core

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SubsonicAuthTest {
    @Test
    fun `the token is the md5 of the password and the salt, as in the Subsonic documentation`() {
        // The example of the API documentation: password "sesame" with the salt "c19b2d".
        assertEquals("26719a1196d2a940705a59634eb18eab", SubsonicAuth.token("sesame", "c19b2d"))
    }

    @Test
    fun `salts are twelve hex characters and differ`() {
        val a = SubsonicAuth.newSalt()
        val b = SubsonicAuth.newSalt()
        assertTrue(a.matches(Regex("[0-9a-f]{12}")))
        assertTrue(a != b)
    }

    @Test
    fun `a login carries the six query parameters of every call`() {
        val login = NavidromeLogin("https://music.example.org/", "maxime", "abc123", "0".repeat(32))
        assertEquals("https://music.example.org", login.baseUrl)
        assertEquals(listOf("u", "t", "s", "v", "c", "f"), login.queryParameters().map { it.first })
        assertEquals("json", login.queryParameters().last().second)
    }

    @Test
    fun `two logins are the same account when the server and user match, not the secret`() {
        val a = NavidromeLogin("https://Music.example.org/", "maxime", "s1", "a".repeat(32))
        val b = NavidromeLogin("https://music.example.org", "maxime", "s2", "b".repeat(32))
        assertTrue(a.sameAccount(b))
        assertFalse(a.sameAccount(NavidromeLogin("https://music.example.org", "alice", "s1", "a".repeat(32))))
        assertFalse(a.sameAccount(null))
    }
}

class LinkCodecTest {
    private fun snapshot(json: String): Snapshot = (LinkCodec.parse(LinkProtocol.SNAPSHOT_PATH, json) as LinkMessage.Snap).snapshot

    @Test
    fun `a snapshot is read as the phone sends it`() {
        val s = snapshot(
            """{"v":1,"phone":"Pixel","pc":{"state":"connected","name":"PC de Max"},
               "devices":[{"deviceId":"local","deviceName":"Pixel","platform":"mobile"},{"deviceId":"hub","deviceName":"PC de Max","platform":"desktop"}],
               "states":{"local":{"song":{"id":"s1","title":"Titre","artist":"Artiste","album":"Album","albumId":"a1","coverArt":"al-1","duration":215},
                         "isPlaying":true,"currentTime":42.5,"duration":215,"shuffle":true,"repeatMode":"all","volume":0.6},
                         "hub":{"song":null,"isPlaying":false,"currentTime":0,"duration":0,"shuffle":false,"repeatMode":"off","volume":1}}}"""
        )
        assertEquals("Pixel", s.phoneName)
        assertEquals(PcLink(PcState.CONNECTED, "PC de Max", null), s.pc)
        assertEquals(listOf(DeviceSummary("local", "Pixel", "mobile"), DeviceSummary("hub", "PC de Max", "desktop")), s.devices)
        val phone = s.states.getValue("local")
        assertEquals(RemoteSong("s1", "Titre", "Artiste", "Album", "a1", "al-1", 215.0), phone.song)
        assertTrue(phone.isPlaying)
        assertEquals(42.5, phone.currentTime, 0.0)
        assertEquals(215.0, phone.duration, 0.0)
        assertTrue(phone.shuffle)
        assertEquals(RepeatMode.ALL, phone.repeatMode)
        assertEquals(0.6, phone.volume, 1e-9)
        assertNull(s.states.getValue("hub").song)
    }

    @Test
    fun `a state with nothing playing, odd numbers or unknown modes is read with safe values`() {
        val s = snapshot(
            """{"v":1,"devices":[{"deviceId":"local","deviceName":"P"}],
               "states":{"local":{"song":null,"isPlaying":"yes","currentTime":-5,"volume":7,"repeatMode":"sideways"}}}"""
        )
        val state = s.states.getValue("local")
        assertNull(state.song)
        assertFalse(state.isPlaying)
        assertEquals(0.0, state.currentTime, 0.0)
        assertEquals(1.0, state.volume, 0.0)
        assertEquals(RepeatMode.OFF, state.repeatMode)
    }

    @Test
    fun `a device without an id is skipped, one without a name takes its id`() {
        val s = snapshot("""{"v":1,"devices":[{"deviceName":"nameless"},{"deviceId":""},{"deviceId":"p1"},"junk"],"states":{}}""")
        assertEquals(listOf(DeviceSummary("p1", "p1", "mobile")), s.devices)
    }

    @Test
    fun `the phone's name falls back on its entry in the list, then on a default`() {
        assertEquals("Pixel", snapshot("""{"v":1,"devices":[{"deviceId":"local","deviceName":"Pixel"}],"states":{}}""").phoneName)
        assertEquals("Téléphone", snapshot("""{"v":1,"devices":[],"states":{}}""").phoneName)
    }

    @Test
    fun `how the phone stands with the PC is read, and anything unknown means not connected`() {
        fun pc(json: String) = snapshot("""{"v":1,"devices":[],"states":{},"pc":$json}""").pc
        assertEquals(PcLink(PcState.ERROR, null, "PC introuvable"), pc("""{"state":"error","message":"PC introuvable"}"""))
        assertEquals(PcLink(PcState.OFF, null, null), pc("""{"state":"off"}"""))
        assertEquals(PcLink(PcState.UNPAIRED, null, null), pc("""{"state":"unpaired"}"""))
        assertEquals(PcLink(PcState.CONNECTING, null, null), pc("""{"state":"connecting"}"""))
        assertEquals(PcLink(PcState.DISCONNECTED, null, null), pc("""{"state":"something new"}"""))
        assertEquals(PcLink(PcState.DISCONNECTED, null, null), snapshot("""{"v":1,"devices":[],"states":{}}""").pc)
    }

    @Test
    fun `a snapshot of another version is not read`() {
        assertEquals(LinkMessage.UnsupportedVersion(2), LinkCodec.parse(LinkProtocol.SNAPSHOT_PATH, """{"v":2,"devices":[],"states":{}}"""))
        assertEquals(LinkMessage.UnsupportedVersion(null), LinkCodec.parse(LinkProtocol.SNAPSHOT_PATH, """{"devices":[],"states":{}}"""))
        assertEquals(LinkMessage.UnsupportedVersion(null), LinkCodec.parse(LinkProtocol.SNAPSHOT_PATH, """{"v":"one"}"""))
    }

    @Test
    fun `closed means closed, and what is not a snapshot is unknown`() {
        assertEquals(LinkMessage.Closed, LinkCodec.parse(LinkProtocol.CLOSED_PATH, """{"v":1}"""))
        assertEquals(LinkMessage.Closed, LinkCodec.parse(LinkProtocol.CLOSED_PATH, "whatever"))
        assertTrue(LinkCodec.parse(LinkProtocol.SNAPSHOT_PATH, "not json") is LinkMessage.Unknown)
        assertTrue(LinkCodec.parse(LinkProtocol.SNAPSHOT_PATH, "[1,2]") is LinkMessage.Unknown)
        assertEquals("/selfhost/link/other", (LinkCodec.parse("/selfhost/link/other", "{}") as LinkMessage.Unknown).path)
    }

    @Test
    fun `the request names the version and nothing else`() {
        val obj = JsonParser.parseString(LinkCodec.request()).asJsonObject
        assertEquals(1, obj.get("v").asInt)
        assertEquals(1, obj.size())
    }

    @Test
    fun `commands carry the phone's own action names and payloads`() {
        fun json(target: String, command: PlayerCommand) = JsonParser.parseString(LinkCodec.command(target, command)).asJsonObject

        assertEquals(1, json("local", PlayerCommand.Toggle).get("v").asInt)
        assertEquals("toggle", json("local", PlayerCommand.Toggle).get("action").asString)
        assertEquals("hub", json("hub", PlayerCommand.Next).get("targetId").asString)
        assertFalse(json("hub", PlayerCommand.Next).has("payload"))
        assertEquals(93.0, json("hub", PlayerCommand.Seek(93.0)).getAsJsonObject("payload").get("seconds").asDouble, 0.0)
        // The phone's volume runs from 0 to 1, whatever the watch shows.
        assertEquals(1.0, json("hub", PlayerCommand.SetVolume(4.0)).getAsJsonObject("payload").get("volume").asDouble, 0.0)
        assertEquals("one", json("local", PlayerCommand.SetRepeatMode(RepeatMode.ONE)).getAsJsonObject("payload").get("mode").asString)

        val play = json("local", PlayerCommand.PlayMedia(MediaKind.ALBUM, "al-1", index = 3, mode = PlayMode.NEXT))
        assertEquals("playMedia", play.get("action").asString)
        val payload = play.getAsJsonObject("payload")
        assertEquals("album", payload.get("kind").asString)
        assertEquals("al-1", payload.get("id").asString)
        assertEquals(3, payload.get("index").asInt)
        assertEquals("next", payload.get("mode").asString)
    }

    @Test
    fun `the repeat button cycles off, all, one`() {
        assertEquals(RepeatMode.ALL, RepeatMode.OFF.next())
        assertEquals(RepeatMode.ONE, RepeatMode.ALL.next())
        assertEquals(RepeatMode.OFF, RepeatMode.ONE.next())
    }
}
