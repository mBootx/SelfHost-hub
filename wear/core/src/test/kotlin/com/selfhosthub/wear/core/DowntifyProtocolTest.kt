package com.selfhosthub.wear.core

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun sample(name: String): String =
    checkNotNull(DowntifyProtocolTest::class.java.getResourceAsStream("/$name")) { "the shared sample $name is missing" }.readBytes().toString(Charsets.UTF_8).trim()

class DowntifyProtocolTest {
    @Test
    fun `the results the phone sends (the shared sample) are read`() {
        val reply = DowntifyCodec.parse(DowntifyProtocol.RESULTS_PATH, sample("downtify-results.json")) as DowntifyReply.Results
        assertEquals("r1", reply.requestId)
        assertEquals(2, reply.songs.size)
        assertEquals(DowntifySong("yt-1", "Breezeblocks", "alt-J", "An Awesome Wave", 227.0), reply.songs[0])
        assertEquals(DowntifySong("yt-2", "Tessellate", "alt-J, Invité", null, 183.0), reply.songs[1])
    }

    @Test
    fun `the phone saying it cannot search is read, with its reason`() {
        val reply = DowntifyCodec.parse(DowntifyProtocol.RESULTS_PATH, sample("downtify-failure.json")) as DowntifyReply.Failure
        assertEquals("r1", reply.requestId)
        assertEquals("Downtify n’est pas connecté sur le téléphone", reply.message)
    }

    @Test
    fun `the answer to a download is read`() {
        val reply = DowntifyCodec.parse(DowntifyProtocol.QUEUED_PATH, sample("downtify-queued.json")) as DowntifyReply.Queued
        assertEquals(DowntifyReply.Queued("r2", "yt-1", true, null), reply)
        val refused = DowntifyCodec.parse(DowntifyProtocol.QUEUED_PATH, """{"v":1,"id":"r3","songId":"yt-9","ok":false,"message":"Relancez la recherche"}""") as DowntifyReply.Queued
        assertEquals(false, refused.ok)
        assertEquals("Relancez la recherche", refused.message)
    }

    @Test
    fun `what the watch sends is what the phone reads`() {
        val search = JsonParser.parseString(DowntifyCodec.searchRequest("a1", "  alt-J ")).asJsonObject
        assertEquals(1, search.get("v").asInt)
        assertEquals("a1", search.get("id").asString)
        assertEquals("alt-J", search.get("query").asString)
        val download = JsonParser.parseString(DowntifyCodec.downloadRequest("a2", "yt-2")).asJsonObject
        assertEquals("yt-2", download.get("songId").asString)
        // The phone cuts a query at 120 characters, and so does the watch before sending it.
        assertEquals(120, JsonParser.parseString(DowntifyCodec.searchRequest("a3", "x".repeat(400))).asJsonObject.get("query").asString.length)
    }

    @Test
    fun `nothing that is not a well formed answer of ours is taken for one`() {
        assertNull(DowntifyCodec.parse(DowntifyProtocol.RESULTS_PATH, "garbage"))
        assertNull(DowntifyCodec.parse(DowntifyProtocol.RESULTS_PATH, """{"v":2,"id":"r","ok":true,"songs":[]}"""))
        assertNull(DowntifyCodec.parse(DowntifyProtocol.RESULTS_PATH, """{"v":1,"ok":true,"songs":[]}"""))
        assertNull(DowntifyCodec.parse(DowntifyProtocol.QUEUED_PATH, """{"v":1,"id":"r","ok":true}"""))
        assertNull(DowntifyCodec.parse("/selfhost/downtify/other", sample("downtify-results.json")))
    }

    @Test
    fun `songs without an id are dropped, a missing list is an empty one, and no more than twelve are kept`() {
        val songs = (1..20).joinToString(",") { """{"id":"s$it","title":"T$it","artist":"A"}""" }
        val many = DowntifyCodec.parse(DowntifyProtocol.RESULTS_PATH, """{"v":1,"id":"r","ok":true,"songs":[{"title":"sans id"},$songs]}""") as DowntifyReply.Results
        assertEquals(12, many.songs.size)
        assertEquals("s1", many.songs.first().id)
        val none = DowntifyCodec.parse(DowntifyProtocol.RESULTS_PATH, """{"v":1,"id":"r","ok":true}""") as DowntifyReply.Results
        assertTrue(none.songs.isEmpty())
    }
}
