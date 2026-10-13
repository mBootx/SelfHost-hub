package com.selfhosthub.wear.service

import com.selfhosthub.wear.core.DeviceState
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.core.MemoryWatchPrefs
import com.selfhosthub.wear.core.RemoteSong
import com.selfhosthub.wear.core.RepeatMode
import com.selfhosthub.wear.service.link.LinkStatus
import com.selfhosthub.wear.service.link.LinkUiState
import com.selfhosthub.wear.service.link.PlayerSnapshot
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Test

private fun state(playing: Boolean, status: LinkStatus = LinkStatus.CONNECTED): LinkUiState {
    val song = RemoteSong("s1", "Titre", "Artiste", null, null, null, 200.0)
    val player = DeviceState(song, playing, 0.0, 200.0, false, RepeatMode.OFF, 1.0)
    return LinkUiState(status = status, players = mapOf(LinkProtocol.PHONE_ID to PlayerSnapshot(player, 0)), targetId = LinkProtocol.PHONE_ID)
}

@OptIn(ExperimentalCoroutinesApi::class)
class AutoOpenerTest {
    private val transport = FakeTransport()
    private var clock = 0L
    private var visible = false
    private val opener = AutoOpener(MemoryWatchPrefs(), transport, TestScope(UnconfinedTestDispatcher()), { visible }, { clock })
    private fun opens() = transport.sent.filter { it.path == LinkProtocol.OPEN_PATH }

    @Test
    fun `music starting asks the phone to open the player, once`() {
        opener.update(state(playing = false))
        opener.update(state(playing = true))
        clock += 30_000
        opener.update(state(playing = true))
        assertEquals(1, opens().size)
        assertEquals("phone-1", opens()[0].nodeId)
        assertEquals("{\"v\":1}", opens()[0].text)
    }

    @Test
    fun `music heard through a link that is not up does not count, and nothing is sent over the app on screen`() {
        opener.update(state(playing = true, status = LinkStatus.PHONE_APP_CLOSED))
        assertEquals(0, opens().size)
        visible = true
        opener.update(state(playing = true))
        assertEquals(0, opens().size)
    }

    @Test
    fun `without a phone around nothing breaks`() {
        transport.nodes = emptyList()
        opener.update(state(playing = true))
        assertEquals(0, opens().size)
        transport.nodes = listOf("phone-1")
        transport.sendError = IllegalStateException("gone")
        clock += 10 * 60_000
        opener.update(state(playing = false))
        clock += 10 * 60_000
        opener.update(state(playing = true))
        assertEquals(0, opens().size)
    }
}
