package com.selfhosthub.wear.core

import java.util.Locale

/** "3:07", or "1:02:03" past an hour. Negative and non-finite values show as 0:00. */
fun formatClock(seconds: Double): String {
    val total = if (seconds.isNaN() || seconds.isInfinite() || seconds < 0) 0L else seconds.toLong()
    val hours = total / 3600
    val minutes = (total % 3600) / 60
    val secs = total % 60
    return if (hours > 0) String.format(Locale.ROOT, "%d:%02d:%02d", hours, minutes, secs) else String.format(Locale.ROOT, "%d:%02d", minutes, secs)
}

/** A size the way the rest of the app writes it, in French: "12,4 Mo". */
fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes o"
    val units = listOf("Ko", "Mo", "Go")
    var value = bytes / 1024.0
    var unit = 0
    while (value >= 1024 && unit < units.lastIndex) {
        value /= 1024
        unit++
    }
    return String.format(Locale.FRANCE, if (value >= 100) "%.0f %s" else "%.1f %s", value, units[unit]).replace(' ', ' ').replace(' ', ' ')
}

/** The progress of a song as a fraction of its length, for a bar: 0 when the length is unknown. */
fun progressFraction(position: Double, duration: Double): Float {
    if (duration <= 0.0 || position.isNaN() || duration.isNaN()) return 0f
    return (position / duration).coerceIn(0.0, 1.0).toFloat()
}
