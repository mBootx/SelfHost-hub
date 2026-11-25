package com.selfhosthub.wear.ui.nowplaying

import androidx.annotation.DrawableRes
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import com.selfhosthub.wear.ui.common.CoverBackdrop
import com.selfhosthub.wear.ui.common.CoverBox
import com.selfhosthub.wear.ui.common.CoverLook
import com.selfhosthub.wear.ui.common.CoverTheme
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
    /** Opens the volume screen. */
    val onVolume: () -> Unit,
    val onLibrary: () -> Unit,
    val onDevices: () -> Unit,
    val onSettings: () -> Unit,
    /** Toggles the song playing in the favourites. */
    val onLike: () -> Unit = {},
    val onLyrics: () -> Unit = {},
    val onQueue: () -> Unit = {},
    val onSleepTimer: (Int) -> Unit = {},
    val onRadio: () -> Unit = {}
)

/**
 * The first screen: what is playing, where it is in the song, and the three big buttons. Swiping down leads to the
 * clock page (the cover as a thumbnail and the time), swiping up to the options page, with the shuffle and repeat
 * buttons, the volume, which player the controls act on, and the way into the library and the settings. The crown changes the volume from either page. The cover of the song, blurred, is
 * behind both pages, and the controls take its colour (`look`; black and green without one).
 */
@Composable
fun NowPlayingContent(
    ui: NowPlayingUi,
    cover: ImageBitmap?,
    actions: NowPlayingActions,
    volumeOverlayPercent: Int?,
    modifier: Modifier = Modifier,
    look: CoverLook? = null,
    /** The song playing was liked from the watch (this session). */
    liked: Boolean = false,
    onCoverClick: () -> Unit = {},
    /** The time to show on the clock page, already formatted. */
    clock: String = "",
    onPageChange: (Int) -> Unit = { NowPlayingPage.current = it }
) {
    val pager = rememberPagerState(initialPage = NowPlayingPage.current, pageCount = { NowPlayingPage.COUNT })
    // The page being looked at is remembered, for the always-on screen and for waking up on it.
    LaunchedEffect(pager) { snapshotFlow { pager.settledPage }.collect { onPageChange(it) } }
    // ...and the page asked for from outside (the player opening because music started) is scrolled to.
    LaunchedEffect(NowPlayingPage.current) {
        if (pager.settledPage != NowPlayingPage.current && !pager.isScrollInProgress) pager.animateScrollToPage(NowPlayingPage.current)
    }
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
        CoverBackdrop(if (ui.hasSong) look else null)
        CoverTheme(if (ui.hasSong) look?.colours else null) {
            Box(Modifier.fillMaxSize()) {
                VerticalPager(state = pager, modifier = Modifier.fillMaxSize()) { page ->
                    when (page) {
                        NowPlayingPage.CLOCK -> ClockPage(cover, ui.hasSong, clock, onCoverClick)
                        NowPlayingPage.PLAYER -> PlayerPage(ui, actions, onCoverClick)
                        else -> OptionsPage(ui, actions, liked)
                    }
                }
                PageDots(pager.currentPage, pager.pageCount, Modifier.align(Alignment.CenterEnd).padding(end = 5.dp))
                if (volumeOverlayPercent != null) VolumeOverlay(volumeOverlayPercent)
            }
        }
    }
}

/** The cover is the screen's backdrop now (blurred, behind the pager): this page is title, controls and time. */
@Composable
private fun PlayerPage(ui: NowPlayingUi, actions: NowPlayingActions, onCoverClick: () -> Unit) {
    if (!ui.hasSong) {
        NothingPlaying(ui, actions)
        return
    }
    val haptics = rememberHaptics()
    var preview by remember { mutableStateOf<Float?>(null) }
    val shownPosition = preview?.let { ControlMath.secondsFor(it, ui.duration) } ?: ui.position

    Box(
        modifier = Modifier.fillMaxSize()
    ) {
        // Title and artist, tap for the full cover. The round screen is only about 134 dp wide this close to its top
        // edge, so the sides are padded to keep the text off the bezel.
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .padding(top = 28.dp, start = 42.dp, end = 42.dp)
                .clickable(onClickLabel = stringResource(R.string.open_cover)) { onCoverClick() }
        ) {
            Text(
                ui.title.orEmpty(),
                style = MaterialTheme.typography.title3.copy(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                color = WatchColors.OnSurface,
                maxLines = 1,
                overflow = TextOverflow.Clip,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .basicMarquee(iterations = 3, initialDelayMillis = 1500)
            )
            Spacer(Modifier.height(2.dp))
            Text(
                ui.statusLine ?: ui.artist.orEmpty(),
                style = MaterialTheme.typography.caption2,
                color = if (ui.statusLine != null) WatchColors.Warning else MaterialTheme.colors.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }

        // Center Transport: Last Song | Circular SeekBar wrapping Center Play/Pause | Next Song
        Row(
            modifier = Modifier
                .align(Alignment.Center)
                .padding(top = 6.dp)
                .fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            TransportButton(
                iconRes = R.drawable.ic_spotify_prev,
                description = stringResource(R.string.previous),
                buttonSize = 42.dp,
                iconSize = 24.dp,
                centerButton = false
            ) {
                haptics.tap()
                actions.onPrevious()
            }

            Spacer(Modifier.width(10.dp))

            CircularSeekBar(
                progress = ui.progress,
                enabled = ui.connected && ui.duration > 0,
                contentDescription = stringResource(R.string.seek_bar),
                modifier = Modifier.size(68.dp),
                strokeWidth = 3.5.dp,
                onPreview = { preview = it },
                onSeek = { fraction ->
                    haptics.confirm()
                    actions.onSeek(ControlMath.secondsFor(fraction, ui.duration))
                }
            ) {
                TransportButton(
                    iconRes = if (ui.isPlaying) R.drawable.ic_spotify_pause else R.drawable.ic_spotify_play,
                    description = stringResource(if (ui.isPlaying) R.string.pause else R.string.play),
                    buttonSize = 61.dp,
                    iconSize = 26.dp,
                    centerButton = true
                ) {
                    haptics.confirm()
                    actions.onToggle()
                }
            }

            Spacer(Modifier.width(10.dp))

            TransportButton(
                iconRes = R.drawable.ic_spotify_next,
                description = stringResource(R.string.next),
                buttonSize = 42.dp,
                iconSize = 24.dp,
                centerButton = false
            ) {
                haptics.tap()
                actions.onNext()
            }
        }

        // Track time: Elapsed / Duration (bottom area)
        Row(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 18.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "${formatClock(shownPosition)} / ${formatClock(ui.duration)}",
                style = MaterialTheme.typography.caption3.copy(fontFeatureSettings = "tnum"),
                color = MaterialTheme.colors.onSurfaceVariant,
                textAlign = TextAlign.Center
            )
        }
    }
}

@Composable
private fun NothingPlaying(ui: NowPlayingUi, actions: NowPlayingActions) {
    val haptics = rememberHaptics()
    Column(
        Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Box(
            Modifier
                .size(40.dp)
                .background(Color.White.copy(alpha = 0.08f), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                painter = painterResource(R.drawable.ic_spotify_library),
                contentDescription = null,
                tint = WatchColors.Accent,
                modifier = Modifier.size(20.dp)
            )
        }
        Spacer(Modifier.height(6.dp))
        Text(
            stringResource(R.string.nothing_playing),
            style = MaterialTheme.typography.title3.copy(fontWeight = FontWeight.Bold),
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.height(2.dp))
        Text(
            ui.statusLine ?: stringResource(R.string.nothing_playing_hint),
            style = MaterialTheme.typography.caption2,
            color = if (ui.statusLine != null) WatchColors.Warning else WatchColors.OnSurfaceMuted,
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.height(10.dp))
        Chip(
            onClick = {
                haptics.tap()
                actions.onLibrary()
            },
            label = { Text(stringResource(R.string.library), maxLines = 1) },
            icon = {
                Icon(
                    painter = painterResource(R.drawable.ic_spotify_library),
                    contentDescription = null,
                    modifier = Modifier.size(18.dp)
                )
            },
            colors = ChipDefaults.primaryChipColors(),
            modifier = Modifier.fillMaxWidth().height(40.dp)
        )
    }
}

@Composable
private fun TransportButton(
    @DrawableRes iconRes: Int,
    description: String,
    buttonSize: Dp,
    iconSize: Dp,
    centerButton: Boolean,
    onClick: () -> Unit
) {
    Button(
        onClick = onClick,
        modifier = Modifier.size(buttonSize),
        colors = if (centerButton) {
            ButtonDefaults.buttonColors(
                backgroundColor = Color.White.copy(alpha = 0.10f),
                contentColor = Color.White
            )
        } else {
            ButtonDefaults.iconButtonColors(contentColor = WatchColors.OnSurface)
        },
        shape = CircleShape
    ) {
        Icon(
            painter = painterResource(iconRes),
            contentDescription = description,
            modifier = Modifier.size(iconSize),
            tint = Color.White
        )
    }
}

/** The whole screen dims and the volume shows as an arc around the edge and a number: unmistakable while the crown turns. */
@Composable
private fun VolumeOverlay(percent: Int, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().background(Color(0xE6000000)), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(
            progress = percent / 100f,
            modifier = Modifier.fillMaxSize().padding(4.dp),
            indicatorColor = MaterialTheme.colors.primary,
            trackColor = Color.White.copy(alpha = 0.14f),
            strokeWidth = 5.dp
        )
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                painter = painterResource(volumeIconRes(percent / 100.0)),
                contentDescription = null,
                tint = MaterialTheme.colors.primary,
                modifier = Modifier.size(24.dp)
            )
            Spacer(Modifier.height(4.dp))
            Text(
                stringResource(R.string.volume_percent, percent),
                style = MaterialTheme.typography.display2.copy(
                    fontSize = 32.sp,
                    fontWeight = FontWeight.SemiBold,
                    fontFeatureSettings = "tnum"
                )
            )
        }
    }
}

/** Which of the pages is shown: a dot for each, on the right edge where a round screen leaves room. */
@Composable
private fun PageDots(current: Int, count: Int, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(5.dp)) {
        repeat(count) { index ->
            Box(Modifier.size(5.dp).background(if (index == current) MaterialTheme.colors.primary else Color(0xFF555555), CircleShape))
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
