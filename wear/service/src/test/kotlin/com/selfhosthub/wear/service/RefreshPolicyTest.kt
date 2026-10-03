package com.selfhosthub.wear.service

import com.selfhosthub.wear.service.sync.RefreshPolicy
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RefreshPolicyTest {
    private val minute = 60_000L
    private val now = 10_000 * minute

    @Test
    fun `a library that never came is read at the next opening`() {
        assertTrue(RefreshPolicy.due(lastAttemptAt = null, lastSuccessAt = null, now = now))
    }

    @Test
    fun `a library read a moment ago is left alone`() {
        assertFalse(RefreshPolicy.due(lastAttemptAt = now - 10 * minute, lastSuccessAt = now - 10 * minute, now = now))
        assertFalse(RefreshPolicy.due(lastAttemptAt = now - 31 * minute, lastSuccessAt = now - 29 * minute, now = now))
    }

    @Test
    fun `an old library is read again`() {
        assertTrue(RefreshPolicy.due(lastAttemptAt = now - 31 * minute, lastSuccessAt = now - 31 * minute, now = now))
        assertTrue(RefreshPolicy.due(lastAttemptAt = now - 3 * 60 * minute, lastSuccessAt = now - 3 * 60 * minute, now = now))
    }

    @Test
    fun `a try that failed a moment ago is not repeated at every opening`() {
        assertFalse(RefreshPolicy.due(lastAttemptAt = now - 2 * minute, lastSuccessAt = null, now = now))
        assertFalse(RefreshPolicy.due(lastAttemptAt = now - 4 * minute, lastSuccessAt = now - 60 * minute, now = now))
    }

    @Test
    fun `but is tried again after a few minutes`() {
        assertTrue(RefreshPolicy.due(lastAttemptAt = now - 6 * minute, lastSuccessAt = null, now = now))
        assertTrue(RefreshPolicy.due(lastAttemptAt = now - 6 * minute, lastSuccessAt = now - 60 * minute, now = now))
    }
}
