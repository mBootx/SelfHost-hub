package com.selfhosthub.wear.ui.nowplaying

import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.selfhosthub.wear.core.MediaKind
import com.selfhosthub.wear.core.PlayMode
import com.selfhosthub.wear.core.PlayerCommand
import com.selfhosthub.wear.data.ArtworkSize
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.service.link.LinkUiState
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.AmbientState
import com.selfhosthub.wear.ui.common.rememberCover
import com.selfhosthub.wear.ui.common.rememberCoverLook
import com.selfhosthub.wear.ui.common.rememberHaptics
import com.selfhosthub.wear.ui.common.rememberLowResRotary
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch

/** Emits the current time now and then every `periodMs`: what moves a progress bar between two messages from the phone. */
fun clockFlow(periodMs: Long): Flow<Long> = flow {
    while (true) {
        emit(System.currentTimeMillis())
        delay(periodMs)
    }
}

@Composable
private fun rememberNowPlaying(graph: WatchGraph, periodMs: Long): Pair<LinkUiState, NowPlayingUi> {
    val linkState by graph.link.state.collectAsStateWithLifecycle()
    val now by remember(periodMs) { clockFlow(periodMs) }.collectAsStateWithLifecycle(initialValue = System.currentTimeMillis())
    return linkState to remember(linkState, now) { linkState.toNowPlaying(now) }
}

/** Now Playing, wired to the phone. */
@Composable
fun NowPlayingRoute(
    graph: WatchGraph,
    onLibrary: () -> Unit,
    onDevices: () -> Unit,
    onSettings: () -> Unit,
    onArt: () -> Unit,
    onVolume: () -> Unit,
    onLyrics: () -> Unit = {},
    onQueue: () -> Unit = {}
) {
    val (_, ui) = rememberNowPlaying(graph, periodMs = 1_000)
    val cover = rememberCover(graph, ui.coverArt, ArtworkSize.MEDIUM)
    val look = rememberCoverLook(cover, hasCover = ui.coverArt != null)
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    val link = graph.link
    val lowRes = rememberLowResRotary()

    var carried by remember { mutableFloatStateOf(0f) }
    // The songs liked in the account (loaded once and updated as the watch stars or unstars a track).
    var liked by remember { mutableStateOf(emptySet<String>()) }
    LaunchedEffect(Unit) {
        runCatching { graph.api.starredSongs().mapTo( linkedSetOf() ) { it.id } }.getOrNull()?.let { starred ->
            liked = liked + starred
        }
    }
    val context = LocalContext.current
    var overlay by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(overlay) {
        if (overlay != null) {
            delay(1_200)
            overlay = null
        }
    }

    fun changeVolume(steps: Int) {
        if (steps == 0) return
        val volume = ControlMath.volumeAfter(ui.volume, steps)
        link.send(PlayerCommand.SetVolume(volume))
        overlay = ControlMath.volumePercent(volume)
    }

    val actions = NowPlayingActions(
        onToggle = { link.send(PlayerCommand.Toggle) },
        onNext = { link.send(PlayerCommand.Next) },
        onPrevious = { link.send(PlayerCommand.Prev) },
        onSeek = { seconds -> link.send(PlayerCommand.Seek(seconds)) },
        onShuffle = { link.send(PlayerCommand.ToggleShuffle) },
        onRepeat = { link.send(PlayerCommand.SetRepeatMode(ui.repeat.next())) },
        onCrown = { pixels ->
            val (steps, rest) = ControlMath.rotarySteps(carried, pixels, lowRes)
            carried = rest
            if (steps != 0) {
                haptics.tick()
                scope.launch { changeVolume(steps) }
            }
        },
        onVolume = onVolume,
        onLibrary = onLibrary,
        onDevices = onDevices,
        onSettings = onSettings,
        onLike = {
            val songId = ui.songId
            if (songId != null) {
                val wasLiked = songId in liked
                haptics.confirm()
                scope.launch {
                    val ok = runCatching {
                        if (wasLiked) graph.api.unstar(songId) else graph.api.star(songId)
                    }.isSuccess
                    if (ok) liked = if (wasLiked) liked - songId else liked + songId
                    val msgRes = if (!ok) R.string.like_failed else if (wasLiked) R.string.unliked else R.string.liked
                    Toast.makeText(context, msgRes, Toast.LENGTH_SHORT).show()
                }
            }
        },
        onLyrics = onLyrics,
        onQueue = onQueue,
        onSleepTimer = { minutes ->
            val reachable = link.send(PlayerCommand.SetSleepTimer(minutes))
            val msgRes = if (!reachable) R.string.phone_unreachable else if (minutes == 0) R.string.sleep_timer_cancelled else R.string.sleep_timer_set
            Toast.makeText(context, msgRes, Toast.LENGTH_SHORT).show()
        },
        onRadio = {
            val songId = ui.songId
            if (songId != null) {
                val reachable = link.send(PlayerCommand.PlayMedia(MediaKind.RADIO, songId, mode = PlayMode.NOW))
                Toast.makeText(context, if (reachable) R.string.sent_to_phone else R.string.phone_unreachable, Toast.LENGTH_SHORT).show()
            }
        }
    )
    NowPlayingContent(ui, cover, actions, overlay, look = look, liked = ui.songId in liked, onCoverClick = onArt, clock = rememberClockText())
}

/**
 * The volume screen, wired to the phone. What it shows is the player's volume, except while it is being turned and for
 * a moment after: then it is the value the watch sent, so that a state from the phone that left before the last turn
 * does not pull the ring back.
 */
@Composable
fun VolumeRoute(graph: WatchGraph) {
    val (_, ui) = rememberNowPlaying(graph, periodMs = 5_000)
    val cover = rememberCover(graph, ui.coverArt, ArtworkSize.MEDIUM)
    val look = rememberCoverLook(cover, hasCover = ui.coverArt != null)
    val haptics = rememberHaptics()
    val lowRes = rememberLowResRotary()
    val link = graph.link
    val context = LocalContext.current

    var held by remember { mutableStateOf<Double?>(null) }
    var touchedAt by remember { mutableLongStateOf(0L) }
    var carried by remember { mutableFloatStateOf(0f) }
    // What the volume was before the mute button, to give it back.
    var beforeMute by remember { mutableStateOf<Double?>(null) }
    LaunchedEffect(touchedAt) {
        if (touchedAt > 0L) {
            delay(1_500)
            held = null
        }
    }

    fun set(volume: Double) {
        // Read from the state, not from this composition: two clicks of the bezel can come before the screen is redrawn.
        val before = held ?: ui.volume
        val next = volume.coerceIn(0.0, 1.0)
        if (ControlMath.stepOf(next) != ControlMath.stepOf(before)) haptics.tick()
        held = next
        touchedAt = System.currentTimeMillis()
        // Whole percents only: a finger on the ring moves by fractions of one, and the phone needs no more.
        if (ControlMath.volumePercent(next) != ControlMath.volumePercent(before)) {
            link.send(PlayerCommand.SetVolume(ControlMath.volumePercent(next) / 100.0))
        }
    }

    VolumeContent(
        volume = held ?: ui.volume,
        caption = ui.statusLine ?: ui.playerName?.let { context.getString(R.string.playing_on, it) },
        captionIsWarning = ui.statusLine != null,
        enabled = ui.connected,
        onRotary = { pixels ->
            val (steps, rest) = ControlMath.rotarySteps(carried, pixels, lowRes)
            carried = rest
            if (steps != 0) set(ControlMath.volumeAfter(held ?: ui.volume, steps))
        },
        onChange = { set(it) },
        onMute = {
            haptics.tap()
            val now = held ?: ui.volume
            if (now > 0.0) {
                beforeMute = now
                set(0.0)
            } else {
                set(beforeMute ?: 0.5)
            }
        },
        look = if (ui.hasSong) look else null
    )
}

/** The always-on version, redrawn at most once a second and each minute when the system updates the screen. */
@Composable
fun AmbientNowPlayingRoute(graph: WatchGraph, ambient: AmbientState) {
    val (_, ui) = rememberNowPlaying(graph, periodMs = 1_000)
    val cover = rememberCover(graph, ui.coverArt, ArtworkSize.THUMBNAIL)
    // The minute of the day moves the content for burn-in protection; `tick` makes sure it is read again.
    val minuteOfDay = remember(ambient.tick) { System.currentTimeMillis() / 60_000 }
    if (NowPlayingPage.current == NowPlayingPage.CLOCK) {
        // The clock page was the one being looked at: the always-on screen is its own, with the cover as outlines.
        val context = LocalContext.current
        val time = remember(ambient.tick) { clockText(context, System.currentTimeMillis()) }
        AmbientClockContent(ui.hasSong, cover, time, ambient, minuteOfDay)
    } else {
        AmbientNowPlayingContent(ui, cover, ambient, minuteOfDay)
    }
}

/** The cover alone, at the largest size: the only place the 640 px version is ever downloaded. */
@Composable
fun ArtRoute(graph: WatchGraph, onClose: () -> Unit) {
    val (_, ui) = rememberNowPlaying(graph, periodMs = 5_000)
    val small = rememberCover(graph, ui.coverArt, ArtworkSize.MEDIUM)
    val large = rememberCover(graph, ui.coverArt, ArtworkSize.LARGE)
    ArtContent(large ?: small, ui.title, onClose)
}
