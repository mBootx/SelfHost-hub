package com.selfhosthub.wear.service.tile

import com.selfhosthub.wear.core.DeviceState
import com.selfhosthub.wear.core.DeviceSummary
import com.selfhosthub.wear.core.LinkProtocol
import com.selfhosthub.wear.core.PlayerCommand
import com.selfhosthub.wear.core.RemoteSong
import com.selfhosthub.wear.core.RepeatMode
import com.selfhosthub.wear.service.link.LinkStatus
import com.selfhosthub.wear.service.link.LinkUiState
import com.selfhosthub.wear.service.link.PlayerSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun playing(title: String = "Neon Rivers", artist: String = "Halcyon Drive", isPlaying: Boolean = true): LinkUiState {
    val song = RemoteSong("s1", title, artist, null, null, null, 200.0)
    val player = DeviceState(song, isPlaying, 10.0, 200.0, false, RepeatMode.OFF, 1.0)
    return LinkUiState(
        status = LinkStatus.CONNECTED,
        devices = listOf(DeviceSummary(LinkProtocol.PHONE_ID, "Galaxy S25", "android")),
        players = mapOf(LinkProtocol.PHONE_ID to PlayerSnapshot(player, 0)),
        targetId = LinkProtocol.PHONE_ID
    )
}

class NowPlayingTileTest {
    @Test
    fun `the tile shows the song, its artist, and the three buttons`() {
        val content = TileContent.of(playing())
        assertEquals("Neon Rivers", content.title)
        assertEquals("Halcyon Drive", content.subtitle)
        assertTrue(content.playing)
        assertTrue(content.controls)
        assertFalse(TileContent.of(playing(isPlaying = false)).playing)
    }

    @Test
    fun `nothing playing, or no link with the phone, shows no buttons and says so`() {
        val idle = TileContent.of(LinkUiState(status = LinkStatus.CONNECTED))
        assertEquals("Rien en lecture", idle.title)
        assertFalse(idle.controls)
        val closed = TileContent.of(playing().copy(status = LinkStatus.PHONE_APP_CLOSED))
        assertEquals("Appli fermée", closed.subtitle)
        assertFalse(closed.controls)
    }

    @Test
    fun `a song without an artist shows the player's name instead`() {
        assertEquals("Galaxy S25", TileContent.of(playing(artist = "")).subtitle)
    }

    @Test
    fun `each button sends its command, anything else sends nothing`() {
        assertEquals(PlayerCommand.Prev, TileClicks.commandFor(TileClicks.PREVIOUS))
        assertEquals(PlayerCommand.Toggle, TileClicks.commandFor(TileClicks.TOGGLE))
        assertEquals(PlayerCommand.Next, TileClicks.commandFor(TileClicks.NEXT))
        assertNull(TileClicks.commandFor("open"))
        assertNull(TileClicks.commandFor(""))
        assertNull(TileClicks.commandFor(null))
    }
}
