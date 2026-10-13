package com.selfhosthub.wear.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val MINUTE = 60_000L

class AutoOpenPolicyTest {
    private val prefs = MemoryWatchPrefs()
    private val policy = AutoOpenPolicy(prefs)

    @Test
    fun `music starting opens the player once, not again while it plays`() {
        assertTrue(policy.onState(playing = true, now = 0, appVisible = false))
        assertFalse(policy.onState(playing = true, now = 30_000, appVisible = false))
        assertFalse(policy.onState(playing = true, now = 4 * MINUTE, appVisible = false))
    }

    @Test
    fun `a pause and a resume soon after do not open it again`() {
        policy.onState(playing = true, now = 0, appVisible = false)
        policy.onState(playing = false, now = 10 * MINUTE, appVisible = false)
        assertFalse(policy.onState(playing = true, now = 11 * MINUTE, appVisible = false))
    }

    @Test
    fun `music starting after a quiet spell of three minutes opens it again`() {
        policy.onState(playing = true, now = 0, appVisible = false)
        policy.onState(playing = false, now = 10 * MINUTE, appVisible = false)
        assertFalse(policy.onState(playing = false, now = 12 * MINUTE, appVisible = false))
        assertTrue(policy.onState(playing = true, now = 13 * MINUTE, appVisible = false))
    }

    @Test
    fun `nothing opens over the app already on screen, or with the setting off`() {
        assertFalse(policy.onState(playing = true, now = 0, appVisible = true))
        val off = AutoOpenPolicy(MemoryWatchPrefs(autoLaunch = false))
        assertFalse(off.onState(playing = true, now = 0, appVisible = false))
    }

    @Test
    fun `the app process starting again while music plays does not reopen it`() {
        policy.onState(playing = true, now = 0, appVisible = false)
        // A new process: a new policy, the same preferences.
        val again = AutoOpenPolicy(prefs)
        assertFalse(again.onState(playing = true, now = 2 * MINUTE, appVisible = false))
    }

    @Test
    fun `the time of the last music heard is kept, also when it stops`() {
        policy.onState(playing = true, now = 5 * MINUTE, appVisible = false)
        assertEquals(5 * MINUTE, prefs.lastPlayingAt)
        policy.onState(playing = false, now = 9 * MINUTE, appVisible = false)
        assertEquals(9 * MINUTE, prefs.lastPlayingAt)
        assertFalse(prefs.wasPlaying)
        policy.onState(playing = false, now = 20 * MINUTE, appVisible = false)
        assertEquals(9 * MINUTE, prefs.lastPlayingAt)
    }
}
