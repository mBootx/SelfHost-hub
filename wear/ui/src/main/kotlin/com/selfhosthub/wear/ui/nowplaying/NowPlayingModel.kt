package com.selfhosthub.wear.ui.nowplaying

import com.selfhosthub.wear.core.RepeatMode
import com.selfhosthub.wear.core.progressFraction
import com.selfhosthub.wear.service.link.LinkStatus
import com.selfhosthub.wear.service.link.LinkUiState

/** What the Now Playing screens show, worked out from the phone's state at one moment. */
data class NowPlayingUi(
    val status: LinkStatus = LinkStatus.CONNECTING,
    /** The player the controls act on, when the phone has told the watch its name. */
    val playerName: String? = null,
    /** True while the watch follows whichever player is playing rather than one picked by hand. */
    val following: Boolean = true,
    val songId: String? = null,
    val title: String? = null,
    val artist: String? = null,
    val album: String? = null,
    val coverArt: String? = null,
    val isPlaying: Boolean = false,
    val position: Double = 0.0,
    val duration: Double = 0.0,
    val shuffle: Boolean = false,
    val repeat: RepeatMode = RepeatMode.OFF,
    /** 0 to 1, as the players report it. */
    val volume: Double = 1.0
) {
    val hasSong: Boolean get() = title != null
    val connected: Boolean get() = status == LinkStatus.CONNECTED
    val progress: Float get() = progressFraction(position, duration)

    /** A short line for under the artist when there is something to say about the link with the phone. */
    val statusLine: String? get() = status.short
}

fun LinkUiState.toNowPlaying(now: Long): NowPlayingUi {
    val snapshot = target
    val player = snapshot?.state
    val song = player?.song
    return NowPlayingUi(
        status = status,
        playerName = targetName,
        following = manualTargetId == null,
        songId = song?.id,
        title = song?.title?.ifBlank { null },
        artist = song?.artist?.ifBlank { null },
        album = song?.album,
        coverArt = song?.coverArt,
        isPlaying = player?.isPlaying == true,
        position = snapshot?.positionAt(now) ?: 0.0,
        duration = (player?.duration?.takeIf { it > 0 } ?: song?.duration) ?: 0.0,
        shuffle = player?.shuffle == true,
        repeat = player?.repeatMode ?: RepeatMode.OFF,
        volume = player?.volume ?: 1.0
    )
}

/** The arithmetic of the seek bar and the crown. */
object ControlMath {
    /** Where a touch at `x` pixels of a bar `width` pixels wide points to, from 0 to 1. */
    fun fractionAt(x: Float, width: Float): Float = if (width <= 0f) 0f else (x / width).coerceIn(0f, 1f)

    /** The position in seconds for a fraction of a song of `duration` seconds. */
    fun secondsFor(fraction: Float, duration: Double): Double = (fraction.coerceIn(0f, 1f) * duration).coerceAtLeast(0.0)

    /**
     * Turns what the crown reports (pixels of scrolling, which come in small pieces) into whole volume steps:
     * returns the steps to apply (positive turns up) and what is left over to carry to the next event.
     */
    fun crownSteps(carried: Float, pixels: Float, pixelsPerStep: Float = 40f): Pair<Int, Float> {
        val total = carried + pixels
        val steps = (total / pixelsPerStep).toInt()
        return steps to (total - steps * pixelsPerStep)
    }

    /** The volume after `steps` of 4 %, kept between 0 and 1. */
    fun volumeAfter(volume: Double, steps: Int, step: Double = 0.04): Double = (volume + steps * step).coerceIn(0.0, 1.0)

    fun volumePercent(volume: Double): Int = Math.round(volume.coerceIn(0.0, 1.0) * 100).toInt()
}
