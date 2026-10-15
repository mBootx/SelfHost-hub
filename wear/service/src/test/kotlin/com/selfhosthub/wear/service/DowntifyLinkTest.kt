package com.selfhosthub.wear.service

import com.google.gson.JsonParser
import com.selfhosthub.wear.core.DowntifyProtocol
import com.selfhosthub.wear.core.DowntifySong
import com.selfhosthub.wear.service.link.DowntifyLink
import com.selfhosthub.wear.service.link.DowntifySearch
import java.io.IOException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val RESULTS =
    """{"v":1,"id":"r1","ok":true,"songs":[{"id":"yt-1","title":"Breezeblocks","artist":"alt-J","album":"An Awesome Wave","duration":227}]}"""

@OptIn(ExperimentalCoroutinesApi::class)
class DowntifyLinkTest {
    private val transport = FakeTransport()
    private var counter = 0
    private fun link(search: Long = 5_000, download: Long = 3_000) = DowntifyLink(transport, search, download, newId = { "r${++counter}" })

    @Test
    fun `a search goes to the phone and the songs it answers with come back`() = runTest {
        val link = link()
        transport.onSend = { sent -> if (sent.path == DowntifyProtocol.SEARCH_PATH) link.onMessage(DowntifyProtocol.RESULTS_PATH, RESULTS.toByteArray()) }
        val outcome = link.search("  alt-J ")
        assertEquals(DowntifySearch.Found(listOf(DowntifySong("yt-1", "Breezeblocks", "alt-J", "An Awesome Wave", 227.0))), outcome)
        val sent = transport.sent.single()
        assertEquals("phone-1", sent.nodeId)
        assertEquals(DowntifyProtocol.SEARCH_PATH, sent.path)
        val body = JsonParser.parseString(sent.text).asJsonObject
        assertEquals("r1", body.get("id").asString)
        assertEquals("alt-J", body.get("query").asString)
    }

    @Test
    fun `an empty query asks nobody`() = runTest {
        assertEquals(DowntifySearch.Found(emptyList()), link().search("   "))
        assertTrue(transport.sent.isEmpty())
    }

    @Test
    fun `the phone saying Downtify is not connected reaches the screen in its words`() = runTest {
        val link = link()
        transport.onSend = {
            link.onMessage(DowntifyProtocol.RESULTS_PATH, """{"v":1,"id":"r1","ok":false,"error":"Downtify n’est pas connecté sur le téléphone"}""".toByteArray())
        }
        assertEquals(DowntifySearch.Failed("Downtify n’est pas connecté sur le téléphone"), link.search("x"))
    }

    @Test
    fun `with no phone connected it says so and sends nothing`() = runTest {
        transport.nodes = emptyList()
        assertEquals(DowntifySearch.Failed(DowntifyLink.NO_PHONE), link().search("x"))
        transport.nodes = listOf("phone-1")
        transport.nodesError = IOException("data layer down")
        assertEquals(DowntifySearch.Failed(DowntifyLink.NO_PHONE), link().search("x"))
        assertTrue(transport.sent.isEmpty())
    }

    @Test
    fun `a message that cannot be sent is said, and a phone that never answers times out`() = runTest {
        transport.sendError = IOException("no route")
        assertEquals(DowntifySearch.Failed(DowntifyLink.NOT_SENT), link().search("x"))
        transport.sendError = null
        var outcome: DowntifySearch? = null
        val link = link(search = 5_000)
        val job = launch { outcome = link.search("x") }
        runCurrent()
        advanceTimeBy(4_000)
        assertEquals(null, outcome)
        advanceTimeBy(1_500)
        job.join()
        assertEquals(DowntifySearch.Failed(DowntifyLink.NO_ANSWER), outcome)
    }

    @Test
    fun `an answer to another question, or to none, is not taken for this one`() = runTest {
        val link = link()
        transport.onSend = {
            link.onMessage(DowntifyProtocol.RESULTS_PATH, """{"v":1,"id":"other","ok":true,"songs":[{"id":"x","title":"Autre","artist":"A"}]}""".toByteArray())
            link.onMessage(DowntifyProtocol.RESULTS_PATH, RESULTS.toByteArray())
        }
        val found = link.search("x") as DowntifySearch.Found
        assertEquals("yt-1", found.songs.single().id)
        // Late and stray answers change nothing.
        link.onMessage(DowntifyProtocol.RESULTS_PATH, RESULTS.toByteArray())
        link.onMessage(DowntifyProtocol.RESULTS_PATH, "garbage".toByteArray())
    }

    @Test
    fun `a download is answered by the phone that it was asked for`() = runTest {
        val link = link()
        transport.onSend = { sent ->
            if (sent.path == DowntifyProtocol.DOWNLOAD_PATH) link.onMessage(DowntifyProtocol.QUEUED_PATH, """{"v":1,"id":"r1","songId":"yt-1","ok":true}""".toByteArray())
        }
        val done = link.download("yt-1")
        assertTrue(done.ok)
        assertEquals(DowntifyProtocol.DOWNLOAD_PATH, transport.sent.single().path)
        assertEquals("yt-1", JsonParser.parseString(transport.sent.single().text).asJsonObject.get("songId").asString)
    }

    @Test
    fun `a refused download says why, and silence is a failure too`() = runTest {
        val link = link(download = 2_000)
        transport.onSend = { link.onMessage(DowntifyProtocol.QUEUED_PATH, """{"v":1,"id":"r1","songId":"yt-1","ok":false,"message":"Relancez la recherche"}""".toByteArray()) }
        val refused = link.download("yt-1")
        assertFalse(refused.ok)
        assertEquals("Relancez la recherche", refused.message)
        transport.onSend = null
        var silent: com.selfhosthub.wear.service.link.DowntifyDownload? = null
        val job = launch { silent = link.download("yt-1") }
        runCurrent()
        advanceTimeBy(2_500)
        job.join()
        assertFalse(silent!!.ok)
        assertEquals(DowntifyLink.NO_ANSWER, silent!!.message)
    }
}
