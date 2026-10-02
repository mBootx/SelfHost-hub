package com.selfhosthub.wear.ui.nowplaying

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.selfhosthub.wear.core.PlayerCommand
import com.selfhosthub.wear.data.ArtworkSize
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.service.link.LinkUiState
import com.selfhosthub.wear.ui.common.AmbientState
import com.selfhosthub.wear.ui.common.rememberCover
import com.selfhosthub.wear.ui.common.rememberHaptics
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
    onArt: () -> Unit
) {
    val (_, ui) = rememberNowPlaying(graph, periodMs = 1_000)
    val cover = rememberCover(graph, ui.coverArt, ArtworkSize.MEDIUM)
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    val link = graph.link

    var carried by remember { mutableFloatStateOf(0f) }
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
            val (steps, rest) = ControlMath.crownSteps(carried, pixels)
            carried = rest
            if (steps != 0) {
                haptics.tick()
                scope.launch { changeVolume(steps) }
            }
        },
        onVolumeStep = { steps -> changeVolume(steps) },
        onLibrary = onLibrary,
        onDevices = onDevices,
        onSettings = onSettings
    )
    NowPlayingContent(ui, cover, actions, overlay, onCoverClick = onArt)
}

/** The always-on version, redrawn at most once a second and each minute when the system updates the screen. */
@Composable
fun AmbientNowPlayingRoute(graph: WatchGraph, ambient: AmbientState) {
    val (_, ui) = rememberNowPlaying(graph, periodMs = 1_000)
    val cover = rememberCover(graph, ui.coverArt, ArtworkSize.THUMBNAIL)
    // The minute of the day moves the content for burn-in protection; `tick` makes sure it is read again.
    val minuteOfDay = remember(ambient.tick) { System.currentTimeMillis() / 60_000 }
    AmbientNowPlayingContent(ui, cover, ambient, minuteOfDay)
}

/** The cover alone, at the largest size: the only place the 640 px version is ever downloaded. */
@Composable
fun ArtRoute(graph: WatchGraph, onClose: () -> Unit) {
    val (_, ui) = rememberNowPlaying(graph, periodMs = 5_000)
    val small = rememberCover(graph, ui.coverArt, ArtworkSize.MEDIUM)
    val large = rememberCover(graph, ui.coverArt, ArtworkSize.LARGE)
    ArtContent(large ?: small, ui.title, onClose)
}
