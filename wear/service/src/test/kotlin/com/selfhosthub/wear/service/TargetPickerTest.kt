package com.selfhosthub.wear.service

import com.selfhosthub.wear.core.DeviceState
import com.selfhosthub.wear.core.DeviceSummary
import com.selfhosthub.wear.core.RemoteSong
import com.selfhosthub.wear.core.RepeatMode
import com.selfhosthub.wear.service.link.LinkLeases
import com.selfhosthub.wear.service.link.LinkSwitch
import com.selfhosthub.wear.service.link.PlayerSnapshot
import com.selfhosthub.wear.service.link.TargetPicker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TargetPickerTest {
    private val phone = DeviceSummary("local", "Pixel", "mobile")
    private val hub = DeviceSummary("hub", "PC", "desktop")
    private val tablet = DeviceSummary("tablet", "Tablette", "mobile")
    private val song = RemoteSong("s", "T", "A", null, null, null, 100.0)

    private fun playing(isPlaying: Boolean) = PlayerSnapshot(DeviceState(song, isPlaying, 0.0, 100.0, false, RepeatMode.OFF, 1.0), 0)

    @Test
    fun `a player picked by hand wins while it is there`() {
        val players = mapOf("local" to playing(true))
        assertEquals("hub", TargetPicker.pick(listOf(phone, hub), players, "hub", null, emptyMap()))
        // Gone: the choice no longer applies, and the watch follows what plays.
        assertEquals("local", TargetPicker.pick(listOf(phone), players, "hub", null, emptyMap()))
    }

    @Test
    fun `the player that is playing wins over the one used last`() {
        val players = mapOf("local" to playing(true), "hub" to playing(false))
        assertEquals("local", TargetPicker.pick(listOf(phone, hub), players, null, "hub", emptyMap()))
    }

    @Test
    fun `of two that play, the one that started last`() {
        val players = mapOf("local" to playing(true), "tablet" to playing(true), "hub" to playing(true))
        val since = mapOf("local" to 100L, "tablet" to 300L, "hub" to 200L)
        assertEquals("tablet", TargetPicker.pick(listOf(phone, hub, tablet), players, null, null, since))
    }

    @Test
    fun `with nothing playing it goes back to the last one used, then the phone, then the first`() {
        val none = emptyMap<String, PlayerSnapshot>()
        assertEquals("hub", TargetPicker.pick(listOf(phone, hub), none, null, "hub", emptyMap()))
        assertEquals("local", TargetPicker.pick(listOf(hub, phone), none, null, "gone", emptyMap()))
        assertEquals("hub", TargetPicker.pick(listOf(hub, tablet), none, null, null, emptyMap()))
        assertNull(TargetPicker.pick(emptyList(), none, null, null, emptyMap()))
    }
}

class LinkLeasesTest {
    private class FakeSwitch : LinkSwitch {
        var starts = 0
        var stops = 0

        override fun start() {
            starts++
        }

        override fun stop() {
            stops++
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After
    fun cancelScope() {
        scope.coroutineContext[Job]?.cancel()
    }

    @Test
    fun `keeping in touch starts with the first lease and stops a little after the last one is given back`() {
        val link = FakeSwitch()
        val leases = LinkLeases(link, scope, graceMs = 100)
        val a = leases.acquire()
        val b = leases.acquire()
        assertEquals(2, leases.holders)
        assertEquals(0, link.stops)

        a.close()
        a.close() // twice does not count twice
        assertEquals(1, leases.holders)
        Thread.sleep(200)
        assertEquals("still held by the second", 0, link.stops)

        b.close()
        assertEquals(0, leases.holders)
        assertEquals("not at once: there is a grace period", 0, link.stops)
        Thread.sleep(300)
        assertEquals(1, link.stops)
    }

    @Test
    fun `taking a lease again within the grace period keeps it going`() {
        val link = FakeSwitch()
        val leases = LinkLeases(link, scope, graceMs = 300)
        leases.acquire().close()
        val again = leases.acquire()
        Thread.sleep(500)
        assertEquals(0, link.stops)
        assertEquals(1, leases.holders)

        again.close()
        Thread.sleep(500)
        assertEquals(1, link.stops)
    }
}
