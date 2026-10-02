package com.selfhosthub.wear.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SetupCodecTest {
    private val login = NavidromeLogin("https://music.example.org", "maxime", "abc123", "26719a1196d2a940705a59634eb18eab")

    @Test
    fun `what the phone sends is read back unchanged`() {
        val setup = WatchSetup(login)
        assertEquals(setup, SetupCodec.decode(SetupCodec.encode(setup)))
    }

    @Test
    fun `the token is kept in lower case`() {
        val json = """{"v":1,"navidrome":{"url":"https://a.b","username":"u","salt":"s","token":"26719A1196D2A940705A59634EB18EAB"}}"""
        assertEquals("26719a1196d2a940705a59634eb18eab", SetupCodec.decode(json).navidrome.token)
    }

    @Test
    fun `a setup from an older phone build that still carries a PC is read without it`() {
        val json = """{"v":1,"navidrome":{"url":"https://a.b","username":"u","salt":"s","token":"26719a1196d2a940705a59634eb18eab"},"hub":{"hubId":"h","code":"ABCDEFGHJK"}}"""
        assertEquals("u", SetupCodec.decode(json).navidrome.username)
    }

    @Test
    fun `other versions and malformed messages are refused whole`() {
        fun refused(json: String) = assertThrows(SetupFormatException::class.java) { SetupCodec.decode(json) }
        refused("""{"v":2,"navidrome":{"url":"https://a.b","username":"u","salt":"s","token":"26719a1196d2a940705a59634eb18eab"}}""")
        refused("""{"navidrome":{"url":"https://a.b","username":"u","salt":"s","token":"26719a1196d2a940705a59634eb18eab"}}""")
        refused("not json")
        refused("[]")
        refused("""{"v":1}""")
        refused("""{"v":1,"hub":{"hubId":"h","code":"ABCDEFGHJK"}}""")
        refused("""{"v":1,"navidrome":{"url":"ftp://a.b","username":"u","salt":"s","token":"26719a1196d2a940705a59634eb18eab"}}""")
        refused("""{"v":1,"navidrome":{"url":"https://a.b","username":"u","salt":"s","token":"not-a-token"}}""")
        refused("""{"v":1,"navidrome":{"url":"https://a.b","username":"","salt":"s","token":"26719a1196d2a940705a59634eb18eab"}}""")
        refused("""{"v":1,"navidrome":{"url":"https://a.b","salt":"s","token":"26719a1196d2a940705a59634eb18eab"}}""")
    }

    @Test
    fun `memory store keeps and forgets`() {
        val store = MemorySetupStore()
        assertNull(store.load())
        store.save(WatchSetup(login))
        assertEquals(login, store.load()!!.navidrome)
        store.clear()
        assertNull(store.load())
    }
}

class PrivateAddressTest {
    @Test
    fun `home network addresses are private`() {
        for (host in listOf("192.168.1.20", "10.0.0.5", "172.16.0.1", "172.31.255.254", "169.254.3.4", "[fd12:3456::1]", "fe80::1", "navidrome", "nas.local", "musique.lan", "box.home.arpa")) {
            assertTrue(host, PrivateAddress.isPrivate(host))
        }
    }

    @Test
    fun `addresses of the internet are not`() {
        for (host in listOf("music.example.org", "8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.1.1", "11.0.0.1", "100.64.0.1", "2001:db8::1", "example.com")) {
            assertFalse(host, PrivateAddress.isPrivate(host))
        }
    }

    @Test
    fun `nothing is not an address`() {
        assertFalse(PrivateAddress.isPrivate(""))
        assertFalse(PrivateAddress.isPrivate("  "))
    }

    @Test
    fun `numbers that are not an IPv4 address do not pass for one`() {
        assertFalse(PrivateAddress.isPrivate("192.168.1.300.example.org"))
        assertFalse(PrivateAddress.isPrivate("10.0.0.256.com"))
    }
}

class FormattingTest {
    @Test
    fun `clock times`() {
        assertEquals("0:00", formatClock(0.0))
        assertEquals("0:09", formatClock(9.9))
        assertEquals("3:07", formatClock(187.0))
        assertEquals("1:02:03", formatClock(3723.0))
        assertEquals("0:00", formatClock(-4.0))
        assertEquals("0:00", formatClock(Double.NaN))
    }

    @Test
    fun `sizes are written in French`() {
        assertEquals("512 o", formatBytes(512))
        assertEquals("1,5 Ko", formatBytes(1536))
        assertEquals("12,4 Mo", formatBytes((12.4 * 1024 * 1024).toLong()))
        assertEquals("120 Mo", formatBytes(120L * 1024 * 1024))
        assertEquals("2,0 Go", formatBytes(2L * 1024 * 1024 * 1024))
    }

    @Test
    fun `progress is a fraction between 0 and 1`() {
        assertEquals(0f, progressFraction(10.0, 0.0), 0f)
        assertEquals(0.5f, progressFraction(50.0, 100.0), 0f)
        assertEquals(1f, progressFraction(150.0, 100.0), 0f)
        assertEquals(0f, progressFraction(-5.0, 100.0), 0f)
    }
}
