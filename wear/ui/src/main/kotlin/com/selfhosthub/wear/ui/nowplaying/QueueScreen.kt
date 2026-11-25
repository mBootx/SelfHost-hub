package com.selfhosthub.wear.ui.nowplaying

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.lazy.itemsIndexed
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.selfhosthub.wear.core.PlayMode
import com.selfhosthub.wear.core.RemoteSong
import com.selfhosthub.wear.core.formatClock
import com.selfhosthub.wear.data.db.TrackEntity
import com.selfhosthub.wear.service.WatchGraph
import com.selfhosthub.wear.ui.R
import com.selfhosthub.wear.ui.library.ListScreen
import com.selfhosthub.wear.ui.library.MediaRow
import com.selfhosthub.wear.ui.library.TrackActionsDialog
import com.selfhosthub.wear.ui.library.rememberMediaSender
import com.selfhosthub.wear.ui.theme.WatchColors

/**
 * Shows the active player's queue ("À suivre"). Tapping an upcoming track plays it immediately on the phone;
 * long-pressing opens the track actions dialog (Play Now, Play Next, Add to Queue, Start Radio).
 */
@Composable
fun QueueContent(
    graph: WatchGraph?,
    currentTitle: String?,
    currentArtist: String?,
    currentCoverArt: String?,
    upNext: List<RemoteSong>,
    onPlay: (RemoteSong) -> Unit,
    onMore: (RemoteSong) -> Unit
) {
    ListScreen(stringResource(R.string.queue)) {
        if (currentTitle != null) {
            item(key = "now-playing") {
                MediaRow(
                    graph = graph,
                    coverId = currentCoverArt,
                    title = currentTitle,
                    subtitle = currentArtist,
                    onClick = {}
                )
            }
        }
        if (upNext.isEmpty()) {
            item(key = "empty") {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Box(
                        Modifier
                            .size(34.dp)
                            .background(Color.White.copy(alpha = 0.08f), CircleShape),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            painter = painterResource(R.drawable.ic_spotify_queue),
                            contentDescription = null,
                            tint = WatchColors.Accent,
                            modifier = Modifier.size(18.dp)
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        stringResource(R.string.queue_empty),
                        style = MaterialTheme.typography.body2,
                        textAlign = TextAlign.Center
                    )
                    Spacer(Modifier.height(2.dp))
                    Text(
                        stringResource(R.string.queue_hint),
                        style = MaterialTheme.typography.caption2,
                        color = WatchColors.OnSurfaceMuted,
                        textAlign = TextAlign.Center
                    )
                }
            }
        } else {
            item(key = "up-next-header") {
                ListHeader { Text(stringResource(R.string.up_next), color = WatchColors.OnSurfaceMuted) }
            }
            itemsIndexed(upNext, key = { idx, song -> "$idx:${song.id}" }) { _, song ->
                val subtitle = listOfNotNull(
                    song.artist.ifBlank { null },
                    song.duration.takeIf { it > 0 }?.let(::formatClock)
                ).joinToString(" · ")
                MediaRow(
                    graph = graph,
                    coverId = song.coverArt,
                    title = song.title,
                    subtitle = subtitle,
                    onClick = { onPlay(song) },
                    onLongClick = { onMore(song) }
                )
            }
        }
    }
}

@Composable
fun QueueRoute(graph: WatchGraph) {
    val linkState by graph.link.state.collectAsStateWithLifecycle()
    val ui = remember(linkState) { linkState.toNowPlaying(System.currentTimeMillis()) }
    val sender = rememberMediaSender(graph)
    var more by remember { mutableStateOf<RemoteSong?>(null) }

    QueueContent(
        graph = graph,
        currentTitle = ui.title,
        currentArtist = ui.artist,
        currentCoverArt = ui.coverArt,
        upNext = ui.upNext,
        onPlay = { song ->
            val albumId = song.albumId
            if (albumId != null) sender.playAlbum(albumId, songId = song.id) else sender.playSong(song.id, PlayMode.NOW)
        },
        onMore = { more = it }
    )
    TrackActionsDialog(
        track = more?.let {
            TrackEntity(it.id, it.title, it.artist, it.album ?: "", it.albumId, it.duration.toLong(), it.coverArt, null, 0L)
        },
        onDismiss = { more = null },
        onNow = {
            more?.let { song ->
                val albumId = song.albumId
                if (albumId != null) sender.playAlbum(albumId, songId = song.id) else sender.playSong(song.id, PlayMode.NOW)
            }
        },
        onNext = { more?.let { sender.playSong(it.id, PlayMode.NEXT) } },
        onLast = { more?.let { sender.playSong(it.id, PlayMode.LAST) } },
        onRadio = { more?.let { sender.startRadio(it.id) } }
    )
    sender.Host()
}
