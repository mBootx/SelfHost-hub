package com.selfhosthub.wear.ui

import com.selfhosthub.wear.core.DeviceState
import com.selfhosthub.wear.core.DeviceSummary
import com.selfhosthub.wear.core.RemoteSong
import com.selfhosthub.wear.core.RepeatMode
import com.selfhosthub.wear.service.link.LinkStatus
import com.selfhosthub.wear.service.link.LinkUiState
import com.selfhosthub.wear.service.link.PlayerSnapshot
import com.selfhosthub.wear.ui.common.AmbientPolicy
import com.selfhosthub.wear.ui.nowplaying.ControlMath
import com.selfhosthub.wear.ui.nowplaying.toNowPlaying
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ControlMathTest {
    @Test
    fun `a touch on the seek bar points to a fraction of it, kept inside`() {
        assertEquals(0.5f, ControlMath.fractionAt(150f, 300f), 0f)
        assertEquals(0f, ControlMath.fractionAt(-20f, 300f), 0f)
        assertEquals(1f, ControlMath.fractionAt(900f, 300f), 0f)
        assertEquals(0f, ControlMath.fractionAt(10f, 0f), 0f)
    }

    @Test
    fun `a fraction of the song is a position in seconds`() {
        assertEquals(113.5, ControlMath.secondsFor(0.5f, 227.0), 1e-9)
        assertEquals(0.0, ControlMath.secondsFor(-1f, 227.0), 0.0)
        assertEquals(227.0, ControlMath.secondsFor(7f, 227.0), 0.0)
        assertEquals(0.0, ControlMath.secondsFor(0.5f, 0.0), 0.0)
    }

    @Test
    fun `the crown's small pieces add up to whole steps and the rest is carried`() {
        assertEquals(0 to 30f, ControlMath.crownSteps(0f, 30f))
        assertEquals(1 to 5f, ControlMath.crownSteps(30f, 15f))
        assertEquals(2 to 10f, ControlMath.crownSteps(0f, 90f))
        // Turning the other way gives negative steps and a negative remainder.
        assertEquals(-2 to -5f, ControlMath.crownSteps(0f, -85f))
        // A back-and-forth does not creep: the carried remainder cancels.
        val (steps, rest) = ControlMath.crownSteps(30f, -30f)
        assertEquals(0, steps)
        assertEquals(0f, rest, 0f)
    }

    @Test
    fun `the volume moves four percent a step and stays between 0 and 1`() {
        assertEquals(0.54, ControlMath.volumeAfter(0.5, 1), 1e-9)
        assertEquals(0.42, ControlMath.volumeAfter(0.5, -2), 1e-9)
        assertEquals(1.0, ControlMath.volumeAfter(0.98, 5), 0.0)
        assertEquals(0.0, ControlMath.volumeAfter(0.02, -5), 0.0)
        assertEquals(62, ControlMath.volumePercent(0.62))
        assertEquals(100, ControlMath.volumePercent(7.0))
        assertEquals(0, ControlMath.volumePercent(-1.0))
    }
}

class AmbientPolicyTest {
    @Test
    fun `without burn-in protection nothing moves`() {
        for (minute in 0L..20L) assertEquals(0 to 0, AmbientPolicy.shiftFor(minute, burnInProtection = false))
    }

    @Test
    fun `with burn-in protection the content moves a little each minute and comes back round`() {
        val shifts = (0L..5L).map { AmbientPolicy.shiftFor(it, burnInProtection = true) }
        assertEquals("six different places", 6, shifts.toSet().size)
        assertEquals(shifts[0], AmbientPolicy.shiftFor(6, burnInProtection = true))
        assertTrue("never more than a few dp from the centre", shifts.all { (x, y) -> kotlin.math.abs(x) <= 3 && kotlin.math.abs(y) <= 3 })
    }

    @Test
    fun `the ambient screen is redrawn at most once a second`() {
        assertFalse(AmbientPolicy.shouldRedraw(now = 1_500, lastRedrawAt = 1_000))
        assertTrue(AmbientPolicy.shouldRedraw(now = 2_000, lastRedrawAt = 1_000))
    }
}

class NowPlayingModelTest {
    private val song = RemoteSong("s1", "Titre", "Artiste", "Album", "a1", "al-1", 200.0)
    private fun connected(state: DeviceState?, manual: String? = null) = LinkUiState(
        status = LinkStatus.CONNECTED,
        phoneName = "Pixel",
        devices = listOf(DeviceSummary("local", "Pixel", "mobile"), DeviceSummary("hub", "PC", "desktop")),
        players = if (state != null) mapOf("hub" to PlayerSnapshot(state, 1_000)) else emptyMap(),
        manualTargetId = manual,
        targetId = "hub"
    )

    @Test
    fun `the screen shows the song, the position moved on since the last message, and the settings of the player`() {
        val ui = connected(DeviceState(song, true, 40.0, 200.0, true, RepeatMode.ALL, 0.3)).toNowPlaying(now = 11_000)
        assertEquals("Titre", ui.title)
        assertEquals("Artiste", ui.artist)
        assertEquals("PC", ui.playerName)
        assertEquals(50.0, ui.position, 1e-9)
        assertEquals(0.25f, ui.progress, 1e-6f)
        assertTrue(ui.shuffle && ui.isPlaying && ui.following)
        assertEquals(RepeatMode.ALL, ui.repeat)
        assertNull(ui.statusLine)
    }

    @Test
    fun `a paused song stays where it was`() {
        val ui = connected(DeviceState(song, false, 40.0, 200.0, false, RepeatMode.OFF, 1.0)).toNowPlaying(now = 60_000)
        assertEquals(40.0, ui.position, 0.0)
    }

    @Test
    fun `nothing playing, and a player chosen by hand`() {
        val ui = connected(null, manual = "hub").toNowPlaying(now = 0)
        assertFalse(ui.hasSong)
        assertFalse(ui.following)
        assertEquals(0f, ui.progress, 0f)
    }

    @Test
    fun `when the phone is not reachable the screen says why in a few words`() {
        assertEquals("Pas de téléphone", LinkUiState(status = LinkStatus.NO_PHONE).toNowPlaying(0).statusLine)
        assertEquals("Appli fermée", LinkUiState(status = LinkStatus.PHONE_APP_CLOSED).toNowPlaying(0).statusLine)
        assertEquals("Versions incompatibles", LinkUiState(status = LinkStatus.VERSION_MISMATCH).toNowPlaying(0).statusLine)
        assertEquals("Connexion…", LinkUiState().toNowPlaying(0).statusLine)
    }

    @Test
    fun `the player's name is the one the phone gave it`() {
        assertEquals("PC", connected(DeviceState(song, true, 0.0, 200.0, false, RepeatMode.OFF, 1.0)).toNowPlaying(0).playerName)
    }

    @Test
    fun `the length comes from the player's state, else from the song`() {
        val withState = connected(DeviceState(song, true, 0.0, 250.0, false, RepeatMode.OFF, 1.0)).toNowPlaying(1_000)
        assertEquals(250.0, withState.duration, 0.0)
        val withoutState = connected(DeviceState(song, true, 0.0, 0.0, false, RepeatMode.OFF, 1.0)).toNowPlaying(1_000)
        assertEquals(200.0, withoutState.duration, 0.0)
    }
}
