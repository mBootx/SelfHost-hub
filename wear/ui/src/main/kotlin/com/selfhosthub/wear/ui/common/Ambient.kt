package com.selfhosthub.wear.ui.common

/**
 * Whether the watch is in ambient mode (the always-on display) and what that screen can do. `tick` moves on each
 * system update of the ambient screen, about once a minute, so that what shows time follows even when nothing else
 * changed.
 */
data class AmbientState(
    val isAmbient: Boolean = false,
    /** The screen needs burn-in protection: no large bright areas, and the picture moves a little now and then. */
    val burnInProtection: Boolean = false,
    /** The ambient screen has no anti-aliasing and few colours. */
    val lowBit: Boolean = false,
    val tick: Long = 0
)

/**
 * How the ambient screen is kept cheap and safe for the display: it redraws at most once a second whatever arrives,
 * and when burn-in protection is on the content is shifted by a few pixels each minute so that no pixel stays lit.
 */
object AmbientPolicy {
    /** The longest the ambient screen waits between two redraws. */
    const val MIN_REDRAW_INTERVAL_MS = 1_000L

    /** The offsets the content cycles through, in dp, one step per minute. */
    private val shifts = listOf(0 to 0, 3 to 1, 0 to 3, -3 to 1, -2 to -2, 2 to -2)

    fun shiftFor(minuteOfDay: Long, burnInProtection: Boolean): Pair<Int, Int> =
        if (burnInProtection) shifts[(minuteOfDay % shifts.size).toInt().coerceAtLeast(0)] else 0 to 0

    /** Whether enough time has passed since `lastRedrawAt` to draw again. */
    fun shouldRedraw(now: Long, lastRedrawAt: Long): Boolean = now - lastRedrawAt >= MIN_REDRAW_INTERVAL_MS
}
