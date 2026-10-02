package com.selfhosthub.wear.ui.nowplaying

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.selfhosthub.wear.core.formatClock
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.CoverBox
import com.selfhosthub.wear.ui.common.rememberHaptics
import com.selfhosthub.wear.ui.theme.WatchColors

/** What the Now Playing screen can ask for. The screen itself does nothing but draw and report. */
class NowPlayingActions(
    val onToggle: () -> Unit,
    val onNext: () -> Unit,
    val onPrevious: () -> Unit,
    val onSeek: (Double) -> Unit,
    val onShuffle: () -> Unit,
    val onRepeat: () -> Unit,
    /** The crown moved by this many pixels of scrolling. */
    val onCrown: (Float) -> Unit,
    val onVolumeStep: (Int) -> Unit,
    val onLibrary: () -> Unit,
    val onDevices: () -> Unit,
    val onSettings: () -> Unit
)

/**
 * The first screen: what is playing, where it is in the song, and the three big buttons. Swiping up leads to the
 * second page, with the shuffle and repeat buttons, the volume, which player the controls act on, and the way into
 * the library and the settings. The crown changes the volume from either page.
 */
@Composable
fun NowPlayingContent(
    ui: NowPlayingUi,
    cover: ImageBitmap?,
    actions: NowPlayingActions,
    volumeOverlayPercent: Int?,
    modifier: Modifier = Modifier,
    onCoverClick: () -> Unit = {}
) {
    val pager = rememberPagerState(pageCount = { 2 })
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    Box(
        modifier
            .fillMaxSize()
            .onRotaryScrollEvent {
                actions.onCrown(it.verticalScrollPixels)
                true
            }
            .focusRequester(focus)
            .focusable()
    ) {
        VerticalPager(state = pager, modifier = Modifier.fillMaxSize()) { page ->
            if (page == 0) PlayerPage(ui, cover, actions, onCoverClick) else OptionsPage(ui, actions)
        }
        PageDots(pager.currentPage, pager.pageCount, Modifier.align(Alignment.CenterEnd).padding(end = 5.dp))
        if (volumeOverlayPercent != null) VolumeOverlay(volumeOverlayPercent)
    }
}

@Composable
private fun PlayerPage(ui: NowPlayingUi, cover: ImageBitmap?, actions: NowPlayingActions, onCoverClick: () -> Unit) {
    if (!ui.hasSong) {
        NothingPlaying(ui, actions)
        return
    }
    val haptics = rememberHaptics()
    var preview by remember { mutableStateOf<Float?>(null) }
    val shownPosition = preview?.let { ControlMath.secondsFor(it, ui.duration) } ?: ui.position

    Column(
        Modifier
            .fillMaxSize()
            .padding(top = 28.dp, bottom = 14.dp, start = 22.dp, end = 22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Top
    ) {
        CoverBox(cover, Modifier.size(50.dp).clickable(onClickLabel = null) { onCoverClick() }, RoundedCornerShape(10.dp))
        Spacer(Modifier.height(4.dp))
        Text(
            ui.title.orEmpty(),
            style = MaterialTheme.typography.title3,
            color = WatchColors.OnSurface,
            maxLines = 1,
            overflow = TextOverflow.Clip,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().basicMarquee(iterations = 3, initialDelayMillis = 1500)
        )
        Text(
            ui.statusLine ?: ui.artist.orEmpty(),
            style = MaterialTheme.typography.caption2,
            color = if (ui.statusLine != null) WatchColors.Warning else WatchColors.OnSurfaceMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth()
        )
        SeekBar(
            progress = ui.progress,
            enabled = ui.connected && ui.duration > 0,
            contentDescription = stringResource(R.string.seek_bar),
            modifier = Modifier.fillMaxWidth(),
            onPreview = { preview = it }
        ) { fraction ->
            haptics.confirm()
            actions.onSeek(ControlMath.secondsFor(fraction, ui.duration))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(formatClock(shownPosition), style = MaterialTheme.typography.caption3, color = WatchColors.OnSurfaceMuted)
            Text(formatClock(ui.duration), style = MaterialTheme.typography.caption3, color = WatchColors.OnSurfaceMuted)
        }
        Spacer(Modifier.height(2.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            TransportButton(Icons.Filled.SkipPrevious, stringResource(R.string.previous), 38.dp, filled = false) {
                haptics.tap()
                actions.onPrevious()
            }
            TransportButton(
                if (ui.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                stringResource(if (ui.isPlaying) R.string.pause else R.string.play),
                54.dp,
                filled = true
            ) {
                haptics.confirm()
                actions.onToggle()
            }
            TransportButton(Icons.Filled.SkipNext, stringResource(R.string.next), 38.dp, filled = false) {
                haptics.tap()
                actions.onNext()
            }
        }
    }
}

@Composable
private fun NothingPlaying(ui: NowPlayingUi, actions: NowPlayingActions) {
    val haptics = rememberHaptics()
    Column(
        Modifier.fillMaxSize().padding(horizontal = 26.dp, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(Icons.Filled.MusicNote, contentDescription = null, tint = WatchColors.OnSurfaceMuted, modifier = Modifier.size(30.dp))
        Spacer(Modifier.height(4.dp))
        Text(stringResource(R.string.nothing_playing), style = MaterialTheme.typography.title3, textAlign = TextAlign.Center)
        Text(
            ui.statusLine ?: stringResource(R.string.nothing_playing_hint),
            style = MaterialTheme.typography.caption2,
            color = if (ui.statusLine != null) WatchColors.Warning else WatchColors.OnSurfaceMuted,
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.height(8.dp))
        Chip(
            onClick = {
                haptics.tap()
                actions.onLibrary()
            },
            label = { Text(stringResource(R.string.library), maxLines = 1) },
            icon = { Icon(Icons.Filled.LibraryMusic, contentDescription = null, modifier = Modifier.size(20.dp)) },
            colors = ChipDefaults.primaryChipColors(),
            modifier = Modifier.fillMaxWidth().height(40.dp)
        )
    }
}

@Composable
private fun TransportButton(icon: ImageVector, description: String, size: Dp, filled: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier.size(size),
        colors = if (filled) ButtonDefaults.primaryButtonColors() else ButtonDefaults.iconButtonColors(),
        shape = CircleShape
    ) {
        Icon(icon, contentDescription = description, modifier = Modifier.size(size * 0.55f), tint = if (filled) Color.Black else WatchColors.OnSurface)
    }
}

/** The whole screen dims and the volume shows as an arc around the edge and a number: unmistakable while the crown turns. */
@Composable
private fun VolumeOverlay(percent: Int, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().background(Color(0xE6000000)), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(
            progress = percent / 100f,
            modifier = Modifier.fillMaxSize().padding(3.dp),
            indicatorColor = WatchColors.Accent,
            trackColor = Color(0xFF333333),
            strokeWidth = 6.dp
        )
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.AutoMirrored.Filled.VolumeUp, contentDescription = null, tint = WatchColors.Accent, modifier = Modifier.size(22.dp))
            Text(stringResource(R.string.volume_percent, percent), style = MaterialTheme.typography.display2)
        }
    }
}

/** Which of the pages is shown: a dot for each, on the right edge where a round screen leaves room. */
@Composable
private fun PageDots(current: Int, count: Int, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(5.dp)) {
        repeat(count) { index ->
            Box(Modifier.size(5.dp).background(if (index == current) WatchColors.Accent else Color(0xFF555555), CircleShape))
        }
    }
}

/** The cover at the largest size, filling the round screen; a tap goes back. */
@Composable
fun ArtContent(cover: ImageBitmap?, title: String?, onClose: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().background(Color.Black).clickable { onClose() }, contentAlignment = Alignment.Center) {
        CoverBox(cover, Modifier.fillMaxSize(), CircleShape, contentDescription = title)
    }
}
