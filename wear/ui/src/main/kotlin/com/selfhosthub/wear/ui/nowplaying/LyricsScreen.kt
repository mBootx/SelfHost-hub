package com.selfhosthub.wear.ui.nowplaying

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListAnchorType
import androidx.wear.compose.foundation.lazy.itemsIndexed
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.selfhosthub.wear.core.PlayerCommand
import com.selfhosthub.wear.data.ArtworkSize
import com.selfhosthub.wear.data.net.LrcParser
import com.selfhosthub.wear.data.net.WatchLyrics
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.common.CoverBackdrop
import com.selfhosthub.wear.ui.common.CoverLook
import com.selfhosthub.wear.ui.common.CoverTheme
import com.selfhosthub.wear.ui.common.rememberCover
import com.selfhosthub.wear.ui.common.rememberCoverLook
import com.selfhosthub.wear.ui.common.rememberHaptics
import com.selfhosthub.wear.ui.theme.WatchColors

/**
 * Synced LRC (or plain) lyrics screen for the currently playing song. Synced lines scroll automatically with the
 * playback position and can be tapped to seek directly to that line.
 */
@Composable
fun LyricsContent(
    title: String?,
    artist: String?,
    lyrics: WatchLyrics?,
    loading: Boolean,
    positionSeconds: Double,
    look: CoverLook? = null,
    onSeek: (Double) -> Unit = {}
) {
    val haptics = rememberHaptics()
    val listState = rememberScalingLazyListState()
    val synced = lyrics?.synced
    val activeIndex = remember(synced, positionSeconds) {
        if (synced != null) LrcParser.activeIndex(synced, positionSeconds) else -1
    }

    LaunchedEffect(activeIndex) {
        // Item 0 is the header; synced lines start at index 1.
        if (activeIndex >= 0) {
            runCatching { listState.animateScrollToItem(activeIndex + 1) }
        }
    }

    Box(Modifier.fillMaxSize()) {
        CoverBackdrop(look)
        CoverTheme(look?.colours) {
            Scaffold(
                timeText = { TimeText() },
                vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
                positionIndicator = { PositionIndicator(scalingLazyListState = listState) }
            ) {
                if (loading) {
                    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(28.dp),
                                indicatorColor = MaterialTheme.colors.primary,
                                strokeWidth = 3.dp
                            )
                            Spacer(Modifier.height(8.dp))
                            Text(
                                stringResource(R.string.lyrics_loading),
                                style = MaterialTheme.typography.caption2,
                                color = WatchColors.OnSurfaceMuted,
                                textAlign = TextAlign.Center
                            )
                        }
                    }
                } else if (synced.isNullOrEmpty() && lyrics?.plain.isNullOrBlank()) {
                    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(
                                Modifier
                                    .size(38.dp)
                                    .background(Color.White.copy(alpha = 0.08f), CircleShape),
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(
                                    painter = painterResource(R.drawable.ic_spotify_lyrics),
                                    contentDescription = null,
                                    tint = MaterialTheme.colors.primary,
                                    modifier = Modifier.size(20.dp)
                                )
                            }
                            Spacer(Modifier.height(8.dp))
                            Text(
                                stringResource(R.string.lyrics_empty),
                                style = MaterialTheme.typography.body2,
                                color = WatchColors.OnSurfaceMuted,
                                textAlign = TextAlign.Center
                            )
                        }
                    }
                } else {
                    ScalingLazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        autoCentering = null,
                        anchorType = ScalingLazyListAnchorType.ItemCenter,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        contentPadding = PaddingValues(top = 34.dp, bottom = 46.dp, start = 14.dp, end = 14.dp)
                    ) {
                        item(key = "header") {
                            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                                Text(
                                    title ?: stringResource(R.string.lyrics),
                                    style = MaterialTheme.typography.title3.copy(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                                    color = MaterialTheme.colors.primary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    textAlign = TextAlign.Center
                                )
                                if (!artist.isNullOrBlank()) {
                                    Text(
                                        artist,
                                        style = MaterialTheme.typography.caption3,
                                        color = WatchColors.OnSurfaceMuted,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        textAlign = TextAlign.Center
                                    )
                                }
                            }
                        }
                        if (!synced.isNullOrEmpty()) {
                            itemsIndexed(synced, key = { idx, line -> "$idx:${line.timeSeconds}" }) { idx, line ->
                                val isActive = idx == activeIndex
                                val isPast = idx < activeIndex
                                val display = line.text.ifBlank { "♪" }
                                Box(
                                    Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(12.dp))
                                        .background(if (isActive) Color.White.copy(alpha = 0.12f) else Color.Transparent)
                                        .clickable {
                                            haptics.tap()
                                            onSeek(line.timeSeconds)
                                        }
                                        .padding(horizontal = 10.dp, vertical = 6.dp),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Text(
                                        display,
                                        style = MaterialTheme.typography.body1.copy(
                                            fontSize = if (isActive) 15.sp else 13.sp,
                                            fontWeight = if (isActive) FontWeight.Bold else FontWeight.Medium,
                                            lineHeight = if (isActive) 19.sp else 17.sp
                                        ),
                                        color = when {
                                            isActive -> Color.White
                                            isPast -> Color.White.copy(alpha = 0.42f)
                                            else -> Color.White.copy(alpha = 0.68f)
                                        },
                                        textAlign = TextAlign.Center
                                    )
                                }
                            }
                        } else {
                            val lines = lyrics?.plain.orEmpty().lines().filter { it.isNotBlank() }
                            itemsIndexed(lines, key = { idx, _ -> "plain-$idx" }) { _, line ->
                                Text(
                                    line,
                                    style = MaterialTheme.typography.body2.copy(lineHeight = 18.sp),
                                    color = WatchColors.OnSurface,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 2.dp)
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun LyricsRoute(graph: WatchGraph) {
    val linkState by graph.link.state.collectAsStateWithLifecycle()
    val now by remember { clockFlow(500L) }.collectAsStateWithLifecycle(initialValue = System.currentTimeMillis())
    val ui = remember(linkState, now) { linkState.toNowPlaying(now) }
    val cover = rememberCover(graph, ui.coverArt, ArtworkSize.MEDIUM)
    val look = rememberCoverLook(cover, hasCover = ui.coverArt != null)

    var lyrics by remember(ui.songId) { mutableStateOf<WatchLyrics?>(null) }
    var loading by remember(ui.songId) { mutableStateOf(true) }

    LaunchedEffect(ui.songId, ui.title, ui.artist) {
        val title = ui.title
        val artist = ui.artist
        if (title.isNullOrBlank() && artist.isNullOrBlank()) {
            lyrics = null
            loading = false
            return@LaunchedEffect
        }
        loading = true
        lyrics = runCatching {
            graph.api.lyrics(artist.orEmpty(), title.orEmpty(), ui.album, ui.duration.toInt())
        }.getOrNull()
        loading = false
    }

    LyricsContent(
        title = ui.title,
        artist = ui.artist,
        lyrics = lyrics,
        loading = loading,
        positionSeconds = ui.position,
        look = if (ui.hasSong) look else null,
        onSeek = { seconds -> graph.link.send(PlayerCommand.Seek(seconds)) }
    )
}
